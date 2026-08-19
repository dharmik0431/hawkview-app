const MAX_SITE_ROWS = 10_000
const MAX_DELETED_ROWS = 10_000
const MAX_TEXT = 1_000
const MAX_COUNT = 10_000_000_000
const MAX_STORAGE_GB = 10_000_000_000

type PlainRecord = Record<string, unknown>

function record(value: unknown): PlainRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? (value as PlainRecord)
    : null
}

function own(value: PlainRecord | null, key: string): unknown {
  return value && Object.prototype.hasOwnProperty.call(value, key)
    ? value[key]
    : undefined
}

function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim()
  return normalized ? normalized.slice(0, max) : null
}

function finiteNumber(value: unknown, max = MAX_COUNT): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    return null
  }
  return value
}

function integer(value: unknown, max = MAX_COUNT): number | null {
  const number = finiteNumber(value, max)
  return number === null ? null : Math.trunc(number)
}

function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function timestamp(value: unknown): string | null {
  const candidate = text(value, 64)
  if (!candidate) return null
  const parsed = new Date(candidate)
  return Number.isFinite(parsed.getTime()) ? candidate : null
}

function safeUrl(value: unknown): string | null {
  const candidate = text(value, 2_000)
  if (!candidate) return null
  try {
    // URL normalizes an explicit default port (for example, :443) to an empty
    // `url.port`. Reject any explicitly supplied port from the raw authority
    // before parsing so the allowlist remains fail closed.
    const authority = /^https:\/\/([^/?#]+)/i.exec(candidate)?.[1]
    if (!authority || authority.includes(':')) return null
    const url = new URL(candidate)
    const host = url.hostname.toLowerCase()
    if (
      url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.search || url.hash ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.sharepoint\.com$/.test(host)
    ) return null
    return url.toString()
  } catch {
    return null
  }
}

export function sharePointRetentionDaysLabel(value: unknown): string {
  const days = integer(value, 36_500)
  return days === null ? 'Not reported by Microsoft' : `${days} days`
}

function stringList(value: unknown, max = 256): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.slice(0, max).map((item) => text(item, 256)).filter((item): item is string => Boolean(item))))
}

function first<T>(...values: Array<T | null | undefined>): T | null {
  return values.find((value): value is T => value !== null && value !== undefined) ?? null
}

function siteType(value: unknown): string {
  const candidate = text(value, 80)?.toLowerCase() ?? ''
  if (candidate.includes('onedrive') || candidate.includes('personal')) return 'OneDrive'
  if (candidate.includes('communication') || candidate.includes('sitepagepublishing')) return 'Communication site'
  if (candidate.includes('microsoft 365') || candidate.includes('group') || candidate.includes('team')) return 'Microsoft 365 group site'
  return candidate ? 'SharePoint site' : 'SharePoint site'
}

