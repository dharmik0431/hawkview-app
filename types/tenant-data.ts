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
    spf: string
    dkim: string
    dmarc: string
  }
  entra?: {
    caPolicies: any[]
    authMethods: any[]
    namedLocations: any[]
  }
}
