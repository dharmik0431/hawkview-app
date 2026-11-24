import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MICROSOFT_USAGE_REPORT_DATASET,
  buildMicrosoftUsageReportSnapshot,
  inspectMicrosoftUsageProjectionEvidence,
} from './sharepoint-data-contract.js'
import { TenantSyncService } from './tenant-sync.service.js'

/**
 * What the published SharePoint bundle says when the stored usage projection is
 * NOT authoritative-complete.
 *
 * `buildBundle` discards usage rows it cannot verify: when the stored
 * projection evidence for a source is not AUTHORITATIVE_COMPLETE, the row array
 * is replaced with `[]` (tenant-sync.service.ts:7025-7032). That part is
 * correct and is not under test here — unverified rows must not be used.
 *
 * The question these tests answer is what the bundle then PUBLISHES. Several
 * fields are summed or counted from those discarded rows, and a sum over an
 * empty array is 0 rather than unknown, while the capability and
 * "synchronized" booleans are derived from the collector's status alone, which
 * is SUCCEEDED. Observed in production on 24 November 2026: a tenant whose
 * usage collection advanced and succeeded, reported Partial with
 * USAGE_PROJECTION_EVIDENCE_INCOMPLETE, permission Confirmed and service plan
 * Satisfied.
 *
 * Fake-only. A fake Prisma double supplies rows; no database, collector,
 * provider or network call is made. These tests assert published output, not
 * provider behaviour, and they establish nothing about whether Microsoft
 * generated fresh report contents or about twenty-minute recurrence.
 */

const GIB = 1024 ** 3
const SCOPE = { organizationId: 'synthetic-org', customerTenantId: 'synthetic-tenant' }
const SITE_ID = 'site-guid'
const SITE_URL = 'https://tenant.sharepoint.com/sites/ops'

/** A per-row shape the real normalizer accepts, carrying real storage bytes. */
const usageRow = (over: Record<string, string>) => ({
  'Report Period': '180',
  'Report Refresh Date': '2026-08-18',
  'Site Id': SITE_ID,
  'Site URL': SITE_URL,
  'Is Deleted': 'False',
  'Last Activity Date': '2026-08-01',
  'Storage Used (Byte)': String(4 * GIB),
  'Storage Allocated (Byte)': String(25 * GIB),
  ...over,
})

/**
 * Build the stored snapshot with the REAL producer, so the projection stamp is
 * exactly what production would have written for these rows rather than a
 * hand-authored stamp the producer would never emit.
 */
function storedUsageSnapshot(coherent: boolean) {
  const sharePointRows = coherent
    ? [
      usageRow({ 'Site Id': 'site-a', 'Site URL': `${SITE_URL}/a` }),
      usageRow({ 'Site Id': 'site-b', 'Site URL': `${SITE_URL}/b` }),
    ]
    // Two different Report Refresh Dates in one report. `coherentUsageRows`
    // requires exactly one, so the producer stamps the source PARTIAL.
    : [
      usageRow({ 'Site Id': 'site-a', 'Site URL': `${SITE_URL}/a` }),
      usageRow({ 'Site Id': 'site-b', 'Site URL': `${SITE_URL}/b`, 'Report Refresh Date': '2026-08-17' }),
    ]
  return buildMicrosoftUsageReportSnapshot(sharePointRows, [])
}

const REAL_USED_BYTES = 2 * 4 * GIB
const REAL_ALLOCATED_BYTES = 2 * 25 * GIB