function projectTenantSettings(source: unknown, contractSource: unknown): Record<string, unknown> {
  const legacy = record(source)
  const contract = record(contractSource)
  const external = record(own(contract, 'externalSharing'))
  const access = record(own(contract, 'accessAndSession'))
  const storage = record(own(contract, 'storageAndLifecycle'))
  const creation = record(own(contract, 'siteCreation'))
  const sync = record(own(contract, 'sync'))
  const collaboration = record(own(contract, 'collaborationAndContent'))
  const notifications = record(own(contract, 'notifications'))

  const projected: Record<string, unknown> = {}
  const set = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) projected[key] = value
  }

  set('sharingCapability', first(text(own(external, 'capability'), 120), text(own(legacy, 'sharingCapability'), 120)))
  set('sharingDomainRestrictionMode', first(text(own(external, 'domainRestrictionMode'), 120), text(own(legacy, 'sharingDomainRestrictionMode'), 120)))
  const allowedDomains = contract ? stringList(own(external, 'allowedDomains')) : stringList(own(legacy, 'sharingAllowedDomainList'))
  const blockedDomains = contract ? stringList(own(external, 'blockedDomains')) : stringList(own(legacy, 'sharingBlockedDomainList'))
  if (allowedDomains.length) set('sharingAllowedDomainList', allowedDomains)
  if (blockedDomains.length) set('sharingBlockedDomainList', blockedDomains)

  const booleans: Array<[string, PlainRecord | null, string, string]> = [
    ['isRequireAcceptingUserToMatchInvitedUserEnabled', external, 'requireAcceptingUserToMatchInvitedUser', 'isRequireAcceptingUserToMatchInvitedUserEnabled'],
    ['isResharingByExternalUsersEnabled', external, 'externalUserResharingEnabled', 'isResharingByExternalUsersEnabled'],
    ['isLegacyAuthProtocolsEnabled', access, 'legacyAuthProtocolsEnabled', 'isLegacyAuthProtocolsEnabled'],
    ['isUnmanagedSyncAppForTenantRestricted', sync, 'unmanagedSyncAppRestricted', 'isUnmanagedSyncAppForTenantRestricted'],
    ['isSitesStorageLimitAutomatic', storage, 'siteStorageLimitsAutomatic', 'isSitesStorageLimitAutomatic'],
    ['isSiteCreationEnabled', creation, 'enabled', 'isSiteCreationEnabled'],
    ['isSiteCreationUIEnabled', creation, 'uiEnabled', 'isSiteCreationUIEnabled'],
    ['isSitePagesCreationEnabled', creation, 'pagesCreationEnabled', 'isSitePagesCreationEnabled'],
    ['isCommentingOnSitePagesEnabled', collaboration, 'commentingOnSitePagesEnabled', 'isCommentingOnSitePagesEnabled'],
    ['isLoopEnabled', collaboration, 'loopEnabled', 'isLoopEnabled'],
    ['isMacSyncAppEnabled', sync, 'macSyncAppEnabled', 'isMacSyncAppEnabled'],
    ['isSyncAppForTenantRestricted', sync, 'syncAppRestricted', 'isSyncAppForTenantRestricted'],
    ['isSyncButtonHiddenOnPersonalSite', sync, 'personalSiteSyncButtonHidden', 'isSyncButtonHiddenOnPersonalSite'],
    ['isFileActivityNotificationEnabled', notifications, 'fileActivityEnabled', 'isFileActivityNotificationEnabled'],
    ['isSharePointMobileNotificationEnabled', notifications, 'mobileEnabled', 'isSharePointMobileNotificationEnabled'],
    ['isSharePointNewsfeedEnabled', notifications, 'newsfeedEnabled', 'isSharePointNewsfeedEnabled'],
  ]
  for (const [output, nested, contractKey, legacyKey] of booleans) {
    set(output, first(boolean(own(nested, contractKey)), boolean(own(legacy, legacyKey))))
  }

  const siteLimitGb = first(finiteNumber(own(storage, 'defaultSiteStorageLimitGB'), MAX_STORAGE_GB), null)
  const oneDriveLimitGb = first(finiteNumber(own(storage, 'defaultOneDriveStorageLimitGB'), MAX_STORAGE_GB), null)
  set('siteCreationDefaultStorageLimitInMB', siteLimitGb === null ? finiteNumber(own(legacy, 'siteCreationDefaultStorageLimitInMB')) : siteLimitGb * 1024)
  set('personalSiteDefaultStorageLimitInMB', oneDriveLimitGb === null ? finiteNumber(own(legacy, 'personalSiteDefaultStorageLimitInMB')) : oneDriveLimitGb * 1024)
  set('deletedUserPersonalSiteRetentionPeriodInDays', first(integer(own(storage, 'deletedUserOneDriveRetentionDays'), 36_500), integer(own(legacy, 'deletedUserPersonalSiteRetentionPeriodInDays'), 36_500)))
  set('siteCreationDefaultManagedPath', first(text(own(creation, 'defaultManagedPath'), 256), text(own(legacy, 'siteCreationDefaultManagedPath'), 256)))
  const paths = contract ? stringList(own(creation, 'availableManagedPaths')) : stringList(own(legacy, 'availableManagedPathsForSiteCreation'))
  if (paths.length) set('availableManagedPathsForSiteCreation', paths)
  set('tenantDefaultTimezone', first(text(own(contract, 'tenantDefaultTimezone'), 160), text(own(legacy, 'tenantDefaultTimezone'), 160)))
  return projected
}

