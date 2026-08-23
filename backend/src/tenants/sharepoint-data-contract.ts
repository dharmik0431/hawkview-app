export const SHAREPOINT_DATA_CONTRACT_VERSION = 2 as const
export const SHAREPOINT_USAGE_OBSERVATION_DAYS = 180 as const
export const ONEDRIVE_USAGE_OBSERVATION_DAYS = 30 as const
export const MICROSOFT_USAGE_REPORT_PROJECTION_VERSION = 1 as const
export const MICROSOFT_USAGE_REPORT_DATASET = 'microsoft-usage-reports-v2' as const
export const SHAREPOINT_CONTRACT_LIMITS = Object.freeze({
  sites: 10_000,
  sharePointUsageRows: 20_000,
  oneDriveUsageRows: 20_000,
  settingListItems: 1_000,
  siteIdParts: 8,
  textLength: 512,
  urlLength: 2_048,
  count: 1_000_000_000_000,
  bytes: 1024 ** 5,
  seconds: 366 * 24 * 60 * 60,
  retentionDays: 36_600,
})

type JsonRecord = Record<string, unknown>
export type MicrosoftUsageReportPeriod = 'D180' | 'D30'
export type MicrosoftUsageSourceProjectionEvidence =
  | { state: 'AUTHORITATIVE_COMPLETE'; reasonCode: null }
  | { state: 'PARTIAL'; reasonCode: 'USAGE_PROJECTION_EVIDENCE_INCOMPLETE' }
  | { state: 'UNVERIFIED_LEGACY'; reasonCode: 'USAGE_PROJECTION_NOT_DURABLY_VERIFIED' }
  | { state: 'REJECTED'; reasonCode: 'USAGE_PROJECTION_EVIDENCE_INVALID' }

export type MicrosoftUsageProjectionEvidence = MicrosoftUsageSourceProjectionEvidence & {
  sharePoint: MicrosoftUsageSourceProjectionEvidence
  oneDrive: MicrosoftUsageSourceProjectionEvidence
}

export type SharePointDataContractInput = {
  sites: unknown
  settings: unknown
  sharePointUsage: unknown
  oneDriveUsage: unknown
  settingsSynchronized: boolean
  usageSynchronized: boolean
  activityAsOf: Date
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function own(record: JsonRecord | null | undefined, key: string) {
  return record && Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined
}

function secretShaped(value: string) {
  return (
    /\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization|api[_-]?key|sig)\b\s*[:=]/i.test(value) ||
    /\bbearer\s+[a-z0-9._~-]+/i.test(value) ||
    /eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}/i.test(value) ||
    /https:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value) ||
    /^\s*[{[]?\s*["']?(?:error|exception|stack|raw)["']?\s*:/i.test(value)
  )
}

function safeText(value: unknown, max: number = SHAREPOINT_CONTRACT_LIMITS.textLength) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (
    !normalized ||
    normalized.length > max ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    secretShaped(normalized)
  ) return null
  return normalized
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  const text = safeText(value, 128)
  return text && (allowed as readonly string[]).includes(text)
    ? (text as T[number])
    : null
}

function optionalBoolean(value: unknown) {
  return typeof value === 'boolean' ? value : null
}

function unsignedInteger(value: unknown, max: number) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'string' && (!/^\d+$/.test(value.trim()) || value.trim().length > 18)) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : null
}

function reportDeleted(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return null
}

function bytesToGigabytes(value: unknown) {
  const bytes = unsignedInteger(value, SHAREPOINT_CONTRACT_LIMITS.bytes)
  return bytes === null ? null : Math.round((bytes / 1024 ** 3) * 100) / 100
}

function megabytesToGigabytes(value: unknown) {
  const megabytes = unsignedInteger(value, SHAREPOINT_CONTRACT_LIMITS.bytes / 1024 ** 2)
  return megabytes === null ? null : Math.round((megabytes / 1024) * 100) / 100
}

function utilizationPercent(used: unknown, allocated: unknown) {
  const usedBytes = unsignedInteger(used, SHAREPOINT_CONTRACT_LIMITS.bytes)
  const allocatedBytes = unsignedInteger(allocated, SHAREPOINT_CONTRACT_LIMITS.bytes)
  if (usedBytes === null || allocatedBytes === null || allocatedBytes === 0) return null
  const percent = Math.round((usedBytes / allocatedBytes) * 10_000) / 100
  return percent <= 10_000 ? percent : null
}

function calendarDate(value: unknown, notAfter?: Date) {
  const text = safeText(value, 10)
  const match = text?.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null
  if (notAfter) {
    const upper = new Date(Date.UTC(notAfter.getUTCFullYear(), notAfter.getUTCMonth(), notAfter.getUTCDate()))
    if (parsed.getTime() > upper.getTime()) return null
  }
  return { text, date: parsed }
}

function isoTimestamp(value: unknown) {
  const text = safeText(value, 64)
  if (!text || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)) return null
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function normalizedSharePointUrl(value: unknown) {
  const text = safeText(value, SHAREPOINT_CONTRACT_LIMITS.urlLength)
  if (!text) return null
  try {
    const url = new URL(text)
    if (
      url.protocol !== 'https:' || url.username || url.password || url.search ||
      url.hash || url.port || !url.hostname.toLowerCase().endsWith('.sharepoint.com')
    ) return null
    return url.toString().replace(/\/$/, '').toLowerCase()
  } catch {
    return null
  }
}

