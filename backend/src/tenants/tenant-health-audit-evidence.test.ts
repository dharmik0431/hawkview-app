import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUDIT_EVIDENCE_EVENT_WINDOW_MS,
  AUDIT_EVIDENCE_FIXED_FIELD_CEILING_BYTES,
  AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES,
  AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH,
  AUDIT_EVIDENCE_MAX_TENANT_PAYLOAD_BYTES,
  AUDIT_EVIDENCE_PROJECTED_VARCHAR_WIDTHS,
  AUDIT_EVIDENCE_SENTINEL_ROWS,
  AUDIT_EVIDENCE_TENANT_CAP,
  AuditEvidenceRequestError,
  assessTenantAuditEvidence,
  auditEvidenceBatchByteCeiling,
  auditEvidencePageCount,
  auditEvidencePageSize,
  buildAuditEvidenceQuery,
  readTenantAuditEvidenceBatch,
  newAuditEvidenceReadMetrics,
  readTenantAuditEvidencePages,
  type AuditEvidenceObservation,
  type AuditEvidenceReadMetrics,
  type AuditEvidenceScope,
  type AuditEvidenceStore,
} from './tenant-health-audit-evidence.js'

/**
 * FAKE-ONLY. No database, driver, network or provider is used. The fake store
 * below IMPLEMENTS the semantics the module's SQL is written to have; it does
 * not demonstrate that PostgreSQL implements them. That is why the query shape
 * is asserted directly in its own tests: a fake's ordering cannot establish SQL
 * semantics, so the two kinds of test carry different weight and neither
 * substitutes for registered disposable-database verification later.
 *
 * Nothing here measures a query plan, transferred bytes, resident memory,
 * connection count, latency or production capacity. The scheduling test is a
 * deterministic algorithm and resource-COUNT test only.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const NOISY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const QUIET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AS_OF = new Date('2026-11-24T12:00:00.000Z')

type SeedEvent = {
  organizationId: string
  customerTenantId: string
  microsoftAuditId: string
  eventDateTime: Date
  activityDisplayName?: string
  category?: string | null
  operationType?: string | null
  result?: string | null
  initiatedBy?: unknown
  targetResources?: unknown
  /** Raw stored text, used to seed malformed JSON the parser must refuse. */
  targetResourcesText?: string
  expiresAt?: Date
}

const seed = (over: Partial<SeedEvent> & Pick<SeedEvent, 'customerTenantId' | 'microsoftAuditId' | 'eventDateTime'>): SeedEvent => ({
  organizationId: ORG_A,
  activityDisplayName: 'Update application',
  category: 'ApplicationManagement',
  operationType: 'Update',
  result: 'success',
  initiatedBy: { user: 'actor' },
  targetResources: [{ displayName: 'app' }],
  expiresAt: new Date(AS_OF.getTime() + 60_000),
  ...over,
})

/**
 * Applies, in order, what the module's statement is written to do:
 * both-column scope match, the inclusive 24h event lower bound, the strict
 * expiry bound, a per-tenant row_number over (eventDateTime DESC,
 * microsoftAuditId DESC), the cap+1 cut, the per-field octet cap and the
 * per-tenant running payload budget.
 *
 * `mode: 'workspace-wide-500'` instead reproduces the CURRENT production read
 * — one shared descending take:500 across all scopes — so a test can show that
 * it loses evidence the contract keeps. That is this suite's negative control.
 */
function fakeStore(events: readonly SeedEvent[], options: {
  mode?: 'contract' | 'workspace-wide-500'
  fail?: boolean
  forgeScope?: AuditEvidenceScope
  nonArray?: boolean
  duplicatePosition?: boolean
} = {}): AuditEvidenceStore & { calls: number; active: number; peak: number; maxRowsInOneCall: number } {
  const state = {
    calls: 0, active: 0, peak: 0, maxRowsInOneCall: 0,
    async query(sql: string, params: readonly unknown[]): Promise<readonly unknown[]> {
      state.calls += 1
      state.active += 1
      state.peak = Math.max(state.peak, state.active)
      try {
        if (options.fail) throw new Error('synthetic-store-failure token=never-surface')
        if (options.nonArray) return { notAnArray: true } as unknown as readonly unknown[]
        const fieldCap = params[0] as number
        const lowerBound = params[1] as Date
        const asOf = params[2] as Date
        const sentinelRows = params[3] as number
        const payloadBudget = params[4] as number
        const pairs: AuditEvidenceScope[] = []
        for (let index = 5; index < params.length; index += 2) {
          pairs.push({
            organizationId: params[index] as string,
            customerTenantId: params[index + 1] as string,
          })
        }
        const inScope = events.filter((event) =>
          pairs.some((pair) =>
            pair.organizationId === event.organizationId &&
            pair.customerTenantId === event.customerTenantId) &&
          event.eventDateTime.getTime() >= lowerBound.getTime() &&
          (event.expiresAt ?? new Date(asOf.getTime() + 1)).getTime() > asOf.getTime())

        const order = (left: SeedEvent, right: SeedEvent) =>
          right.eventDateTime.getTime() - left.eventDateTime.getTime() ||
          (left.microsoftAuditId < right.microsoftAuditId ? 1 : left.microsoftAuditId > right.microsoftAuditId ? -1 : 0)

        const bytesOf = (value: unknown, text?: string) =>
          Buffer.byteLength(text ?? (value === undefined || value === null ? '' : JSON.stringify(value)), 'utf8')

        const emit = (event: SeedEvent, position: number, running: number) => {
          const initiatedBytes = bytesOf(event.initiatedBy)
          const targetBytes = bytesOf(event.targetResources, event.targetResourcesText)
          const overBudget = running > payloadBudget
          const initiatedWithheld = initiatedBytes > fieldCap || overBudget
          const targetWithheld = targetBytes > fieldCap || overBudget
          // A genuinely absent nullable payload is SQL NULL, exactly as the
          // projection would return it, and is NOT withheld.
          const initiatedAbsent = event.initiatedBy === undefined || event.initiatedBy === null
          const targetAbsent = event.targetResourcesText === undefined &&
            (event.targetResources === undefined || event.targetResources === null)
          const initiatedText = initiatedWithheld || initiatedAbsent
            ? null : JSON.stringify(event.initiatedBy)
          const targetText = targetWithheld || targetAbsent
            ? null : (event.targetResourcesText ?? JSON.stringify(event.targetResources))
          return {
            organization_id: event.organizationId,
            customer_tenant_id: event.customerTenantId,
            microsoft_audit_id: event.microsoftAuditId,
            event_date_time: event.eventDateTime,
            activity_display_name: event.activityDisplayName ?? 'Update application',
            category: event.category ?? null,
            operation_type: event.operationType ?? null,
            result: event.result ?? null,
            row_position: position,
            field_oversize: initiatedBytes > fieldCap || targetBytes > fieldCap,
            over_payload_budget: overBudget,
            initiated_by_withheld: initiatedWithheld,
            target_resources_withheld: targetWithheld,
            initiated_by_text: initiatedText,
            target_resources_text: targetText,
          }
        }

        let rows: unknown[]
        if (options.mode === 'workspace-wide-500') {
          rows = [...inScope].sort(order).slice(0, AUDIT_EVIDENCE_TENANT_CAP)
            .map((event, index) => emit(event, index + 1, 0))
        } else {
          rows = []
          for (const pair of pairs) {
            const forTenant = inScope
              .filter((event) => event.customerTenantId === pair.customerTenantId &&
                event.organizationId === pair.organizationId)
              .sort(order)
              .slice(0, sentinelRows)
            let running = 0
            forTenant.forEach((event, index) => {
              running += Math.min(bytesOf(event.initiatedBy), fieldCap) +
                Math.min(bytesOf(event.targetResources, event.targetResourcesText), fieldCap)
              rows.push(emit(event, index + 1, running))
            })
          }
        }
        if (options.forgeScope) {
          rows.push(emit(seed({
            organizationId: options.forgeScope.organizationId,
            customerTenantId: options.forgeScope.customerTenantId,
            microsoftAuditId: 'forged',
            eventDateTime: AS_OF,
          }), 1, 0))
        }
        if (options.duplicatePosition && rows.length > 0) rows.push(rows[0])
        state.maxRowsInOneCall = Math.max(state.maxRowsInOneCall, rows.length)
        return rows
      } finally {
        state.active -= 1
      }
    },
  }
  return state
}

