import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  buildSharePointViewModel,
  sharePointReportedDeletedState,
  sharePointRetentionDaysLabel,
} from './sharepoint-view-model.ts'

test('maps the P0-7 contract to the fields consumed by the approved SharePoint UI', () => {
  const view = buildSharePointViewModel({
    dataContract: {
      contractVersion: 2,
      projection: {
        sites: { inputRows: 1, projectedRows: 1, invalidRows: 0, truncated: false },
        sharePointUsage: { inputRows: 1, projectedRows: 1, invalidRows: 0, truncated: false },
        oneDriveUsage: { inputRows: 1, projectedRows: 1, invalidRows: 0, truncated: false },
      },
      overview: {
        sharePointSiteCount: 1,
        sharePointStorageUsedGB: 2,
        sharePointReportedAllocationGB: 20,
        sharePointInactive90Days: 1,
        sharePointInactive180Days: 0,
        sharePointSitesMissingReportedOwner: 0,
        sharePointSitesWithMatchedUsage: 1,
        sharePointSitesWithoutMatchedUsage: 0,
        sharePointReportedDeletedCount: 1,
      },
      tenantSettings: {
        externalSharing: {
          capability: 'externalUserAndGuestSharing',
          domainRestrictionMode: 'allowList',
          allowedDomains: ['contoso.com'],
          requireAcceptingUserToMatchInvitedUser: true,
        },
        accessAndSession: { legacyAuthProtocolsEnabled: false },
        storageAndLifecycle: { defaultOneDriveStorageLimitGB: 1024 },
        siteCreation: { enabled: true, uiEnabled: true },
        collaborationAndContent: { commentingOnSitePagesEnabled: true },
        sync: { unmanagedSyncAppRestricted: true, personalSiteSyncButtonHidden: false },
        notifications: { fileActivityEnabled: true },
      },
      usageReports: {
        sharePoint: { state: 'available', reportRefreshDate: '2026-08-18', identifiersConcealed: false },
        oneDrive: { state: 'available', reportRefreshDate: '2026-08-18' },
      },
      sites: [{
        id: 'site-1', name: 'Operations', url: 'https://contoso.sharepoint.com/sites/operations', siteType: 'Microsoft 365 group site',
        usage: { ownerDisplayName: 'Alex Admin', hasReportedOwner: true, fileCount: 120, pageViewCount: 300, storageUsedGB: 2, storageAllocatedGB: 20, lastActivityAt: '2026-08-17', activityAgeDays: 1, activityState: 'reported', reportRefreshDate: '2026-08-18', reportPeriod: 'D180', microsoftReportedDeleted: false },
      }],
      reportedDeletedSites: [{ id: 'deleted-1', name: 'Old site', url: 'https://contoso.sharepoint.com/sites/old', reportPeriod: 'D180' }],
      oneDriveAccounts: [{
        id: 'od-1', url: 'https://contoso-my.sharepoint.com/personal/alex_contoso_com',
        ownerDisplayName: 'Alex Admin', ownerPrincipalName: 'alex@contoso.com',
        storageUsedGB: 1, storageAllocatedGB: 10, storageUtilizationPercent: 10,
        lastActivityAt: '2026-08-18', activityAgeDays: 0, activityState: 'reported',
        reportRefreshDate: '2026-08-18', reportPeriod: 'D30', microsoftReportedDeleted: false,
      }],
    },
    sync: {
      sites: { status: 'success', lastAttemptAt: '2026-08-19T12:00:00Z', lastSuccessfulAt: '2026-08-19T12:00:00Z' },
      settings: { status: 'success', lastAttemptAt: '2026-08-19T12:00:00Z', lastSuccessfulAt: '2026-08-19T12:00:00Z' },
      usage: { status: 'success', lastAttemptAt: '2026-08-19T12:00:00Z', lastSuccessfulAt: '2026-08-19T12:00:00Z' },
    },
  })

  assert.equal(view.sites[0]?.type, 'Microsoft 365 group site')
  assert.equal(view.sites[0]?.ownerDisplayName, 'Alex Admin')
  assert.equal(view.sites[0]?.fileCount, 120)
  assert.equal(view.sites[0]?.pageViews, 300)
  assert.equal(view.sites[0]?.activityAgeDays, 1)
  assert.equal(view.overview.reportedStorageUsedGB, 2)
  assert.equal(view.overview.sitesWithMatchedUsage, 1)
  assert.equal(view.overview.reportedDeletedCount, 1)
  assert.equal(view.reportedDeletedSites.length, 1)
  assert.equal(view.siteTableRows.length, 2)
  assert.equal(view.tenantSettings.personalSiteDefaultStorageLimitInMB, 1024 * 1024)
  assert.equal(view.tenantSettings.isLegacyAuthProtocolsEnabled, false)
  assert.equal(view.tenantSettings.isSiteCreationEnabled, true)
  assert.equal(view.tenantSettings.isUnmanagedSyncAppForTenantRestricted, true)
  assert.equal(view.oneDriveAccounts[0]?.type, 'OneDrive')
  assert.equal(view.oneDriveAccounts[0]?.storageQuotaGB, 10)
  assert.equal(view.oneDriveUsageReport.exactClaimsAvailable, true)
  assert.equal(view.reportPrivacy.identifiersConcealed, false)
  assert.equal(view.reportPrivacy.concealedSiteCount, 0)
  assert.equal(view.sync.status, 'success')
  assert.equal(view.inventory.countLabel, '1')
})

