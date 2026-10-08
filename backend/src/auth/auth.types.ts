import type { Request } from 'express'
import type { ConsoleSessionStatus } from './console-session.service.js'

export interface AuthenticatedIdentity {
  subject: string
  email: string
  displayName?: string
  signInProvider?: string
  /** Always present for identities produced by IdentityTokenVerifier. */
  assuranceLevel?: 'aal1' | 'aal2'
  /** Signed Supabase claims; never supplied by a request body or user_metadata. */
  sessionId?: string
  authenticatedAt?: Date
}

export interface AuthenticatedRequest extends Request {
  auth: AuthenticatedIdentity
  requestId: string
  consoleSession?: ConsoleSessionStatus
}