const metrics = (): AuditEvidenceReadMetrics => newAuditEvidenceReadMetrics()
const minutesBefore = (count: number) => new Date(AS_OF.getTime() - count * 60_000)
/** Lexicographically descending ids, so id order and time order disagree. */
const paddedId = (index: number) => `evt-${String(index).padStart(4, '0')}`

// ---------------------------------------------------------------------------
// The defect this component exists to prevent
// ---------------------------------------------------------------------------

test('a noisy tenant cannot consume a quiet tenant’s evidence window', async () => {
  const noisy = Array.from({ length: AUDIT_EVIDENCE_SENTINEL_ROWS }, (_unused, index) => seed({
    customerTenantId: NOISY, microsoftAuditId: paddedId(index), eventDateTime: minutesBefore(index + 1),
  }))
  // One older, adverse row for the quiet tenant: older than every noisy row.
  const critical = seed({
    customerTenantId: QUIET, microsoftAuditId: 'quiet-critical',
    eventDateTime: minutesBefore(AUDIT_EVIDENCE_SENTINEL_ROWS + 10),
    activityDisplayName: 'Add member to role', category: 'RoleManagement',
  })
  const scopes: AuditEvidenceScope[] = [
    { organizationId: ORG_A, customerTenantId: NOISY },
    { organizationId: ORG_A, customerTenantId: QUIET },
  ]

  const batch = await readTenantAuditEvidenceBatch(fakeStore([...noisy, critical]), scopes, AS_OF)
  const [noisyResult, quietResult] = batch.tenants

  assert.equal(noisyResult.status, 'CAPPED', 'the noisy tenant reaches its own cap')
  assert.equal(noisyResult.reason, 'TENANT_EVENT_CAP_REACHED')
  assert.equal(noisyResult.observations.length, AUDIT_EVIDENCE_TENANT_CAP,
    'the sentinel row is never returned as an observation')
  assert.equal(quietResult.status, 'COMPLETE', 'the quiet tenant is read independently')
  assert.deepEqual(quietResult.observations.map((o) => o.microsoftAuditId), ['quiet-critical'],
    'the quiet tenant’s older adverse row survives a noisier neighbour')

  // NEGATIVE CONTROL: the current production shape loses exactly that row.
  const shared = await readTenantAuditEvidenceBatch(
    fakeStore([...noisy, critical], { mode: 'workspace-wide-500' }), scopes, AS_OF)
  assert.deepEqual(shared.tenants[1].observations, [],
    'a single shared take:500 starves the quiet tenant, which is the defect under test')
  assert.notEqual(shared.tenants[1].observations.length, quietResult.observations.length,
    'the two shapes genuinely differ, so the assertion above is not vacuous')
})

// ---------------------------------------------------------------------------
// Cap boundaries and the sentinel
// ---------------------------------------------------------------------------

for (const { rows, status, observations, label } of [
  { rows: 0, status: 'COMPLETE', observations: 0, label: 'zero rows is a complete empty read' },
  { rows: 499, status: 'COMPLETE', observations: 499, label: 'below the cap' },
  { rows: AUDIT_EVIDENCE_TENANT_CAP, status: 'COMPLETE', observations: 500, label: 'exactly at the cap' },
  { rows: AUDIT_EVIDENCE_SENTINEL_ROWS, status: 'CAPPED', observations: 500, label: 'the sentinel establishes CAPPED' },
  { rows: AUDIT_EVIDENCE_SENTINEL_ROWS + 25, status: 'CAPPED', observations: 500, label: 'beyond the sentinel' },
] as const) {
  test(`cap boundary: ${rows} qualifying rows — ${label}`, async () => {
    const events = Array.from({ length: rows }, (_unused, index) => seed({
      customerTenantId: QUIET, microsoftAuditId: paddedId(index), eventDateTime: minutesBefore(index + 1),
    }))
    const batch = await readTenantAuditEvidenceBatch(
      fakeStore(events), [{ organizationId: ORG_A, customerTenantId: QUIET }], AS_OF)
    assert.equal(batch.tenants[0].status, status)
    assert.equal(batch.tenants[0].observations.length, observations)
    assert.equal(batch.tenants[0].capReached, status === 'CAPPED')
    assert.equal(batch.tenants[0].reason, status === 'CAPPED' ? 'TENANT_EVENT_CAP_REACHED' : 'OK')
  })
}

test('tied event timestamps are ordered deterministically by the unique tie-breaker', async () => {
  const tied = new Date(AS_OF.getTime() - 60_000)
  const events = ['evt-b', 'evt-a', 'evt-c'].map((id) =>
    seed({ customerTenantId: QUIET, microsoftAuditId: id, eventDateTime: tied }))
  const scopes = [{ organizationId: ORG_A, customerTenantId: QUIET }]

  const first = await readTenantAuditEvidenceBatch(fakeStore(events), scopes, AS_OF)
  // Reversed insertion order must not change the result.
  const second = await readTenantAuditEvidenceBatch(fakeStore([...events].reverse()), scopes, AS_OF)
  const ids = (batch: Awaited<ReturnType<typeof readTenantAuditEvidenceBatch>>) =>
    batch.tenants[0].observations.map((o) => o.microsoftAuditId)

  assert.deepEqual(ids(first), ['evt-c', 'evt-b', 'evt-a'],
    'descending microsoftAuditId breaks the tie, and (tenant, auditId) is unique')
  assert.deepEqual(ids(first), ids(second), 'the order does not depend on input order')
})

// ---------------------------------------------------------------------------
// Scope isolation and forged results
// ---------------------------------------------------------------------------

test('one tenant id is never widened across organizations', async () => {
  const sameTenantOtherOrg = seed({
    organizationId: ORG_B, customerTenantId: QUIET,
    microsoftAuditId: 'other-org', eventDateTime: minutesBefore(1),
  })
  const own = seed({ customerTenantId: QUIET, microsoftAuditId: 'own', eventDateTime: minutesBefore(2) })
  const batch = await readTenantAuditEvidenceBatch(
    fakeStore([sameTenantOtherOrg, own]), [{ organizationId: ORG_A, customerTenantId: QUIET }], AS_OF)
  assert.deepEqual(batch.tenants[0].observations.map((o) => o.microsoftAuditId), ['own'],
    'both scope columns are matched together')
})