async function publishedBundle(coherent: boolean) {
  const snapshot = storedUsageSnapshot(coherent)
  const observedAt = new Date()
  const syncRow = {
    lastAttemptAt: new Date(Date.now() - 60_000),
    lastSuccessfulAt: new Date(Date.now() - 60_000),
    lastErrorCode: null as string | null,
    lastErrorMessage: null as string | null,
    consecutiveFailures: 0,
  }
  const field = (fieldKey: string) => ({
    fieldKey, state: 'AVAILABLE', reasonCode: null, message: null,
    source: 'Microsoft Graph Reports', endpoint: '/reports/getSharePointSiteUsageDetail',
    lastAttemptAt: syncRow.lastAttemptAt, lastSuccessfulAt: syncRow.lastSuccessfulAt,
    isStale: false,
  })
  const scoped = ({ where }: any) => {
    assert.equal(where.organizationId, SCOPE.organizationId)
    assert.equal(where.customerTenantId, SCOPE.customerTenantId)
  }
  const many = { findMany: async (args: any) => { scoped(args); return [] } }
  const prisma = {
    directoryUser: many, directoryGroup: many, tenantLicense: many, tenantDomain: many,
    signInLog: many, directoryAuditLog: many, m365ActivitySubscription: many,
    tenantEntraSnapshot: {
      findMany: async (args: any) => {
        scoped(args)
        return [
          { resourceType: 'SHAREPOINT_USAGE', payload: snapshot, observedAt },
          {
            resourceType: 'SHAREPOINT_SITES',
            observedAt,
            payload: [
              { id: `tenant.sharepoint.com,site-a,web-a`, webUrl: `${SITE_URL}/a` },
              { id: `tenant.sharepoint.com,site-b,web-b`, webUrl: `${SITE_URL}/b` },
            ],
          },
        ]
      },
    },
    tenantCollectionFieldState: {
      findMany: async (args: any) => {
        scoped(args)
        return ['sharepoint.usage', 'sharepoint.activity', 'sharepoint.deleted-sites',
          'sharepoint.sites.inventory'].map(field)
      },
    },
    syncState: {
      findMany: async (args: any) => {
        scoped(args)
        return [
          { resourceType: 'SHAREPOINT_USAGE', status: 'SUCCEEDED', ...syncRow },
          { resourceType: 'SHAREPOINT_SITES', status: 'SUCCEEDED', ...syncRow },
        ]
      },
    },
    m365ActivityContent: {
      groupBy: async (args: any) => { scoped(args); return [] },
      findFirst: async (args: any) => { scoped(args); return null },
    },
    m365AuditDailyUsage: {
      findFirst: async (args: any) => { scoped(args); return null },
      aggregate: async (args: any) => {
        scoped(args)
        return { _sum: { downloadedBytes: null, recordsStored: null, blobsProcessed: null } }
      },
    },
  }
  const service = new TenantSyncService(prisma as never, {} as never, {} as never,
    {} as never, {} as never, {} as never)
  const output = await (service as any).buildBundle({
    id: SCOPE.customerTenantId, organizationId: SCOPE.organizationId,
    microsoftTenantId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Synthetic', primaryDomain: 'example.invalid', status: 'CONNECTED',
    connection: { lastVerifiedAt: observedAt },
  })
  return JSON.parse(JSON.stringify(output.bundle)).sharepoint
}

test('the fixture itself establishes the two projection states, using the real producer', () => {
  const incomplete = inspectMicrosoftUsageProjectionEvidence(storedUsageSnapshot(false))
  assert.equal(incomplete.sharePoint.state, 'PARTIAL',
    'two Report Refresh Dates in one report is an incomplete SharePoint projection')
  assert.equal(incomplete.sharePoint.reasonCode, 'USAGE_PROJECTION_EVIDENCE_INCOMPLETE')

  const complete = inspectMicrosoftUsageProjectionEvidence(storedUsageSnapshot(true))
  assert.equal(complete.sharePoint.state, 'AUTHORITATIVE_COMPLETE',
    'one refresh date across coherent rows is complete')
  assert.equal(storedUsageSnapshot(true)[0].hawkviewDataset, MICROSOFT_USAGE_REPORT_DATASET)
})

