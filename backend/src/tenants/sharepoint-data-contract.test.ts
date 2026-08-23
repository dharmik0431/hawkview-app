import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantsService } from './tenants.service.js'
import {
  buildMicrosoftUsageReportSnapshot,
  buildSharePointDataContract,
  inspectMicrosoftUsageProjectionEvidence,
  MICROSOFT_USAGE_REPORT_DATASET,
  ONEDRIVE_USAGE_OBSERVATION_DAYS,
  SHAREPOINT_CONTRACT_LIMITS,
  SHAREPOINT_DATA_CONTRACT_VERSION,
  SHAREPOINT_USAGE_OBSERVATION_DAYS,
} from './sharepoint-data-contract.js'

const GIB = 1024 ** 3
const COMPLETE_SOURCE_EVIDENCE = { state: 'AUTHORITATIVE_COMPLETE', reasonCode: null } as const
const PARTIAL_SOURCE_EVIDENCE = { state: 'PARTIAL', reasonCode: 'USAGE_PROJECTION_EVIDENCE_INCOMPLETE' } as const
const REJECTED_SOURCE_EVIDENCE = { state: 'REJECTED', reasonCode: 'USAGE_PROJECTION_EVIDENCE_INVALID' } as const
const LEGACY_SOURCE_EVIDENCE = { state: 'UNVERIFIED_LEGACY', reasonCode: 'USAGE_PROJECTION_NOT_DURABLY_VERIFIED' } as const

test('canonicalizes only exact Microsoft numeric or D-prefixed report periods', () => {
  const snapshot = buildMicrosoftUsageReportSnapshot(
    [{ 'Report Period': '180', 'Report Refresh Date': '2026-08-18', 'Site URL': 'https://tenant.sharepoint.com/sites/ops' }],
    [{ 'Report Period': 'D30', 'Report Refresh Date': '2026-08-18', 'Site URL': 'https://tenant-my.sharepoint.com/personal/alex_tenant_com' }],
  )
  assert.equal(snapshot[0].hawkviewDataset, MICROSOFT_USAGE_REPORT_DATASET)
  assert.equal(snapshot[0].sharePointSites[0]?.['Report Period'], 'D180')
  assert.equal(snapshot[0].oneDriveAccounts[0]?.['Report Period'], 'D30')
  assert.deepEqual(inspectMicrosoftUsageProjectionEvidence(snapshot), {
    ...COMPLETE_SOURCE_EVIDENCE,
    sharePoint: COMPLETE_SOURCE_EVIDENCE,
    oneDrive: COMPLETE_SOURCE_EVIDENCE,
  })
  const historical = buildSharePointDataContract({
    sites: [{ id: 'tenant.sharepoint.com,site-guid,web-guid', webUrl: 'https://tenant.sharepoint.com/sites/ops' }],
    settings: null,
    settingsSynchronized: false,
    usageSynchronized: true,
    activityAsOf: new Date('2026-08-19T00:00:00.000Z'),
    sharePointUsage: [{
      'Report Period': '180',
      'Report Refresh Date': '2026-08-18',
      'Site Id': 'site-guid',
      'Site URL': 'https://tenant.sharepoint.com/sites/ops',
      'Is Deleted': 'False',
      'Last Activity Date': '2026-01-01',
      'Storage Used (Byte)': String(GIB),
      'Storage Allocated (Byte)': String(10 * GIB),
    }],
    oneDriveUsage: [],
  })
  assert.equal(historical.usageReports.sharePoint.state, 'available')
  assert.equal(historical.overview.sharePointInactive90Days, 1)
  assert.equal(historical.overview.sharePointStorageUsedGB, 1)

  for (const hostile of ['ALL', 'D30', '180 days', 'D180?access_token=secret', '', null]) {
    assert.throws(
      () => buildMicrosoftUsageReportSnapshot(
        [{ 'Report Period': hostile }],
        [{ 'Report Period': '30' }],
      ),
      /unexpected Report Period/,
    )
  }
  assert.deepEqual(
    inspectMicrosoftUsageProjectionEvidence([{
      ...snapshot[0],
      projectionEvidence: {
        ...snapshot[0].projectionEvidence,
        sharePoint: { requestedPeriod: 'D180', rowCount: 999 },
      },
    }]),
    { ...REJECTED_SOURCE_EVIDENCE, sharePoint: REJECTED_SOURCE_EVIDENCE, oneDrive: COMPLETE_SOURCE_EVIDENCE },
  )
  assert.deepEqual(
    inspectMicrosoftUsageProjectionEvidence([{
      hawkviewDataset: 'microsoft-usage-reports-v1',
      sharePointSites: [],
      oneDriveAccounts: [],
    }]),
    { ...LEGACY_SOURCE_EVIDENCE, sharePoint: LEGACY_SOURCE_EVIDENCE, oneDrive: LEGACY_SOURCE_EVIDENCE },
  )

  const emptySnapshot = buildMicrosoftUsageReportSnapshot([], [])
  assert.deepEqual(emptySnapshot[0].projectionEvidence, {
    version: 1,
    state: 'PARTIAL',
    sharePoint: { state: 'PARTIAL', requestedPeriod: 'D180', rowCount: 0 },
    oneDrive: { state: 'PARTIAL', requestedPeriod: 'D30', rowCount: 0 },
  })
  assert.deepEqual(inspectMicrosoftUsageProjectionEvidence(emptySnapshot), {
    ...PARTIAL_SOURCE_EVIDENCE,
    sharePoint: PARTIAL_SOURCE_EVIDENCE,
    oneDrive: PARTIAL_SOURCE_EVIDENCE,
  })

  const sharePointOnlySnapshot = buildMicrosoftUsageReportSnapshot(
    [{ 'Report Period': 180, 'Report Refresh Date': '2026-08-18', 'Site URL': 'https://tenant.sharepoint.com/sites/ops' }],
    [],
  )
  assert.deepEqual(inspectMicrosoftUsageProjectionEvidence(sharePointOnlySnapshot), {
    ...PARTIAL_SOURCE_EVIDENCE,
    sharePoint: COMPLETE_SOURCE_EVIDENCE,
    oneDrive: PARTIAL_SOURCE_EVIDENCE,
  })

  const tamperedPeriod = structuredClone(snapshot)
  tamperedPeriod[0].sharePointSites[0]['Report Period'] = 'D30'
  assert.deepEqual(inspectMicrosoftUsageProjectionEvidence(tamperedPeriod), {
    ...REJECTED_SOURCE_EVIDENCE,
    sharePoint: REJECTED_SOURCE_EVIDENCE,
    oneDrive: COMPLETE_SOURCE_EVIDENCE,
  })

  const tamperedRefresh = structuredClone(snapshot)
  ;(tamperedRefresh[0].oneDriveAccounts[0] as Record<string, unknown>)['Report Refresh Date'] = '2026-02-30'
  assert.deepEqual(inspectMicrosoftUsageProjectionEvidence(tamperedRefresh), {
    ...REJECTED_SOURCE_EVIDENCE,
    sharePoint: COMPLETE_SOURCE_EVIDENCE,
    oneDrive: REJECTED_SOURCE_EVIDENCE,
  })
})

