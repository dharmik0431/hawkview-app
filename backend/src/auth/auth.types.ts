import type { Request } from 'express'

export interface AuthenticatedIdentity {
  subject: string
  email: string
  displayName?: string
  signInProvider?: string
}

export interface AuthenticatedRequest extends Request {
  auth: AuthenticatedIdentity
}
