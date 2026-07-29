import { Injectable, UnauthorizedException } from '@nestjs/common'
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from 'jose'
import type { AuthenticatedIdentity } from './auth.types.js'

const GOOGLE_IDENTITY_JWKS = new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
)

interface IdentityPlatformPayload extends JWTPayload {
  email?: string
  email_verified?: boolean
  name?: string
  user_id?: string
  firebase?: {
    sign_in_provider?: string
  }
}

@Injectable()
export class IdentityTokenVerifier {
  private readonly projectId: string
  private readonly jwks = createRemoteJWKSet(GOOGLE_IDENTITY_JWKS)

  constructor() {
    const projectId =
      process.env.IDENTITY_PLATFORM_PROJECT_ID ??
      process.env.GOOGLE_CLOUD_PROJECT

    if (!projectId) {
      throw new Error(
        'IDENTITY_PLATFORM_PROJECT_ID or GOOGLE_CLOUD_PROJECT is required.',
      )
    }

    this.projectId = projectId
  }

  async verify(token: string): Promise<AuthenticatedIdentity> {
    try {
      const { payload } = await jwtVerify<IdentityPlatformPayload>(
        token,
        this.jwks,
        {
          algorithms: ['RS256'],
          audience: this.projectId,
          issuer: `https://securetoken.google.com/${this.projectId}`,
        },
      )

      if (
        !payload.sub ||
        payload.user_id !== payload.sub ||
        !payload.email ||
        payload.email_verified !== true
      ) {
        throw new UnauthorizedException('A verified email is required.')
      }

      return {
        subject: payload.sub,
        email: payload.email.trim().toLowerCase(),
        displayName: payload.name?.trim() || undefined,
        signInProvider: payload.firebase?.sign_in_provider,
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error
      }

      throw new UnauthorizedException('Invalid or expired identity token.')
    }
  }
}