test('a returned scope that was not requested makes the whole batch UNREAD', async () => {
  const scopes = [{ organizationId: ORG_A, customerTenantId: QUIET }]
  const batch = await readTenantAuditEvidenceBatch(
    fakeStore([seed({ customerTenantId: QUIET, microsoftAuditId: 'own', eventDateTime: minutesBefore(1) })],
      { forgeScope: { organizationId: ORG_B, customerTenantId: OTHER } }),
    scopes, AS_OF)
  assert.equal(batch.tenants[0].status, 'UNREAD')
  assert.equal(batch.tenants[0].reason, 'SCOPE_MISMATCH')
  assert.deepEqual(batch.tenants[0].observations, [],
    'a result that violates its own scope filter is refused, not partly trusted')
})

test('every requested scope is preserved, including one with no rows at all', async () => {
  const scopes = [
    { organizationId: ORG_A, customerTenantId: NOISY },
    { organizationId: ORG_A, customerTenantId: QUIET },
    { organizationId: ORG_B, customerTenantId: OTHER },
  ]
  const batch = await readTenantAuditEvidenceBatch(
    fakeStore([seed({ customerTenantId: NOISY, microsoftAuditId: 'only', eventDateTime: minutesBefore(1) })]),
    scopes, AS_OF)
  assert.equal(batch.tenants.length, 3, 'an omitted tenant is never silently dropped')
  assert.deepEqual(batch.tenants.map((t) => t.scope.customerTenantId), [NOISY, QUIET, OTHER],
    'results stay in requested order')
  assert.deepEqual(batch.tenants.map((t) => t.status), ['COMPLETE', 'COMPLETE', 'COMPLETE'])
  assert.deepEqual(batch.tenants[2].observations, [])
})

// ---------------------------------------------------------------------------
// A read that did not happen is not an empty one
// ---------------------------------------------------------------------------

test('a store failure is UNREAD for every scope and leaks nothing from the exception', async () => {
  const scopes = [
    { organizationId: ORG_A, customerTenantId: NOISY },
    { organizationId: ORG_A, customerTenantId: QUIET },
  ]
  const batch = await readTenantAuditEvidenceBatch(fakeStore([], { fail: true }), scopes, AS_OF)
  assert.deepEqual(batch.tenants.map((t) => t.status), ['UNREAD', 'UNREAD'])
  assert.deepEqual(batch.tenants.map((t) => t.reason), ['READ_FAILED', 'READ_FAILED'])
  const serialized = JSON.stringify(batch)
  assert.equal(serialized.includes('synthetic-store-failure'), false, 'no exception message')
  assert.equal(serialized.includes('token=never-surface'), false, 'no exception detail')
  assert.equal(serialized.includes('SELECT'), false, 'no SQL text')
  assert.equal(serialized.includes('directory_audit_logs'), false, 'no table name')
})

test('a non-array result is UNREAD, never a complete empty read', async () => {
  const batch = await readTenantAuditEvidenceBatch(
    fakeStore([], { nonArray: true }), [{ organizationId: ORG_A, customerTenantId: QUIET }], AS_OF)
  assert.equal(batch.tenants[0].status, 'UNREAD')
  assert.equal(batch.tenants[0].reason, 'ROW_VALIDATION_FAILED')
})

test('a repeated row position means the window gave no total order, and is refused', async () => {
  const batch = await readTenantAuditEvidenceBatch(
    fakeStore([seed({ customerTenantId: QUIET, microsoftAuditId: 'a', eventDateTime: minutesBefore(1) })],
      { duplicatePosition: true }),
    [{ organizationId: ORG_A, customerTenantId: QUIET }], AS_OF)
  assert.equal(batch.tenants[0].status, 'UNREAD')
  assert.equal(batch.tenants[0].reason, 'ROW_VALIDATION_FAILED')
})

test('a failure for one page cannot fabricate completeness for the fleet', async () => {
  const scopes: AuditEvidenceScope[] = Array.from({ length: 20 }, (_unused, index) => ({
    organizationId: ORG_A,
    customerTenantId: `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, '0')}`,
  }))
  let call = 0
  const store: AuditEvidenceStore = {
    async query(sql, params) {
      call += 1
      if (call === 2) throw new Error('synthetic-second-page-failure')
      return fakeStore([]).query(sql, params)
    },
  }
  const statuses: string[] = []
  for await (const page of readTenantAuditEvidencePages(store, scopes, AS_OF)) {
    for (const tenant of page.tenants) statuses.push(tenant.status)
  }
  assert.equal(statuses.length, 20, 'every scope is still accounted for')
  assert.equal(statuses.filter((s) => s === 'UNREAD').length, 4,
    'the failed page’s four scopes are UNREAD, not absent and not COMPLETE')
  assert.equal(statuses.filter((s) => s === 'COMPLETE').length, 16)
})

// ---------------------------------------------------------------------------
// One assessment time; event cutoff and strict expiry
// ---------------------------------------------------------------------------

test('the event lower bound is inclusive at exactly 24 hours and excludes anything older', async () => {
  const atBound = new Date(AS_OF.getTime() - AUDIT_EVIDENCE_EVENT_WINDOW_MS)
  const events = [
    seed({ customerTenantId: QUIET, microsoftAuditId: 'at-bound', eventDateTime: atBound }),
    seed({ customerTenantId: QUIET, microsoftAuditId: 'one-ms-older', eventDateTime: new Date(atBound.getTime() - 1) }),
  ]
  const batch = await readTenantAuditEvidenceBatch(
    fakeStore(events), [{ organizationId: ORG_A, customerTenantId: QUIET }], AS_OF)
  assert.deepEqual(batch.tenants[0].observations.map((o) => o.microsoftAuditId), ['at-bound'])
})

test('saved expiry is strict: expiresAt equal to the assessment time does not qualify', async () => {
  const events = [
    seed({ customerTenantId: QUIET, microsoftAuditId: 'expires-now', eventDateTime: minutesBefore(1), expiresAt: AS_OF }),
    seed({ customerTenantId: QUIET, microsoftAuditId: 'expires-later', eventDateTime: minutesBefore(2), expiresAt: new Date(AS_OF.getTime() + 1) }),
  ]
  const batch = await readTenantAuditEvidenceBatch(
    fakeStore(events), [{ organizationId: ORG_A, customerTenantId: QUIET }], AS_OF)
  assert.deepEqual(batch.tenants[0].observations.map((o) => o.microsoftAuditId), ['expires-later'],
    'expiry uses > asOf, matching the existing rule')
})

