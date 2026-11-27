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

type BundleOptions = {
  /** Replace the stored SHAREPOINT_USAGE payload entirely. `null` omits the
   *  snapshot row, which is the absent-evidence case. */
  usagePayload?: unknown[] | null
  fieldOverrides?: Record<string, Partial<{
    state: string; reasonCode: string | null; message: string | null; isStale: boolean
  }>>
}

async function publishedBundle(coherent: boolean, options: BundleOptions = {}) {
  const snapshot = options.usagePayload === undefined
    ? storedUsageSnapshot(coherent)
    : options.usagePayload
  const observedAt = new Date()
  const syncRow = {
    lastAttemptAt: new Date(Date.now() - 60_000),
    lastSuccessfulAt: new Date(Date.now() - 60_000),
    lastErrorCode: null as string | null,
    lastErrorMessage: null as string | null,
    consecutiveFailures: 0,
  }
  const field = (fieldKey: string) => ({
    fieldKey, state: 'AVAILABLE', reasonCode: null as string | null, message: null as string | null,
    source: 'Microsoft Graph Reports', endpoint: '/reports/getSharePointSiteUsageDetail',
    lastAttemptAt: syncRow.lastAttemptAt, lastSuccessfulAt: syncRow.lastSuccessfulAt,
    isStale: false,
    ...(options.fieldOverrides?.[fieldKey] ?? {}),
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
          ...(snapshot === null
            ? []
            : [{ resourceType: 'SHAREPOINT_USAGE', payload: snapshot, observedAt }]),
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

test('the usage envelope publishes a truthful state when the projection is incomplete', async () => {
  // CORRECTED DIAGNOSIS. An earlier version of this test claimed a global
  // PENDING-discard rule prevented truthful envelope metadata. That was wrong,
  // and independent review showed why: `collectionState('sharepoint.usage',
  // value)` passes NO resourceType (tenant-sync.service.ts:8117-8120), so
  // `sync` is undefined and `pendingFieldHasCompletedCollector` is false at
  // :7305-7317. The field row's own state is therefore published as-is, and no
  // change to that shared rule is needed.
  //
  // The usage-specific fix is that `refreshCollectionFieldStates` now attaches
  // the same projection evidence to `sharepoint.usage` that the two
  // *-usage-projection keys already carry, so the durable row is PENDING with
  // an existing reason instead of AVAILABLE with a null one. This test supplies
  // the row that producer now writes and asserts the envelope publishes it.
  const sharepoint = await publishedBundle(false, {
    fieldOverrides: {
      'sharepoint.usage': {
        state: 'PENDING',
        reasonCode: 'USAGE_PROJECTION_EVIDENCE_INCOMPLETE',
        message: 'The stored Microsoft usage report does not contain complete validated period and refresh-date evidence.',
        isStale: true,
      },
    },
  })
  assert.equal(sharepoint.collection.usage.value, null, 'the value stays unknown')
  assert.equal(sharepoint.collection.usage.state, 'PENDING',
    'a PENDING usage field is NOT discarded, because this call passes no resourceType')
  assert.equal(sharepoint.collection.usage.reasonCode, 'USAGE_PROJECTION_EVIDENCE_INCOMPLETE')
  assert.equal(sharepoint.collection.usage.isStale, true)
})

// ---------------------------------------------------------------------------
// Independent review of 3bcb32a found two remaining false-zero paths: absent or
// legacy evidence still reached the legacy reducers, and a COMPLETE projection
// does not establish that every storage cell is a usable number. Each bullet of
// that review's required coverage has a test below.
// ---------------------------------------------------------------------------

/** One coherent SharePoint row, with real bytes, usable as legacy input. */
const legacyRow = (over: Record<string, string> = {}) => usageRow({
  'Site Id': 'legacy-a', 'Site URL': `${SITE_URL}/legacy-a`, ...over,
})

test('an absent usage snapshot with a SUCCEEDED collection publishes unknown, never an invented zero', async () => {
  // Finding 1. With no stored snapshot the row array is empty and there is no
  // v2 projection, so the old flag admitted it and every total summed to 0
  // while the capabilities read true.
  const sharepoint = await publishedBundle(true, { usagePayload: null })

  assert.equal(sharepoint.overview.summedSiteStorageUsedBytes, null)
  assert.equal(sharepoint.overview.summedSiteQuotaBytes, null)
  assert.equal(sharepoint.collection.usage.value, null)
  assert.equal(sharepoint.capabilities.usageReport, false)
  assert.equal(sharepoint.capabilities.siteOwnerPresence, false)
  assert.equal(sharepoint.capabilities.deletedSites, false)
  assert.equal(sharepoint.deletedSitesSynchronized, false)
  assert.equal(sharepoint.overview.totalStorageQuotaGB, null)
  assert.equal(sharepoint.overview.storageQuotaSource, 'unavailable')
})

test('a coherent LEGACY v1 snapshot keeps publishing its real values', async () => {
  // Finding 1, compatibility half. A v1 dataset carries no v2 projection
  // evidence, so its rows are not gated. Rejecting every legacy shape would
  // lose working behaviour, so a non-empty legacy row set stays usable.
  const sharepoint = await publishedBundle(true, {
    usagePayload: [{
      hawkviewDataset: 'microsoft-usage-reports-v1',
      sharePointSites: [legacyRow(), legacyRow({ 'Site Id': 'legacy-b', 'Site URL': `${SITE_URL}/legacy-b` })],
      oneDriveAccounts: [],
    }],
  })
  assert.equal(sharepoint.overview.summedSiteStorageUsedBytes, REAL_USED_BYTES,
    'coherent legacy rows still produce their real total')
  assert.equal(sharepoint.overview.summedSiteQuotaBytes, REAL_ALLOCATED_BYTES)
  assert.equal(sharepoint.collection.usage.value, REAL_USED_BYTES)
  assert.equal(sharepoint.capabilities.usageReport, true)
})

test('an unrecognized bare-row snapshot also keeps working, which is preserved legacy behaviour', async () => {
  const sharepoint = await publishedBundle(true, {
    usagePayload: [legacyRow(), legacyRow({ 'Site Id': 'legacy-b', 'Site URL': `${SITE_URL}/legacy-b` })],
  })
  assert.equal(sharepoint.overview.summedSiteStorageUsedBytes, REAL_USED_BYTES)
  assert.equal(sharepoint.capabilities.usageReport, true)
})

test('a LEGACY snapshot with no rows is unknown, not a measured zero', async () => {
  // The deliberate behaviour change, stated in the source comment: without
  // projection evidence there is no way to distinguish a tenant with no
  // reported sites from a report that never arrived.
  for (const payload of [
    [{ hawkviewDataset: 'microsoft-usage-reports-v1', sharePointSites: [], oneDriveAccounts: [] }],
    [] as unknown[],
  ]) {
    const sharepoint = await publishedBundle(true, { usagePayload: payload })
    assert.equal(sharepoint.overview.summedSiteStorageUsedBytes, null, JSON.stringify(payload).slice(0, 60))
    assert.equal(sharepoint.collection.usage.value, null)
    assert.equal(sharepoint.capabilities.usageReport, false)
  }
})

test('a COMPLETE projection with an unusable byte cell publishes unknown for that total only', async () => {
  // Finding 2. Projection coherence validates period, dates and identity — not
  // storage cells. Each case below keeps the projection AUTHORITATIVE_COMPLETE
  // while one storage column is unusable, and used and allocated are summed
  // INDEPENDENTLY so one does not destroy the other.
  const cases: Array<[string, Record<string, string>, 'used' | 'allocated']> = [
    ['missing used', { 'Storage Used (Byte)': '' }, 'used'],
    ['non-numeric used', { 'Storage Used (Byte)': 'n/a' }, 'used'],
    ['negative used', { 'Storage Used (Byte)': '-1' }, 'used'],
    ['fractional used', { 'Storage Used (Byte)': '1.5' }, 'used'],
    ['missing allocated', { 'Storage Allocated (Byte)': '' }, 'allocated'],
    ['negative allocated', { 'Storage Allocated (Byte)': '-4096' }, 'allocated'],
  ]
  for (const [label, damage, which] of cases) {
    const rows = [
      usageRow({ 'Site Id': 'site-a', 'Site URL': `${SITE_URL}/a` }),
      usageRow({ 'Site Id': 'site-b', 'Site URL': `${SITE_URL}/b`, ...damage }),
    ]
    const sharepoint = await publishedBundle(true, {
      usagePayload: buildMicrosoftUsageReportSnapshot(rows, []) as unknown[],
    })
    const evidence = inspectMicrosoftUsageProjectionEvidence(
      buildMicrosoftUsageReportSnapshot(rows, []))
    assert.equal(evidence.sharePoint.state, 'AUTHORITATIVE_COMPLETE',
      `${label}: the projection itself is still complete, which is the point`)

    if (which === 'used') {
      assert.equal(sharepoint.overview.summedSiteStorageUsedBytes, null, `${label}: used unknown`)
      assert.equal(sharepoint.collection.usage.value, null, `${label}`)
      assert.equal(sharepoint.overview.summedSiteQuotaBytes, REAL_ALLOCATED_BYTES,
        `${label}: allocated is unaffected — the two totals are independent`)
      assert.equal(sharepoint.overview.storageQuotaSource, 'reported-site-allocation')
    } else {
      assert.equal(sharepoint.overview.summedSiteQuotaBytes, null, `${label}: allocated unknown`)
      assert.equal(sharepoint.overview.totalStorageQuotaGB, null, `${label}`)
      assert.equal(sharepoint.overview.storageQuotaSource, 'unavailable', `${label}`)
      assert.equal(sharepoint.overview.summedSiteStorageUsedBytes, REAL_USED_BYTES,
        `${label}: a good used figure is NOT lost because allocation is unusable`)
      assert.equal(sharepoint.collection.usage.value, REAL_USED_BYTES, `${label}`)
    }
    // The capability is still asserted: the rows were verified and used. Only
    // the specific total is unknown.
    assert.equal(sharepoint.capabilities.usageReport, true, `${label}`)
  }
})

test('a legitimate measured zero is still published as zero, not as unknown', async () => {
  // The control that stops the correction from over-reaching. A complete
  // projection over rows whose storage really is zero must publish 0.
  const rows = [
    usageRow({ 'Site Id': 'site-a', 'Site URL': `${SITE_URL}/a`, 'Storage Used (Byte)': '0', 'Storage Allocated (Byte)': '0' }),
    usageRow({ 'Site Id': 'site-b', 'Site URL': `${SITE_URL}/b`, 'Storage Used (Byte)': '0', 'Storage Allocated (Byte)': '0' }),
  ]
  const sharepoint = await publishedBundle(true, {
    usagePayload: buildMicrosoftUsageReportSnapshot(rows, []) as unknown[],
  })
  assert.equal(sharepoint.overview.summedSiteStorageUsedBytes, 0, 'a measured zero stays zero')
  assert.equal(sharepoint.overview.summedSiteQuotaBytes, 0)
  assert.equal(sharepoint.collection.usage.value, 0)
  assert.equal(sharepoint.capabilities.usageReport, true)
  // And an allocation of zero still yields no quota figure, as before.
  assert.equal(sharepoint.overview.totalStorageQuotaGB, null)
  assert.equal(sharepoint.overview.storageQuotaSource, 'unavailable')
})

test('an incomplete projection cannot regain usable totals through the canonical contract either', async () => {
  // The review's fifth bullet: there must be no back door where the canonical
  // re-derivation supplies a number the legacy path refused.
  const sharepoint = await publishedBundle(false)
  assert.equal(sharepoint.overview.summedSiteStorageUsedBytes, null, 'the legacy total is unknown')
  assert.equal(sharepoint.dataContract.usageReports.sharePoint.state, 'partial')
  assert.equal(sharepoint.dataContract.overview.sharePointStorageUsedGB, null,
    'and the canonical total is unknown too, so neither path supplies a figure')
  assert.equal(sharepoint.dataContract.usageReports.sharePoint.rowCount, 0,
    'the contract reports the gated row count rather than the stored one')
})

test('report refresh dates and site inventory semantics are unchanged by this correction', async () => {
  // Explicitly out of scope: the review requires these stay as they were.
  const complete = await publishedBundle(true)
  assert.equal(complete.collection.activity.value, 2, 'site-derived activity count unchanged')
  assert.equal(complete.overview.totalSites, 2, 'site inventory unchanged')
  assert.equal(complete.dataContract.usageReports.sharePoint.reportRefreshDate, '2026-08-18',
    'the provider report date is unchanged')
})

// ---------------------------------------------------------------------------
// The producer half of the envelope-metadata fix: what
// `refreshCollectionFieldStates` now writes for `sharepoint.usage`.
// ---------------------------------------------------------------------------

/** Drive the real field-state producer and return the upsert it wrote per key. */
async function writtenFieldStates(usagePayload: unknown[]) {
  const writes = new Map<string, Record<string, unknown>>()
  const service = new TenantSyncService({
    syncState: {
      findMany: async () => [
        { resourceType: 'SHAREPOINT_USAGE', status: 'SUCCEEDED' },
        { resourceType: 'SHAREPOINT_SITES', status: 'SUCCEEDED' },
      ],
    },
    tenantEntraSnapshot: {
      findMany: async ({ select, where }: any) => {
        if (select?.resourceType) {
          return [{ resourceType: 'SHAREPOINT_USAGE' }, { resourceType: 'SHAREPOINT_SITES' }]
        }
        return where?.resourceType === 'SHAREPOINT_USAGE' ? [{ payload: usagePayload }] : [{ payload: [] }]
      },
    },
    tenantCollectionFieldState: {
      upsert: async (args: any) => {
        writes.set(args.where.customerTenantId_fieldKey.fieldKey, args.create ?? args.update)
      },
    },
  } as never, {} as never, {} as never, {} as never, {} as never, {} as never)
  await (service as never as {
    refreshCollectionFieldStates: (t: unknown) => Promise<void>
  }).refreshCollectionFieldStates({
    id: SCOPE.customerTenantId, organizationId: SCOPE.organizationId,
    microsoftTenantId: '11111111-1111-4111-8111-111111111111', status: 'ACTIVE',
    displayName: null, primaryDomain: null,
    connection: {
      status: 'CONNECTED', connectionMode: 'HAWKVIEW_MANAGED',
      exchangeReadOnlyEnabledAt: null, clientId: null, credentialReference: null,
    },
  })
  return writes
}

test('an incomplete projection makes the durable sharepoint.usage row truthful, not AVAILABLE', async () => {
  const writes = await writtenFieldStates(storedUsageSnapshot(false) as unknown[])
  const usage = writes.get('sharepoint.usage')
  assert.ok(usage, 'the usage key is written')
  assert.equal(usage!.state, 'PENDING',
    'an incomplete projection must not leave this row AVAILABLE with a null reason')
  assert.equal(usage!.reasonCode, 'USAGE_PROJECTION_EVIDENCE_INCOMPLETE')
  assert.equal(usage!.isStale, true)

  // The projection keys keep their existing behaviour, and the site-derived
  // keys are untouched by this change.
  assert.equal(writes.get('sharepoint.usage-projection')!.state, 'PENDING')
  assert.equal(writes.get('sharepoint.usage-projection')!.reasonCode,
    'USAGE_PROJECTION_EVIDENCE_INCOMPLETE')
  assert.equal(writes.get('sharepoint.sites.inventory')!.state, 'AVAILABLE',
    'site inventory is not a usage-report projection and is unchanged')
})

test('a complete projection leaves the durable sharepoint.usage row AVAILABLE', async () => {
  const writes = await writtenFieldStates(storedUsageSnapshot(true) as unknown[])
  const usage = writes.get('sharepoint.usage')!
  assert.equal(usage.state, 'AVAILABLE', 'the healthy path is unchanged')
  assert.equal(usage.reasonCode, null)
  assert.equal(usage.isStale, false)
  assert.equal(writes.get('sharepoint.usage-projection')!.state, 'AVAILABLE')
})
