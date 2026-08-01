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
}
