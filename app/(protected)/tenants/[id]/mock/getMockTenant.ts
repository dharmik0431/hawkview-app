// app/(protected)/tenants/[id]/mock/getMockTenant.ts

import type { TenantMockBundle } from './types'
import { TENANT_MOCKS } from './tenants'

export function getMockTenant(tenantId: string): TenantMockBundle {
  const key = (tenantId ?? '').toLowerCase().trim()
  return (TENANT_MOCKS[key] ?? TENANT_MOCKS._default) as TenantMockBundle
}
