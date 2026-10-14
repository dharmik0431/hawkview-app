import type { Tenant } from '../../types/api.ts'

export type CollectionServiceKey =
  | 'office365' | 'entraId' | 'exchange' | 'sharePointOneDrive'
  | 'signInLogs' | 'auditLogs'

export type CollectionBadge = {
  label: string
  detail: string
  tone: 'ok' | 'attention' | 'neutral'
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null

function dateLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toLocaleString() : null
}

export function tenantConnectionBadge(tenant: Pick<Tenant, 'status' | 'connectionStatus'>): CollectionBadge {
  if (tenant.status === 'suspended') {
    return { label: 'Suspended', detail: 'This tenant is suspended; a past connection does not establish current collection.', tone: 'attention' }
  }
  if (tenant.status === 'disconnected' || tenant.connectionStatus === 'revoked') {
    return { label: 'Disconnected', detail: 'Tenant-wide Microsoft access is reported disconnected or revoked. Earlier collected data may still be visible.', tone: 'attention' }
  }
  if (tenant.connectionStatus === 'error') {
    return { label: 'Needs attention', detail: 'Tenant-wide Microsoft connection verification reported an error. Check tenant settings for the reported cause.', tone: 'attention' }
  }
  if (tenant.status === 'pending' || tenant.connectionStatus === 'pending-consent') {
    return { label: 'Setup pending', detail: 'Tenant-wide Microsoft connection setup or consent has not completed.', tone: 'neutral' }
  }
  if (tenant.status === 'active' && tenant.connectionStatus === 'connected') {
    return { label: 'Connected', detail: 'The tenant-wide Microsoft connection is reported connected. Each service collection is shown separately below.', tone: 'ok' }
  }
  return { label: 'Not verified', detail: 'This response does not establish the tenant-wide connection state.', tone: 'neutral' }
}

/** A service collector result is distinct from the tenant-wide OAuth connection
 * and from a security finding. Missing or malformed evidence cannot become OK. */
export function serviceCollectionBadge(syncFreshness: unknown, key: CollectionServiceKey): CollectionBadge {
  const service = record(record(record(syncFreshness)?.services)?.[key])
  if (!service) return { label: 'Status unavailable', detail: 'The tenant list did not provide a verified collection result for this service.', tone: 'neutral' }

  const status = service.status
  const freshness = service.freshnessStatus
  const last = dateLabel(service.lastSuccessfulCollectionAt)
  const lastDetail = last ? ` Last successful collection: ${last}.` : ' No successful collection time was reported.'
  const counts = Number.isInteger(service.successfulCollectors) && Number.isInteger(service.expectedCollectors)
    && (service.successfulCollectors as number) >= 0 && (service.expectedCollectors as number) >= (service.successfulCollectors as number)
    ? ` ${(service.successfulCollectors as number)}/${service.expectedCollectors as number} expected collectors succeeded within their freshness window.`
    : ''
  const permissionRequired = typeof service.permissionRequiredCollectors === 'number' && service.permissionRequiredCollectors > 0
  const failed = typeof service.failedCollectors === 'number' && service.failedCollectors > 0

  if (status === 'UNKNOWN' && service.expectedCollectors === 0) {
    const notLicensed = typeof service.notLicensedCollectors === 'number' && service.notLicensedCollectors > 0
    const unsupported = typeof service.unsupportedCollectors === 'number' && service.unsupportedCollectors > 0
    if (notLicensed && unsupported) {
      return { label: 'Not eligible', detail: 'Reported licensing and support limits exclude all collectors in this service. This is not a tenant-wide connection failure.', tone: 'neutral' }
    }
    if (notLicensed) {
      return { label: 'Not licensed', detail: 'No collector in this service is currently eligible under the reported Microsoft licensing. This is not a tenant-wide connection failure.', tone: 'neutral' }
    }
    if (unsupported) {
      return { label: 'Unsupported', detail: 'No collector in this service is supported for this tenant. This is not a tenant-wide connection failure.', tone: 'neutral' }
    }
  }

  if (status === 'RUNNING') return { label: 'Syncing', detail: `A collection is running; displayed data may be from before it started.${lastDetail}`, tone: 'neutral' }
  if (status === 'FAILED' && permissionRequired && !failed) return { label: 'Access needed', detail: `At least one service collector needs Microsoft permission.${lastDetail} This does not establish a tenant-wide connection failure.`, tone: 'attention' }
  if (status === 'FAILED') return { label: 'Collection failed', detail: `A service collection attempt failed.${lastDetail} This does not by itself establish a tenant-wide connection failure.`, tone: 'attention' }
  if (status === 'PARTIAL' && permissionRequired) return { label: 'Partial · access needed', detail: `Collection is partial and at least one service collector needs Microsoft permission.${lastDetail}${counts} This does not establish a tenant-wide connection failure.`, tone: 'attention' }
  if (status === 'PARTIAL') return { label: 'Partial', detail: `Some service collectors have not completed successfully.${lastDetail}${counts} Inspect collection details for the cause.`, tone: 'attention' }
  if (status === 'STALE' || freshness === 'STALE') return { label: 'Stale', detail: `Some service data is older than its collection window.${lastDetail}${counts}`, tone: 'attention' }
  if (status === 'NOT_COLLECTED') return { label: 'Not collected', detail: 'No collector state was recorded for this service. This is not an empty or healthy result.', tone: 'neutral' }
  if (status === 'PENDING') return { label: 'Pending', detail: 'Service collection has not completed. This is not an empty or healthy result.', tone: 'neutral' }
  if (status === 'SUCCESS' && last) {
    if (freshness === 'CURRENT') return { label: 'Collected', detail: `Expected collectors succeeded within their current windows.${lastDetail}${counts} This does not establish payload completeness or absence of security findings.`, tone: 'ok' }
    if (freshness === 'AGING') return { label: 'Aging', detail: `Expected collectors succeeded, but some data is older than its usual interval.${lastDetail}${counts}`, tone: 'neutral' }
  }
  return { label: 'Status unavailable', detail: 'The reported service status or timestamp cannot establish current collection.', tone: 'neutral' }
}