test('explains Microsoft-concealed report identifiers without calling them missing permissions', () => {
  const view = buildSharePointViewModel({
    dataContract: {
      contractVersion: 2,
      projection: {
        sites: { inputRows: 2, projectedRows: 2, invalidRows: 0, truncated: false },
        sharePointUsage: { inputRows: 2, projectedRows: 2, invalidRows: 0, truncated: false },
        oneDriveUsage: { inputRows: 1, projectedRows: 1, invalidRows: 0, truncated: false },
      },
      usageReports: {
        sharePoint: { state: 'available', reportRefreshDate: '2026-08-18', identifiersConcealed: true },
        oneDrive: { state: 'available', reportRefreshDate: '2026-08-18' },
      },
      overview: {
        sharePointSiteCount: 2,
        sharePointSitesWithMatchedUsage: 0,
        sharePointSitesWithoutMatchedUsage: 2,
      },
      sites: [
        {
          id: 'site-1',
          name: 'Operations',
          url: 'https://contoso.sharepoint.com/sites/operations',
          usageReportMatch: 'identifiers-concealed',
          usage: {},
        },
        {
          id: 'site-2',
          name: 'Projects',
          url: 'https://contoso.sharepoint.com/sites/projects',
          usageReportMatch: 'identifiers-concealed',
          usage: {},
        },
      ],
      oneDriveAccounts: [{
        id: 'od-1',
        ownerPrincipalName: 'alex@contoso.com',
        reportRefreshDate: '2026-08-18',
        reportPeriod: 'D30',
      }],
    },
  })

  assert.equal(view.reportPrivacy.identifiersConcealed, true)
  assert.equal(view.reportPrivacy.concealedSiteCount, 2)
  assert.equal(view.reportPrivacy.limitation, 'microsoft-report-identifiers-concealed')
  assert.equal(view.sites.every((site) => site.activityDataStatus === 'identifiers-concealed'), true)
})

test('supports the current legacy backend DTO without inventing activity or owner data', () => {
  const view = buildSharePointViewModel({
    overview: { totalSites: 1, sharingSharePoint: 'externalUserSharingOnly' },
    tenantSettings: { sharingCapability: 'externalUserSharingOnly' },
    sites: [{
      id: 'site-1', name: 'Legacy', url: 'https://contoso.sharepoint.com/sites/legacy', type: 'SharePoint site',
      ownerDisplayName: 'Legacy Owner', hasReportedOwner: true, storageUsedGB: 1, storageQuotaGB: 5,
      lastActivityAt: null, activityAgeDays: null, activityStatus: 'unknown',
    }],
  })
  assert.equal(view.overview.totalSites, 1)
  assert.equal(view.overview.sharingCapability, 'externalUserSharingOnly')
  assert.equal(view.sites[0]?.ownerDisplayName, null)
  assert.equal(view.sites[0]?.storageUsedGB, null)
  assert.equal(view.sites[0]?.activityAgeDays, null)
})

