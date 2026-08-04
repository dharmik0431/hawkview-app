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

interface SecretAccessResponse {
  payload?: { data?: string }
}

interface EncryptedPayload {
  ciphertext: Uint8Array<ArrayBuffer>
  initializationVector: Uint8Array<ArrayBuffer>
  authenticationTag: Uint8Array<ArrayBuffer>
}

@Injectable()
export class SecretStoreService {
  private cachedGoogleToken: { value: string; expiresAt: number } | null = null

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

  private get legacyProjectId() {
    return (
      process.env.GOOGLE_CLOUD_PROJECT?.trim() ??
      process.env.GCP_PROJECT_ID?.trim() ??
      ''
    )
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

  private async persist(
    name: string,
    value: string,
    legacyReference?: string
  ) {
    const encrypted = this.encrypt(name, value)
    const secret = await this.prisma.encryptedSecret.upsert({
      where: { name },
      create: {
        name,
        ...encrypted,
        legacyReference,
      },
      update: {
        ...encrypted,
        ...(legacyReference ? { legacyReference } : {}),
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

    const match = reference.match(LEGACY_REFERENCE_PATTERN)
    if (!match) {
      throw new ServiceUnavailableException(
        'The stored credential reference is invalid.'
      )
    }

    const value = await this.accessLegacyGoogleSecret(reference)
    const secret = await this.persist(match[2], value, reference)
    return this.decrypt(secret)
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

    const match = reference.match(LEGACY_REFERENCE_PATTERN)
    if (!match) {
      throw new ServiceUnavailableException(
        'The stored credential reference is invalid.'
      )
    }

    await this.prisma.encryptedSecret.deleteMany({
      where: { legacyReference: reference },
    })

    if (this.legacyProjectId) {
      await this.deleteLegacyGoogleSecret(reference)
    }
  }

  async accessOrCreate(secretId: string, createValue: () => string) {
    const existing = await this.prisma.encryptedSecret.findUnique({
      where: { name: secretId },
    })
    if (existing) return this.decrypt(existing)

    if (this.legacyProjectId) {
      const legacyReference = `projects/${this.legacyProjectId}/secrets/${secretId}/versions/latest`
      try {
        return await this.access(legacyReference)
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('status' in error) ||
          error.status !== 404
        ) {
          throw error
        }
      }
    }

    const value = createValue()
    await this.persist(secretId, value)
    return value
  }

  private async getLegacyGoogleAccessToken() {
    const configuredToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim()
    if (configuredToken) return configuredToken
    if (
      this.cachedGoogleToken &&
      this.cachedGoogleToken.expiresAt > Date.now() + 60_000
    ) {
      return this.cachedGoogleToken.value
    }

    const response = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(5_000),
      }
    )
    if (!response.ok) {
      throw new ServiceUnavailableException(
        'HawkView could not migrate a legacy stored credential.'
      )
    }
    const body = (await response.json()) as {
      access_token?: string
      expires_in?: number
    }
    if (!body.access_token) {
      throw new ServiceUnavailableException(
        'Google Cloud did not return a service identity token.'
      )
    }
    this.cachedGoogleToken = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 300) * 1000,
    }
    return body.access_token
  }

  private async legacyGoogleRequest(
    url: string,
    init: RequestInit = {},
    acceptedStatuses: number[] = [200]
  ) {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${await this.getLegacyGoogleAccessToken()}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(10_000),
    })
    if (!acceptedStatuses.includes(response.status)) {
      const error = new Error(
        `Legacy Secret Manager request failed with status ${response.status}.`
      ) as Error & { status?: number }
      error.status = response.status
      throw error
    }
    return response
  }

  private async accessLegacyGoogleSecret(reference: string) {
    const response = await this.legacyGoogleRequest(
      `https://secretmanager.googleapis.com/v1/${reference}:access`
    )
    const body = (await response.json()) as SecretAccessResponse
    const value = body.payload?.data
      ? Buffer.from(body.payload.data, 'base64').toString('utf8').trim()
      : ''
    if (!value) {
      throw new ServiceUnavailableException(
        'The legacy stored Microsoft credential is unavailable.'
      )
    }
    return value
  }

  private async deleteLegacyGoogleSecret(reference: string) {
    const match = reference.match(LEGACY_REFERENCE_PATTERN)
    if (!match || match[1] !== this.legacyProjectId) return
    await this.legacyGoogleRequest(
      `https://secretmanager.googleapis.com/v1/projects/${match[1]}/secrets/${match[2]}`,
      { method: 'DELETE' },
      [200, 404]
    )
  }
}