test('one assessment time is shared by every page of a traversal', async () => {
  const scopes: AuditEvidenceScope[] = Array.from({ length: 33 }, (_unused, index) => ({
    organizationId: ORG_A,
    customerTenantId: `eeeeeeee-eeee-4eee-8eee-${String(index).padStart(12, '0')}`,
  }))
  const seenLowerBounds = new Set<number>()
  const seenAsOf = new Set<number>()
  const store: AuditEvidenceStore = {
    async query(_sql, params) {
      seenLowerBounds.add((params[1] as Date).getTime())
      seenAsOf.add((params[2] as Date).getTime())
      return []
    },
  }
  const batches: Date[] = []
  for await (const page of readTenantAuditEvidencePages(store, scopes, AS_OF)) batches.push(page.asOf)

  assert.equal(seenAsOf.size, 1, 'the expiry bound is identical on every page')
  assert.equal(seenLowerBounds.size, 1, 'the event bound is identical on every page')
  assert.deepEqual([...seenAsOf], [AS_OF.getTime()])
  assert.deepEqual([...seenLowerBounds], [AS_OF.getTime() - AUDIT_EVIDENCE_EVENT_WINDOW_MS])
  assert.equal(new Set(batches.map((d) => d.getTime())).size, 1, 'and reported identically')
})

// ---------------------------------------------------------------------------
// Transfer bounds: oversize and malformed evidence
// ---------------------------------------------------------------------------

test('an oversized payload field is withheld and the tenant is never COMPLETE', async () => {
  const huge = { blob: 'x'.repeat(AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES + 1) }
  const events = [
    seed({ customerTenantId: QUIET, microsoftAuditId: 'oversize', eventDateTime: minutesBefore(1), targetResources: huge }),
    seed({ customerTenantId: QUIET, microsoftAuditId: 'normal', eventDateTime: minutesBefore(2) }),
  ]
  const batch = await readTenantAuditEvidenceBatch(
    fakeStore(events), [{ organizationId: ORG_A, customerTenantId: QUIET }], AS_OF)
  const tenant = batch.tenants[0]

  assert.equal(tenant.status, 'UNREAD')
  assert.equal(tenant.reason, 'PAYLOAD_FIELD_OVERSIZE')
  assert.notEqual(tenant.observations.length, 0,
    'oversize evidence is never reported as a complete empty read')
  assert.equal(tenant.observations.length, 2, 'the rows still arrive, with the value withheld')
  assert.equal(tenant.observations[0].payloadWithheld, true)
  assert.equal(tenant.observations[0].targetResources, null)
  assert.equal(tenant.withheldPayloads, 1)
  assert.equal(JSON.stringify(batch).includes('xxxxxxxxxx'), false,
    'the oversized value itself is never carried in the result')
})

test('the per-tenant payload budget withholds later payloads without dropping their rows', async () => {
  // Each event carries close to the field cap, so the running budget is crossed
  // well before the row cap.
  const chunky = { blob: 'y'.repeat(AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES - 64) }
  const count = Math.ceil(AUDIT_EVIDENCE_MAX_TENANT_PAYLOAD_BYTES /
    AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES) + 8
  const events = Array.from({ length: count }, (_unused, index) => seed({
    customerTenantId: QUIET, microsoftAuditId: paddedId(index),
    eventDateTime: minutesBefore(index + 1), targetResources: chunky,
  }))
  const batch = await readTenantAuditEvidenceBatch(
    fakeStore(events), [{ organizationId: ORG_A, customerTenantId: QUIET }], AS_OF)
  const tenant = batch.tenants[0]

  assert.equal(tenant.status, 'UNREAD')
  assert.equal(tenant.reason, 'PAYLOAD_BYTES_WITHHELD')
  assert.equal(tenant.observations.length, count, 'no row is dropped, so the tenant cannot look empty')
  assert.ok(tenant.withheldPayloads > 0, 'the payloads past the budget are withheld')
  assert.ok(tenant.withheldPayloads < count, 'and the ones within it are kept')
  assert.equal(tenant.observations[0].payloadWithheld, false, 'the newest evidence is retained')
  assert.equal(tenant.observations.at(-1)?.payloadWithheld, true)
})

test('malformed stored JSON is withheld rather than thrown or treated as complete', async () => {
  const events = [seed({
    customerTenantId: QUIET, microsoftAuditId: 'malformed', eventDateTime: minutesBefore(1),
    targetResourcesText: '{"unterminated": ',
  })]
  const batch = await readTenantAuditEvidenceBatch(
    fakeStore(events), [{ organizationId: ORG_A, customerTenantId: QUIET }], AS_OF)
  assert.equal(batch.tenants[0].status, 'UNREAD')
  assert.equal(batch.tenants[0].reason, 'PAYLOAD_BYTES_WITHHELD')
  assert.equal(batch.tenants[0].observations[0].payloadWithheld, true)
  assert.equal(batch.tenants[0].observations[0].targetResources, null)
})

// ---------------------------------------------------------------------------
// Request rejection happens before any storage access
// ---------------------------------------------------------------------------

test('an empty batch issues no query at all', async () => {
  const store = fakeStore([])
  await assert.rejects(
    () => readTenantAuditEvidenceBatch(store, [], AS_OF),
    (error: unknown) => error instanceof AuditEvidenceRequestError && error.code === 'EMPTY_BATCH')
  assert.equal(store.calls, 0, 'storage was never reached')
})

test('an oversized, malformed or duplicated batch is rejected before storage access', async () => {
  const store = fakeStore([])
  const tooMany: AuditEvidenceScope[] = Array.from(
    { length: AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH + 1 }, (_unused, index) => ({
      organizationId: ORG_A,
      customerTenantId: `ffffffff-ffff-4fff-8fff-${String(index).padStart(12, '0')}`,
    }))
  const cases: Array<[AuditEvidenceScope[], Date, string]> = [
    [tooMany, AS_OF, 'BATCH_TOO_LARGE'],
    [[{ organizationId: 'not-a-uuid', customerTenantId: QUIET }], AS_OF, 'INVALID_SCOPE'],
    [[{ organizationId: ORG_A, customerTenantId: 'DROP TABLE directory_audit_logs' }], AS_OF, 'INVALID_SCOPE'],
    [[{ organizationId: ORG_A, customerTenantId: QUIET }, { organizationId: ORG_A, customerTenantId: QUIET }], AS_OF, 'DUPLICATE_SCOPE'],
    [[{ organizationId: ORG_A, customerTenantId: QUIET }], new Date(Number.NaN), 'INVALID_AS_OF'],
  ]
  for (const [scopes, asOf, code] of cases) {
    await assert.rejects(
      () => readTenantAuditEvidenceBatch(store, scopes, asOf),
      (error: unknown) => error instanceof AuditEvidenceRequestError && error.code === code, code)
  }
  assert.equal(store.calls, 0, 'no rejected request reaches storage')
})

// ---------------------------------------------------------------------------
// The actual parameterized statement
// ---------------------------------------------------------------------------

