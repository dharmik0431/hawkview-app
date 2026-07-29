import { apiClient } from '@/lib/api/client'
import type { TenantBundle } from '@/types/tenant-data'
import type {
  TenantDataProvider,
  TenantSectionKey,
  TenantSummary,
} from './provider'

export const apiProvider: TenantDataProvider = {
  async getTenantSummary(id: string): Promise<TenantSummary> {
    const response = await apiClient.get<{ bundle: TenantBundle }>(
      `/api/tenants/${encodeURIComponent(id)}`
    )
    return response.bundle.tenant
  },

  async getTenantBundle(id: string): Promise<TenantBundle> {
    const response = await apiClient.get<{ bundle: TenantBundle }>(
      `/api/tenants/${encodeURIComponent(id)}`
    )
    return response.bundle
  },

  async getTenantSection(id: string, section: TenantSectionKey): Promise<any> {
    return apiClient.get(
      `/api/tenants/${encodeURIComponent(id)}/sections/${encodeURIComponent(section)}`
    )
  },
}
