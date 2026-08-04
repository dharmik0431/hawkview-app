import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common'
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service.js'

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

@Injectable()
export class SecretStoreService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService
  ) {}

  private get encryptionKey() {
    const configured = process.env.SECRET_ENCRYPTION_KEY?.trim() ?? ''
    const key = /^[a-f\d]{64}$/i.test(configured)
      ? Buffer.from(configured, 'hex')
      : Buffer.from(configured, 'base64')

    if (key.length !== 32) {
      throw new ServiceUnavailableException(
        'Secure credential encryption is not configured.'
      )
    }
    return key
  }

  private encrypt(name: string, value: string): EncryptedPayload {
    if (!value) {
      throw new ServiceUnavailableException('A secret value is required.')
    }

    const initializationVector = randomBytes(12)
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      initializationVector
    )
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

  private decrypt(secret: {
    name: string
    ciphertext: Uint8Array
    initializationVector: Uint8Array
    authenticationTag: Uint8Array
  }) {
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
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

  private databaseReference(id: string) {
    return `${DATABASE_REFERENCE_PREFIX}${id}`
  }

  private async persist(name: string, value: string) {
    const encrypted = this.encrypt(name, value)
    const secret = await this.prisma.encryptedSecret.upsert({
      where: { name },
      create: {
        name,
        ...encrypted,
      },
      update: {
        ...encrypted,
      },
    })
    return secret
  }

  async store(secretId: string, value: string) {
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
      return this.decrypt(secret)
    }

    const migrated = await this.prisma.encryptedSecret.findUnique({
      where: { legacyReference: reference },
    })
    if (migrated) return this.decrypt(migrated)

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
    if (existing) return this.decrypt(existing)

    const value = createValue()
    await this.persist(secretId, value)
    return value
  }
}