test('the statement is fully parameterized and interpolates no identifier or value', () => {
  const scopes = [
    { organizationId: ORG_A, customerTenantId: NOISY },
    { organizationId: ORG_B, customerTenantId: QUIET },
  ]
  const { sql, params } = buildAuditEvidenceQuery(scopes, AS_OF)

  assert.deepEqual(params.slice(0, 5), [
    AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES,
    new Date(AS_OF.getTime() - AUDIT_EVIDENCE_EVENT_WINDOW_MS),
    AS_OF,
    AUDIT_EVIDENCE_SENTINEL_ROWS,
    AUDIT_EVIDENCE_MAX_TENANT_PAYLOAD_BYTES,
  ])
  assert.deepEqual(params.slice(5), [ORG_A, NOISY, ORG_B, QUIET], 'scope values are bound, in order')

  // No value of any kind is present in the statement text.
  for (const value of [ORG_A, ORG_B, NOISY, QUIET, AS_OF.toISOString(), '2026-11-24']) {
    assert.equal(sql.includes(value), false, `the statement must not contain ${value}`)
  }
  assert.equal(/\b\d{4}-\d{2}-\d{2}/.test(sql), false, 'no interpolated timestamp')
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(sql), false,
    'no interpolated uuid')
  assert.equal(sql.includes('(organization_id, customer_tenant_id) IN (($6::uuid, $7::uuid), ($8::uuid, $9::uuid))'),
    true, 'both scope columns are matched together, one bound pair per scope')
})

test('the statement carries the per-tenant window, cap, order and both byte bounds', () => {
  const { sql } = buildAuditEvidenceQuery([{ organizationId: ORG_A, customerTenantId: QUIET }], AS_OF)
  const required: Array<[string, string]> = [
    ['PARTITION BY customer_tenant_id', 'each tenant is capped independently'],
    ['ORDER BY event_date_time DESC, microsoft_audit_id DESC', 'deterministic, total order'],
    ['row_number() OVER tenant_window', 'per-tenant position'],
    ['WHERE row_position <= $4', 'the cap+1 sentinel cut'],
    ['event_date_time >= $2', 'inclusive 24h lower bound'],
    ['expires_at > $3', 'strict saved-expiry bound'],
    ["octet_length(coalesce(initiated_by::text, '')) <= $1", 'per-field byte cap in the projection'],
    ["octet_length(coalesce(target_resources::text, '')) <= $1", 'per-field byte cap in the projection'],
    ['AS initiated_by_withheld', 'withholding is reported explicitly, not inferred from NULL'],
    ['AS target_resources_withheld', 'withholding is reported explicitly, not inferred from NULL'],
    ['ROWS UNBOUNDED PRECEDING', 'running per-tenant payload total'],
    ['running_payload_bytes > $5', 'the per-tenant payload budget'],
  ]
  for (const [fragment, why] of required) {
    assert.equal(sql.includes(fragment), true, `${why}: ${fragment}`)
  }
  // The unbounded columns are deliberately not selected.
  for (const column of ['raw', 'additional_details', 'result_reason']) {
    assert.equal(new RegExp(`\\b${column}\\b`).test(sql), false,
      `${column} is unbounded and must not be projected`)
  }
  assert.equal(sql.includes('SELECT *'), false, 'no star projection')
})

// ---------------------------------------------------------------------------
// Bounded scheduling. A resource-COUNT test, not a capacity measurement.
// ---------------------------------------------------------------------------

test('a 1,001-scope traversal uses 63 bounded sequential reads with one in flight', async () => {
  const scopes: AuditEvidenceScope[] = Array.from({ length: 1001 }, (_unused, index) => ({
    organizationId: ORG_A,
    customerTenantId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  }))
  assert.equal(new Set(scopes.map((s) => s.customerTenantId)).size, 1001, 'the fixture has 1,001 distinct scopes')
  assert.equal(auditEvidencePageCount(1001), 63, '1001 / 16 rounds up to 63')

  // Two events per scope, so every page returns rows and none is trivially empty.
  const events = scopes.flatMap((scope) => [0, 1].map((offset) => seed({
    organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
    microsoftAuditId: paddedId(offset), eventDateTime: minutesBefore(offset + 1),
  })))
  const store = fakeStore(events)
  const counters = metrics()

  let pages = 0
  let largestPageScopes = 0
  let observationsHeldAtOnce = 0
  const statuses: string[] = []
  for await (const page of readTenantAuditEvidencePages(store, scopes, AS_OF, counters)) {
    pages += 1
    largestPageScopes = Math.max(largestPageScopes, page.tenants.length)
    observationsHeldAtOnce = Math.max(observationsHeldAtOnce,
      page.tenants.reduce((total, tenant) => total + tenant.observations.length, 0))
    // Only the outcome is retained; the page's raw observations are released.
    for (const tenant of page.tenants) statuses.push(tenant.status)
  }

  assert.equal(pages, 63, 'bounded sequential pages')
  assert.equal(counters.reads, 63, 'one storage call per page')
  assert.equal(counters.peakActiveReads, 1, 'one batch in flight at a time')
  assert.equal(store.peak, 1, 'the store never saw two concurrent calls')
  assert.equal(largestPageScopes <= AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH, true)
  assert.equal(statuses.length, 1001, 'every scope’s outcome is preserved')
  assert.deepEqual([...new Set(statuses)], ['COMPLETE'])
  assert.equal(store.maxRowsInOneCall <=
    AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH * AUDIT_EVIDENCE_SENTINEL_ROWS, true,
    'no single read exceeds 16 x 501 rows')
  assert.equal(observationsHeldAtOnce <=
    AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH * AUDIT_EVIDENCE_TENANT_CAP, true,
    'at most one page of observations is alive at a time; this counts objects, not bytes or memory')
})

test('the fixed-field ceiling is at least the declared column widths, recomputed from the schema', () => {
  // Deliberately NOT recomputed from the module's own formula, which would only
  // detect drift between two copies of the same arithmetic. These widths are
  // read from prisma/schema.prisma: microsoft_audit_id VarChar(200),
  // activity_display_name VarChar(500), category and operation_type
  // VarChar(100), result VarChar(50).
  assert.deepEqual([...AUDIT_EVIDENCE_PROJECTED_VARCHAR_WIDTHS], [200, 500, 100, 100, 50],
    'the declared widths this ceiling rests on')
  const declaredChars = AUDIT_EVIDENCE_PROJECTED_VARCHAR_WIDTHS.reduce((total, width) => total + width, 0)
  assert.equal(declaredChars, 950)
  // varchar(n) limits CHARACTERS, so UTF-8 needs four bytes per character.
  const required = declaredChars * 4 + 2 * 36 + 32 + 20 + 4 * 5 + 13 * 4
  assert.ok(AUDIT_EVIDENCE_FIXED_FIELD_CEILING_BYTES >= required,
    `the ceiling must cover ${required} bytes, not ${AUDIT_EVIDENCE_FIXED_FIELD_CEILING_BYTES}`)
  assert.ok(declaredChars + 2 * 36 + 32 + 20 > 1024,
    'and a 1024-byte ceiling would be below even the pure-ASCII sum of the widths')
})

