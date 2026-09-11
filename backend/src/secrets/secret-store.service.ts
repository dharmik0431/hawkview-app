import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common'
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service.js'
import { encryptionKeyRing, type EncryptionKeyRing } from './secret-encryption-keys.js'
import { PLATFORM_OWNED, assertStorable, type SecretOwner } from './secret-owner.js'

const DATABASE_REFERENCE_PREFIX = 'encrypted-secret:'
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LEGACY_REFERENCE_PATTERN =
  /^projects\/([^/]+)\/secrets\/([^/]+)\/versions\/[^/]+$/

interface EncryptedPayload {
  ciphertext: Uint8Array<ArrayBuffer>
  initializationVector: Uint8Array<ArrayBuffer>
  authenticationTag: Uint8Array<ArrayBuffer>
}

/** A stored secret, as every read path here needs to see it. `keyVersion` is not
 * optional: a row whose sealing key is unknown cannot be opened, so there is
 * nothing useful to do with its absence except refuse. */
interface StoredSecret {
  id: string
  name: string
  ciphertext: Uint8Array
  initializationVector: Uint8Array
  authenticationTag: Uint8Array
  keyVersion: number
}

export const SEALED_WITH_UNAVAILABLE_KEY = 'SECRET_SEALED_WITH_UNAVAILABLE_KEY_VERSION'