test('fails closed for prototype objects, oversized values, and invalid URLs', () => {
  const inherited = Object.create({ id: 'inherited', name: 'unsafe' })
  const view = buildSharePointViewModel({
    sites: [
      inherited,
      { id: 'safe', name: 'Safe', url: 'javascript:alert(1)', storageUsedGB: 1e308, activityAgeDays: -1 },
    ],
  })
  assert.equal(view.sites.length, 1)
  assert.equal(view.sites[0]?.url, null)
  assert.equal(view.sites[0]?.storageUsedGB, null)
  assert.equal(view.sites[0]?.activityAgeDays, null)
})

test('marks capped contract projections partial and reports an at-least count', () => {
  const sites = Array.from({ length: 10_001 }, (_, index) => ({
    id: `site-${index}`,
    name: `Site ${index}`,
    url: `https://contoso.sharepoint.com/sites/site-${index}`,
  }))
  const view = buildSharePointViewModel({
    dataContract: {
      contractVersion: 2,
      projection: {
        sites: { inputRows: 10_001, projectedRows: 10_001, invalidRows: 0, truncated: false },
        sharePointUsage: { inputRows: 0, projectedRows: 0, invalidRows: 0, truncated: false },
        oneDriveUsage: { inputRows: 0, projectedRows: 0, invalidRows: 0, truncated: false },
      },
      sites,
    },
    sync: {
      sites: { status: 'succeeded' },
      settings: { status: 'succeeded' },
      usage: { status: 'succeeded' },
    },
  })
  assert.equal(view.sites.length, 10_000)
  assert.equal(view.inventory.projectionComplete, false)
  assert.equal(view.inventory.countLabel, '10000+')
  assert.equal(view.sync.status, 'partial')
})

test('does not revive legacy usage facts when the canonical contract fails closed', () => {
  const sites = Array.from({ length: 30 }, (_, index) => ({
    id: `site-${index}`,
    name: `Site ${index}`,
    url: `https://contoso.sharepoint.com/sites/site-${index}`,
    usageReportMatch: 'unmatched',
    usage: {
      lastActivityAt: null,
      activityAgeDays: null,
      reportRefreshDate: null,
      storageUsedGB: null,
      storageAllocatedGB: null,
    },
    bestEffortDefaultDriveQuota: {
      usedGB: 1,
      totalGB: 10,
      authoritativeForSiteAllocation: false,
    },
  }))
  const view = buildSharePointViewModel({
    dataContract: {
      contractVersion: 2,
      projection: {
        sites: { inputRows: 30, projectedRows: 30, invalidRows: 0, truncated: false },
        sharePointUsage: { inputRows: 14, projectedRows: 14, invalidRows: 1, truncated: false },
        oneDriveUsage: { inputRows: 0, projectedRows: 0, invalidRows: 0, truncated: false },
      },
      overview: {
        sharePointStorageUsedGB: null,
        sharePointReportedAllocationGB: null,
        sharePointInactive90Days: null,
        sharePointInactive180Days: null,
        sharePointSitesMissingReportedOwner: null,
        sharePointSitesWithMatchedUsage: null,
        sharePointSitesWithoutMatchedUsage: null,
        sharePointReportedDeletedCount: 14,
      },
      usageReports: { sharePoint: { state: 'partial', reportRefreshDate: null } },
      sites,
    },
    overview: {
      totalStorageQuotaGB: 999,
      inactiveSites90Days: 14,
      inactiveSites180Days: 10,
      sitesWithoutActivityData: 16,
      sitesMissingReportedOwner: 30,
    },
    reportRefreshedAt: '2026-08-01',
    deletedSites: [{ id: 'legacy-deleted', name: 'Legacy deleted signal' }],
    sync: {
      sites: { status: 'success' },
      settings: { status: 'success' },
      usage: { status: 'success' },
    },
  })

  assert.equal(view.contractPresent, true)
  assert.equal(view.overview.reportedStorageUsedGB, null)
  assert.equal(view.overview.totalStorageQuotaGB, null)
  assert.equal(view.overview.inactiveSites90Days, null)
  assert.equal(view.overview.inactiveSites180Days, null)
  assert.equal(view.overview.sitesWithoutActivityData, null)
  assert.equal(view.overview.sitesMissingReportedOwner, null)
  assert.equal(view.overview.sitesWithMatchedUsage, null)
  assert.equal(view.overview.reportedDeletedCount, null)
  assert.equal(view.sync.reportRefreshedAt, null)
  assert.equal(view.usageReport.projectionComplete, false)
  assert.equal(view.usageReport.exactClaimsAvailable, false)
  assert.equal(view.reportedDeletedSites.length, 0)
  assert.equal(view.sites.filter((site) => site.lastActivityAt).length, 0)
  assert.equal(view.sites[0]?.reportedStorageUsedGB, null)
  assert.equal(view.sites[0]?.bestEffortDriveStorageUsedGB, 1)
  assert.equal(view.sites[0]?.storageUsedSource, 'graph-default-drive-best-effort')
  assert.equal(view.inventory.countLabel, '30')
  assert.equal(view.inventory.countAtLeast, false)
  assert.equal(view.sync.status, 'partial')
})

