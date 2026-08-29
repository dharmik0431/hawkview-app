import type { Request } from 'express'

export interface AuthenticatedIdentity {
  subject: string
  email: string
  displayName?: string
  signInProvider?: string
  /** Always present for identities produced by IdentityTokenVerifier. */
  assuranceLevel?: 'aal1' | 'aal2'
}

export interface AuthenticatedRequest extends Request {
  auth: AuthenticatedIdentity
  requestId: string
}