test('the batch ceiling is the stated arithmetic, and is a ceiling not a measurement', () => {
  const ceiling = auditEvidenceBatchByteCeiling(AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH)
  assert.equal(ceiling, 37_158_912, 'about 35.4 MiB for a full 16-scope batch')
  assert.equal(
    ceiling,
    16 * (AUDIT_EVIDENCE_MAX_TENANT_PAYLOAD_BYTES + 2 * AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES) +
      16 * AUDIT_EVIDENCE_SENTINEL_ROWS * AUDIT_EVIDENCE_FIXED_FIELD_CEILING_BYTES)
  // The fixed-field term dominates, which is why reducing the aggregate means
  // reducing the scope count or the per-tenant budget, never sharing one budget
  // across tenants.
  assert.ok(16 * AUDIT_EVIDENCE_SENTINEL_ROWS * AUDIT_EVIDENCE_FIXED_FIELD_CEILING_BYTES >
    16 * AUDIT_EVIDENCE_MAX_TENANT_PAYLOAD_BYTES)
  assert.equal(auditEvidenceBatchByteCeiling(1) * 16, ceiling, 'it scales linearly in scopes')
  assert.equal(auditEvidencePageCount(0), 0)
  assert.equal(auditEvidencePageCount(1), 1)
  assert.equal(auditEvidencePageCount(16), 1)
  assert.equal(auditEvidencePageCount(17), 2)
})

// ---------------------------------------------------------------------------
// The completeness policy
// ---------------------------------------------------------------------------

test('only a COMPLETE read with nothing adverse can yield a clean audit assessment', () => {
  const scope = { organizationId: ORG_A, customerTenantId: QUIET }
  const base = { scope, observations: [], capReached: false, withheldPayloads: 0 } as const

  const clean = assessTenantAuditEvidence({ ...base, status: 'COMPLETE', reason: 'OK' })
  assert.equal(clean.auditWindowComplete, true)
  assert.equal(clean.auditWindowUnknown, false)
  assert.equal(clean.auditAssessmentClean, true)

  for (const incomplete of [
    { ...base, status: 'CAPPED', reason: 'TENANT_EVENT_CAP_REACHED' },
    { ...base, status: 'UNREAD', reason: 'READ_FAILED' },
    { ...base, status: 'UNREAD', reason: 'PAYLOAD_FIELD_OVERSIZE' },
    { ...base, status: 'UNREAD', reason: 'PAYLOAD_BYTES_WITHHELD' },
    { ...base, status: 'UNREAD', reason: 'SCOPE_MISMATCH' },
    { ...base, status: 'UNREAD', reason: 'ROW_VALIDATION_FAILED' },
  ] as const) {
    const assessment = assessTenantAuditEvidence(incomplete)
    assert.equal(assessment.auditWindowComplete, false, incomplete.reason)
    assert.equal(assessment.auditWindowUnknown, true, incomplete.reason)
    assert.equal(assessment.auditAssessmentClean, false,
      `${incomplete.reason} must never authorize a clean assessment`)
  }
})

test('an incomplete read never erases an already observed adverse finding', () => {
  const scope = { organizationId: ORG_A, customerTenantId: QUIET }
  const findings = ['role-escalation-observed']
  for (const status of ['COMPLETE', 'CAPPED', 'UNREAD'] as const) {
    const assessment = assessTenantAuditEvidence(
      { scope, status, reason: status === 'COMPLETE' ? 'OK' : status === 'CAPPED' ? 'TENANT_EVENT_CAP_REACHED' : 'READ_FAILED', observations: [], capReached: status === 'CAPPED', withheldPayloads: 0 },
      findings)
    assert.deepEqual(assessment.adverseFindings, findings, `${status} preserves the finding`)
    assert.equal(assessment.auditAssessmentClean, false,
      `${status} with an adverse finding is never clean`)
  }
})

test('a COMPLETE read with a withheld payload is still not clean', () => {
  const assessment = assessTenantAuditEvidence({
    scope: { organizationId: ORG_A, customerTenantId: QUIET },
    status: 'COMPLETE', reason: 'OK', observations: [], capReached: false, withheldPayloads: 1,
  })
  assert.equal(assessment.auditAssessmentClean, false,
    'a withheld value means the stored evidence was not fully seen')
})

test('the in-flight instrument is a measurement, not a constant', async () => {
  // Control for the scheduling assertion above: if `peakActiveReads` were pinned
  // to 1 by construction, asserting 1 for a sequential traversal would prove
  // nothing. Two deliberately overlapped batches must push it to 2.
  const counters = newAuditEvidenceReadMetrics()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let started = 0
  const store: AuditEvidenceStore = {
    async query() {
      started += 1
      if (started <= 2) await gate
      return []
    },
  }
  const first = readTenantAuditEvidenceBatch(store, [{ organizationId: ORG_A, customerTenantId: NOISY }], AS_OF, counters)
  const second = readTenantAuditEvidenceBatch(store, [{ organizationId: ORG_A, customerTenantId: QUIET }], AS_OF, counters)
  await Promise.resolve()
  release?.()
  await Promise.all([first, second])

  assert.equal(counters.reads, 2)
  assert.equal(counters.peakActiveReads, 2, 'overlapping batches raise the peak')
  assert.equal(counters.activeReads, 0, 'the in-flight count returns to zero')

  // And the sequential traversal genuinely keeps it at 1.
  const sequential = newAuditEvidenceReadMetrics()
  const scopes: AuditEvidenceScope[] = Array.from({ length: 40 }, (_unused, index) => ({
    organizationId: ORG_A,
    customerTenantId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  }))
  for await (const page of readTenantAuditEvidencePages(fakeStore([]), scopes, AS_OF, sequential)) {
    assert.equal(sequential.activeReads, 0, 'a page is complete before it is yielded')
    void page
  }
  assert.equal(sequential.reads, 3)
  assert.equal(sequential.peakActiveReads, 1)
})

test('a genuinely absent nullable payload is a complete read, not a withheld one', async () => {
  // `initiated_by` and `target_resources` are both nullable columns, so an
  // event may legitimately carry neither. Inferring "withheld" from a NULL
  // value would mark such an ordinary read UNREAD, so withholding is reported
  // by its own projected flag instead.
  const events = [
    seed({
      customerTenantId: QUIET, microsoftAuditId: 'no-payload', eventDateTime: minutesBefore(1),
      initiatedBy: null, targetResources: null,
    }),
    seed({ customerTenantId: QUIET, microsoftAuditId: 'with-payload', eventDateTime: minutesBefore(2) }),
  ]
  const batch = await readTenantAuditEvidenceBatch(
    fakeStore(events), [{ organizationId: ORG_A, customerTenantId: QUIET }], AS_OF)
  const tenant = batch.tenants[0]

  assert.equal(tenant.status, 'COMPLETE', 'an absent payload must not look like a withheld one')
  assert.equal(tenant.reason, 'OK')
  assert.equal(tenant.withheldPayloads, 0)
  assert.equal(tenant.observations[0].payloadWithheld, false)
  assert.equal(tenant.observations[0].initiatedBy, null, 'and the value is still reported as absent')
  assert.equal(tenant.observations[0].targetResources, null)
  assert.deepEqual(tenant.observations[1].targetResources, [{ displayName: 'app' }])
  assert.equal(assessTenantAuditEvidence(tenant).auditAssessmentClean, true,
    'a complete read of events that carry no payload is a clean audit assessment')
})

// ---------------------------------------------------------------------------
// Hostile and non-conforming store behaviour. Each case below corresponds to a
// defect found by independent review of this module.
// ---------------------------------------------------------------------------

/** A store that returns exactly the rows it is given, verbatim. */
const rowStore = (rows: readonly unknown[]): AuditEvidenceStore & { calls: number } => {
  const state = { calls: 0, async query() { state.calls += 1; return rows } }
  return state
}