function normalizedSiteId(value: unknown) {
  const text = safeText(value, 512)
  if (!text || !/^[a-z0-9,{}-]+$/i.test(text)) return null
  return text.toLowerCase().replace(/[{}]/g, '')
}

function domainName(value: unknown) {
  const text = safeText(value, 253)?.toLowerCase()
  return text && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(text) ? text : null
}

function guid(value: unknown) {
  const text = safeText(value, 36)?.toLowerCase()
  return text && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text) ? text : null
}

function managedPath(value: unknown) {
  const text = safeText(value, 128)
  if (!text || !/^\/[A-Za-z0-9._~/-]*$/.test(text) || text.includes('..') || text.includes('//') || text.includes('\\')) return null
  return text
}

function timeZone(value: unknown) {
  const text = safeText(value, 128)
  return text && /^[A-Za-z0-9 _()+,./-]+$/.test(text) ? text : null
}

function boundedList(value: unknown, validator: (item: unknown) => string | null) {
  if (!Array.isArray(value)) return { values: [] as string[], truncated: false, invalidItems: 0 }
  const limited = value.slice(0, SHAREPOINT_CONTRACT_LIMITS.settingListItems)
  const values: string[] = []
  let invalidItems = 0
  for (const item of limited) {
    const normalized = validator(item)
    if (!normalized) {
      invalidItems += 1
      continue
    }
    if (!values.includes(normalized)) values.push(normalized)
  }
  return { values, truncated: value.length > limited.length, invalidItems }
}

function boundedRecords(value: unknown, limit: number) {
  if (!Array.isArray(value)) {
    return { rows: [] as JsonRecord[], inputRows: 0, invalidRows: value == null ? 0 : 1, truncated: false }
  }
  const rows: JsonRecord[] = []
  let invalidRows = 0
  for (const item of value.slice(0, limit)) {
    if (isPlainRecord(item)) rows.push(item)
    else invalidRows += 1
  }
  return { rows, inputRows: value.length, invalidRows, truncated: value.length > limit }
}

/**
 * Microsoft report requests use D-prefixed periods, while report exports can
 * represent the same period as either `D180`/`D30` or `180`/`30`. Accept only
 * those exact Microsoft-shaped representations and return the code-owned
 * requested value. Arbitrary row text can never select a different period.
 */
export function canonicalMicrosoftUsageReportPeriod(
  value: unknown,
  expected: MicrosoftUsageReportPeriod,
) {
  const raw =
    typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : safeText(value, 4)?.toUpperCase()
  return raw === expected || raw === expected.slice(1) ? expected : null
}

export function normalizeMicrosoftUsageReportRows(
  value: unknown,
  expected: MicrosoftUsageReportPeriod,
) {
  const limit = expected === 'D180'
    ? SHAREPOINT_CONTRACT_LIMITS.sharePointUsageRows
    : SHAREPOINT_CONTRACT_LIMITS.oneDriveUsageRows
  const input = boundedRecords(value, limit)
  if (input.truncated || input.invalidRows > 0) {
    throw new Error(`Microsoft ${expected} usage report exceeded HawkView's safe row contract.`)
  }
  return input.rows.map((row) => {
    if (!canonicalMicrosoftUsageReportPeriod(own(row, 'Report Period'), expected)) {
      throw new Error(`Microsoft ${expected} usage report returned an unexpected Report Period.`)
    }
    return { ...row, 'Report Period': expected }
  })
}

function usageRowIdentity(row: JsonRecord, source: 'sharePoint' | 'oneDrive') {
  const siteId = normalizedSiteId(own(row, 'Site Id'))
  if (siteId) return `site:${siteId}`
  const url = normalizedSharePointUrl(own(row, 'Site URL'))
  if (url) return `url:${url}`
  if (source === 'oneDrive') {
    const upn = safeText(own(row, 'Owner Principal Name'), 320)?.toLowerCase()
    if (upn) return `upn:${upn}`
  }
  return null
}

function coherentUsageRows(
  rows: JsonRecord[],
  expected: MicrosoftUsageReportPeriod,
  source: 'sharePoint' | 'oneDrive',
  asOf: Date,
) {
  if (rows.length === 0) return false
  const refreshDates = new Set<string>()
  const identities = new Set<string>()
  for (const row of rows) {
    if (canonicalMicrosoftUsageReportPeriod(own(row, 'Report Period'), expected) !== expected) return false
    if (!validReportDates(row, asOf)) return false
    const refresh = calendarDate(own(row, 'Report Refresh Date'), asOf)?.text
    const identity = usageRowIdentity(row, source)
    if (!refresh || !identity || identities.has(identity)) return false
    refreshDates.add(refresh)
    identities.add(identity)
  }
  return refreshDates.size === 1
}

