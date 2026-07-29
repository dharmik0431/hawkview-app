import type { TenantBundle } from '@/types/tenant-data'

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
  TenantBundle['tenant'],
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
  getTenantBundle(id: string): Promise<TenantBundle>
  getTenantSection(id: string, section: TenantSectionKey): Promise<any>
}
