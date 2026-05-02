// app/(protected)/tenants/[id]/mock/types.ts
// Keep it loose for now. We’ll tighten later.

export type TenantMockBundle = {
  tenant: any
  users: any[]
  signIns: any[]
  exchange: any
  sharepoint: any
  teams: any

  // moved-from-page.tsx mock blocks
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