export function buildMicrosoftUsageReportSnapshot(
  sharePointUsage: unknown,
  oneDriveUsage: unknown,
) {
  const sharePointSites = normalizeMicrosoftUsageReportRows(sharePointUsage, 'D180')
  const oneDriveAccounts = normalizeMicrosoftUsageReportRows(oneDriveUsage, 'D30')
  const activityAsOf = new Date()
  const sharePointEvidenceComplete = coherentUsageRows(sharePointSites, 'D180', 'sharePoint', activityAsOf)
  const oneDriveEvidenceComplete = coherentUsageRows(oneDriveAccounts, 'D30', 'oneDrive', activityAsOf)
  const projectionState =
    sharePointEvidenceComplete && oneDriveEvidenceComplete
      ? 'AUTHORITATIVE_COMPLETE'
      : 'PARTIAL'
  return [{
    hawkviewDataset: MICROSOFT_USAGE_REPORT_DATASET,
    projectionEvidence: {
      version: MICROSOFT_USAGE_REPORT_PROJECTION_VERSION,
      state: projectionState,
      sharePoint: {
        state: sharePointEvidenceComplete ? 'AUTHORITATIVE_COMPLETE' : 'PARTIAL',
        requestedPeriod: 'D180',
        rowCount: sharePointSites.length,
      },
      oneDrive: {
        state: oneDriveEvidenceComplete ? 'AUTHORITATIVE_COMPLETE' : 'PARTIAL',
        requestedPeriod: 'D30',
        rowCount: oneDriveAccounts.length,
      },
    },
    sharePointSites,
    oneDriveAccounts,
  }]
}

/**
 * Bounded readiness verification of the collector stamp and the exact row
 * period/date invariants it attests. Older payloads remain usable by the
 * tenant bundle, but are not promoted to durably verified readiness until the
 * normal collector refreshes them.
 */
export function inspectMicrosoftUsageProjectionEvidence(
  payload: unknown,
): MicrosoftUsageProjectionEvidence {
  const rejected: MicrosoftUsageSourceProjectionEvidence = {
    state: 'REJECTED', reasonCode: 'USAGE_PROJECTION_EVIDENCE_INVALID',
  }
  const legacy: MicrosoftUsageSourceProjectionEvidence = {
    state: 'UNVERIFIED_LEGACY', reasonCode: 'USAGE_PROJECTION_NOT_DURABLY_VERIFIED',
  }
  const rejectAll = (): MicrosoftUsageProjectionEvidence => ({ ...rejected, sharePoint: rejected, oneDrive: rejected })
  if (!Array.isArray(payload) || payload.length !== 1) {
    return rejectAll()
  }
  const envelope = isPlainRecord(payload[0]) ? payload[0] : null
  if (!envelope) {
    return rejectAll()
  }
  if (own(envelope, 'hawkviewDataset') === 'microsoft-usage-reports-v1') {
    return { ...legacy, sharePoint: legacy, oneDrive: legacy }
  }
  if (own(envelope, 'hawkviewDataset') !== MICROSOFT_USAGE_REPORT_DATASET) {
    return rejectAll()
  }
  const evidenceValue = own(envelope, 'projectionEvidence')
  const evidence = isPlainRecord(evidenceValue) ? evidenceValue : null
  const sharePointValue = evidence ? own(evidence, 'sharePoint') : null
  const oneDriveValue = evidence ? own(evidence, 'oneDrive') : null
  const sharePoint = isPlainRecord(sharePointValue) ? sharePointValue : null
  const oneDrive = isPlainRecord(oneDriveValue) ? oneDriveValue : null
  const sharePointRows = own(envelope, 'sharePointSites')
  const oneDriveRows = own(envelope, 'oneDriveAccounts')
  const globalEvidenceValid =
    own(evidence ?? undefined, 'version') === MICROSOFT_USAGE_REPORT_PROJECTION_VERSION &&
    ['AUTHORITATIVE_COMPLETE', 'PARTIAL'].includes(String(own(evidence ?? undefined, 'state'))) &&
    Array.isArray(sharePointRows) &&
    Array.isArray(oneDriveRows) &&
    sharePointRows.length <= SHAREPOINT_CONTRACT_LIMITS.sharePointUsageRows &&
    oneDriveRows.length <= SHAREPOINT_CONTRACT_LIMITS.oneDriveUsageRows
  if (!globalEvidenceValid) {
    return rejectAll()
  }
  const now = new Date()
  const complete: MicrosoftUsageSourceProjectionEvidence = { state: 'AUTHORITATIVE_COMPLETE', reasonCode: null }
  const partial: MicrosoftUsageSourceProjectionEvidence = {
    state: 'PARTIAL', reasonCode: 'USAGE_PROJECTION_EVIDENCE_INCOMPLETE',
  }
  const sourceResult = (
    sourceEvidence: JsonRecord | null,
    rows: unknown[],
    expected: MicrosoftUsageReportPeriod,
    source: 'sharePoint' | 'oneDrive',
    limit: number,
  ): MicrosoftUsageSourceProjectionEvidence => {
    const structural =
      ['AUTHORITATIVE_COMPLETE', 'PARTIAL'].includes(String(own(sourceEvidence ?? undefined, 'state'))) &&
      own(sourceEvidence ?? undefined, 'requestedPeriod') === expected &&
      unsignedInteger(own(sourceEvidence ?? undefined, 'rowCount'), limit) === rows.length &&
      rows.every(isPlainRecord)
    if (!structural) return rejected
    const sourceComplete = coherentUsageRows(rows as JsonRecord[], expected, source, now)
    const stampedComplete = own(sourceEvidence ?? undefined, 'state') === 'AUTHORITATIVE_COMPLETE'
    if (sourceComplete !== stampedComplete) return rejected
    return sourceComplete ? complete : partial
  }
  const sharePointResult = sourceResult(sharePoint, sharePointRows, 'D180', 'sharePoint', SHAREPOINT_CONTRACT_LIMITS.sharePointUsageRows)
  const oneDriveResult = sourceResult(oneDrive, oneDriveRows, 'D30', 'oneDrive', SHAREPOINT_CONTRACT_LIMITS.oneDriveUsageRows)
  const sharePointComplete = sharePointResult.state === 'AUTHORITATIVE_COMPLETE'
  const oneDriveComplete = oneDriveResult.state === 'AUTHORITATIVE_COMPLETE'
  const projectionComplete = sharePointComplete && oneDriveComplete
  const anyRejected = sharePointResult.state === 'REJECTED' || oneDriveResult.state === 'REJECTED'
  const aggregateState = anyRejected ? 'REJECTED' : projectionComplete ? 'AUTHORITATIVE_COMPLETE' : 'PARTIAL'
  const aggregateStampValid = own(evidence ?? undefined, 'state') === (projectionComplete ? 'AUTHORITATIVE_COMPLETE' : 'PARTIAL')
  return aggregateState === 'AUTHORITATIVE_COMPLETE' && aggregateStampValid
    ? { ...complete, sharePoint: sharePointResult, oneDrive: oneDriveResult }
    : aggregateState === 'PARTIAL' && aggregateStampValid
      ? { ...partial, sharePoint: sharePointResult, oneDrive: oneDriveResult }
      : { ...rejected, sharePoint: sharePointResult, oneDrive: oneDriveResult }
}