test('uses canonical usage matches and marks plus counts only for inventory truncation', () => {
  const view = buildSharePointViewModel({
    dataContract: {
      contractVersion: 2,
      projection: {
        sites: { inputRows: 2, projectedRows: 2, invalidRows: 0, truncated: false },
        sharePointUsage: { inputRows: 2, projectedRows: 2, invalidRows: 0, truncated: false },
        oneDriveUsage: { inputRows: 1, projectedRows: 0, invalidRows: 1, truncated: false },
      },
      overview: {
        sharePointSitesWithMatchedUsage: 1,
        sharePointSitesWithoutMatchedUsage: 1,
      },
      usageReports: { sharePoint: { state: 'available', reportRefreshDate: '2026-08-18' } },
      sites: [
        { id: 'one', url: 'https://contoso.sharepoint.com/sites/one' },
        { id: 'two', url: 'https://contoso.sharepoint.com/sites/two' },
      ],
    },
    sync: {
      sites: { status: 'success' },
      settings: { status: 'success' },
      usage: { status: 'success' },
    },
  })

  assert.equal(view.overview.sitesWithMatchedUsage, 1)
  assert.equal(view.overview.sitesWithoutMatchedUsage, 1)
  assert.equal(view.inventory.countLabel, '2')
  assert.equal(view.inventory.countAtLeast, false)
  assert.equal(view.inventory.projectionComplete, true)
  assert.equal(view.usageReport.projectionComplete, true)
  assert.equal(view.sync.status, 'partial')
})

test('requires canonical available report state, observed refresh, and complete usage projection for exact claims', () => {
  const base = {
    contractVersion: 2,
    projection: {
      sites: { inputRows: 1, projectedRows: 1, invalidRows: 0, truncated: false },
      sharePointUsage: { inputRows: 1, projectedRows: 1, invalidRows: 0, truncated: false },
      oneDriveUsage: { inputRows: 0, projectedRows: 0, invalidRows: 0, truncated: false },
    },
    overview: {
      sharePointInactive90Days: 1,
      sharePointStorageUsedGB: 5,
      sharePointSitesWithMatchedUsage: 1,
    },
    sites: [{
      id: 'site-1',
      url: 'https://contoso.sharepoint.com/sites/one',
      // Hostile legacy-shaped top-level values must not be revived in contract mode.
      storageUsedGB: 99,
      lastActivityAt: '2020-01-01',
      activityAgeDays: 2_000,
      ownerDisplayName: 'Legacy owner',
    }],
  }

  for (const [sharePoint, expectedRefresh] of [
    [{ state: 'partial', reportRefreshDate: '2026-08-18' }, '2026-08-18'],
    [{ state: 'available', reportRefreshDate: null }, null],
    [{ state: 'available', reportRefreshDate: '2999-01-01' }, null],
    [{ state: 'available', reportRefreshDate: '0' }, null],
    [{ state: 'available', reportRefreshDate: '2026-02-30' }, null],
    [{ state: 'available', reportRefreshDate: '08/18/2026' }, null],
  ]) {
    const view = buildSharePointViewModel({
      dataContract: { ...base, usageReports: { sharePoint } },
      reportRefreshedAt: '2026-08-01',
    })
    assert.equal(view.usageReport.projectionComplete, false)
    assert.equal(view.usageReport.exactClaimsAvailable, false)
    assert.equal(view.sync.reportRefreshedAt, expectedRefresh)
    assert.equal(view.overview.inactiveSites90Days, null)
    assert.equal(view.overview.reportedStorageUsedGB, null)
    assert.equal(view.overview.sitesWithMatchedUsage, null)
    assert.equal(view.sites[0]?.storageUsedGB, null)
    assert.equal(view.sites[0]?.lastActivityAt, null)
    assert.equal(view.sites[0]?.ownerDisplayName, null)
  }

  const canonicalIso = buildSharePointViewModel({
    dataContract: {
      ...base,
      usageReports: { sharePoint: { state: 'available', reportRefreshDate: '2026-08-18T12:00:00.000Z' } },
    },
  })
  assert.equal(canonicalIso.usageReport.projectionComplete, true)
  assert.equal(canonicalIso.usageReport.exactClaimsAvailable, true)
  assert.equal(canonicalIso.sync.reportRefreshedAt, '2026-08-18T12:00:00.000Z')
})