const rawRow = (over: Record<string, unknown> = {}) => ({
  organization_id: ORG_A,
  customer_tenant_id: QUIET,
  microsoft_audit_id: 'evt-1',
  event_date_time: minutesBefore(1),
  activity_display_name: 'Update application',
  category: 'ApplicationManagement',
  operation_type: 'Update',
  result: 'success',
  row_position: 1,
  field_oversize: false,
  over_payload_budget: false,
  initiated_by_withheld: false,
  target_resources_withheld: false,
  initiated_by_text: '{"user":"actor"}',
  target_resources_text: '[{"displayName":"app"}]',
  ...over,
})
const ONE_SCOPE = [{ organizationId: ORG_A, customerTenantId: QUIET }]

test('row_position is accepted as a number, a bigint and a decimal string', async () => {
  // row_number() is a Postgres bigint. Prisma raw gives a BigInt; a
  // node-postgres-shaped store gives a decimal string. Rejecting either would
  // turn every successful read into UNREAD.
  for (const position of [1, 1n, '1'] as const) {
    const batch = await readTenantAuditEvidenceBatch(
      rowStore([rawRow({ row_position: position })]), ONE_SCOPE, AS_OF)
    assert.equal(batch.tenants[0].status, 'COMPLETE', `rendering ${typeof position}`)
    assert.equal(batch.tenants[0].observations.length, 1)
  }
  // And anything that is not a position at all is still refused.
  for (const position of ['1.5', '-1', '', 'one', 1.5, 0, 502, null, {}, true]) {
    const batch = await readTenantAuditEvidenceBatch(
      rowStore([rawRow({ row_position: position })]), ONE_SCOPE, AS_OF)
    assert.equal(batch.tenants[0].status, 'UNREAD', `rejected: ${JSON.stringify(position)}`)
    assert.equal(batch.tenants[0].reason, 'ROW_VALIDATION_FAILED')
  }
})

test('a withheld flag in any recognized rendering is honoured, and an unrecognized one fails closed', async () => {
  // These four flags are the only thing separating "withheld" from "genuinely
  // absent". A bare `=== true` would read 't' or 1 as "nothing was withheld",
  // reporting withheld evidence as COMPLETE.
  for (const truthy of ['t', 'true', 1, '1', true] as const) {
    const batch = await readTenantAuditEvidenceBatch(
      rowStore([rawRow({ target_resources_withheld: truthy, target_resources_text: null })]),
      ONE_SCOPE, AS_OF)
    assert.equal(batch.tenants[0].status, 'UNREAD', `rendering ${JSON.stringify(truthy)}`)
    assert.equal(batch.tenants[0].reason, 'PAYLOAD_BYTES_WITHHELD')
    assert.equal(batch.tenants[0].observations[0].payloadWithheld, true)
  }
  for (const falsy of ['f', 'false', 0, '0', false] as const) {
    const batch = await readTenantAuditEvidenceBatch(
      rowStore([rawRow({ target_resources_withheld: falsy })]), ONE_SCOPE, AS_OF)
    assert.equal(batch.tenants[0].status, 'COMPLETE', `rendering ${JSON.stringify(falsy)}`)
  }
  for (const unknownRendering of ['TRUE', 'yes', 2, -1, null, undefined, {}, []]) {
    const batch = await readTenantAuditEvidenceBatch(
      rowStore([rawRow({ field_oversize: unknownRendering })]), ONE_SCOPE, AS_OF)
    assert.equal(batch.tenants[0].status, 'UNREAD',
      `an unrecognized boolean must fail closed: ${JSON.stringify(unknownRendering)}`)
    assert.equal(batch.tenants[0].reason, 'ROW_VALIDATION_FAILED')
  }
})

test('a row property that throws when read becomes UNREAD, not an escaping exception', async () => {
  const hostile = {
    ...rawRow(),
    get target_resources_text(): string {
      throw new Error('pg: decode failed, conninfo=postgres://user:secret@host/db')
    },
  }
  const batch = await readTenantAuditEvidenceBatch(rowStore([hostile]), ONE_SCOPE, AS_OF)
  assert.equal(batch.tenants[0].status, 'UNREAD')
  assert.equal(batch.tenants[0].reason, 'ROW_VALIDATION_FAILED')
  const serialized = JSON.stringify(batch)
  assert.equal(serialized.includes('conninfo'), false, 'no connection string')
  assert.equal(serialized.includes('secret'), false, 'no credential')
  assert.equal(serialized.includes('decode failed'), false, 'no driver message')
})

test('row positions must be dense from 1; a gap means rows were lost in transit', async () => {
  const rows = [1, 2, 500].map((position) =>
    rawRow({ row_position: position, microsoft_audit_id: `evt-${position}` }))
  const batch = await readTenantAuditEvidenceBatch(rowStore(rows), ONE_SCOPE, AS_OF)
  assert.equal(batch.tenants[0].status, 'UNREAD',
    'three rows numbered up to 500 is a window with rows missing, not a complete window of three')
  assert.equal(batch.tenants[0].reason, 'ROW_VALIDATION_FAILED')

  // The contiguous case of the same size is accepted, so the check is not
  // simply refusing small results.
  const contiguous = [1, 2, 3].map((position) =>
    rawRow({ row_position: position, microsoft_audit_id: `evt-${position}` }))
  const ok = await readTenantAuditEvidenceBatch(rowStore(contiguous), ONE_SCOPE, AS_OF)
  assert.equal(ok.tenants[0].status, 'COMPLETE')
  assert.equal(ok.tenants[0].observations.length, 3)
})

test('observations are ordered by validated position, not by the order the store delivered', async () => {
  const shuffled = [3, 1, 2].map((position) =>
    rawRow({ row_position: position, microsoft_audit_id: `evt-${position}` }))
  const batch = await readTenantAuditEvidenceBatch(rowStore(shuffled), ONE_SCOPE, AS_OF)
  assert.deepEqual(batch.tenants[0].observations.map((o) => o.microsoftAuditId),
    ['evt-1', 'evt-2', 'evt-3'], 'arrival order cannot reorder the result')
})

test('an oversized payload on the sentinel row alone leaves the tenant CAPPED', async () => {
  // The sentinel is never returned, so nothing of it is withheld from the
  // caller. Absorbing its flags would downgrade a correctly CAPPED tenant to
  // UNREAD for evidence the caller was never going to receive.
  const rows = Array.from({ length: AUDIT_EVIDENCE_SENTINEL_ROWS }, (_unused, index) =>
    rawRow({
      row_position: index + 1,
      microsoft_audit_id: paddedId(index),
      ...(index + 1 === AUDIT_EVIDENCE_SENTINEL_ROWS
        ? { field_oversize: true, target_resources_withheld: true, target_resources_text: null }
        : {}),
    }))
  const batch = await readTenantAuditEvidenceBatch(rowStore(rows), ONE_SCOPE, AS_OF)
  assert.equal(batch.tenants[0].status, 'CAPPED')
  assert.equal(batch.tenants[0].reason, 'TENANT_EVENT_CAP_REACHED')
  assert.equal(batch.tenants[0].withheldPayloads, 0)
  assert.equal(batch.tenants[0].observations.length, AUDIT_EVIDENCE_TENANT_CAP)
})