function expectedPeriod(row: JsonRecord, expected: 'D180' | 'D30') {
  return canonicalMicrosoftUsageReportPeriod(own(row, 'Report Period'), expected) === expected
}

function validReportDates(row: JsonRecord, asOf: Date) {
  const refresh = calendarDate(own(row, 'Report Refresh Date'), asOf)
  if (!refresh) return false
  const activity = own(row, 'Last Activity Date')
  if (activity === '' || activity === null || activity === undefined) return true
  return Boolean(calendarDate(activity, refresh.date))
}

function latestRefreshDate(rows: JsonRecord[], asOf: Date) {
  return rows
    .map((row) => calendarDate(own(row, 'Report Refresh Date'), asOf)?.text)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null
}

function reportActivity(row: JsonRecord | undefined, asOf: Date) {
  if (!row) return { lastActivityAt: null, activityAgeDays: null, activityState: 'unavailable' as const }
  const refresh = calendarDate(own(row, 'Report Refresh Date'), asOf)
  if (!refresh) return { lastActivityAt: null, activityAgeDays: null, activityState: 'report-refresh-unavailable' as const }
  const rawActivity = own(row, 'Last Activity Date')
  if (rawActivity === '' || rawActivity === null || rawActivity === undefined) {
    return { lastActivityAt: null, activityAgeDays: null, activityState: 'not-reported-by-microsoft' as const }
  }
  const activity = calendarDate(rawActivity, refresh.date)
  if (!activity) return { lastActivityAt: null, activityAgeDays: null, activityState: 'invalid-or-inconsistent-report-date' as const }
  return {
    lastActivityAt: activity.text,
    activityAgeDays: Math.floor((refresh.date.getTime() - activity.date.getTime()) / 86_400_000),
    activityState: 'reported' as const,
  }
}

function siteType(site: JsonRecord, usage: JsonRecord | undefined) {
  const template = safeText(own(usage, 'Root Web Template'), 128)?.toUpperCase() ?? ''
  const url = normalizedSharePointUrl(own(site, 'webUrl')) ?? ''
  if (url.includes('-my.sharepoint.com/personal/')) return 'OneDrive'
  if (template.includes('SITEPAGEPUBLISHING')) return 'Communication site'
  if (template.includes('GROUP')) return 'Microsoft 365 group site'
  return 'SharePoint site'
}

