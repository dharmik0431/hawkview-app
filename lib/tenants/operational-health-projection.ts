import type { TenantsResponse } from '../../types/api.ts'
import {
  tenantActionableHealthProjection,
  type TenantActionableHealthProjection,
} from '../attention/computeTenantAttention.ts'

export type TenantOperationalRecord = TenantsResponse['tenants'][number] & {
  collectionReadiness?: unknown
  tenantHealth?: {
    resourceHealth?: unknown
  }
  resourceHealth?: unknown
}

export type TenantOperationalProjection = {
  status: 'LOADING' | 'READY' | 'UNAVAILABLE'
  tenant: TenantOperationalRecord | null
  tenants: TenantOperationalRecord[]
  actionableHealth: TenantActionableHealthProjection
}

export function projectTenantOperationalHealth(input: {
  tenantId?: string | null
  response?: TenantsResponse
  queryState: 'LOADING' | 'SUCCESS' | 'ERROR'
}): TenantOperationalProjection {
  const tenants = Array.isArray(input.response?.tenants)
    ? input.response.tenants as TenantOperationalRecord[]
    : []
  const normalizedTenantId = String(input.tenantId ?? '').trim().toLowerCase()
  const tenant = normalizedTenantId
    ? tenants.find((candidate) => candidate.id.toLowerCase() === normalizedTenantId) ?? null
    : null
  const status = input.queryState === 'LOADING'
    ? 'LOADING' as const
    : input.queryState === 'ERROR' || !tenant
      ? 'UNAVAILABLE' as const
      : 'READY' as const

  return {
    status,
    tenant,
    tenants,
    actionableHealth: status === 'READY'
      ? tenantActionableHealthProjection(tenant)
      : { status: 'UNAVAILABLE', items: [] },
  }
}