function projectSite(value: unknown): Record<string, unknown> | null {
  const site = record(value)
  if (!site) return null
  const usage = record(own(site, 'usage'))
  const drive = record(own(site, 'bestEffortDefaultDriveQuota'))
  const id = first(text(own(site, 'id'), 256), safeUrl(own(site, 'url')))
  if (!id) return null
  const used = first(
    finiteNumber(own(usage, 'storageUsedGB'), MAX_STORAGE_GB),
    finiteNumber(own(site, 'storageUsedGB'), MAX_STORAGE_GB),
    finiteNumber(own(drive, 'usedGB'), MAX_STORAGE_GB),
  )
  const allocated = first(
    finiteNumber(own(usage, 'storageAllocatedGB'), MAX_STORAGE_GB),
    finiteNumber(own(site, 'storageQuotaGB'), MAX_STORAGE_GB),
  )
  const activityAgeDays = first(integer(own(usage, 'activityAgeDays'), 100_000), integer(own(site, 'activityAgeDays'), 100_000))
  const reportedDeleted = first(boolean(own(usage, 'microsoftReportedDeleted')), boolean(own(site, 'usageReportDeleted')), boolean(own(site, 'isDeleted')))
  return {
    id,
    name: first(text(own(site, 'name'), 500), text(own(site, 'displayName'), 500), 'Unnamed SharePoint site'),
    description: text(own(site, 'description'), 1_000),
    url: safeUrl(first(own(site, 'url'), own(site, 'webUrl'))),
    type: siteType(first(own(site, 'siteType'), own(site, 'type'), own(usage, 'rootWebTemplate'))),
    ownerDisplayName: first(text(own(usage, 'ownerDisplayName'), 500), text(own(site, 'ownerDisplayName'), 500)),
    ownerPrincipalName: first(text(own(usage, 'ownerPrincipalName'), 500), text(own(site, 'ownerPrincipalName'), 500)),
    hasReportedOwner: first(boolean(own(usage, 'hasReportedOwner')), boolean(own(site, 'hasReportedOwner'))),
    storageUsedGB: used,
    storageQuotaGB: allocated,
    storageUtilizationPercent: first(finiteNumber(own(usage, 'storageUtilizationPercent'), 100), allocated && used !== null ? Math.min(100, (used / allocated) * 100) : null),
    lastActivityAt: first(timestamp(own(usage, 'lastActivityAt')), timestamp(own(site, 'lastActivityAt'))),
    activityAgeDays,
    activityState: first(text(own(usage, 'activityState'), 80), text(own(site, 'activityStatus'), 80), 'unavailable'),
    activityDataStatus: first(text(own(site, 'usageReportMatch'), 80), text(own(site, 'activityDataStatus'), 80)),
    activitySource: text(own(site, 'activitySource'), 120),
    fileCount: first(integer(own(usage, 'fileCount')), integer(own(site, 'fileCount'))),
    activeFileCount: first(integer(own(usage, 'activeFileCount')), integer(own(site, 'activeFileCount'))),
    pageViews: first(integer(own(usage, 'pageViewCount')), integer(own(site, 'pageViews'))),
    visitedPages: first(integer(own(usage, 'visitedPageCount')), integer(own(site, 'visitedPages'))),
    reportRefreshedAt: first(timestamp(own(usage, 'reportRefreshDate')), timestamp(own(site, 'reportRefreshedAt'))),
    reportPeriod: first(text(own(usage, 'reportPeriod'), 20), text(own(site, 'reportPeriod'), 20)),
    createdDate: first(timestamp(own(site, 'createdAt')), timestamp(own(site, 'createdDateTime')), timestamp(own(site, 'createdDate'))),
    graphLastModified: first(timestamp(own(site, 'graphLastModifiedAt')), timestamp(own(site, 'lastModifiedAt')), timestamp(own(site, 'lastModifiedDateTime')), timestamp(own(site, 'graphLastModified'))),
    rootTemplate: first(text(own(usage, 'rootWebTemplate'), 120), text(own(site, 'rootTemplate'), 120)),
    usageReportDeleted: reportedDeleted,
    isDeleted: reportedDeleted,
    collection: record(own(site, 'collection')),
  }
}

