import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import {
  buildSharePointDataContract,
  ONEDRIVE_USAGE_OBSERVATION_DAYS,
  SHAREPOINT_CONTRACT_LIMITS,
  SHAREPOINT_DATA_CONTRACT_VERSION,
  SHAREPOINT_USAGE_OBSERVATION_DAYS,
} from './sharepoint-data-contract.js'

const GIB = 1024 ** 3

test('projects the supported tenant settings through a closed truthful contract', () => {
  const contract = buildSharePointDataContract({
    sites: [],
    sharePointUsage: [],
    oneDriveUsage: [],
    settingsSynchronized: true,
    usageSynchronized: true,
    activityAsOf: new Date('2026-08-19T12:00:00.000Z'),
    settings: {
      sharingCapability: 'externalUserAndGuestSharing',
      sharingDomainRestrictionMode: 'allowList',
      sharingAllowedDomainList: ['contoso.com', ' fabrikam.com ', 'contoso.com'],
      sharingBlockedDomainList: ['blocked.example'],
      isRequireAcceptingUserToMatchInvitedUserEnabled: true,
      isResharingByExternalUsersEnabled: false,
      isLegacyAuthProtocolsEnabled: false,
      idleSessionSignOut: {
        isEnabled: true,
        warnAfterInSeconds: 1_800,
        signOutAfterInSeconds: 3_600,
        injected: 'not projected',
      },
      isSitesStorageLimitAutomatic: true,
      siteCreationDefaultStorageLimitInMB: 102_400,
      personalSiteDefaultStorageLimitInMB: 1_048_576,
      deletedUserPersonalSiteRetentionPeriodInDays: 93,
      isSiteCreationEnabled: true,
      isSiteCreationUIEnabled: true,
      isSitePagesCreationEnabled: false,
      siteCreationDefaultManagedPath: '/sites/',
      availableManagedPathsForSiteCreation: ['/sites/', '/teams/'],
      isCommentingOnSitePagesEnabled: true,
      isLoopEnabled: false,
      imageTaggingOption: 'basic',
      allowedDomainGuidsForSyncApp: ['11111111-1111-4111-8111-111111111111'],
      excludedFileExtensionsForSyncApp: ['pst', 'tmp'],
      isMacSyncAppEnabled: true,
      isSyncButtonHiddenOnPersonalSite: false,
      isUnmanagedSyncAppForTenantRestricted: true,
      isFileActivityNotificationEnabled: true,
      isSharePointMobileNotificationEnabled: false,
      isSharePointNewsfeedEnabled: false,
      tenantDefaultTimezone: 'Eastern Standard Time',
      access_token: 'must-not-leak',
      arbitraryNestedObject: { password: 'must-not-leak' },
    },
  })

  assert.equal(contract.contractVersion, SHAREPOINT_DATA_CONTRACT_VERSION)
  assert.deepEqual(contract.tenantSettings.externalSharing, {
    capability: 'externalUserAndGuestSharing',
    appliesTo: 'SharePoint and OneDrive',
    domainRestrictionMode: 'allowList',
    allowedDomains: ['contoso.com', 'fabrikam.com'],
    blockedDomains: ['blocked.example'],
    requireAcceptingUserToMatchInvitedUser: true,
    externalUserResharingEnabled: false,
  })
  assert.deepEqual(contract.tenantSettings.accessAndSession.idleSessionSignOut, {
    enabled: true,
    warnAfterSeconds: 1_800,
    signOutAfterSeconds: 3_600,
  })
  assert.equal(contract.tenantSettings.storageAndLifecycle.defaultSiteStorageLimitGB, 100)
  assert.equal(contract.tenantSettings.storageAndLifecycle.defaultOneDriveStorageLimitGB, 1_024)
  assert.equal(contract.tenantSettings.storageAndLifecycle.deletedUserOneDriveRetentionDays, 93)
  assert.deepEqual(contract.tenantSettings.siteCreation.availableManagedPaths, ['/sites/', '/teams/'])
  assert.deepEqual(contract.tenantSettings.sync.excludedFileExtensions, ['pst', 'tmp'])

  const serialized = JSON.stringify(contract)
  assert.doesNotMatch(serialized, /must-not-leak|access_token|password|arbitraryNestedObject/)
  assert.equal('sharingSharePoint' in contract.overview, false)
  assert.equal('sharingOneDrive' in contract.overview, false)
})