test('keeps empty synchronized usage reports partial and all exact report aggregates unknown', () => {
  const contract = buildSharePointDataContract({
    sites: [{
      id: 'tenant.sharepoint.com,site-guid,web-guid',
      displayName: 'Known inventory site',
      webUrl: 'https://tenant.sharepoint.com/sites/known',
    }],
    settings: null,
    settingsSynchronized: false,
    sharePointUsage: [],
    oneDriveUsage: [],
    usageSynchronized: true,
    activityAsOf: new Date('2026-08-19T12:00:00.000Z'),
  })

  assert.equal(contract.usageReports.sharePoint.state, 'partial')
  assert.equal(contract.usageReports.sharePoint.reportRefreshDate, null)
  assert.equal(contract.usageReports.oneDrive.state, 'partial')
  assert.equal(contract.overview.sharePointReportedDeletedCount, null)
  assert.equal(contract.overview.sharePointInactive90Days, null)
  assert.equal(contract.overview.sharePointInactive180Days, null)
  assert.equal(contract.overview.sharePointStorageUsedGB, null)
  assert.equal(contract.overview.oneDriveAccountCount, null)
})

test('rejects mixed-refresh and duplicate report rows for exact aggregates', () => {
  const base = {
    'Report Period': 'D180',
    'Is Deleted': 'False',
    'Storage Used (Byte)': String(GIB),
    'Storage Allocated (Byte)': String(10 * GIB),
  }
  for (const sharePointUsage of [
    [
      { ...base, 'Site Id': 'site-a', 'Site URL': 'https://tenant.sharepoint.com/sites/a', 'Report Refresh Date': '2026-08-18' },
      { ...base, 'Site Id': 'site-b', 'Site URL': 'https://tenant.sharepoint.com/sites/b', 'Report Refresh Date': '2026-08-17' },
    ],
    [
      { ...base, 'Site Id': 'site-a', 'Site URL': 'https://tenant.sharepoint.com/sites/a', 'Report Refresh Date': '2026-08-18' },
      { ...base, 'Site Id': 'site-a', 'Site URL': 'https://tenant.sharepoint.com/sites/a', 'Report Refresh Date': '2026-08-18' },
    ],
  ]) {
    const contract = buildSharePointDataContract({
      sites: [
        { id: 'site-a', webUrl: 'https://tenant.sharepoint.com/sites/a' },
        { id: 'site-b', webUrl: 'https://tenant.sharepoint.com/sites/b' },
      ],
      settings: null,
      settingsSynchronized: false,
      sharePointUsage,
      oneDriveUsage: [],
      usageSynchronized: true,
      activityAsOf: new Date('2026-08-19T12:00:00.000Z'),
    })
    assert.equal(contract.usageReports.sharePoint.state, 'partial')
    assert.equal(contract.overview.sharePointStorageUsedGB, null)
    assert.equal(contract.overview.sharePointReportedDeletedCount, null)
    assert.equal(contract.overview.sharePointInactive90Days, null)
  }
})

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

