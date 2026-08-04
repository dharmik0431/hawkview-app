import { Injectable, UnauthorizedException } from '@nestjs/common'
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from 'jose'
import type { AuthenticatedIdentity } from './auth.types.js'

interface SupabasePayload extends JWTPayload {
  email?: string
  user_metadata?: {
    display_name?: string
    full_name?: string
  }
  app_metadata?: { provider?: string }
}

@Injectable()
export class IdentityTokenVerifier {
  private readonly issuer: string
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>

  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '')

    if (!supabaseUrl) {
      throw new Error('SUPABASE_URL is required.')
    }

    this.issuer = `${supabaseUrl}/auth/v1`
    this.jwks = createRemoteJWKSet(
      new URL(`${this.issuer}/.well-known/jwks.json`),
    )
  }

  async verify(token: string): Promise<AuthenticatedIdentity> {
    try {
      const { payload } = await jwtVerify<SupabasePayload>(
        token,
        this.jwks,
        {
          audience: 'authenticated',
          issuer: this.issuer,
        },
      )

      if (
        !payload.sub ||
        !payload.email ||
        payload.role !== 'authenticated'
      ) {
        throw new UnauthorizedException('A verified email is required.')
      }

      return {
        subject: payload.sub,
        email: payload.email.trim().toLowerCase(),
        displayName:
          payload.user_metadata?.display_name?.trim() ||
          payload.user_metadata?.full_name?.trim() ||
          undefined,
        signInProvider: payload.app_metadata?.provider,
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error
      }

      throw new UnauthorizedException('Invalid or expired identity token.')
    }
  }
}