test('projects SharePoint and OneDrive report data without claiming per-site access', () => {
  const contract = buildSharePointDataContract({
    settings: null,
    settingsSynchronized: false,
    usageSynchronized: true,
    activityAsOf: new Date('2026-08-19T12:00:00.000Z'),
    sites: [
      {
        id: 'contoso.sharepoint.com,site-guid,web-guid',
        displayName: 'Operations',
        description: 'Operations workspace',
        webUrl: 'https://contoso.sharepoint.com/sites/operations',
        createdDateTime: '2024-01-02T00:00:00Z',
        lastModifiedDateTime: '2026-08-18T12:30:00Z',
        driveQuota: {
          used: 3 * GIB,
          total: 30 * GIB,
          remaining: 27 * GIB,
          deleted: 0,
          state: 'normal',
        },
        externalSharing: 'Anyone',
        guestsCount: 99,
      },
      {
        id: 'unmatched',
        displayName: 'Unmatched',
        webUrl: 'https://contoso.sharepoint.com/sites/unmatched',
      },
    ],
    sharePointUsage: [
      {
        'Report Refresh Date': '2026-08-18',
        'Site Id': 'site-guid',
        'Site URL': 'https://contoso.sharepoint.com/sites/operations',
        'Owner Display Name': 'Alex Admin',
        'Owner Principal Name': 'alex@contoso.com',
        'Is Deleted': 'False',
        'Last Activity Date': '2026-08-17',
        'File Count': '120',
        'Active File Count': '12',
        'Page View Count': '300',
        'Visited Page Count': '25',
        'Storage Used (Byte)': String(2 * GIB),
        'Storage Allocated (Byte)': String(20 * GIB),
        'Root Web Template': 'GROUP#0',
        'Report Period': 'D180',
      },
    ],
    oneDriveUsage: [
      {
        'Report Refresh Date': '2026-08-18',
        'Site URL': 'https://contoso-my.sharepoint.com/personal/alex_contoso_com',
        'Owner Display Name': 'Alex Admin',
        'Owner Principal Name': 'alex@contoso.com',
        'Is Deleted': 'False',
        'Last Activity Date': '2026-08-18',
        'File Count': '42',
        'Active File Count': '7',
        'Storage Used (Byte)': String(GIB),
        'Storage Allocated (Byte)': String(10 * GIB),
        'Report Period': 'D30',
      },
    ],
  })

  assert.equal(contract.usageReports.sharePoint.observationWindowDays, SHAREPOINT_USAGE_OBSERVATION_DAYS)
  assert.equal(contract.usageReports.oneDrive.observationWindowDays, ONEDRIVE_USAGE_OBSERVATION_DAYS)
  assert.equal(contract.usageReports.sharePoint.matchedSiteCount, 1)
  assert.equal(contract.usageReports.sharePoint.identifiersConcealed, false)
  assert.equal(contract.overview.sharePointSitesMissingReportedOwner, 0)
  assert.equal(contract.overview.sharePointStorageUsedGB, 2)
  assert.equal(contract.overview.sharePointReportedAllocationGB, 20)
  assert.equal(contract.overview.oneDriveAccountCount, 1)
  assert.equal(contract.overview.oneDriveStorageUsedGB, 1)

  assert.deepEqual(contract.sites[0].usage, {
    reportRefreshDate: '2026-08-18',
    reportPeriod: 'D180',
    microsoftReportedDeleted: false,
    rootWebTemplate: 'GROUP#0',
    ownerDisplayName: 'Alex Admin',
    ownerPrincipalName: 'alex@contoso.com',
    hasReportedOwner: true,
    fileCount: 120,
    activeFileCount: 12,
    pageViewCount: 300,
    visitedPageCount: 25,
    storageUsedGB: 2,
    storageAllocatedGB: 20,
    storageUtilizationPercent: 10,
    lastActivityAt: '2026-08-17',
    activityAgeDays: 1,
    activityState: 'reported',
  })
  assert.deepEqual(contract.sites[0].accessMetadata, {
    state: 'not-collected-least-privilege',
    reasonCode: 'NOT_COLLECTED_LEAST_PRIVILEGE',
  })
  assert.deepEqual(contract.sites[0].bestEffortDefaultDriveQuota, {
    source: 'Microsoft Graph default drive quota',
    authoritativeForSiteAllocation: false,
    usedGB: 3,
    totalGB: 30,
    remainingGB: 27,
    deletedGB: 0,
    state: 'normal',
  })
  assert.equal(JSON.stringify(contract.sites[0]).includes('externalSharing'), false)
  assert.equal(JSON.stringify(contract.sites[0]).includes('guestsCount'), false)
  assert.equal(contract.oneDriveAccounts[0].storageUtilizationPercent, 10)
})