test('accepts exact legacy D180 claims only with independently validated report evidence', () => {
  const view = buildSharePointViewModel({
    reportRefreshedAt: '2026-08-18',
    overview: {
      totalSites: 1,
      totalStorageQuotaGB: 5,
      inactiveSites90Days: 1,
      inactiveSites180Days: 0,
      sitesMissingReportedOwner: 0,
    },
    sites: [{
      id: 'legacy-1',
      name: 'Legacy with evidence',
      url: 'https://contoso.sharepoint.com/sites/legacy',
      ownerDisplayName: 'Legacy Owner',
      hasReportedOwner: true,
      storageUsedGB: 1,
      storageQuotaGB: 5,
      lastActivityAt: '2026-01-01',
      activityAgeDays: 229,
      activitySource: 'microsoft-d180-report',
      reportPeriod: 'D180',
      reportRefreshedAt: '2026-08-18',
    }],
  })

  assert.equal(view.usageReport.exactClaimsAvailable, true)
  assert.equal(view.sync.reportRefreshedAt, '2026-08-18')
  assert.equal(view.overview.inactiveSites90Days, 1)
  assert.equal(view.overview.totalStorageQuotaGB, 5)
  assert.equal(view.sites[0]?.ownerDisplayName, 'Legacy Owner')
  assert.equal(view.sites[0]?.storageUsedGB, 1)
  assert.equal(view.sites[0]?.activityAgeDays, 229)
})

test('rejects malformed or incoherent legacy D180 evidence dates', () => {
  for (const [reportRefreshedAt, lastActivityAt, expectedRefresh] of [
    ['0', '2026-01-01', null],
    ['2026-02-30', '2026-01-01', null],
    ['08/18/2026', '2026-01-01', null],
    ['2026-08-18', '2026-02-30', '2026-08-18'],
    ['2026-08-18', '2999-01-01', '2026-08-18'],
    ['2026-08-18', '2026-08-19', '2026-08-18'],
  ]) {
    const view = buildSharePointViewModel({
      reportRefreshedAt,
      overview: { inactiveSites90Days: 1, totalStorageQuotaGB: 5 },
      sites: [{
        id: 'legacy-1',
        url: 'https://contoso.sharepoint.com/sites/legacy',
        storageUsedGB: 1,
        storageQuotaGB: 5,
        lastActivityAt,
        activityAgeDays: 229,
        activitySource: 'microsoft-d180-report',
        reportPeriod: 'D180',
        reportRefreshedAt,
      }],
    })
    assert.equal(view.usageReport.exactClaimsAvailable, false)
    assert.equal(view.sync.reportRefreshedAt, expectedRefresh)
    assert.equal(view.overview.inactiveSites90Days, null)
    assert.equal(view.overview.totalStorageQuotaGB, null)
    assert.equal(view.sites[0]?.storageUsedGB, null)
    assert.equal(view.sites[0]?.lastActivityAt, null)
  }
})

