import type { TenantMockBundle } from '../mock/types'

export type TenantSectionKey =
  | 'overview'
  | 'users'
  | 'signins'
  | 'exchange'
  | 'sharepoint'
  | 'teams'
  | 'licenses'
  | 'dns'
  | 'entra'

export type TenantSummary = Pick<
  TenantMockBundle['tenant'],
  | 'id'
  | 'name'
  | 'domain'
  | 'provider'
  | 'status'
  | 'secureScore'
  | 'licenseCount'
  | 'lastSync'
>

export interface TenantDataProvider {
  getTenantSummary(id: string): Promise<TenantSummary>
  getTenantBundle(id: string): Promise<TenantMockBundle>
  getTenantSection(id: string, section: TenantSectionKey): Promise<any>
}