test('labels usage-report deleted rows as signals and never claims recoverability', () => {
  const contract = buildSharePointDataContract({
    sites: [],
    settings: null,
    settingsSynchronized: false,
    usageSynchronized: true,
    activityAsOf: new Date('2026-08-19T12:00:00.000Z'),
    sharePointUsage: [
      {
        'Site Id': '{deleted-guid}',
        'Site URL': 'https://contoso.sharepoint.com/sites/deleted',
        'Is Deleted': 'True',
        'Last Activity Date': '2026-01-01',
        'Report Refresh Date': '2026-08-18',
        'Report Period': 'D180',
      },
    ],
    oneDriveUsage: [],
  })

  assert.equal(contract.reportedDeletedSites.length, 1)
  assert.deepEqual(contract.reportedDeletedSites[0], {
    id: 'deleted-guid',
    name: 'https://contoso.sharepoint.com/sites/deleted',
    url: 'https://contoso.sharepoint.com/sites/deleted',
    ownerDisplayName: null,
    ownerPrincipalName: null,
    lastActivityAt: '2026-01-01',
    reportRefreshDate: '2026-08-18',
    reportPeriod: 'D180',
    source: 'Microsoft Graph SharePoint site usage report',
    evidenceKind: 'reported-deleted-site',
    recoverability: 'not-established',
  })
  assert.match(contract.evidenceBoundaries.reportedDeletedSites, /not a recycle-bin inventory/i)
  assert.doesNotMatch(JSON.stringify(contract), /recoverable/i)
})

test('fails closed when reports or settings are not successfully synchronized', () => {
  const contract = buildSharePointDataContract({
    sites: [],
    settings: { sharingCapability: 'externalUserSharingOnly' },
    settingsSynchronized: false,
    sharePointUsage: [
      { 'Site URL': 'https://contoso.sharepoint.com/sites/old', 'Is Deleted': 'True' },
    ],
    oneDriveUsage: [
      { 'Owner Principal Name': 'old@contoso.com', 'Storage Used (Byte)': String(GIB) },
    ],
    usageSynchronized: false,
    activityAsOf: new Date('2026-08-19T12:00:00.000Z'),
  })

  assert.equal(contract.tenantSettings.state, 'unavailable')
  assert.equal(contract.tenantSettings.externalSharing.capability, null)
  assert.equal(contract.usageReports.sharePoint.state, 'unavailable')
  assert.equal(contract.overview.oneDriveAccountCount, null)
  assert.equal(contract.overview.sharePointReportedDeletedCount, null)
  assert.deepEqual(contract.oneDriveAccounts, [])
  assert.deepEqual(contract.reportedDeletedSites, [])
})

test('identifies concealed SharePoint report identifiers without guessing site matches', () => {
  const contract = buildSharePointDataContract({
    sites: [
      {
        id: 'real-site',
        displayName: 'Known Graph site',
        webUrl: 'https://contoso.sharepoint.com/sites/known',
      },
    ],
    settings: null,
    settingsSynchronized: false,
    sharePointUsage: [
      {
        'Site URL': 'concealed-site-1',
        'Last Activity Date': '2026-08-01',
        'Owner Principal Name': 'concealed-owner-1',
        'Report Refresh Date': '2026-08-18',
        'Is Deleted': 'False',
        'Report Period': 'D180',
      },
    ],
    oneDriveUsage: [],
    usageSynchronized: true,
    activityAsOf: new Date('2026-08-19T12:00:00.000Z'),
  })

  assert.equal(contract.usageReports.sharePoint.identifiersConcealed, true)
  assert.equal(contract.usageReports.sharePoint.matchedSiteCount, 0)
  assert.equal(contract.sites[0].usage.activityState, 'unavailable')
  assert.equal(contract.overview.sharePointSitesMissingReportedOwner, 0)
})

