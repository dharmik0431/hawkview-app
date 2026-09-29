/** Display-time age is separate from evidence availability and collection health. */
export interface DatasetAgeEvidence {
  source: string
  observedAt: unknown
  reportDate?: unknown
  emptyVerified?: boolean
}

export const OUTDATED_AFTER_MS = 6 * 60 * 60 * 1000
export const AGE_REFRESH_MS = 60 * 1000

/** Check the supplied wall-clock components before Date.parse normalizes them.
 * Comparing the resulting UTC date to the input would reject valid offsets. */
function observationInstant(value: unknown): number {
  if (typeof value !== 'string') return NaN
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!parts) return NaN
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = parts
  const year = Number(yearText), month = Number(monthText), day = Number(dayText)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
      Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return NaN
  return Date.parse(value)
}

export function datasetAge(evidence: DatasetAgeEvidence, now: number) {
  const at = observationInstant(evidence.observedAt)
  if (!Number.isFinite(now) || !Number.isFinite(at) || at > now) {
    return { label: 'Update time unavailable', outdated: false, timestamp: null }
  }
  const minutes = Math.floor((now - at) / 60000)
  const amount = minutes < 60 ? minutes : minutes < 1440 ? Math.floor(minutes / 60) : Math.floor(minutes / 1440)
  const unit = minutes < 60 ? 'minute' : minutes < 1440 ? 'hour' : 'day'
  return {
    label: minutes === 0 ? 'Updated less than a minute ago' : `Updated ${amount} ${unit}${amount === 1 ? '' : 's'} ago`,
    outdated: now - at >= OUTDATED_AFTER_MS,
    timestamp: new Date(at).toISOString(),
  }
}

type Bundle = Record<string, any> | null | undefined
const unavailable = (source: string): DatasetAgeEvidence => ({ source, observedAt: null })
function snapshot(bundle: Bundle, key: string, source: string, rows?: unknown): DatasetAgeEvidence {
  const entry = bundle?.sync?.[key]
  return { source, observedAt: entry?.lastSuccessfulAt,
    emptyVerified: Array.isArray(rows) && ['success', 'succeeded'].includes(String(entry?.status).toLowerCase()) }
}

// Each adapter follows the section's selected rows. No service-wide clock is used.
export function applicationsAge(bundle: Bundle): DatasetAgeEvidence {
  return snapshot(bundle, 'applications', 'App registrations', bundle?.entra?.appRegistrations || bundle?.entra?.applications || bundle?.appRegistrations || bundle?.applications)
}
export function servicePrincipalsAge(bundle: Bundle): DatasetAgeEvidence {
  return snapshot(bundle, 'servicePrincipals', 'Enterprise applications', bundle?.entra?.enterpriseApplications || bundle?.entra?.servicePrincipals || bundle?.enterpriseApplications || bundle?.servicePrincipals)
}
export function groupsAge(bundle: Bundle): DatasetAgeEvidence {
  // Exchange groups are a projection of the same directoryGroups dataset.
  return snapshot(bundle, 'groups', 'Groups', bundle?.entra?.groups || bundle?.exchange?.groups || bundle?.groups)
}
export function licensesAge(bundle: Bundle, rows: unknown): DatasetAgeEvidence {
  return Array.isArray(rows) && rows === bundle?.licenses?.rows
    ? snapshot(bundle, 'licenses', 'License inventory', rows) : unavailable('License inventory')
}
export function conditionalAccessAge(evidence: Bundle): DatasetAgeEvidence {
  const selected = evidence?.conditionalAccess
  return { source: 'Conditional Access', observedAt: selected?.observedAt,
    emptyVerified: selected?.availability === 'READY' && selected?.count === 0 }
}
export function selectedDnsRecord(dns: Bundle, domain: string): Bundle {
  const key = domain.toLowerCase()
  const selected = dns?.byDomain?.[key] ?? dns?.byDomain?.[domain]
  if (selected) return selected
  return typeof dns?.domain === 'string' && dns.domain.toLowerCase() === key ? dns : null
}
export function dnsAge(dns: Bundle, domain: string): DatasetAgeEvidence {
  return { source: `DNS for ${domain}`, observedAt: selectedDnsRecord(dns, domain)?.checkedAt }
}
// These contracts lack timestamps for every displayed dataset. Do not substitute
// a recent service success, event occurrence date, or report download time.
export const entraOverviewAge = (): DatasetAgeEvidence => unavailable('Identity overview')
export const licenseActivityAge = (): DatasetAgeEvidence => unavailable('License activity')
export const sharePointAge = (): DatasetAgeEvidence => unavailable('SharePoint and OneDrive overview')

export function sharePointReportAge(view: Bundle): DatasetAgeEvidence {
  // Legacy view models may take the newest row date. Only the canonical report
  // envelope identifies an observation date for the report as a whole.
  const reported = view?.contractPresent ? view?.usageReport?.reportRefreshedAt : null
  return { source: 'SharePoint usage report', observedAt: reported, reportDate: reported }
}
export const sharePointSettingsAge = (): DatasetAgeEvidence => unavailable('SharePoint tenant settings')

/** A calendar date is useful evidence, but cannot support an hourly age. */
export function datasetReportDate(evidence: DatasetAgeEvidence, now: number): string | null {
  const date = evidence.reportDate
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(now)) return null
  const at = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== date || date > new Date(now).toISOString().slice(0, 10)) return null
  return `Report dated ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(at)}`
}

export const exchangeAge = (): DatasetAgeEvidence => unavailable('Exchange workspace')
export function signInsAge(selected: Bundle): DatasetAgeEvidence {
  const source = selected?.selectedSource
  return { source: source === 'OFFICE_365_ACTIVITY_FEED' ? 'Microsoft 365 sign-in activity' : 'Sign-in activity',
    observedAt: source === 'OFFICE_365_ACTIVITY_FEED' || source === 'MICROSOFT_GRAPH' ? selected?.observedAt : null }
}
export function activityLogsAge(bundle: Bundle, tab: 'signins' | 'audit'): DatasetAgeEvidence {
  // The activity route lacks selected sign-in source metadata. A Graph success
  // must not date fallback rows. Directory audit has its own durable snapshot.
  return tab === 'signins' ? unavailable('Sign-in activity') : snapshot(bundle, 'auditLogs', 'Directory audit', bundle?.auditLogs)
}
