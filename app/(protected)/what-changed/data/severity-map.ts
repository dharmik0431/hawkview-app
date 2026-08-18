import type { ChangeCategory, ChangeSeverity } from './change-types'

export const CATEGORY_DEFAULT_SEVERITY: Record<ChangeCategory, ChangeSeverity> = {
  Roles: 'High',
  MFA: 'High',
  'Conditional Access': 'High',
  Apps: 'High',
  Licenses: 'Medium',
  Users: 'Medium',
  Groups: 'Medium',
  Devices: 'Low',
  Passwords: 'High',
  'Sign-ins': 'Low',
  Organization: 'Medium',
  Domains: 'Medium',
  Exchange: 'Medium',
  SharePoint: 'Medium',
  Unknown: 'Low',
}
