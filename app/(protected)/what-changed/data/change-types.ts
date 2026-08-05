export type ChangeSeverity = 'High' | 'Medium' | 'Low'

export type ChangeCategory =
  | 'Roles'
  | 'MFA'
  | 'Conditional Access'
  | 'Apps'
  | 'Licenses'
  | 'Users'
  | 'Groups'
  | 'Devices'
  | 'Passwords'
  | 'Sign-ins'

export type ChangeSource = 'Entra' | 'M365' | 'Unknown'

export type ChangeEvidence = {
  result?: string
  resultReason?: string
  operationType?: string
  loggedByService?: string
  actor?: { displayName?: string; principalName?: string; type?: string; objectId?: string; ipAddress?: string; automatedBy?: string }
  application?: { displayName?: string; appId?: string; objectId?: string; servicePrincipalId?: string; publisher?: string; appType?: string; signInAudience?: string; description?: string; homepage?: unknown }
  permissions?: { permissionName?: unknown; permissionType?: string; consentType?: string; scope?: unknown; resourceApi?: string; appRole?: string; assignedTo?: string; grantingAdmin?: string; consentStatus?: string }
  targets?: Array<{ displayName: string; targetType?: string; objectId?: string; upn?: string }>
}

export function isAppRelatedEvent(e: ChangeEvent): boolean {
  if (e.eventType === 'sign-in' || e.category === 'Sign-ins') {
    return false
  }
  if (e.category === 'Apps') {
    return true
  }
  const text = `${e.title} ${e.summary} ${e.category} ${e.target ?? ''}`.toLowerCase()
  return /service\s*principal|application|app\s*registration|credential|client\s*secret|certificate|key\s*credential|oauth|permission\s*grant|consent|app\s*role|approle|enterprise\s*app/i.test(text)
}

export type ChangeEvent = {
  id: string
  ts: string // ISO string
  tenantId: string
  tenantName: string
  provider: 'Microsoft' | 'Google'
  category: ChangeCategory
  severity: ChangeSeverity
  title: string
  summary: string
  actor?: string
  target?: string
  source: ChangeSource
  eventType?: 'change' | 'sign-in'
  correlationId?: string
  recoveryGuidance?: string[]
  evidence?: ChangeEvidence

  ip?: string
  location?: { city?: string; region?: string; country?: string }
  client?: { app?: string; device?: string }

  // for a simple diff view
  before?: Record<string, any>
  after?: Record<string, any>
}