// ---------------------------------------------------------------------------
// Caller mutation cannot corrupt a result
// ---------------------------------------------------------------------------

test('a scope appended while the read is in flight cannot appear in the result', async () => {
  const mutable: AuditEvidenceScope[] = [{ organizationId: ORG_A, customerTenantId: QUIET }]
  const store: AuditEvidenceStore = {
    async query() {
      // A caller reusing one scratch array, or another task appending to it.
      mutable.push({ organizationId: ORG_A, customerTenantId: NOISY })
      return []
    },
  }
  const batch = await readTenantAuditEvidenceBatch(store, mutable, AS_OF)
  assert.equal(batch.tenants.length, 1,
    'only the scopes that were validated and bound into the statement are reported')
  assert.equal(batch.tenants[0].scope.customerTenantId, QUIET)
})

test('mutating the scope object afterwards cannot relabel the evidence', async () => {
  const scope = { organizationId: ORG_A, customerTenantId: QUIET }
  const batch = await readTenantAuditEvidenceBatch(
    rowStore([rawRow()]), [scope], AS_OF)
  scope.customerTenantId = NOISY
  assert.equal(batch.tenants[0].scope.customerTenantId, QUIET,
    'the result holds a copy, so a reused scope object cannot move observations to another tenant')
  assert.equal(Object.isFrozen(batch.tenants[0].scope), true)
})

test('the returned observations cannot be extended by a consumer', async () => {
  const batch = await readTenantAuditEvidenceBatch(rowStore([rawRow()]), ONE_SCOPE, AS_OF)
  const tenant = batch.tenants[0]
  assert.equal(Object.isFrozen(tenant.observations), true)
  assert.throws(() => (tenant.observations as AuditEvidenceObservation[]).push(tenant.observations[0]))
  assert.equal(assessTenantAuditEvidence(tenant).observedCount, 1,
    'so observedCount cannot be inflated after the fact')
})

test('mutating asOf during a traversal cannot shift the window between pages', async () => {
  const mutableAsOf = new Date(AS_OF.getTime())
  const scopes: AuditEvidenceScope[] = Array.from({ length: 33 }, (_unused, index) => ({
    organizationId: ORG_A,
    customerTenantId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  }))
  const bounds = new Set<string>()
  const store: AuditEvidenceStore = {
    async query(_sql, params) {
      bounds.add(`${(params[1] as Date).getTime()}:${(params[2] as Date).getTime()}`)
      mutableAsOf.setTime(mutableAsOf.getTime() + 3_600_000)
      return []
    },
  }
  const reported = new Set<number>()
  for await (const page of readTenantAuditEvidencePages(store, scopes, mutableAsOf)) {
    reported.add(page.asOf.getTime())
  }
  assert.equal(bounds.size, 1, 'every page used one event bound and one expiry bound')
  assert.deepEqual([...reported], [AS_OF.getTime()], 'and reported the snapshotted time')
})

// ---------------------------------------------------------------------------
// Whole-traversal validation
// ---------------------------------------------------------------------------

test('a malformed or duplicated scope anywhere in a long list is rejected before any page', async () => {
  const base: AuditEvidenceScope[] = Array.from({ length: 20 }, (_unused, index) => ({
    organizationId: ORG_A,
    customerTenantId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  }))
  const cases: Array<[AuditEvidenceScope[], string, string]> = [
    [[...base.slice(0, 16), { organizationId: ORG_A, customerTenantId: 'not-a-uuid' }, ...base.slice(17)],
      'INVALID_SCOPE', 'an invalid scope in page 2'],
    [[...base, base[0]], 'DUPLICATE_SCOPE', 'a duplicate straddling a page boundary'],
  ]
  for (const [scopes, code, label] of cases) {
    const store = rowStore([])
    const pages: unknown[] = []
    await assert.rejects(
      async () => { for await (const page of readTenantAuditEvidencePages(store, scopes, AS_OF)) pages.push(page) },
      (error: unknown) => error instanceof AuditEvidenceRequestError && error.code === code, label)
    assert.equal(pages.length, 0, `${label}: no page is yielded before the whole list is validated`)
    assert.equal(store.calls, 0, `${label}: storage is never reached`)
  }
})

test('a non-finite page size falls back to the default instead of propagating NaN', async () => {
  assert.equal(auditEvidencePageSize(Number.NaN), AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH)
  assert.equal(auditEvidencePageSize(Number.POSITIVE_INFINITY), AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH)
  assert.equal(auditEvidencePageSize(0), 1)
  assert.equal(auditEvidencePageSize(-5), 1)
  assert.equal(auditEvidencePageSize(99), AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH)
  assert.equal(auditEvidencePageSize(4), 4)
  assert.equal(auditEvidencePageCount(1001, Number.NaN), 63)

  const scopes: AuditEvidenceScope[] = Array.from({ length: 20 }, (_unused, index) => ({
    organizationId: ORG_A,
    customerTenantId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  }))
  const store = rowStore([])
  let pages = 0
  for await (const page of readTenantAuditEvidencePages(store, scopes, AS_OF, undefined, Number.NaN)) {
    pages += 1
    void page
  }
  assert.equal(pages, 2, 'a NaN page size must not turn a 20-scope traversal into an empty-batch error')
  assert.equal(store.calls, 2)
})

// ---------------------------------------------------------------------------
// A limitation on the record, not a passing property
// ---------------------------------------------------------------------------

test('a store that applies its own narrower window is NOT detectable, and this records that', async () => {
  // Documented limitation. CAPPED depends on the store delivering the sentinel,
  // and a complete empty read depends on "no rows" meaning "no rows exist".
  // The current workspace-wide take:500 satisfies neither, and the reader
  // cannot tell. Only the statement this module builds carries the per-tenant
  // cap, which is why the statement shape is asserted directly and why
  // registered database verification remains a follow-up.
  const noisy = Array.from({ length: AUDIT_EVIDENCE_SENTINEL_ROWS }, (_unused, index) => seed({
    customerTenantId: NOISY, microsoftAuditId: paddedId(index), eventDateTime: minutesBefore(index + 1),
  }))
  const critical = seed({
    customerTenantId: QUIET, microsoftAuditId: 'quiet-critical',
    eventDateTime: minutesBefore(AUDIT_EVIDENCE_SENTINEL_ROWS + 10),
  })
  const scopes: AuditEvidenceScope[] = [
    { organizationId: ORG_A, customerTenantId: NOISY },
    { organizationId: ORG_A, customerTenantId: QUIET },
  ]
  const batch = await readTenantAuditEvidenceBatch(
    fakeStore([...noisy, critical], { mode: 'workspace-wide-500' }), scopes, AS_OF)

  assert.equal(batch.tenants[1].status, 'COMPLETE',
    'the starved tenant reads COMPLETE although its evidence was lost upstream')
  assert.equal(assessTenantAuditEvidence(batch.tenants[1]).auditAssessmentClean, true,
    'and would authorize a clean audit assessment — the limitation this test records')
  assert.equal(batch.tenants[0].capReached, false,
    'the truncated tenant shows no sentinel either, so no signal reaches the caller')
})
