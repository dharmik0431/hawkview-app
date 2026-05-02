// app/(protected)/tenants/[id]/mock/tenants/index.ts

import type { TenantMockBundle } from '../types'

import { tenantMock as defaultTenant } from './_default'
import { tenantMock as alphatechMs } from './alphatech-ms'
import { tenantMock as betasolutionsGw } from './betasolutions-gw'
import { tenantMock as gammaMs } from './gamma-ms'
import { tenantMock as startupLabsMs } from './startup-labs-ms'
import { tenantMock as deltahealthMs } from './deltahealth-ms'

// Used by getMockTenant (lookup by id)
export const TENANT_MOCKS: Record<string, TenantMockBundle> = {
  [alphatechMs.tenant.id]: alphatechMs,
  [betasolutionsGw.tenant.id]: betasolutionsGw,
  [gammaMs.tenant.id]: gammaMs,
  [startupLabsMs.tenant.id]: startupLabsMs,
  [deltahealthMs.tenant.id]: deltahealthMs,
  _default: defaultTenant,
}

// Used by tenants list UI
export const TENANTS = [
  alphatechMs.tenant,
  betasolutionsGw.tenant,
  gammaMs.tenant,
  startupLabsMs.tenant,
  deltahealthMs.tenant,
]