@Injectable()
export class SecretStoreService {
  private readonly logger = new Logger(SecretStoreService.name)

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService
  ) {}

  /** Resolved per call rather than held, so a completed rotation takes effect on
   * a restart rather than a deploy, and so a test can change keys between
   * assertions without rebuilding an injector. */
  private get keys(): EncryptionKeyRing {
    return encryptionKeyRing()
  }

  private encrypt(name: string, value: string, key: Buffer): EncryptedPayload {
    if (!value) {
      throw new ServiceUnavailableException('A secret value is required.')
    }

    const initializationVector = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, initializationVector)
    // The name is the additional authenticated data, so ciphertext cannot be
    // moved between rows. Re-sealing keeps the same name and so the same binding.
    cipher.setAAD(Buffer.from(name, 'utf8'))
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ])

    return {
      ciphertext: Uint8Array.from(ciphertext),
      initializationVector: Uint8Array.from(initializationVector),
      authenticationTag: Uint8Array.from(cipher.getAuthTag()),
    }
  }

  private decrypt(secret: StoredSecret) {
    const keys = this.keys
    const key = keys.key(secret.keyVersion)
    if (key === null) {
      // A DIFFERENT FACT FROM A FAILED DECRYPTION, and reported differently.
      // "This service does not hold the key that sealed this row" is an
      // operational state with a known remedy — put the previous key back, or
      // finish the rotation. Reporting it as "could not be decrypted" is what
      // made a rotation mistake indistinguishable from data loss.
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: SEALED_WITH_UNAVAILABLE_KEY,
        message:
          'This credential is sealed with encryption key version ' +
          secret.keyVersion +
          ', which this service does not hold. It holds version ' +
          keys.currentVersion +
          '. The ciphertext is intact and nothing has been lost. See docs/secret-store.md.',
      })
    }

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(secret.initializationVector)
      )
      decipher.setAAD(Buffer.from(secret.name, 'utf8'))
      decipher.setAuthTag(Buffer.from(secret.authenticationTag))
      return Buffer.concat([
        decipher.update(Buffer.from(secret.ciphertext)),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      throw new ServiceUnavailableException(
        'The stored credential could not be decrypted.'
      )
    }
  }

  /** Opens the secret and, when it was sealed with an older key, re-seals it.
   *
   * RE-SEALING CAN NEVER FAIL THE READ. The caller already holds the plaintext by
   * the time this runs, so turning a successful decryption into an error because
   * a follow-up write failed would convert a rotation convenience into an outage.
   * A row that fails to re-seal is retried on its next read, and the previous key
   * stays necessary until it succeeds — which `rotationStatus()` reports. */
  private async openAndReseal(secret: StoredSecret) {
    const value = this.decrypt(secret)
    const keys = this.keys
    if (secret.keyVersion === keys.currentVersion) return value

    try {
      const resealed = this.encrypt(secret.name, value, keys.current)
      // Guarded on the version that was read. A concurrent re-seal of the same
      // row updates zero rows here rather than overwriting a newer seal, so two
      // simultaneous reads cannot leave a row labelled one version and sealed
      // with another.
      await this.prisma.encryptedSecret.updateMany({
        where: { id: secret.id, keyVersion: secret.keyVersion },
        data: { ...resealed, keyVersion: keys.currentVersion },
      })
    } catch {
      this.logger.warn(JSON.stringify({
        event: 'secret_reseal_deferred',
        name: secret.name,
        from: secret.keyVersion,
        to: keys.currentVersion,
      }))
    }
    return value
  }

  private databaseReference(id: string) {
    return `${DATABASE_REFERENCE_PREFIX}${id}`
  }

  private async persist(name: string, value: string) {
    const keys = this.keys
    const keyVersion = keys.currentVersion
    const encrypted = this.encrypt(name, value, keys.current)
    const secret = await this.prisma.encryptedSecret.upsert({
      where: { name },
      create: {
        name,
        ...encrypted,
        keyVersion,
      },
      update: {
        ...encrypted,
        keyVersion,
      },
    })
    return secret
  }

  /** `owner` is required, and tenant-owned secrets are refused. See
   * `secret-owner.ts` for why a working code path is deliberately stopped. */
  async store(secretId: string, value: string, owner: SecretOwner) {
    assertStorable(owner)
    const secret = await this.persist(secretId, value)
    return this.databaseReference(secret.id)
  }

  async access(reference: string) {
    if (reference.startsWith(DATABASE_REFERENCE_PREFIX)) {
      const id = reference.slice(DATABASE_REFERENCE_PREFIX.length)
      if (!UUID_PATTERN.test(id)) {
        throw new ServiceUnavailableException(
          'The stored credential reference is invalid.'
        )
      }
      const secret = await this.prisma.encryptedSecret.findUnique({
        where: { id },
      })
      if (!secret) {
        throw new ServiceUnavailableException(
          'The stored Microsoft credential is unavailable.'
        )
      }
      return this.openAndReseal(secret)
    }

    const migrated = await this.prisma.encryptedSecret.findUnique({
      where: { legacyReference: reference },
    })
    if (migrated) return this.openAndReseal(migrated)

    if (!LEGACY_REFERENCE_PATTERN.test(reference)) {
      throw new ServiceUnavailableException(
        'The stored credential reference is invalid.'
      )
    }
    throw new ServiceUnavailableException(
      'The migrated credential is unavailable in encrypted storage.'
    )
  }

  async delete(reference: string) {
    if (reference.startsWith(DATABASE_REFERENCE_PREFIX)) {
      const id = reference.slice(DATABASE_REFERENCE_PREFIX.length)
      if (!UUID_PATTERN.test(id)) {
        throw new ServiceUnavailableException(
          'The stored credential reference is invalid.'
        )
      }
      await this.prisma.encryptedSecret.deleteMany({ where: { id } })
      return
    }

    if (!LEGACY_REFERENCE_PATTERN.test(reference)) {
      throw new ServiceUnavailableException(
        'The stored credential reference is invalid.'
      )
    }

    await this.prisma.encryptedSecret.deleteMany({
      where: { legacyReference: reference },
    })
  }

  async accessOrCreate(secretId: string, createValue: () => string) {
    const existing = await this.prisma.encryptedSecret.findUnique({
      where: { name: secretId },
    })
    if (existing) return this.openAndReseal(existing)

    // Platform-owned by construction: this path mints one of HawkView's own
    // secrets when it is missing, and nothing tenant-scoped can be created by it.
    // Stated rather than assumed, so that a future tenant-scoped caller has to
    // change this line and meet the refusal.
    assertStorable(PLATFORM_OWNED)
    const value = createValue()
    await this.persist(secretId, value)
    return value
  }

  /** Whether a rotation is safe to finish, measured by attempting every secret.
   *
   * THE INSTRUMENT FOR THE ONLY RISK THAT MATTERS HERE. A rotation is finished by
   * removing the previous key, and the safe moment to do that is when no row
   * still needs it. This answers that by OPENING each row rather than by reading
   * its version column, because a version label is a claim and the claim is
   * exactly what could be wrong.
   *
   * Returns no plaintext and no ciphertext — names, versions, and whether each
   * one opened. Safe to log and safe to show an operator. */
  async rotationStatus() {
    const secrets = await this.prisma.encryptedSecret.findMany({
      select: {
        id: true,
        name: true,
        keyVersion: true,
        ciphertext: true,
        initializationVector: true,
        authenticationTag: true,
      },
    })
    const currentVersion = this.keys.currentVersion

    const rows = secrets.map((secret) => {
      let readable = false
      try {
        this.decrypt(secret)
        readable = true
      } catch {
        readable = false
      }
      return { name: secret.name, keyVersion: secret.keyVersion, readable }
    })

    return {
      currentVersion,
      secrets: rows,
      unreadable: rows.filter((row) => !row.readable).length,
      /** Rows still sealed with an older key. The previous key must stay
       * configured while this is above zero. */
      resealPending: rows.filter((row) => row.keyVersion !== currentVersion).length,
      /** Every secret opens AND sits at the current version, so nothing needs the
       * previous key any more. */
      complete: rows.every(
        (row) => row.readable && row.keyVersion === currentVersion
      ),
    }
  }
}