function projectTenantSettings(settings: unknown, synchronized: boolean) {
  const value = synchronized && isPlainRecord(settings) ? settings : null
  const allowedDomains = boundedList(own(value, 'sharingAllowedDomainList'), domainName)
  const blockedDomains = boundedList(own(value, 'sharingBlockedDomainList'), domainName)
  const availablePaths = boundedList(own(value, 'availableManagedPathsForSiteCreation'), managedPath)
  const allowedSyncDomains = boundedList(own(value, 'allowedDomainGuidsForSyncApp'), guid)
  const excludedExtensions = boundedList(own(value, 'excludedFileExtensionsForSyncApp'), (item) => {
    const text = safeText(item, 32)?.toLowerCase()
    return text && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(text) ? text : null
  })
  const idleValue = own(value, 'idleSessionSignOut')
  const idleSession = isPlainRecord(idleValue) ? idleValue : null
  return {
    state: value ? ('available' as const) : ('unavailable' as const),
    source: 'Microsoft Graph /admin/sharepoint/settings',
    scope: 'SharePoint and OneDrive tenant settings',
    externalSharing: {
      capability: enumValue(own(value, 'sharingCapability'), [
        'disabled', 'externalUserSharingOnly', 'externalUserAndGuestSharing', 'existingExternalUserSharingOnly',
      ] as const),
      appliesTo: 'SharePoint and OneDrive' as const,
      domainRestrictionMode: enumValue(own(value, 'sharingDomainRestrictionMode'), ['none', 'allowList', 'blockList'] as const),
      allowedDomains: allowedDomains.values,
      blockedDomains: blockedDomains.values,
      requireAcceptingUserToMatchInvitedUser: optionalBoolean(own(value, 'isRequireAcceptingUserToMatchInvitedUserEnabled')),
      externalUserResharingEnabled: optionalBoolean(own(value, 'isResharingByExternalUsersEnabled')),
    },
    accessAndSession: {
      legacyAuthProtocolsEnabled: optionalBoolean(own(value, 'isLegacyAuthProtocolsEnabled')),
      idleSessionSignOut: {
        enabled: optionalBoolean(own(idleSession, 'isEnabled')),
        warnAfterSeconds: unsignedInteger(own(idleSession, 'warnAfterInSeconds'), SHAREPOINT_CONTRACT_LIMITS.seconds),
        signOutAfterSeconds: unsignedInteger(own(idleSession, 'signOutAfterInSeconds'), SHAREPOINT_CONTRACT_LIMITS.seconds),
      },
    },
    storageAndLifecycle: {
      siteStorageLimitsAutomatic: optionalBoolean(own(value, 'isSitesStorageLimitAutomatic')),
      defaultSiteStorageLimitGB: megabytesToGigabytes(own(value, 'siteCreationDefaultStorageLimitInMB')),
      defaultOneDriveStorageLimitGB: megabytesToGigabytes(own(value, 'personalSiteDefaultStorageLimitInMB')),
      deletedUserOneDriveRetentionDays: unsignedInteger(own(value, 'deletedUserPersonalSiteRetentionPeriodInDays'), SHAREPOINT_CONTRACT_LIMITS.retentionDays),
    },
    siteCreation: {
      enabled: optionalBoolean(own(value, 'isSiteCreationEnabled')),
      uiEnabled: optionalBoolean(own(value, 'isSiteCreationUIEnabled')),
      pagesCreationEnabled: optionalBoolean(own(value, 'isSitePagesCreationEnabled')),
      defaultManagedPath: managedPath(own(value, 'siteCreationDefaultManagedPath')),
      availableManagedPaths: availablePaths.values,
    },
    collaborationAndContent: {
      commentingOnSitePagesEnabled: optionalBoolean(own(value, 'isCommentingOnSitePagesEnabled')),
      loopEnabled: optionalBoolean(own(value, 'isLoopEnabled')),
      imageTaggingOption: enumValue(own(value, 'imageTaggingOption'), ['disabled', 'basic', 'enhanced'] as const),
    },
    sync: {
      allowedDomainGuids: allowedSyncDomains.values,
      excludedFileExtensions: excludedExtensions.values,
      macSyncAppEnabled: optionalBoolean(own(value, 'isMacSyncAppEnabled')),
      personalSiteSyncButtonHidden: optionalBoolean(own(value, 'isSyncButtonHiddenOnPersonalSite')),
      unmanagedSyncAppRestricted: optionalBoolean(own(value, 'isUnmanagedSyncAppForTenantRestricted')),
    },
    notifications: {
      fileActivityEnabled: optionalBoolean(own(value, 'isFileActivityNotificationEnabled')),
      mobileEnabled: optionalBoolean(own(value, 'isSharePointMobileNotificationEnabled')),
      newsfeedEnabled: optionalBoolean(own(value, 'isSharePointNewsfeedEnabled')),
    },
    tenantDefaultTimezone: timeZone(own(value, 'tenantDefaultTimezone')),
    listProjection: {
      allowedDomainsTruncated: allowedDomains.truncated,
      blockedDomainsTruncated: blockedDomains.truncated,
      availableManagedPathsTruncated: availablePaths.truncated,
      allowedDomainGuidsTruncated: allowedSyncDomains.truncated,
      excludedFileExtensionsTruncated: excludedExtensions.truncated,
      invalidItemsDropped: allowedDomains.invalidItems + blockedDomains.invalidItems + availablePaths.invalidItems + allowedSyncDomains.invalidItems + excludedExtensions.invalidItems,
    },
  }
}

function sumKnown(rows: JsonRecord[], key: string) {
  if (rows.length === 0) return null
  let total = 0
  for (const row of rows) {
    const value = unsignedInteger(own(row, key), SHAREPOINT_CONTRACT_LIMITS.bytes)
    if (value === null || total > SHAREPOINT_CONTRACT_LIMITS.bytes - value) return null
    total += value
  }
  return total
}