test('does not convert an omitted Microsoft activity date into inactivity', () => {
  const contract = buildSharePointDataContract({
    sites: [
      {
        id: 'site-id',
        displayName: 'No activity date',
        webUrl: 'https://contoso.sharepoint.com/sites/no-activity-date',
      },
    ],
    settings: null,
    settingsSynchronized: false,
    sharePointUsage: [
      {
        'Site Id': 'site-id',
        'Site URL': 'https://contoso.sharepoint.com/sites/no-activity-date',
        'Last Activity Date': '',
        'Report Refresh Date': '2026-08-18',
        'Is Deleted': 'False',
        'Report Period': 'D180',
      },
    ],
    oneDriveUsage: [],
    usageSynchronized: true,
    activityAsOf: new Date('2026-08-19T12:00:00.000Z'),
  })

  assert.deepEqual(
    {
      activityAgeDays: contract.sites[0].usage.activityAgeDays,
      activityState: contract.sites[0].usage.activityState,
      lastActivityAt: contract.sites[0].usage.lastActivityAt,
    },
    {
      activityAgeDays: null,
      activityState: 'not-reported-by-microsoft',
      lastActivityAt: null,
    }
  )
  assert.equal(contract.overview.sharePointInactive90Days, 0)
  assert.equal(contract.overview.sharePointInactive180Days, 0)
})

test('fails closed on hostile, inherited, malformed, and out-of-range values', () => {
  const inheritedSettings = Object.create({ sharingCapability: 'externalUserAndGuestSharing' })
  inheritedSettings.tenantDefaultTimezone = 'Eastern Standard Time'
  inheritedSettings.sharingAllowedDomainList = [
    'contoso.com', 'https://evil.example', 'access_token=stolen', 'invalid',
  ]
  inheritedSettings.availableManagedPathsForSiteCreation = ['/sites/', '/../escape', '//double']
  inheritedSettings.allowedDomainGuidsForSyncApp = [
    '11111111-1111-4111-8111-111111111111', 'not-a-guid',
  ]
  inheritedSettings.idleSessionSignOut = Object.create({ isEnabled: true })

  const inheritedSite = Object.create({ displayName: 'Inherited secret site' })
  inheritedSite.id = 'inherited'
  const contract = buildSharePointDataContract({
    sites: [
      inheritedSite,
      {
        id: 'safe-site',
        displayName: 'access_token=do-not-render',
        description: '{"error":{"client_secret":"leak"}}',
        webUrl: 'https://user:password@contoso.sharepoint.com/sites/secret?sig=leak',
        createdDateTime: 'not-a-time',
        driveQuota: Object.create({ used: 42 }),
      },
    ],
    settings: inheritedSettings,
    settingsSynchronized: true,
    sharePointUsage: [{
      'Report Period': 'D180',
      'Report Refresh Date': '2026-02-30',
      'Site URL': 'https://contoso.sharepoint.com/sites/safe',
      'Is Deleted': 'maybe',
      'Storage Used (Byte)': String(SHAREPOINT_CONTRACT_LIMITS.bytes + 1),
    }],
    oneDriveUsage: [],
    usageSynchronized: true,
    activityAsOf: new Date('2026-08-19T00:00:00.000Z'),
  })

  assert.equal(contract.tenantSettings.externalSharing.capability, null)
  assert.equal(contract.tenantSettings.state, 'unavailable')
  assert.deepEqual(contract.tenantSettings.externalSharing.allowedDomains, [])
  assert.deepEqual(contract.tenantSettings.siteCreation.availableManagedPaths, [])
  assert.deepEqual(contract.tenantSettings.sync.allowedDomainGuids, [])
  assert.equal(contract.tenantSettings.accessAndSession.idleSessionSignOut.enabled, null)
  assert.equal(contract.projection.sites.invalidRows, 1)
  assert.equal(contract.overview.sharePointSiteCount, null)
  assert.equal(contract.overview.sharePointStorageUsedGB, null)
  assert.equal(contract.overview.sharePointReportedDeletedCount, null)
  const serialized = JSON.stringify(contract)
  assert.doesNotMatch(serialized, /do-not-render|client_secret|password@|sig=leak|Inherited secret site/)
})

