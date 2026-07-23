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

export type ChangeSource = 'Entra' | 'M365' | 'Unknown'

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

  ip?: string
  location?: { city?: string; region?: string; country?: string }
  client?: { app?: string; device?: string }

  // for a simple diff view
  before?: Record<string, any>
  after?: Record<string, any>
}