function projectOneDriveAccount(value: unknown): Record<string, unknown> | null {
  const account = record(value)
  if (!account) return null
  const id = first(text(own(account, 'id'), 320), safeUrl(own(account, 'url')), text(own(account, 'ownerPrincipalName'), 320))
  if (!id) return null
  const ownerDisplayName = text(own(account, 'ownerDisplayName'), 500)
  const ownerPrincipalName = text(own(account, 'ownerPrincipalName'), 500)
  return {
    id,
    name: first(ownerDisplayName, ownerPrincipalName, 'Unnamed OneDrive account'),
    url: safeUrl(own(account, 'url')),
    type: 'OneDrive',
    ownerDisplayName,
    ownerPrincipalName,
    hasReportedOwner: Boolean(ownerDisplayName || ownerPrincipalName),
    storageUsedGB: finiteNumber(own(account, 'storageUsedGB'), MAX_STORAGE_GB),
    storageQuotaGB: finiteNumber(own(account, 'storageAllocatedGB'), MAX_STORAGE_GB),
    storageUtilizationPercent: finiteNumber(own(account, 'storageUtilizationPercent'), 100),
    lastActivityAt: timestamp(own(account, 'lastActivityAt')),
    activityAgeDays: integer(own(account, 'activityAgeDays'), 100_000),
    activityState: first(text(own(account, 'activityState'), 80), 'unavailable'),
    fileCount: integer(own(account, 'fileCount')),
    activeFileCount: integer(own(account, 'activeFileCount')),
    reportRefreshedAt: timestamp(own(account, 'reportRefreshDate')),
    reportPeriod: text(own(account, 'reportPeriod'), 20),
    usageReportDeleted: boolean(own(account, 'microsoftReportedDeleted')),
    isDeleted: boolean(own(account, 'microsoftReportedDeleted')),
  }
}

function projectDeletedSignal(value: unknown): Record<string, unknown> | null {
  const signal = record(value)
  if (!signal) return null
  const id = first(text(own(signal, 'id'), 256), safeUrl(own(signal, 'url')))
  if (!id) return null
  return {
    id,
    name: first(text(own(signal, 'name'), 500), safeUrl(own(signal, 'url')), 'Microsoft reported deleted site'),
    url: safeUrl(own(signal, 'url')),
    type: 'Reported deleted signal',
    ownerDisplayName: text(own(signal, 'ownerDisplayName'), 500),
    ownerPrincipalName: text(own(signal, 'ownerPrincipalName'), 500),
    lastActivityAt: timestamp(first(own(signal, 'lastActivityAt'), own(signal, 'lastActivity'))),
    reportRefreshedAt: timestamp(own(signal, 'reportRefreshDate')),
    reportPeriod: text(own(signal, 'reportPeriod'), 20),
    usageReportDeleted: true,
    isDeleted: true,
    isReportedDeletedSignal: true,
  }
}

function maxTimestamp(values: unknown[]): string | null {
  return values
    .map(timestamp)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null
}

