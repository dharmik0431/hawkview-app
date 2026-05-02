// app/(protected)/tenants/[id]/mock/mockData.ts

export type Provider = 'microsoft' | 'google'
export type TenantStatus = 'healthy' | 'warning' | 'critical'

export type Tenant = {
  id: string
  name: string
  domain: string
  provider: Provider
  status: TenantStatus
  secureScore: number
  licenseCount: number
  lastSync: string
  domains?: string[]
}

// ✅ Put TENANTS here
export const TENANTS: Tenant[] = [
  // paste your existing TENANTS array here
]

// ✅ Export every mock dataset you currently have in page.tsx
export const MOCK_USERS = [
  // paste users array here
]

export const MOCK_SIGNINS = [
  // paste signins array here
]

// Exchange
export const MOCK_MAILBOXES = [
  // paste exchange mailboxes here
]

export const MOCK_MAILRULES = [
  // paste exchange rules here
]

export const MOCK_ACCEPTED_DOMAINS = [
  // paste accepted domains here
]

export const MOCK_MAIL_GROUPS = [
  // paste mail groups here
]

// ✅ Backward-compatible aliases (in case any code still imports these)
export const MOCK_EXCHANGE_MAILBOXES = MOCK_MAILBOXES
export const MOCK_EXCHANGE_RULES = MOCK_MAILRULES
export const MOCK_EXCHANGE_DOMAINS = MOCK_ACCEPTED_DOMAINS
export const MOCK_EXCHANGE_GROUPS = MOCK_MAIL_GROUPS

// SharePoint
export const MOCK_SP_OVERVIEW = {
  // paste overview object
}

export const MOCK_SP_SITES = [
  // paste sites array
]

export const MOCK_SP_DELETED_SITES = [
  // paste deleted sites array
]

// ✅ Backward-compatible alias
export const MOCK_SP_DELETED = MOCK_SP_DELETED_SITES

// Teams (if you want)
export const MOCK_TEAMS = {
  // paste teams mock object
}
