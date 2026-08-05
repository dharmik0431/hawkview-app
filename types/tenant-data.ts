export type TenantBundle = {
  tenant: any
  users: any[]
  signIns: any[]
  exchange: any
  sharepoint: any
  teams: any
  licenses?: {
    rows: Array<{
      name: string
      used: number
      total: number
      status?: 'ok' | 'warn' | 'bad'
      note?: string
    }>
  }
  dns?: {
    domain?: string
    spf?: string | { record: string; status: 'healthy' | 'warning' }
    dkim?: string | { record: string; status: 'healthy' | 'warning' }
    dmarc?: string | { record: string; status: 'healthy' | 'warning' }
    blacklist?: { record: string; status: 'not_checked' }
    checkedAt?: string
    byDomain?: Record<string, any>
  }
  entra?: {
    caPolicies: any[]
    authMethods: any[]
    namedLocations: any[]
  }
  sync?: {
    users?: TenantSyncStatus
    licenses?: TenantSyncStatus
    domains?: TenantSyncStatus
    groups?: TenantSyncStatus
    signIns?: TenantSyncStatus
    auditLogs?: TenantSyncStatus
    [resource: string]: TenantSyncStatus | undefined
  }
}

export type TenantSyncStatus = {
  status: string
  lastSuccessfulAt: string | null
  lastError: string | null
}
