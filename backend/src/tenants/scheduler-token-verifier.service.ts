import { Injectable, UnauthorizedException } from '@nestjs/common'
import { timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

const GOOGLE_OIDC_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs')
)

interface GoogleSchedulerPayload extends JWTPayload {
  email?: string
  email_verified?: boolean
}

@Injectable()
export class SchedulerTokenVerifier {
  private readonly sharedSecret: string
  private readonly audience: string
  private readonly serviceAccountEmail: string

  constructor() {
    this.sharedSecret = process.env.SCHEDULER_SHARED_SECRET?.trim() ?? ''
    if (this.sharedSecret && this.sharedSecret.length < 32) {
      throw new Error('SCHEDULER_SHARED_SECRET must be at least 32 characters.')
    }
    this.audience = process.env.SCHEDULER_OIDC_AUDIENCE?.trim() ?? ''
    this.serviceAccountEmail =
      process.env.SCHEDULER_SERVICE_ACCOUNT_EMAIL?.trim().toLowerCase() ?? ''
  }

  async verify(authorization: string | undefined) {
    if (
      !this.sharedSecret &&
      (!this.audience || !this.serviceAccountEmail)
    ) {
      throw new UnauthorizedException(
        'Scheduled synchronization authentication is not configured.'
      )
    }
    const match = authorization?.match(/^Bearer ([^\s]+)$/)
    if (!match) {
      throw new UnauthorizedException('A scheduler bearer token is required.')
    }

    if (this.sharedSecret && this.matchesSharedSecret(match[1])) {
      return { authenticationMethod: 'shared-secret' }
    }

    if (!this.audience || !this.serviceAccountEmail) {
      throw new UnauthorizedException('Invalid scheduler bearer token.')
    }

    try {
      const { payload } = await jwtVerify<GoogleSchedulerPayload>(
        match[1],
        GOOGLE_OIDC_JWKS,
        {
          algorithms: ['RS256'],
          audience: this.audience,
          issuer: ['https://accounts.google.com', 'accounts.google.com'],
        }
      )
      if (
        payload.email_verified !== true ||
        payload.email?.toLowerCase() !== this.serviceAccountEmail
      ) {
        throw new UnauthorizedException(
          'The scheduler service account is not authorized.'
        )
      }
      return payload
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error
      throw new UnauthorizedException('Invalid scheduler identity token.')
    }
  }

  private matchesSharedSecret(candidate: string) {
    const actual = Buffer.from(candidate)
    const expected = Buffer.from(this.sharedSecret)

    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    )
  }
}
