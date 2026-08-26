import { Injectable, UnauthorizedException } from '@nestjs/common'
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from 'jose'
import type { AuthenticatedIdentity } from './auth.types.js'

interface SupabasePayload extends JWTPayload {
  email?: string
  aal?: string
  session_id?: string
  is_anonymous?: boolean
  user_metadata?: {
    display_name?: string
    full_name?: string
  }
  app_metadata?: { provider?: string }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Supabase does not include an authoritative `email_confirmed` claim in its
 * access-token contract. Instead, Confirm Email prevents a session from being
 * issued before confirmation; when the setting is disabled, Supabase treats
 * the email as implicitly confirmed. Validate the signed permanent-session
 * boundary here and never trust user_metadata as confirmation evidence.
 */
export function authenticatedIdentityFromSupabasePayload(
  payload: SupabasePayload,
): AuthenticatedIdentity {
  const email = typeof payload.email === 'string' ? payload.email.trim() : ''
  if (
    typeof payload.sub !== 'string' ||
    !UUID_PATTERN.test(payload.sub) ||
    !email ||
    payload.role !== 'authenticated' ||
    payload.is_anonymous !== false ||
    (payload.aal !== 'aal1' && payload.aal !== 'aal2') ||
    typeof payload.session_id !== 'string' ||
    !UUID_PATTERN.test(payload.session_id)
  ) {
    throw new UnauthorizedException(
      'A confirmed, non-anonymous Supabase session is required.',
    )
  }

  return {
    subject: payload.sub,
    email: email.toLowerCase(),
    displayName:
      payload.user_metadata?.display_name?.trim() ||
      payload.user_metadata?.full_name?.trim() ||
      undefined,
    signInProvider: payload.app_metadata?.provider,
    assuranceLevel: payload.aal,
  }
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

      return authenticatedIdentityFromSupabasePayload(payload)
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error
      }

      throw new UnauthorizedException('Invalid or expired identity token.')
    }
  }
}