test('only exact numeric data-contract version 2 can authorize canonical usage facts', () => {
  for (const contractVersion of [undefined, '2', 0, 1, 3, 999]) {
    const view = buildSharePointViewModel({
      dataContract: {
        contractVersion,
        projection: {
          sites: { inputRows: 1, projectedRows: 1, invalidRows: 0, truncated: false },
          sharePointUsage: { inputRows: 1, projectedRows: 1, invalidRows: 0, truncated: false },
          oneDriveUsage: { inputRows: 0, projectedRows: 0, invalidRows: 0, truncated: false },
        },
        usageReports: { sharePoint: { state: 'available', reportRefreshDate: '2026-08-18' } },
        overview: {
          sharePointStorageUsedGB: 999,
          sharePointInactive90Days: 1,
          sharePointSitesWithMatchedUsage: 1,
        },
        sites: [{
          id: 'safe-inventory',
          name: 'Safe inventory identity',
          url: 'https://contoso.sharepoint.com/sites/safe',
          usage: {
            storageUsedGB: 999,
            ownerDisplayName: 'Untrusted version owner',
            lastActivityAt: '2026-01-01',
            activityAgeDays: 229,
            reportRefreshDate: '2026-08-18',
            reportPeriod: 'D180',
          },
        }],
      },
      // The mere presence of an unsupported contract is an authority boundary;
      // these legacy values must not be revived as a fallback.
      overview: { inactiveSites90Days: 77, totalStorageQuotaGB: 777 },
      reportRefreshedAt: '2026-08-18',
    })

    assert.equal(view.contractPresent, true)
    assert.equal(view.inventory.projectionComplete, false)
    assert.equal(view.usageReport.projectionComplete, false)
    assert.equal(view.usageReport.exactClaimsAvailable, false)
    assert.equal(view.sync.reportRefreshedAt, null)
    assert.equal(view.overview.reportedStorageUsedGB, null)
    assert.equal(view.overview.inactiveSites90Days, null)
    assert.equal(view.overview.totalStorageQuotaGB, null)
    assert.equal(view.sites[0]?.name, 'Safe inventory identity')
    assert.equal(view.sites[0]?.storageUsedGB, null)
    assert.equal(view.sites[0]?.ownerDisplayName, null)
    assert.equal(view.sites[0]?.lastActivityAt, null)
  }
})

test('OneDrive account totals require their own available, observed, complete projection', () => {
  const base = {
    contractVersion: 2,
    projection: {
      sites: { inputRows: 0, projectedRows: 0, invalidRows: 0, truncated: false },
      sharePointUsage: { inputRows: 0, projectedRows: 0, invalidRows: 0, truncated: false },
      oneDriveUsage: { inputRows: 1, projectedRows: 1, invalidRows: 0, truncated: false },
    },
    usageReports: {
      sharePoint: { state: 'available', reportRefreshDate: '2026-08-18' },
      oneDrive: { state: 'partial', reportRefreshDate: '2026-08-18' },
    },
    oneDriveAccounts: [{
      id: 'tampered-account',
      ownerPrincipalName: 'alex@contoso.com',
      storageUsedGB: 999,
      reportRefreshDate: '2026-08-18',
      reportPeriod: 'D30',
    }],
  }
  const partial = buildSharePointViewModel({ dataContract: base })
  assert.equal(partial.oneDriveUsageReport.exactClaimsAvailable, false)
  assert.equal(partial.oneDriveAccounts.length, 0)
  assert.equal(partial.sync.status, 'partial')

  const invalidRefresh = buildSharePointViewModel({
    dataContract: {
      ...base,
      usageReports: {
        ...base.usageReports,
        oneDrive: { state: 'available', reportRefreshDate: '2026-02-30' },
      },
    },
  })
  assert.equal(invalidRefresh.oneDriveUsageReport.exactClaimsAvailable, false)
  assert.equal(invalidRefresh.oneDriveAccounts.length, 0)
})

test('legacy OneDrive rows never become exact account or usage claims from presence alone', () => {
  const view = buildSharePointViewModel({
    oneDriveAccounts: [{
      id: 'legacy-unproven',
      ownerPrincipalName: 'alex@contoso.com',
      storageUsedGB: 999,
      storageAllocatedGB: 1_000,
      lastActivityAt: '2000-01-01',
      activityAgeDays: 9_000,
    }],
    collection: {
      reports: { refreshedAt: '2026-08-18' },
    },
  })

  assert.equal(view.contractPresent, false)
  assert.equal(view.oneDriveUsageReport.exactClaimsAvailable, false)
  assert.equal(view.oneDriveAccounts.length, 0)
})

