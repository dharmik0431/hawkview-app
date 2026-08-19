import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSharePointViewModel,
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
        sharePoint: { reportRefreshDate: '2026-08-18' },
        oneDrive: { reportRefreshDate: '2026-08-18' },
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
  assert.equal(view.reportedDeletedSites.length, 1)
  assert.equal(view.siteTableRows.length, 2)
  assert.equal(view.tenantSettings.personalSiteDefaultStorageLimitInMB, 1024 * 1024)
  assert.equal(view.tenantSettings.isLegacyAuthProtocolsEnabled, false)
  assert.equal(view.tenantSettings.isSiteCreationEnabled, true)
  assert.equal(view.tenantSettings.isUnmanagedSyncAppForTenantRestricted, true)
  assert.equal(view.oneDriveAccounts[0]?.type, 'OneDrive')
  assert.equal(view.oneDriveAccounts[0]?.storageQuotaGB, 10)
  assert.equal(view.sync.status, 'success')
  assert.equal(view.inventory.countLabel, '1')
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
  assert.equal(view.sites[0]?.ownerDisplayName, 'Legacy Owner')
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