test('a complete projection publishes the real storage it holds', async () => {
  // The positive control. Same fixture, same collector status; only the stored
  // projection differs. Without this, the assertions below could not show that
  // the published zero comes from the projection state rather than the fixture.
  const sharepoint = await publishedBundle(true)
  assert.equal(sharepoint.overview.summedSiteStorageUsedBytes, REAL_USED_BYTES)
  assert.equal(sharepoint.overview.summedSiteQuotaBytes, REAL_ALLOCATED_BYTES)
  assert.equal(sharepoint.collection.usage.value, REAL_USED_BYTES)
  assert.equal(sharepoint.collection.usage.state, 'AVAILABLE')
  assert.equal(sharepoint.collection.activity.value, 2)
  assert.equal(sharepoint.capabilities.usageReport, true)
  assert.equal(sharepoint.deletedSitesSynchronized, true)
  assert.equal(sharepoint.dataContract.usageReports.sharePoint.state, 'available')
})

test('an incomplete projection publishes no summed value and claims no capability', async () => {
  // The corrected contract. The tenant genuinely holds REAL_USED_BYTES, in rows
  // the bundle discarded as unverifiable. Before the correction every field
  // below was published as a value: summed bytes as 0, and each capability and
  // the deleted-site synchronized flag as true, because they were derived from
  // the collector's SUCCEEDED status alone.
  const sharepoint = await publishedBundle(false)

  // Unchanged, and already correct before the correction: the data contract
  // re-derives coherence itself and reports the source as partial.
  assert.equal(sharepoint.dataContract.usageReports.sharePoint.state, 'partial')

  // Nothing summed from the discarded rows is published as a number.
  assert.equal(sharepoint.overview.summedSiteStorageUsedBytes, null,
    'a sum over discarded rows must be unknown, never 0 bytes')
  assert.equal(sharepoint.overview.summedSiteQuotaBytes, null)
  assert.equal(sharepoint.collection.usage.value, null)

  // No capability derived from the usage report is asserted.
  assert.equal(sharepoint.capabilities.usageReport, false)
  assert.equal(sharepoint.capabilities.siteOwnerPresence, false)
  assert.equal(sharepoint.capabilities.deletedSites, false)
  assert.equal(sharepoint.deletedSitesSynchronized, false,
    'so the empty list below reads as "not observed", not as "none reported"')
  assert.deepEqual(sharepoint.deletedSites, [])

  // Deliberately NOT changed by this correction, asserted so the boundary is
  // explicit. `collection.activity` counts SITES
  // (tenant-sync.service.ts:7497 `sharePointSites.map(getSharePointActivity)`),
  // so its value is a real site count rather than a usage-row sum.
  assert.equal(sharepoint.collection.activity.value, 2)

  // Already safe before the correction: an explicit greater-than-zero guard
  // happened to catch the summed zero on these two. That asymmetry is the
  // clearest evidence the zero was never intended to be published.
  assert.equal(sharepoint.overview.totalStorageQuotaGB, null)
  assert.equal(sharepoint.overview.storageQuotaSource, 'unavailable')
})

test('a residual this correction does NOT close: the usage envelope still reads AVAILABLE', async () => {
  // Recorded as a limitation rather than asserted as correct. The value is now
  // null, so no fabricated number is published, but the envelope's state still
  // comes from the durable field row, which is AVAILABLE because:
  //   - the field-key table attaches `projectionEvidence` to only the two
  //     `*-usage-projection` keys, not to `sharepoint.usage`
  //     (tenant-sync.service.ts:2925-2930 versus the override at :2947); and
  //   - even were it PENDING, `collectionState` discards a PENDING field whose
  //     collector has completed (:7314-7317), which SHAREPOINT_USAGE has.
  // Closing it means changing that discard rule, which every field key in the
  // bundle depends on. That is not a minimal correction and is left for review.
  const sharepoint = await publishedBundle(false)
  assert.equal(sharepoint.collection.usage.state, 'AVAILABLE')
  assert.equal(sharepoint.collection.usage.reasonCode, null)
  assert.equal(sharepoint.collection.usage.isStale, false)
  assert.equal(sharepoint.collection.usage.value, null,
    'the value is unknown, which is what this correction guarantees')
})
