import type {
  TenantDataProvider,
  TenantSectionKey,
  TenantSummary,
} from './provider'
import type { TenantMockBundle } from '../mock/types'
import { getMockTenant } from '../mock' // adjust if your path differs

export const mockProvider: TenantDataProvider = {
  async getTenantSummary(id: string): Promise<TenantSummary> {
    const bundle = getMockTenant(id) as TenantMockBundle
    return {
      id: bundle.tenant.id,
      name: bundle.tenant.name,
      domain: bundle.tenant.domain,
      provider: bundle.tenant.provider,
      status: bundle.tenant.status,
      secureScore: bundle.tenant.secureScore,
      licenseCount: bundle.tenant.licenseCount,
      lastSync: bundle.tenant.lastSync,
    }
  },

  async getTenantBundle(id: string): Promise<TenantMockBundle> {
    return getMockTenant(id) as TenantMockBundle
  },

  async getTenantSection(id: string, section: TenantSectionKey) {
    const b = getMockTenant(id) as any
    switch (section) {
      case 'overview':
        return b.tenant
      case 'users':
        return b.users
      case 'signins':
        return b.signIns
      case 'exchange':
        return b.exchange
      case 'sharepoint':
        return b.sharepoint
      case 'teams':
        return b.teams
      case 'licenses':
        return b.licenses
      case 'dns':
        return b.dns
      case 'entra':
        return b.entra
      default:
        return null
    }
  },
}
