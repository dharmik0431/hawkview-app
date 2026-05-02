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

  // for a simple diff view
  before?: Record<string, any>
  after?: Record<string, any>
}