test('enforces report periods, calendar dates, refresh ordering, tri-state deletion, and unknown totals', () => {
  const contract = buildSharePointDataContract({
    sites: [{ id: 'site-a', displayName: 'Site A', webUrl: 'https://contoso.sharepoint.com/sites/a' }],
    settings: null,
    settingsSynchronized: false,
    sharePointUsage: [
      {
        'Report Period': 'D30',
        'Report Refresh Date': '2026-08-18',
        'Site URL': 'https://contoso.sharepoint.com/sites/wrong-period',
        'Is Deleted': 'False',
      },
      {
        'Report Period': 'D180',
        'Report Refresh Date': '2026-08-20',
        'Last Activity Date': '2026-08-21',
        'Site URL': 'https://contoso.sharepoint.com/sites/a',
        'Is Deleted': 'unknown',
      },
    ],
    oneDriveUsage: [{
      'Report Period': 'D180',
      'Report Refresh Date': '2026-08-18',
      'Is Deleted': 'False',
    }],
    usageSynchronized: true,
    activityAsOf: new Date('2026-08-19T00:00:00.000Z'),
  })

  assert.equal(contract.usageReports.sharePoint.state, 'partial')
  assert.equal(contract.usageReports.oneDrive.state, 'partial')
  assert.equal(contract.sites[0].usage.activityState, 'unavailable')
  assert.equal(contract.sites[0].usage.activityAgeDays, null)
  assert.equal(contract.sites[0].usage.microsoftReportedDeleted, null)
  assert.equal(contract.overview.sharePointInactive90Days, null)
  assert.equal(contract.overview.sharePointStorageUsedGB, null)
  assert.equal(contract.overview.oneDriveAccountCount, null)
})

test('caps every projected collection and reports cap plus one instead of doing unbounded work', () => {
  const site = { id: 'site', displayName: 'Site', webUrl: 'https://contoso.sharepoint.com/sites/site' }
  const report = {
    'Report Period': 'D180', 'Report Refresh Date': '2026-08-18',
    'Site URL': 'https://contoso.sharepoint.com/sites/site', 'Is Deleted': 'False',
  }
  const oneDrive = {
    'Report Period': 'D30', 'Report Refresh Date': '2026-08-18',
    'Site URL': 'https://contoso-my.sharepoint.com/personal/user', 'Is Deleted': 'False',
  }
  const contract = buildSharePointDataContract({
    sites: Array(SHAREPOINT_CONTRACT_LIMITS.sites + 1).fill(site),
    settings: {
      sharingAllowedDomainList: Array(SHAREPOINT_CONTRACT_LIMITS.settingListItems + 1).fill('contoso.com'),
    },
    settingsSynchronized: true,
    sharePointUsage: Array(SHAREPOINT_CONTRACT_LIMITS.sharePointUsageRows + 1).fill(report),
    oneDriveUsage: Array(SHAREPOINT_CONTRACT_LIMITS.oneDriveUsageRows + 1).fill(oneDrive),
    usageSynchronized: true,
    activityAsOf: new Date('2026-08-19T00:00:00.000Z'),
  })

  assert.equal(contract.sites.length, SHAREPOINT_CONTRACT_LIMITS.sites)
  assert.equal(contract.oneDriveAccounts.length, SHAREPOINT_CONTRACT_LIMITS.oneDriveUsageRows)
  assert.equal(contract.projection.sites.truncated, true)
  assert.equal(contract.projection.sharePointUsage.truncated, true)
  assert.equal(contract.projection.oneDriveUsage.truncated, true)
  assert.equal(contract.tenantSettings.listProjection.allowedDomainsTruncated, true)
  assert.equal(contract.usageReports.sharePoint.state, 'partial')
  assert.equal(contract.overview.sharePointSiteCount, null)
  assert.equal(contract.overview.oneDriveAccountCount, null)
})