test('the real usage collector stamps requested periods before an authoritative save', async () => {
  const sharePointCsv = [
    'Report Refresh Date,Site Id,Site URL,Is Deleted,Last Activity Date,Storage Used (Byte),Storage Allocated (Byte),Report Period',
    '2026-08-18,site-guid,https://contoso.sharepoint.com/sites/ops,False,2026-08-17,1073741824,10737418240,180',
  ].join('\r\n')
  const oneDriveCsv = [
    'Report Refresh Date,Site URL,Owner Principal Name,Is Deleted,Last Activity Date,Storage Used (Byte),Storage Allocated (Byte),Report Period',
    '2026-08-18,https://contoso-my.sharepoint.com/personal/alex_contoso_com,alex@contoso.com,False,2026-08-18,1,10,D30',
  ].join('\r\n')
  const saved: unknown[][] = []
  const service = new TenantSyncService(
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
  )
  ;(service as any).runSnapshotSync = async (
    _tenant: unknown,
    _resource: string,
    work: () => Promise<void>,
  ) => work()
  ;(service as any).saveSnapshot = async (...args: unknown[]) => saved.push(args)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => new Response(
    String(input).includes('getSharePointSiteUsageDetail')
      ? sharePointCsv
      : oneDriveCsv,
    { status: 200, headers: { 'content-type': 'text/csv' } },
  )
  try {
    await (service as any).syncSharePointUsage(
      { id: 'tenant-1', organizationId: 'org-1' },
      'graph-token',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(saved.length, 1)
  const collection = saved[0]?.[2] as {
    completeness: string
    rows: Array<Record<string, any>>
  }
  assert.equal(collection.completeness, 'authoritative_complete')
  assert.equal(collection.rows[0]?.hawkviewDataset, MICROSOFT_USAGE_REPORT_DATASET)
  assert.equal(collection.rows[0]?.sharePointSites[0]?.['Report Period'], 'D180')
  assert.equal(collection.rows[0]?.oneDriveAccounts[0]?.['Report Period'], 'D30')
  assert.deepEqual(inspectMicrosoftUsageProjectionEvidence(collection.rows), {
    ...COMPLETE_SOURCE_EVIDENCE,
    sharePoint: COMPLETE_SOURCE_EVIDENCE,
    oneDrive: COMPLETE_SOURCE_EVIDENCE,
  })
})

test('the real usage collector refuses an unexpected period before baseline save', async () => {
  let saved = false
  const service = new TenantSyncService(
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
  )
  ;(service as any).runSnapshotSync = async (
    _tenant: unknown,
    _resource: string,
    work: () => Promise<void>,
  ) => work()
  ;(service as any).saveSnapshot = async () => { saved = true }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => new Response(
    String(input).includes('getSharePointSiteUsageDetail')
      ? 'Report Refresh Date,Report Period\r\n2026-08-18,ALL'
      : 'Report Refresh Date,Report Period\r\n2026-08-18,30',
    { status: 200, headers: { 'content-type': 'text/csv' } },
  )
  try {
    await assert.rejects(
      () => (service as any).syncSharePointUsage(
        { id: 'tenant-1', organizationId: 'org-1' },
        'graph-token',
      ),
      /unexpected Report Period/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(saved, false)
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
  assert.equal(contract.overview.sharePointSitesMissingReportedOwner, null)
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
  assert.equal(contract.overview.sharePointInactive90Days, null)
  assert.equal(contract.overview.sharePointInactive180Days, null)
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
          'Report Period': '180',
          'Report Refresh Date': '2026-08-18',
          'Site Id': 'site-guid',
          'Site URL': 'https://contoso.sharepoint.com/sites/operations',
          'Is Deleted': 'False',
          'Last Activity Date': '2026-01-01',
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
  assert.equal(sharePoint.dataContract.overview.sharePointInactive90Days, 1)
  assert.equal(sharePoint.overview.inactiveSites90Days, 1)
  assert.doesNotMatch(JSON.stringify(sharePoint.dataContract), /must-not-enter-the-contract|access_token/)

  ;(snapshots[2] as any).payload[0].sharePointSites[0]['Report Period'] = 'ALL'
  const invalid = await (service as any).buildBundle({
    id: expectedScope.customerTenantId,
    organizationId: expectedScope.organizationId,
    microsoftTenantId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Contoso',
    primaryDomain: 'contoso.com',
    status: 'CONNECTED',
    connection: { lastVerifiedAt: successfulAt },
  })
  assert.equal(invalid.bundle.sharepoint.dataContract.usageReports.sharePoint.state, 'partial')
  assert.equal(invalid.bundle.sharepoint.dataContract.overview.sharePointInactive90Days, null)
  assert.equal(invalid.bundle.sharepoint.overview.inactiveSites90Days, null)

  const usageV2 = (sharePointRefresh: string, oneDriveRefresh: string) => buildMicrosoftUsageReportSnapshot(
    [{
      'Report Period': 'D180',
      'Report Refresh Date': sharePointRefresh,
      'Site Id': 'site-guid',
      'Site URL': 'https://contoso.sharepoint.com/sites/operations',
      'Is Deleted': 'False',
      'Last Activity Date': '2026-01-01',
      'Storage Used (Byte)': String(GIB),
      'Storage Allocated (Byte)': String(10 * GIB),
    }],
    [{
      'Report Period': 'D30',
      'Report Refresh Date': oneDriveRefresh,
      'Site URL': 'https://contoso-my.sharepoint.com/personal/alex_contoso_com',
      'Owner Principal Name': 'alex@contoso.com',
      'Is Deleted': 'False',
      'Storage Used (Byte)': String(GIB),
      'Storage Allocated (Byte)': String(10 * GIB),
    }],
  )
  for (const [sharePointRefresh, oneDriveRefresh] of [
    ['2026-08-17', '2026-08-18'],
    ['2026-08-18', '2026-08-17'],
  ]) {
    ;(snapshots[2] as any).payload = usageV2(sharePointRefresh, oneDriveRefresh)
    const independentlyRefreshed = await (service as any).buildBundle({
      id: expectedScope.customerTenantId,
      organizationId: expectedScope.organizationId,
      microsoftTenantId: '11111111-1111-4111-8111-111111111111',
      displayName: 'Contoso',
      primaryDomain: 'contoso.com',
      status: 'CONNECTED',
      connection: { lastVerifiedAt: successfulAt },
    })
    assert.equal(independentlyRefreshed.bundle.sharepoint.dataContract.usageReports.sharePoint.state, 'available')
    assert.equal(independentlyRefreshed.bundle.sharepoint.dataContract.usageReports.oneDrive.state, 'available')
  }

  const tamperedV2 = usageV2('2026-08-18', '2026-08-18')
  tamperedV2[0].projectionEvidence.sharePoint.rowCount = 999
  ;(snapshots[2] as any).payload = tamperedV2
  const rejectedSource = await (service as any).buildBundle({
    id: expectedScope.customerTenantId,
    organizationId: expectedScope.organizationId,
    microsoftTenantId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Contoso',
    primaryDomain: 'contoso.com',
    status: 'CONNECTED',
    connection: { lastVerifiedAt: successfulAt },
  })
  assert.equal(rejectedSource.bundle.sharepoint.dataContract.usageReports.sharePoint.state, 'partial')
  assert.equal(rejectedSource.bundle.sharepoint.dataContract.overview.sharePointStorageUsedGB, null)
  assert.equal(rejectedSource.bundle.sharepoint.dataContract.overview.sharePointInactive90Days, null)
  assert.equal(rejectedSource.bundle.sharepoint.dataContract.usageReports.oneDrive.state, 'available')
  assert.equal(rejectedSource.bundle.sharepoint.dataContract.overview.oneDriveAccountCount, 1)
})

test('tenant-list mapping uses only tenant-scoped compact projection fields', () => {
  const service = new TenantsService(
    {} as never,
    {
      getRequiredPermissions: () => [{ name: 'Reports.Read.All' }],
      getAccessContract: () => ({ connectionRequiredPermissions: [] }),
    } as never,
    {} as never,
  )
  const current = new Date()
  const tenant = {
    id: 'tenant-a',
    microsoftTenantId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Tenant A',
    primaryDomain: 'tenant-a.example',
    status: 'ACTIVE',
    organization: { id: 'org-a', name: 'Org A', slug: 'org-a' },
    connection: {
      connectionMode: 'HAWKVIEW_MANAGED',
      status: 'ACTIVE',
      consentedPermissions: ['Reports.Read.All'],
      lastVerifiedAt: current,
      lastErrorCode: null,
    },
    tenantLicenses: [{
      enabledUnits: 1,
      servicePlans: [{ servicePlanName: 'SHAREPOINTENTERPRISE', provisioningStatus: 'Success' }],
    }],
    syncStates: ['LICENSES', 'SHAREPOINT_SITES', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE'].map((resourceType) => ({
      resourceType,
      status: 'SUCCEEDED',
      lastAttemptAt: current,
      lastSuccessfulAt: current,
      lastErrorCode: null,
      lastErrorMessage: null,
      consecutiveFailures: 0,
    })),
    entraSnapshots: [],
    collectionFieldStates: [
      { fieldKey: 'sharepoint.usage-projection', state: 'AVAILABLE', reasonCode: null },
      { fieldKey: 'onedrive.usage-projection', state: 'PENDING', reasonCode: 'USAGE_PROJECTION_EVIDENCE_INCOMPLETE' },
    ],
    m365ActivitySubscriptions: [],
  }
  const mapped = (service as any).mapTenant(tenant)
  const datasets = mapped.collectionReadiness.workloads.find(
    (workload: any) => workload.key === 'sharepoint_onedrive',
  ).datasets
  assert.equal(datasets.find((dataset: any) => dataset.key === 'sharepoint_usage_reports').state, 'READY')
  assert.equal(datasets.find((dataset: any) => dataset.key === 'onedrive_usage_reports').state, 'PARTIAL')

  const otherTenant = (service as any).mapTenant({
    ...tenant,
    id: 'tenant-b',
    organization: { id: 'org-b', name: 'Org B', slug: 'org-b' },
    collectionFieldStates: [],
  })
  const otherDatasets = otherTenant.collectionReadiness.workloads.find(
    (workload: any) => workload.key === 'sharepoint_onedrive',
  ).datasets
  assert.equal(otherDatasets.find((dataset: any) => dataset.key === 'sharepoint_usage_reports').state, 'UNVERIFIED')
  assert.equal(otherDatasets.find((dataset: any) => dataset.key === 'onedrive_usage_reports').state, 'UNVERIFIED')
})

test('materializes tenant-scoped SharePoint and OneDrive projection proof into bounded field rows', async () => {
  const scope = { organizationId: 'org-a', customerTenantId: 'tenant-a' }
  const payload = buildMicrosoftUsageReportSnapshot(
    [{ 'Report Period': '180', 'Report Refresh Date': '2026-08-18', 'Site URL': 'https://tenant.sharepoint.com/sites/ops' }],
    [],
  )
  const writes: any[] = []
  const prisma = {
    syncState: {
      findMany: async ({ where }: any) => {
        assert.deepEqual(where, scope)
        return [{
          resourceType: 'SHAREPOINT_USAGE', status: 'SUCCEEDED',
          lastAttemptAt: new Date('2026-08-19T12:00:00.000Z'),
          lastSuccessfulAt: new Date('2026-08-19T12:00:00.000Z'),
          lastErrorMessage: null,
        }]
      },
    },
    tenantEntraSnapshot: {
      findMany: async ({ where, select }: any) => {
        assert.deepEqual(where, scope)
        assert.deepEqual(select, { resourceType: true, payload: true })
        return [{ resourceType: 'SHAREPOINT_USAGE', payload }]
      },
    },
    tenantCollectionFieldState: {
      upsert: async (args: any) => writes.push(args),
    },
  }
  const service = new TenantSyncService(
    prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never,
  )
  await (service as any).refreshCollectionFieldStates({ id: scope.customerTenantId, organizationId: scope.organizationId })

  const sharePoint = writes.find((write) => write.create.fieldKey === 'sharepoint.usage-projection')
  const oneDrive = writes.find((write) => write.create.fieldKey === 'onedrive.usage-projection')
  assert.equal(sharePoint.create.organizationId, scope.organizationId)
  assert.equal(sharePoint.create.customerTenantId, scope.customerTenantId)
  assert.equal(sharePoint.create.state, 'AVAILABLE')
  assert.equal(sharePoint.create.reasonCode, null)
  assert.equal(oneDrive.create.state, 'PENDING')
  assert.equal(oneDrive.create.reasonCode, 'USAGE_PROJECTION_EVIDENCE_INCOMPLETE')
})