export function buildSharePointDataContract(input: SharePointDataContractInput) {
  const activityAsOf = input.activityAsOf instanceof Date && Number.isFinite(input.activityAsOf.getTime())
    ? input.activityAsOf
    : new Date(0)
  const siteInput = boundedRecords(input.sites, SHAREPOINT_CONTRACT_LIMITS.sites)
  const sharePointInput = boundedRecords(input.sharePointUsage, SHAREPOINT_CONTRACT_LIMITS.sharePointUsageRows)
  const oneDriveInput = boundedRecords(input.oneDriveUsage, SHAREPOINT_CONTRACT_LIMITS.oneDriveUsageRows)
  const sharePointPeriodRows = sharePointInput.rows.filter((row) => expectedPeriod(row, 'D180'))
  const oneDrivePeriodRows = oneDriveInput.rows.filter((row) => expectedPeriod(row, 'D30'))
  const invalidSharePointPeriodRows = sharePointInput.rows.length - sharePointPeriodRows.length
  const invalidOneDrivePeriodRows = oneDriveInput.rows.length - oneDrivePeriodRows.length
  const sharePointRows = sharePointPeriodRows.filter((row) => validReportDates(row, activityAsOf))
  const oneDriveRows = oneDrivePeriodRows.filter((row) => validReportDates(row, activityAsOf))
  const invalidSharePointDateRows = sharePointPeriodRows.length - sharePointRows.length
  const invalidOneDriveDateRows = oneDrivePeriodRows.length - oneDriveRows.length
  const sharePointProjectionComplete = input.usageSynchronized && !sharePointInput.truncated && sharePointInput.invalidRows === 0 && invalidSharePointPeriodRows === 0 && invalidSharePointDateRows === 0 && coherentUsageRows(sharePointRows, 'D180', 'sharePoint', activityAsOf)
  const oneDriveProjectionComplete = input.usageSynchronized && !oneDriveInput.truncated && oneDriveInput.invalidRows === 0 && invalidOneDrivePeriodRows === 0 && invalidOneDriveDateRows === 0 && coherentUsageRows(oneDriveRows, 'D30', 'oneDrive', activityAsOf)

  const usageByUrl = new Map<string, JsonRecord>()
  const usageBySiteId = new Map<string, JsonRecord>()
  for (const row of sharePointRows) {
    const url = normalizedSharePointUrl(own(row, 'Site URL'))
    const id = normalizedSiteId(own(row, 'Site Id'))
    if (url && !usageByUrl.has(url)) usageByUrl.set(url, row)
    if (id && !usageBySiteId.has(id)) usageBySiteId.set(id, row)
  }
  const usageForSite = (site: JsonRecord) => {
    const url = normalizedSharePointUrl(own(site, 'webUrl'))
    if (url && usageByUrl.has(url)) return usageByUrl.get(url)
    const id = normalizedSiteId(own(site, 'id'))
    if (!id) return undefined
    for (const part of id.split(',').slice(0, SHAREPOINT_CONTRACT_LIMITS.siteIdParts)) {
      const match = usageBySiteId.get(part)
      if (match) return match
    }
    return undefined
  }
  const matchedSharePointUsageRows = new Set(siteInput.rows.map(usageForSite).filter((row): row is JsonRecord => Boolean(row)))
  const sharePointRowsWithActivity = sharePointRows.filter((row) => Boolean(calendarDate(own(row, 'Last Activity Date'), activityAsOf)))
  const sharePointIdentifiersConcealed = sharePointRowsWithActivity.length > 0 && matchedSharePointUsageRows.size === 0

  const sites = siteInput.rows.map((site, index) => {
    const usage = usageForSite(site)
    const driveQuotaValue = own(site, 'driveQuota')
    const driveQuota = isPlainRecord(driveQuotaValue) ? driveQuotaValue : null
    const used = own(usage, 'Storage Used (Byte)')
    const allocated = own(usage, 'Storage Allocated (Byte)')
    return {
      id: normalizedSiteId(own(site, 'id')) ?? `sharepoint-site-${index}`,
      name: safeText(own(site, 'displayName')) ?? safeText(own(site, 'name')) ?? 'Unnamed SharePoint site',
      url: normalizedSharePointUrl(own(site, 'webUrl')),
      type: siteType(site, usage),
      description: safeText(own(site, 'description')),
      createdAt: isoTimestamp(own(site, 'createdDateTime')),
      graphLastModifiedAt: isoTimestamp(own(site, 'lastModifiedDateTime')),
      usageReportMatch: usage ? ('matched' as const) : sharePointIdentifiersConcealed ? ('identifiers-concealed' as const) : ('unmatched' as const),
      usage: {
        reportRefreshDate: calendarDate(own(usage, 'Report Refresh Date'), activityAsOf)?.text ?? null,
        reportPeriod: usage ? ('D180' as const) : null,
        microsoftReportedDeleted: usage ? reportDeleted(own(usage, 'Is Deleted')) : null,
        rootWebTemplate: safeText(own(usage, 'Root Web Template'), 128),
        ownerDisplayName: safeText(own(usage, 'Owner Display Name')),
        ownerPrincipalName: safeText(own(usage, 'Owner Principal Name'), 320),
        hasReportedOwner: Boolean(safeText(own(usage, 'Owner Display Name')) || safeText(own(usage, 'Owner Principal Name'), 320)),
        fileCount: unsignedInteger(own(usage, 'File Count'), SHAREPOINT_CONTRACT_LIMITS.count),
        activeFileCount: unsignedInteger(own(usage, 'Active File Count'), SHAREPOINT_CONTRACT_LIMITS.count),
        pageViewCount: unsignedInteger(own(usage, 'Page View Count'), SHAREPOINT_CONTRACT_LIMITS.count),
        visitedPageCount: unsignedInteger(own(usage, 'Visited Page Count'), SHAREPOINT_CONTRACT_LIMITS.count),
        storageUsedGB: bytesToGigabytes(used),
        storageAllocatedGB: bytesToGigabytes(allocated),
        storageUtilizationPercent: utilizationPercent(used, allocated),
        ...reportActivity(usage, activityAsOf),
      },
      bestEffortDefaultDriveQuota: driveQuota ? {
        source: 'Microsoft Graph default drive quota' as const,
        authoritativeForSiteAllocation: false as const,
        usedGB: bytesToGigabytes(own(driveQuota, 'used')),
        totalGB: bytesToGigabytes(own(driveQuota, 'total')),
        remainingGB: bytesToGigabytes(own(driveQuota, 'remaining')),
        deletedGB: bytesToGigabytes(own(driveQuota, 'deleted')),
        state: enumValue(own(driveQuota, 'state'), ['normal', 'nearing', 'critical', 'exceeded'] as const),
      } : null,
      accessMetadata: { state: 'not-collected-least-privilege' as const, reasonCode: 'NOT_COLLECTED_LEAST_PRIVILEGE' as const },
    }
  })

  const oneDriveAccounts = oneDriveRows.map((row, index) => {
    const used = own(row, 'Storage Used (Byte)')
    const allocated = own(row, 'Storage Allocated (Byte)')
    return {
      id: normalizedSiteId(own(row, 'Site Id')) ?? normalizedSharePointUrl(own(row, 'Site URL')) ?? safeText(own(row, 'Owner Principal Name'), 320) ?? `onedrive-account-${index}`,
      url: normalizedSharePointUrl(own(row, 'Site URL')),
      ownerDisplayName: safeText(own(row, 'Owner Display Name')),
      ownerPrincipalName: safeText(own(row, 'Owner Principal Name'), 320),
      microsoftReportedDeleted: reportDeleted(own(row, 'Is Deleted')),
      reportRefreshDate: calendarDate(own(row, 'Report Refresh Date'), activityAsOf)?.text ?? null,
      reportPeriod: 'D30' as const,
      fileCount: unsignedInteger(own(row, 'File Count'), SHAREPOINT_CONTRACT_LIMITS.count),
      activeFileCount: unsignedInteger(own(row, 'Active File Count'), SHAREPOINT_CONTRACT_LIMITS.count),
      storageUsedGB: bytesToGigabytes(used),
      storageAllocatedGB: bytesToGigabytes(allocated),
      storageUtilizationPercent: utilizationPercent(used, allocated),
      ...reportActivity(row, activityAsOf),
    }
  })

  const reportedDeletedSites = sharePointRows.filter((row) => reportDeleted(own(row, 'Is Deleted')) === true).map((row, index) => ({
    id: normalizedSiteId(own(row, 'Site Id')) ?? normalizedSharePointUrl(own(row, 'Site URL')) ?? `reported-deleted-site-${index}`,
    name: safeText(own(row, 'Site Name')) ?? normalizedSharePointUrl(own(row, 'Site URL')) ?? 'Deleted site reported by Microsoft',
    url: normalizedSharePointUrl(own(row, 'Site URL')),
    ownerDisplayName: safeText(own(row, 'Owner Display Name')),
    ownerPrincipalName: safeText(own(row, 'Owner Principal Name'), 320),
    lastActivityAt: reportActivity(row, activityAsOf).lastActivityAt,
    reportRefreshDate: calendarDate(own(row, 'Report Refresh Date'), activityAsOf)?.text ?? null,
    reportPeriod: 'D180' as const,
    source: 'Microsoft Graph SharePoint site usage report' as const,
    evidenceKind: 'reported-deleted-site' as const,
    recoverability: 'not-established' as const,
  }))

  const currentSharePointRows = sharePointRows.filter((row) => reportDeleted(own(row, 'Is Deleted')) === false)
  const currentOneDriveRows = oneDriveRows.filter((row) => reportDeleted(own(row, 'Is Deleted')) === false)
  const sharePointTotalsAuthoritative = sharePointProjectionComplete && sharePointRows.every((row) => reportDeleted(own(row, 'Is Deleted')) !== null)
  const oneDriveTotalsAuthoritative = oneDriveProjectionComplete && oneDriveRows.every((row) => reportDeleted(own(row, 'Is Deleted')) !== null)
  const sharePointActivityCoverageComplete =
    sharePointProjectionComplete &&
    sites.length > 0 &&
    sites.every(
      (site) =>
        site.usageReportMatch === 'matched' &&
        site.usage.activityState === 'reported',
    )
  const sharePointUsedBytes = sharePointTotalsAuthoritative ? sumKnown(currentSharePointRows, 'Storage Used (Byte)') : null
  const sharePointAllocatedBytes = sharePointTotalsAuthoritative ? sumKnown(currentSharePointRows, 'Storage Allocated (Byte)') : null
  const oneDriveUsedBytes = oneDriveTotalsAuthoritative ? sumKnown(currentOneDriveRows, 'Storage Used (Byte)') : null
  const oneDriveAllocatedBytes = oneDriveTotalsAuthoritative ? sumKnown(currentOneDriveRows, 'Storage Allocated (Byte)') : null

  return {
    contractVersion: SHAREPOINT_DATA_CONTRACT_VERSION,
    projection: {
      limits: SHAREPOINT_CONTRACT_LIMITS,
      sites: { inputRows: siteInput.inputRows, projectedRows: sites.length, invalidRows: siteInput.invalidRows, truncated: siteInput.truncated },
      sharePointUsage: { inputRows: sharePointInput.inputRows, projectedRows: sharePointRows.length, invalidRows: sharePointInput.invalidRows, invalidPeriodRows: invalidSharePointPeriodRows, invalidDateRows: invalidSharePointDateRows, truncated: sharePointInput.truncated },
      oneDriveUsage: { inputRows: oneDriveInput.inputRows, projectedRows: oneDriveRows.length, invalidRows: oneDriveInput.invalidRows, invalidPeriodRows: invalidOneDrivePeriodRows, invalidDateRows: invalidOneDriveDateRows, truncated: oneDriveInput.truncated },
    },
    tenantSettings: projectTenantSettings(input.settings, input.settingsSynchronized),
    usageReports: {
      sharePoint: {
        state: !input.usageSynchronized ? ('unavailable' as const) : sharePointProjectionComplete ? ('available' as const) : ('partial' as const),
        source: 'Microsoft Graph getSharePointSiteUsageDetail' as const,
        observationWindowDays: SHAREPOINT_USAGE_OBSERVATION_DAYS,
        reportPeriod: 'D180' as const,
        reportRefreshDate: latestRefreshDate(sharePointRows, activityAsOf),
        rowCount: input.usageSynchronized ? sharePointRows.length : null,
        matchedSiteCount: input.usageSynchronized ? matchedSharePointUsageRows.size : null,
        unmatchedRowCount: input.usageSynchronized ? Math.max(0, sharePointRows.length - matchedSharePointUsageRows.size) : null,
        identifiersConcealed: input.usageSynchronized ? sharePointIdentifiersConcealed : null,
      },
      oneDrive: {
        state: !input.usageSynchronized ? ('unavailable' as const) : oneDriveProjectionComplete ? ('available' as const) : ('partial' as const),
        source: 'Microsoft Graph getOneDriveUsageAccountDetail' as const,
        observationWindowDays: ONEDRIVE_USAGE_OBSERVATION_DAYS,
        reportPeriod: 'D30' as const,
        reportRefreshDate: latestRefreshDate(oneDriveRows, activityAsOf),
        rowCount: input.usageSynchronized ? oneDriveRows.length : null,
      },
    },
    overview: {
      sharePointSiteCount: siteInput.truncated || siteInput.invalidRows > 0 ? null : sites.length,
      sharePointReportedDeletedCount: sharePointTotalsAuthoritative ? reportedDeletedSites.length : null,
      sharePointStorageUsedGB: bytesToGigabytes(sharePointUsedBytes),
      sharePointReportedAllocationGB: bytesToGigabytes(sharePointAllocatedBytes),
      sharePointInactive90Days: sharePointActivityCoverageComplete ? sites.filter((site) => site.usage.activityAgeDays !== null && site.usage.activityAgeDays >= 90).length : null,
      sharePointInactive180Days: sharePointActivityCoverageComplete ? sites.filter((site) => site.usage.activityAgeDays !== null && site.usage.activityAgeDays >= 180).length : null,
      sharePointSitesMissingReportedOwner: sharePointProjectionComplete ? sites.filter((site) => site.usageReportMatch === 'matched' && !site.usage.hasReportedOwner).length : null,
      sharePointSitesWithMatchedUsage: sharePointProjectionComplete ? sites.filter((site) => site.usageReportMatch === 'matched').length : null,
      sharePointSitesWithoutMatchedUsage: sharePointProjectionComplete ? sites.filter((site) => site.usageReportMatch !== 'matched').length : null,
      oneDriveAccountCount: oneDriveTotalsAuthoritative ? oneDriveAccounts.filter((account) => account.microsoftReportedDeleted === false).length : null,
      oneDriveReportedDeletedCount: oneDriveTotalsAuthoritative ? oneDriveAccounts.filter((account) => account.microsoftReportedDeleted === true).length : null,
      oneDriveStorageUsedGB: bytesToGigabytes(oneDriveUsedBytes),
      oneDriveReportedAllocationGB: bytesToGigabytes(oneDriveAllocatedBytes),
    },
    sites,
    oneDriveAccounts: input.usageSynchronized ? oneDriveAccounts : [],
    reportedDeletedSites: input.usageSynchronized ? reportedDeletedSites : [],
    evidenceBoundaries: {
      tenantSharingPolicy: 'Microsoft Graph exposes one combined SharePoint and OneDrive tenant sharing capability; HawkView does not claim two independently observed policies.',
      perSiteAccess: 'Standard mode does not collect current site-user, site collection administrator, sharing-member, guest, or per-site permission inventory.',
      reportedOwner: 'Microsoft usage reports provide one reported owner field, not a complete owner or administrator list.',
      reportedAllocation: 'Reported allocations are summed from complete, current usage rows and are not the tenant licensed storage pool.',
      reportedDeletedSites: 'A Microsoft usage-report deleted flag is not a recycle-bin inventory and does not establish recoverability or deletion time.',
      graphLastModifiedAt: 'Graph lastModifiedDateTime is resource metadata; it is not proof of user activity or an administrative change.',
    },
  }
}