export type SharePointViewModel = ReturnType<typeof buildSharePointViewModel>

export function buildSharePointViewModel(value: unknown) {
  const source = record(value) ?? {}
  const contract = record(own(source, 'dataContract'))
  const contractOverview = record(own(contract, 'overview'))
  const projection = record(own(contract, 'projection'))
  const siteProjection = record(own(projection, 'sites'))
  const sharePointUsageProjection = record(own(projection, 'sharePointUsage'))
  const oneDriveUsageProjection = record(own(projection, 'oneDriveUsage'))
  const legacyOverview = record(first(own(source, 'overview'), own(source, 'settings'), source))
  const usageReports = record(own(contract, 'usageReports'))
  const sharePointReport = record(own(usageReports, 'sharePoint'))
  const oneDriveReport = record(own(usageReports, 'oneDrive'))
  const sync = record(own(source, 'sync'))
  const syncRows = ['sites', 'settings', 'usage'].map((key) => record(own(sync, key))).filter((row): row is PlainRecord => Boolean(row))
  const statuses = syncRows.map((row) => text(own(row, 'status'), 40)?.toLowerCase()).filter(Boolean)
  const baseSyncStatus = statuses.includes('failed')
    ? 'failed'
    : statuses.includes('partial')
      ? 'partial'
      : statuses.includes('running')
        ? 'running'
        : statuses.length > 0 && statuses.every((status) => status === 'success' || status === 'succeeded')
          ? 'success'
          : 'never-synced'

  const rawSites = Array.isArray(own(contract, 'sites'))
    ? (own(contract, 'sites') as unknown[])
    : Array.isArray(own(source, 'sites'))
      ? (own(source, 'sites') as unknown[])
      : []
  const clientSiteCapped = rawSites.length > MAX_SITE_ROWS
  const sites = rawSites.slice(0, MAX_SITE_ROWS).map(projectSite).filter((site): site is NonNullable<ReturnType<typeof projectSite>> => Boolean(site))

  const incompleteProjectionRow = (row: PlainRecord | null) => {
    if (!row) return true
    const inputRows = integer(own(row, 'inputRows'), MAX_COUNT)
    const projectedRows = integer(own(row, 'projectedRows'), MAX_COUNT)
    const invalidRows = integer(own(row, 'invalidRows'), MAX_COUNT)
    const invalidPeriodRows = integer(own(row, 'invalidPeriodRows'), MAX_COUNT) ?? 0
    const invalidDateRows = integer(own(row, 'invalidDateRows'), MAX_COUNT) ?? 0
    const truncated = boolean(own(row, 'truncated'))
    return inputRows === null || projectedRows === null || invalidRows === null || truncated === null ||
      truncated || invalidRows > 0 || invalidPeriodRows > 0 || invalidDateRows > 0 || projectedRows < inputRows
  }
  const contractProjectionIncomplete = Boolean(contract) && (
    incompleteProjectionRow(siteProjection) ||
    incompleteProjectionRow(sharePointUsageProjection) ||
    incompleteProjectionRow(oneDriveUsageProjection)
  )
  const projectionIncomplete = clientSiteCapped || contractProjectionIncomplete
  const syncStatus = projectionIncomplete && !['failed', 'running'].includes(baseSyncStatus)
    ? 'partial'
    : baseSyncStatus

  const rawDeleted = Array.isArray(own(contract, 'reportedDeletedSites'))
    ? (own(contract, 'reportedDeletedSites') as unknown[])
    : Array.isArray(own(source, 'deletedSites'))
      ? (own(source, 'deletedSites') as unknown[])
      : []
  const reportedDeletedSites = rawDeleted.slice(0, MAX_DELETED_ROWS).map(projectDeletedSignal).filter((site): site is NonNullable<ReturnType<typeof projectDeletedSignal>> => Boolean(site))

  const rawOneDrive = Array.isArray(own(contract, 'oneDriveAccounts'))
    ? (own(contract, 'oneDriveAccounts') as unknown[])
    : Array.isArray(own(source, 'oneDriveAccounts'))
      ? (own(source, 'oneDriveAccounts') as unknown[])
      : []

  return {
    contractVersion: text(own(contract, 'contractVersion'), 40) ?? finiteNumber(own(contract, 'contractVersion'), 100),
    inventory: {
      projectionComplete: !projectionIncomplete,
      truncated: clientSiteCapped || boolean(own(siteProjection, 'truncated')) === true,
      countAtLeast: projectionIncomplete,
      countLabel: projectionIncomplete ? `${sites.length}+` : String(sites.length),
    },
    overview: {
      totalSites: first(integer(own(contractOverview, 'sharePointSiteCount')), integer(own(contractOverview, 'discoveredSharePointSiteCount')), integer(own(legacyOverview, 'totalSites')), sites.length),
      totalStorageQuotaGB: first(finiteNumber(own(contractOverview, 'sharePointReportedAllocationGB'), MAX_STORAGE_GB), finiteNumber(own(legacyOverview, 'totalStorageQuotaGB'), MAX_STORAGE_GB)),
      storageQuotaSource: first(text(own(legacyOverview, 'storageQuotaSource'), 120), 'reported-site-allocation'),
      oneDriveStorageLimitGB: finiteNumber(own(legacyOverview, 'oneDriveStorageLimitGB'), MAX_STORAGE_GB),
      siteStorageLimitsMode: text(own(legacyOverview, 'siteStorageLimitsMode'), 80),
      inactiveSites90Days: first(integer(own(contractOverview, 'sharePointInactive90Days')), integer(own(legacyOverview, 'inactiveSites90Days'))),
      inactiveSites180Days: first(integer(own(contractOverview, 'sharePointInactive180Days')), integer(own(legacyOverview, 'inactiveSites180Days'))),
      // The contract distinguishes a missing usage-row match from a matched row
      // that has no reported activity date. The approved UI computes the latter
      // from projected site rows, so do not substitute the former here.
      sitesWithoutActivityData: integer(own(legacyOverview, 'sitesWithoutActivityData')),
      sitesMissingReportedOwner: first(integer(own(contractOverview, 'sharePointSitesMissingReportedOwner')), integer(own(legacyOverview, 'sitesMissingReportedOwner'))),
      sharingCapability: first(text(own(record(own(contract, 'tenantSettings')) ? record(own(record(own(contract, 'tenantSettings')), 'externalSharing')) : null, 'capability'), 120), text(own(legacyOverview, 'sharingCapability'), 120), text(own(legacyOverview, 'sharingSharePoint'), 120)),
    },
    sites,
    siteTableRows: [...sites, ...reportedDeletedSites.filter((signal) => !sites.some((site) => site.id === signal.id || (site.url && site.url === signal.url)))],
    reportedDeletedSites,
    oneDriveAccounts: rawOneDrive.slice(0, MAX_SITE_ROWS).map(projectOneDriveAccount).filter((site): site is NonNullable<ReturnType<typeof projectOneDriveAccount>> => Boolean(site)),
    tenantSettings: projectTenantSettings(own(source, 'tenantSettings') ?? own(record(own(record(own(source, 'collection')), 'tenantSettings')), 'value'), own(contract, 'tenantSettings')),
    sync: {
      status: syncStatus,
      lastAttemptAt: maxTimestamp(syncRows.map((row) => own(row, 'lastAttemptAt'))),
      lastSuccessAt: maxTimestamp(syncRows.map((row) => own(row, 'lastSuccessfulAt'))),
      reportRefreshedAt: first(timestamp(own(sharePointReport, 'reportRefreshDate')), timestamp(own(oneDriveReport, 'reportRefreshDate'))),
    },
  }
}