test('available zero-row usage sources cannot authorize exact tenant metrics', () => {
  const sites = Array.from({ length: 30 }, (_, index) => ({
    id: `site-${index}`,
    name: `Site ${index}`,
    url: `https://contoso.sharepoint.com/sites/site-${index}`,
  }))
  const view = buildSharePointViewModel({
    dataContract: {
      contractVersion: 2,
      projection: {
        sites: { inputRows: 30, projectedRows: 30, invalidRows: 0, truncated: false },
        sharePointUsage: { inputRows: 0, projectedRows: 0, invalidRows: 0, truncated: false },
        oneDriveUsage: { inputRows: 0, projectedRows: 0, invalidRows: 0, truncated: false },
      },
      usageReports: {
        sharePoint: { state: 'available', reportRefreshDate: '2026-08-18' },
        oneDrive: { state: 'available', reportRefreshDate: '2026-08-18' },
      },
      overview: {
        sharePointStorageUsedGB: 999,
        sharePointReportedAllocationGB: 9_999,
        sharePointInactive90Days: 14,
        sharePointSitesWithMatchedUsage: 14,
      },
      sites,
      oneDriveAccounts: [{ id: 'unproven', ownerPrincipalName: 'alex@contoso.com', storageUsedGB: 999 }],
    },
    sync: {
      sites: { status: 'success' },
      settings: { status: 'success' },
      usage: { status: 'success' },
    },
  })

  assert.equal(view.inventory.projectionComplete, true)
  assert.equal(view.inventory.countLabel, '30')
  assert.equal(view.usageReport.exactClaimsAvailable, false)
  assert.equal(view.oneDriveUsageReport.exactClaimsAvailable, false)
  assert.equal(view.overview.reportedStorageUsedGB, null)
  assert.equal(view.overview.totalStorageQuotaGB, null)
  assert.equal(view.overview.inactiveSites90Days, null)
  assert.equal(view.overview.sitesWithMatchedUsage, null)
  assert.equal(view.oneDriveAccounts.length, 0)
  assert.equal(view.sync.status, 'partial')
})

test('one valid legacy D180 row never authorizes an unproven sibling or aggregate', () => {
  const view = buildSharePointViewModel({
    reportRefreshedAt: '2026-08-18',
    overview: { totalStorageQuotaGB: 1_004, inactiveSites90Days: 2 },
    sites: [
      {
        id: 'valid',
        url: 'https://contoso.sharepoint.com/sites/valid',
        ownerDisplayName: 'Reported owner',
        storageUsedGB: 1,
        storageQuotaGB: 5,
        lastActivityAt: '2026-01-01',
        activityAgeDays: 229,
        activitySource: 'microsoft-d180-report',
        reportPeriod: 'D180',
        reportRefreshedAt: '2026-08-18',
      },
      {
        id: 'unproven',
        url: 'https://contoso.sharepoint.com/sites/unproven',
        ownerDisplayName: 'Fabricated legacy owner',
        storageUsedGB: 999,
        storageQuotaGB: 999,
        lastActivityAt: '2000-01-01',
        activityAgeDays: 9_000,
      },
    ],
  })

  assert.equal(view.usageReport.exactClaimsAvailable, false)
  assert.equal(view.overview.totalStorageQuotaGB, null)
  assert.equal(view.overview.inactiveSites90Days, null)
  assert.equal(view.sites[0]?.storageUsedGB, 1)
  assert.equal(view.sites[0]?.ownerDisplayName, 'Reported owner')
  assert.equal(view.sites[1]?.storageUsedGB, null)
  assert.equal(view.sites[1]?.lastActivityAt, null)
  assert.equal(view.sites[1]?.ownerDisplayName, null)
})