test('serializes the tenant bundle with organization isolation and a legacy sharing bridge', async () => {
  const expectedScope = { organizationId: 'org-1', customerTenantId: 'tenant-1' }
  const scoped = (where: Record<string, unknown>) => {
    assert.equal(where.organizationId, expectedScope.organizationId)
    assert.equal(where.customerTenantId, expectedScope.customerTenantId)
  }
  const snapshots = [
    {
      resourceType: 'SHAREPOINT_SITES',
      payload: [{
        id: 'contoso.sharepoint.com,site-guid,web-guid',
        displayName: 'Operations',
        webUrl: 'https://contoso.sharepoint.com/sites/operations',
      }],
    },
    {
      resourceType: 'SHAREPOINT_SETTINGS',
      payload: [{
        sharingCapability: 'externalUserSharingOnly',
        access_token: 'must-not-enter-the-contract',
      }],
    },
    {
      resourceType: 'SHAREPOINT_USAGE',
      payload: [{
        hawkviewDataset: 'microsoft-usage-reports-v1',
        sharePointSites: [{
          'Report Period': 'D180',
          'Report Refresh Date': '2026-08-18',
          'Site Id': 'site-guid',
          'Site URL': 'https://contoso.sharepoint.com/sites/operations',
          'Is Deleted': 'False',
          'Storage Used (Byte)': String(GIB),
          'Storage Allocated (Byte)': String(10 * GIB),
        }],
        oneDriveAccounts: [],
      }],
    },
  ]
  const successfulAt = new Date('2026-08-19T12:00:00.000Z')
  const syncStates = ['SHAREPOINT_SITES', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE'].map((resourceType) => ({
    resourceType,
    status: 'SUCCEEDED',
    lastAttemptAt: successfulAt,
    lastSuccessfulAt: successfulAt,
    lastErrorMessage: null,
  }))
  const prisma = {
    directoryUser: { findMany: async ({ where }: any) => (scoped(where), []) },
    directoryGroup: { findMany: async ({ where }: any) => (scoped(where), []) },
    tenantLicense: { findMany: async ({ where }: any) => (scoped(where), []) },
    tenantDomain: { findMany: async ({ where }: any) => (scoped(where), []) },
    syncState: {
      findMany: async ({ where }: any) => {
        scoped(where)
        return syncStates
      },
    },
    tenantEntraSnapshot: { findMany: async ({ where }: any) => (scoped(where), snapshots) },
    tenantCollectionFieldState: { findMany: async ({ where }: any) => (scoped(where), []) },
    signInLog: { findMany: async ({ where }: any) => (scoped(where), []) },
    directoryAuditLog: { findMany: async ({ where }: any) => (scoped(where), []) },
    m365ActivitySubscription: { findMany: async ({ where }: any) => (scoped(where), []) },
    m365ActivityContent: {
      groupBy: async ({ where }: any) => (scoped(where), []),
      findFirst: async ({ where }: any) => (scoped(where), null),
    },
    m365AuditDailyUsage: {
      findFirst: async ({ where }: any) => (scoped(where), null),
      aggregate: async ({ where }: any) => (
        scoped(where), { _sum: { downloadedBytes: null, recordsStored: null, blobsProcessed: null } }
      ),
    },
  }
  const service = new TenantSyncService(
    prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never
  )
  const result = await (service as any).buildBundle({
    id: expectedScope.customerTenantId,
    organizationId: expectedScope.organizationId,
    microsoftTenantId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Contoso',
    primaryDomain: 'contoso.com',
    status: 'CONNECTED',
    connection: { lastVerifiedAt: successfulAt },
  })
  const sharePoint = result.bundle.sharepoint

  assert.equal(sharePoint.overview.tenantSharingCapability, 'externalUserSharingOnly')
  assert.equal(sharePoint.overview.sharingSharePoint, sharePoint.overview.tenantSharingCapability)
  assert.equal(sharePoint.overview.sharingOneDrive, sharePoint.overview.tenantSharingCapability)
  assert.deepEqual(sharePoint.overview.sharingCompatibility, {
    canonicalField: 'tenantSharingCapability',
    deprecatedAliases: ['sharingSharePoint', 'sharingOneDrive'],
    aliasesRepresentSameCombinedTenantPolicy: true,
  })
  assert.equal(sharePoint.dataContract.contractVersion, SHAREPOINT_DATA_CONTRACT_VERSION)
  assert.equal(sharePoint.dataContract.sites[0].usageReportMatch, 'matched')
  assert.doesNotMatch(JSON.stringify(sharePoint.dataContract), /must-not-enter-the-contract|access_token/)
})