test('legacy aggregate evidence requires every D180 row to share the coherent refresh day', () => {
  const view = buildSharePointViewModel({
    reportRefreshedAt: '2026-08-18',
    overview: { totalStorageQuotaGB: 10, inactiveSites90Days: 2 },
    sites: [
      {
        id: 'one',
        url: 'https://contoso.sharepoint.com/sites/one',
        storageQuotaGB: 5,
        activitySource: 'microsoft-d180-report',
        reportPeriod: 'D180',
        reportRefreshedAt: '2026-08-18',
      },
      {
        id: 'two',
        url: 'https://contoso.sharepoint.com/sites/two',
        storageQuotaGB: 5,
        activitySource: 'microsoft-d180-report',
        reportPeriod: 'D180',
        reportRefreshedAt: '2026-08-17',
      },
    ],
  })

  assert.equal(view.usageReport.exactClaimsAvailable, false)
  assert.equal(view.overview.totalStorageQuotaGB, null)
  assert.equal(view.overview.inactiveSites90Days, null)
  assert.equal(view.sites[0]?.storageQuotaGB, 5)
  assert.equal(view.sites[1]?.storageQuotaGB, null)
})

test('allows only commercial SharePoint URLs without authority or query ambiguity', () => {
  const urls = [
    'https://contoso.sharepoint.com/sites/ops',
    'https://contoso-my.sharepoint.com/personal/alex_contoso_com',
    'https://evil.example/sites/ops',
    'https://user:pass@contoso.sharepoint.com/sites/ops',
    'https://contoso.sharepoint.com:444/sites/ops',
    'https://contoso.sharepoint.com:443/sites/ops',
    'https://contoso.sharepoint.com/sites/ops?download=1',
    'https://contoso.sharepoint.com/sites/ops#fragment',
  ]
  const view = buildSharePointViewModel({
    sites: urls.map((url, index) => ({ id: `site-${index}`, name: `Site ${index}`, url })),
  })
  assert.equal(view.sites[0]?.url, 'https://contoso.sharepoint.com/sites/ops')
  assert.equal(view.sites[1]?.url, 'https://contoso-my.sharepoint.com/personal/alex_contoso_com')
  for (const site of view.sites.slice(2)) assert.equal(site.url, null)
})

test('does not invent a OneDrive retention period', () => {
  assert.equal(sharePointRetentionDaysLabel(undefined), 'Not reported by Microsoft')
  assert.equal(sharePointRetentionDaysLabel('30'), 'Not reported by Microsoft')
  assert.equal(sharePointRetentionDaysLabel(30), '30 days')
})

test('renders authoritative deleted and matched-owner counts without recomputing duplicate rows', () => {
  const source = readFileSync(new URL('../../app/(protected)/tenants/[id]/components/sections/sharepoint-section.tsx', import.meta.url), 'utf8')
  assert.match(source, /const usageReportMarkedDeletedCount = SP_OVERVIEW\.reportedDeletedCount/)
  assert.doesNotMatch(source, /reportedDeletedSites\.length\s*\+/)
  assert.match(source, /matched D180 usage rows/)
  assert.match(source, /Activity Date Availability/)
  assert.doesNotMatch(source, /Report Data Availability/)
  assert.match(source, /site\.reportPeriod \|\| 'Not reported'/)
  assert.doesNotMatch(source, /site\.reportPeriod \|\| 'D180'/)
  assert.match(source, /deletedState === true \? 'Yes' : deletedState === false \? 'No' : 'Not reported'/)
  assert.match(source, /usageDeletedFilter === 'active' && deletedState !== false/)
  assert.match(source, /const hasActivity = Boolean\(s\.lastActivityAt \|\| s\.lastActivity\)/)
  assert.match(source, /Microsoft report identifiers are concealed/)
  assert.match(source, /Display concealed user, group, and site names in all reports/)
  assert.match(source, /Changing it does not grant HawkView additional permissions/)
  assert.match(source, /Matching unavailable — Microsoft concealed Site IDs and URLs/)
  assert.doesNotMatch(source, /Missing permission on HawkView/)
})

test('preserves Microsoft reported-deleted truth as an explicit tri-state', () => {
  assert.equal(sharePointReportedDeletedState({ isDeleted: true }), true)
  assert.equal(sharePointReportedDeletedState({ usageReportDeleted: true, isDeleted: false }), true)
  assert.equal(sharePointReportedDeletedState({ isDeleted: false }), false)
  assert.equal(sharePointReportedDeletedState({ usageReportDeleted: false }), false)
  assert.equal(sharePointReportedDeletedState({}), null)
  assert.equal(sharePointReportedDeletedState(Object.create({ isDeleted: false })), null)
})
