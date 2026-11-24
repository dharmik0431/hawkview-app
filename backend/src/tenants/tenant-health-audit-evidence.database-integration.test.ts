import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import {
  AUDIT_EVIDENCE_EVENT_WINDOW_MS,
  AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES,
  AUDIT_EVIDENCE_MAX_TENANT_PAYLOAD_BYTES,
  AUDIT_EVIDENCE_NULLABLE_TEXT_COLUMNS,
  AUDIT_EVIDENCE_PROJECTED_COLUMNS,
  AUDIT_EVIDENCE_SENTINEL_ROWS,
  AUDIT_EVIDENCE_TENANT_CAP,
  assessTenantAuditEvidence,
  buildAuditEvidenceQuery,
  readTenantAuditEvidenceBatch,
  type AuditEvidenceScope,
  type AuditEvidenceStore,
} from './tenant-health-audit-evidence.js'

/**
 * Physical witness for the tenant-scoped audit-evidence reader.
 *
 * It executes the UNMODIFIED statement `buildAuditEvidenceQuery` produces, with
 * its bound parameters, against the migrated schema, and feeds the real driver
 * rows through the real reader. The reader, its query and its callers are not
 * changed by this suite.
 *
 * HOSTED ONLY. `assertDisposableTestDatabase` deliberately also permits a local
 * disposable route on port 55432. This witness refuses that: physical execution
 * belongs to the registered hosted disposable PostgreSQL service in the
 * ordinary fresh profile. Without the opt-in and the CI service marker every
 * case below SKIPS without opening a connection, and a local skip is NOT a
 * physical pass.
 *
 * What it does not establish: 1,001-tenant query plans, transfer overhead, RSS,
 * latency, deployed permissions or search_path, provider completeness, caller
 * authorization, source coherence, history admission, or any part of the
 * customer-facing HAW-70 outcome.
 */

const enabled =
  process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1' &&
  process.env.HAWKVIEW_CI_DISPOSABLE_POSTGRES === '1'

/**
 * The shared boundary first, then the hosted-only narrowing. Called before any
 * client is constructed, so a non-hosted route never opens a socket.
 */
function hostedDisposableDatabaseUrl(): URL {
  const url = assertDisposableTestDatabase()
  assert.equal(url.port, '5432',
    'this witness runs only against the hosted CI service on port 5432; the shared guard also allows a local 55432 route, which is refused here')
  return url
}

const AS_OF = new Date('2026-11-20T12:00:00.000Z')
const minutesBefore = (count: number) => new Date(AS_OF.getTime() - count * 60_000)
const auditId = (index: number) => `evt-${String(index).padStart(5, '0')}`

type SeedEvent = {
  tenantId: string
  microsoftAuditId: string
  eventDateTime: Date
  activityDisplayName?: string
  category?: string | null
  operationType?: string | null
  result?: string | null
  /** SQL expression for initiated_by; `NULL` for an explicit SQL null. */
  initiatedBySql?: string
  targetResourcesSql?: string
  expiresAt?: Date
}

/** A fixture scope set: one organization, N tenants, all freshly generated. */
type Fixture = {
  readonly organizationId: string
  readonly tenants: readonly string[]
  readonly pool: pg.Pool
  readonly store: AuditEvidenceStore
  scope(index: number): AuditEvidenceScope
  seed(events: readonly SeedEvent[]): Promise<void>
  /** Measure an expression's byte length in PostgreSQL, never in JavaScript. */
  octets(expression: string): Promise<number>
  close(): Promise<void>
}

async function fixture(tenantCount: number): Promise<Fixture> {
  const url = hostedDisposableDatabaseUrl()
  const connectionString = url.toString()
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 2 }) })
  let organizationId = ''
  const tenants: string[] = []
  try {
    const organization = await prisma.organization.create({
      data: { name: 'HAW-70 audit evidence witness', slug: `haw70-audit-evidence-${randomUUID()}` },
    })
    organizationId = organization.id
    for (let index = 0; index < tenantCount; index += 1) {
      const tenant = await prisma.customerTenant.create({
        data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' },
      })
      tenants.push(tenant.id)
    }
  } finally {
    await prisma.$disconnect()
  }

  const pool = new pg.Pool({ connectionString, max: 3 })
  const store: AuditEvidenceStore = {
    async query(sql, params) {
      return (await pool.query(sql, [...params])).rows
    },
  }
  return {
    organizationId,
    tenants,
    pool,
    store,
    scope: (index: number) => ({ organizationId, customerTenantId: tenants[index]! }),
    async seed(events) {
      for (const event of events) {
        await pool.query(
          `INSERT INTO directory_audit_logs
             (id, organization_id, customer_tenant_id, microsoft_audit_id, event_date_time,
              activity_display_name, category, operation_type, result,
              initiated_by, target_resources, raw, expires_at)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4::timestamptz,
              $5, $6, $7, $8,
              ${event.initiatedBySql ?? `'{"user":"actor"}'::jsonb`},
              ${event.targetResourcesSql ?? `'[{"displayName":"app"}]'::jsonb`},
              '{}'::jsonb, $9::timestamptz)`,
          [
            organizationId, event.tenantId, event.microsoftAuditId, event.eventDateTime.toISOString(),
            event.activityDisplayName ?? 'Update application',
            event.category === undefined ? 'ApplicationManagement' : event.category,
            event.operationType === undefined ? 'Update' : event.operationType,
            event.result === undefined ? 'success' : event.result,
            (event.expiresAt ?? new Date(AS_OF.getTime() + 86_400_000)).toISOString(),
          ],
        )
      }
    },
    async octets(expression) {
      const { rows } = await pool.query(`SELECT octet_length((${expression})::text) AS bytes`)
      return Number(rows[0].bytes)
    },
    async close() {
      // Scoped cleanup only: these fixture rows and scopes, nothing shared. The
      // organization cascade removes the tenants and their audit rows; a
      // failure here is deliberately NOT suppressed.
      const cleanup = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 2 }) })
      try {
        await cleanup.organization.delete({ where: { id: organizationId } })
      } finally {
        await cleanup.$disconnect()
        await pool.end()
      }
    },
  }
}

/** Build a jsonb expression whose `::text` is EXACTLY `bytes` octets. */
function paddedJsonb(bytes: number, character: string, characterBytes: number): string {
  // jsonb renders an object as {"a": "..."} — nine octets of structure around
  // the padded string. The exact length is asserted in PostgreSQL by the caller
  // rather than trusted from this arithmetic.
  const padding = (bytes - 9) / characterBytes
  assert.ok(Number.isInteger(padding) && padding > 0,
    `cannot pad to ${bytes} octets with a ${characterBytes}-octet character`)
  return `jsonb_build_object('a', repeat('${character}', ${padding}))`
}

// ---------------------------------------------------------------------------
// Family 1 — the actual query and driver contract
// ---------------------------------------------------------------------------

test('the unmodified statement executes on migrated PostgreSQL and its real rows decode',
  { skip: !enabled, timeout: 60_000 }, async () => {
    const f = await fixture(1)
    try {
      await f.seed([
        { tenantId: f.tenants[0]!, microsoftAuditId: auditId(1), eventDateTime: minutesBefore(5) },
        // Explicit SQL NULLs in every nullable projected column.
        {
          tenantId: f.tenants[0]!, microsoftAuditId: auditId(2), eventDateTime: minutesBefore(10),
          category: null, operationType: null, result: null,
          initiatedBySql: 'NULL', targetResourcesSql: 'NULL',
        },
      ])

      // The unqualified relation the statement names must resolve to the public
      // table in THIS connection. Recorded as a connection-context assumption,
      // not as proof of deployed permissions or search_path.
      const resolved = await f.pool.query(
        `SELECT to_regclass('directory_audit_logs')::text AS relation, current_setting('search_path') AS search_path`)
      assert.equal(resolved.rows[0].relation, 'public.directory_audit_logs')

      const query = buildAuditEvidenceQuery([f.scope(0)], AS_OF)
      const raw = await f.pool.query(query.sql, [...query.params])
      assert.equal(raw.rows.length, 2, 'both seeded events qualify')

      // All fifteen own projected columns are present on every real row.
      for (const row of raw.rows) {
        for (const column of AUDIT_EVIDENCE_PROJECTED_COLUMNS) {
          assert.ok(Object.prototype.hasOwnProperty.call(row, column),
            `the driver row must own ${column}`)
        }
        assert.equal(Object.keys(row).length, AUDIT_EVIDENCE_PROJECTED_COLUMNS.length,
          'and no column beyond the declared projection')
      }

      // Actual renderings, asserted rather than assumed.
      const [newest, nulls] = raw.rows
      assert.ok(typeof newest.row_position === 'string' || typeof newest.row_position === 'bigint',
        `row_number() is int8; this driver rendered ${typeof newest.row_position}`)
      assert.equal(Number(newest.row_position), 1)
      assert.ok(newest.event_date_time instanceof Date, 'timestamptz arrives as a Date')
      assert.equal(typeof newest.field_oversize, 'boolean')
      assert.equal(typeof newest.over_payload_budget, 'boolean')
      assert.equal(typeof newest.initiated_by_withheld, 'boolean')
      assert.equal(typeof newest.target_resources_withheld, 'boolean')
      assert.equal(typeof newest.initiated_by_text, 'string', 'jsonb is projected as serialized text')
      assert.deepEqual(JSON.parse(newest.initiated_by_text), { user: 'actor' })

      // Explicit SQL NULL is a delivered absence, not withholding.
      assert.equal(nulls.category, null)
      assert.equal(nulls.operation_type, null)
      assert.equal(nulls.result, null)
      assert.equal(nulls.initiated_by_text, null)
      assert.equal(nulls.target_resources_text, null)
      assert.equal(nulls.initiated_by_withheld, false)
      assert.equal(nulls.target_resources_withheld, false)

      // The real rows through the real reader.
      const batch = await readTenantAuditEvidenceBatch(f.store, [f.scope(0)], AS_OF)
      const tenant = batch.tenants[0]!
      assert.equal(tenant.status, 'COMPLETE',
        'genuine nulls from PostgreSQL must stay COMPLETE, never ROW_VALIDATION_FAILED')
      assert.equal(tenant.reason, 'OK')
      assert.equal(tenant.withheldPayloads, 0)
      assert.equal(tenant.observations.length, 2)
      assert.deepEqual(tenant.observations.map((o) => o.microsoftAuditId), [auditId(1), auditId(2)])
      assert.deepEqual(tenant.observations[0]!.targetResources, [{ displayName: 'app' }])
      assert.equal(tenant.observations[1]!.initiatedBy, null)
      assert.equal(tenant.observations[1]!.payloadWithheld, false)
      assert.equal(tenant.observations[1]!.category, null)
      assert.equal(assessTenantAuditEvidence(tenant).auditAssessmentClean, true)
      assert.equal(AUDIT_EVIDENCE_NULLABLE_TEXT_COLUMNS.length, 5)
    } finally {
      await f.close()
    }
  })

test('a representative positive and null case also decodes through the installed Prisma raw path',
  { skip: !enabled, timeout: 60_000 }, async () => {
    const f = await fixture(1)
    const url = hostedDisposableDatabaseUrl()
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString(), max: 2 }),
    })
    try {
      await f.seed([
        { tenantId: f.tenants[0]!, microsoftAuditId: auditId(1), eventDateTime: minutesBefore(5) },
        {
          tenantId: f.tenants[0]!, microsoftAuditId: auditId(2), eventDateTime: minutesBefore(10),
          category: null, initiatedBySql: 'NULL', targetResourcesSql: 'NULL',
        },
      ])
      // Deliberately not the whole matrix on both drivers: one representative
      // case, to show the reader decodes what Prisma's raw path renders too.
      const prismaStore: AuditEvidenceStore = {
        async query(sql, params) {
          return await prisma.$queryRawUnsafe(sql, ...params)
        },
      }
      const batch = await readTenantAuditEvidenceBatch(prismaStore, [f.scope(0)], AS_OF)
      const tenant = batch.tenants[0]!
      assert.equal(tenant.status, 'COMPLETE')
      assert.equal(tenant.observations.length, 2)
      assert.deepEqual(tenant.observations.map((o) => o.microsoftAuditId), [auditId(1), auditId(2)])
      assert.equal(tenant.observations[1]!.initiatedBy, null)
      assert.equal(tenant.observations[1]!.payloadWithheld, false)
    } finally {
      await prisma.$disconnect()
      await f.close()
    }
  })

// ---------------------------------------------------------------------------
// Family 2 — tenant isolation, and the original starvation bug
// ---------------------------------------------------------------------------

test('a noisy tenant cannot consume a quiet tenant’s window, in one real query',
  { skip: !enabled, timeout: 180_000 }, async () => {
    const f = await fixture(3)
    try {
      // Tiny payloads throughout, so the independent byte guard cannot
      // legitimately mask the cap result.
      const tiny = `'{"a":1}'::jsonb`
      const noisy: SeedEvent[] = Array.from({ length: AUDIT_EVIDENCE_SENTINEL_ROWS }, (_u, index) => ({
        tenantId: f.tenants[0]!, microsoftAuditId: auditId(index), eventDateTime: minutesBefore(index + 1),
        initiatedBySql: tiny, targetResourcesSql: tiny,
      }))
      await f.seed(noisy)
      await f.seed([{
        tenantId: f.tenants[1]!, microsoftAuditId: 'quiet-critical',
        eventDateTime: minutesBefore(AUDIT_EVIDENCE_SENTINEL_ROWS + 20),
        activityDisplayName: 'Add member to role', category: 'RoleManagement',
        initiatedBySql: tiny, targetResourcesSql: tiny,
      }])
      // A third tenant is seeded but NOT requested.
      await f.seed([{
        tenantId: f.tenants[2]!, microsoftAuditId: 'unrequested',
        eventDateTime: minutesBefore(2), initiatedBySql: tiny, targetResourcesSql: tiny,
      }])

      const requested = [f.scope(0), f.scope(1)]
      const batch = await readTenantAuditEvidenceBatch(f.store, requested, AS_OF)
      const [noisyResult, quietResult] = batch.tenants

      assert.equal(noisyResult!.status, 'CAPPED')
      assert.equal(noisyResult!.reason, 'TENANT_EVENT_CAP_REACHED')
      assert.equal(noisyResult!.observations.length, AUDIT_EVIDENCE_TENANT_CAP,
        'exactly the cap, with the sentinel excluded')
      assert.equal(noisyResult!.withheldPayloads, 0, 'the byte guard did not interfere')

      assert.equal(quietResult!.status, 'COMPLETE', 'the quiet tenant is read independently')
      assert.deepEqual(quietResult!.observations.map((o) => o.microsoftAuditId), ['quiet-critical'],
        'its older adverse event survives a noisier neighbour in the same query')

      // The unrequested tenant never appears.
      assert.equal(batch.tenants.length, 2)
      assert.equal(JSON.stringify(batch).includes('unrequested'), false)

      // An incomplete read cannot produce a clean assessment while a known
      // adverse finding is carried.
      const capped = assessTenantAuditEvidence(noisyResult!, ['role-escalation-observed'])
      assert.equal(capped.auditWindowUnknown, true)
      assert.equal(capped.auditAssessmentClean, false)
      assert.deepEqual(capped.adverseFindings, ['role-escalation-observed'])
    } finally {
      await f.close()
    }
  })

test('the statement matches exact organization/tenant pairs, not either column alone',
  { skip: !enabled, timeout: 60_000 }, async () => {
    const first = await fixture(1)
    const second = await fixture(1)
    try {
      await first.seed([{ tenantId: first.tenants[0]!, microsoftAuditId: 'own', eventDateTime: minutesBefore(5) }])
      await second.seed([{ tenantId: second.tenants[0]!, microsoftAuditId: 'other-org', eventDateTime: minutesBefore(5) }])

      // A crossed pair: this organization with the other organization's tenant.
      const crossed: AuditEvidenceScope = {
        organizationId: first.organizationId, customerTenantId: second.tenants[0]!,
      }
      const batch = await readTenantAuditEvidenceBatch(first.store, [first.scope(0), crossed], AS_OF)
      assert.equal(batch.tenants.length, 2)
      assert.deepEqual(batch.tenants[0]!.observations.map((o) => o.microsoftAuditId), ['own'])
      assert.equal(batch.tenants[1]!.status, 'COMPLETE',
        'a crossed pair is a complete empty read, not a leak')
      assert.deepEqual(batch.tenants[1]!.observations, [],
        'the other organization’s event is not returned for a crossed pair')
      assert.equal(JSON.stringify(batch).includes('other-org'), false)
    } finally {
      await first.close()
      await second.close()
    }
  })

test('results follow the requested scope order, independently of SQL row order',
  { skip: !enabled, timeout: 60_000 }, async () => {
    const f = await fixture(3)
    try {
      for (let index = 0; index < 3; index += 1) {
        await f.seed([{
          tenantId: f.tenants[index]!, microsoftAuditId: `tenant-${index}`,
          eventDateTime: minutesBefore(index + 1),
        }])
      }
      const reversed = [f.scope(2), f.scope(0), f.scope(1)]
      const batch = await readTenantAuditEvidenceBatch(f.store, reversed, AS_OF)
      assert.deepEqual(batch.tenants.map((t) => t.scope.customerTenantId),
        reversed.map((s) => s.customerTenantId), 'requested order is preserved')
      assert.deepEqual(batch.tenants.map((t) => t.observations[0]!.microsoftAuditId),
        ['tenant-2', 'tenant-0', 'tenant-1'])
      // The SQL itself orders by customer_tenant_id, which is deliberately a
      // different order from the request.
      const query = buildAuditEvidenceQuery(reversed, AS_OF)
      assert.ok(query.sql.includes('ORDER BY customer_tenant_id ASC'))
    } finally {
      await f.close()
    }
  })

// ---------------------------------------------------------------------------
// Family 3 — window, cap, order and the time boundaries
// ---------------------------------------------------------------------------

for (const rows of [0, 499, AUDIT_EVIDENCE_TENANT_CAP, AUDIT_EVIDENCE_SENTINEL_ROWS] as const) {
  test(`the real window at exactly ${rows} qualifying events`,
    { skip: !enabled, timeout: 180_000 }, async () => {
      const f = await fixture(1)
      try {
        const tiny = `'{"a":1}'::jsonb`
        await f.seed(Array.from({ length: rows }, (_u, index) => ({
          tenantId: f.tenants[0]!, microsoftAuditId: auditId(index),
          eventDateTime: minutesBefore(index + 1),
          initiatedBySql: tiny, targetResourcesSql: tiny,
        })))
        const batch = await readTenantAuditEvidenceBatch(f.store, [f.scope(0)], AS_OF)
        const tenant = batch.tenants[0]!
        const capped = rows > AUDIT_EVIDENCE_TENANT_CAP
        assert.equal(tenant.status, capped ? 'CAPPED' : 'COMPLETE')
        assert.equal(tenant.reason, capped ? 'TENANT_EVENT_CAP_REACHED' : 'OK')
        assert.equal(tenant.capReached, capped)
        assert.equal(tenant.observations.length, Math.min(rows, AUDIT_EVIDENCE_TENANT_CAP))
        if (capped) {
          assert.equal(tenant.observations.some((o) => o.microsoftAuditId === auditId(500)), false,
            'the sentinel row is never returned as an observation')
        }
      } finally {
        await f.close()
      }
    })
}

test('tied event timestamps order by the unique audit id, stably across repeated reads',
  { skip: !enabled, timeout: 60_000 }, async () => {
    const f = await fixture(1)
    try {
      const tied = minutesBefore(7)
      await f.seed(['evt-b', 'evt-a', 'evt-c'].map((microsoftAuditId) => ({
        tenantId: f.tenants[0]!, microsoftAuditId, eventDateTime: tied,
      })))
      const first = await readTenantAuditEvidenceBatch(f.store, [f.scope(0)], AS_OF)
      const second = await readTenantAuditEvidenceBatch(f.store, [f.scope(0)], AS_OF)
      const ids = (batch: typeof first) => batch.tenants[0]!.observations.map((o) => o.microsoftAuditId)
      assert.deepEqual(ids(first), ['evt-c', 'evt-b', 'evt-a'],
        'descending microsoft_audit_id is the tie-break, and that pair is unique per tenant')
      assert.deepEqual(ids(first), ids(second), 'and it is stable across reads')
    } finally {
      await f.close()
    }
  })

test('the event cutoff is inclusive at 24h and the expiry bound is strict, under one fixed time',
  { skip: !enabled, timeout: 60_000 }, async () => {
    const f = await fixture(1)
    try {
      const atBound = new Date(AS_OF.getTime() - AUDIT_EVIDENCE_EVENT_WINDOW_MS)
      await f.seed([
        { tenantId: f.tenants[0]!, microsoftAuditId: 'at-bound', eventDateTime: atBound },
        { tenantId: f.tenants[0]!, microsoftAuditId: 'one-ms-older', eventDateTime: new Date(atBound.getTime() - 1) },
        { tenantId: f.tenants[0]!, microsoftAuditId: 'expires-at-asof', eventDateTime: minutesBefore(3), expiresAt: AS_OF },
        { tenantId: f.tenants[0]!, microsoftAuditId: 'expires-after', eventDateTime: minutesBefore(4), expiresAt: new Date(AS_OF.getTime() + 1) },
        // No upper bound on event time is intended policy; a future event
        // inside the retention window still qualifies. Preserved, not changed.
        { tenantId: f.tenants[0]!, microsoftAuditId: 'future-event', eventDateTime: new Date(AS_OF.getTime() + 60_000) },
      ])
      const batch = await readTenantAuditEvidenceBatch(f.store, [f.scope(0)], AS_OF)
      const ids = batch.tenants[0]!.observations.map((o) => o.microsoftAuditId)
      assert.ok(ids.includes('at-bound'), 'exactly 24h old qualifies')
      assert.equal(ids.includes('one-ms-older'), false, 'one millisecond older does not')
      assert.equal(ids.includes('expires-at-asof'), false, 'expiry equal to the assessment time does not qualify')
      assert.ok(ids.includes('expires-after'), 'expiry after it does')
      assert.ok(ids.includes('future-event'),
        'the accepted statement has no event upper bound; this preserves that policy')
      assert.equal(batch.asOf.getTime(), AS_OF.getTime())
    } finally {
      await f.close()
    }
  })

// ---------------------------------------------------------------------------
// Family 4 — the projection byte boundary, measured in PostgreSQL
// ---------------------------------------------------------------------------

for (const [label, character, characterBytes] of [
  ['single-byte', 'x', 1], ['multibyte', 'é', 2],
] as const) {
  test(`the per-field byte cap at exactly 4096 and 4097 octets, ${label} content`,
    { skip: !enabled, timeout: 90_000 }, async () => {
      const f = await fixture(1)
      try {
        const atCap = paddedJsonb(AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES, character, characterBytes)
        const overCap = paddedJsonb(AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES + characterBytes, character, characterBytes)
        // Lengths established by PostgreSQL, not by JavaScript string length.
        assert.equal(await f.octets(atCap), AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES)
        assert.equal(await f.octets(overCap), AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES + characterBytes)

        await f.seed([
          // Exactly at the cap: delivered.
          {
            tenantId: f.tenants[0]!, microsoftAuditId: 'at-cap', eventDateTime: minutesBefore(5),
            initiatedBySql: `'{"a":1}'::jsonb`, targetResourcesSql: atCap,
          },
          // Over the cap in ONE field; the other valid field stays delivered.
          {
            tenantId: f.tenants[0]!, microsoftAuditId: 'over-cap', eventDateTime: minutesBefore(6),
            initiatedBySql: `'{"b":2}'::jsonb`, targetResourcesSql: overCap,
          },
        ])

        const query = buildAuditEvidenceQuery([f.scope(0)], AS_OF)
        const raw = await f.pool.query(query.sql, [...query.params])
        const byId = new Map(raw.rows.map((row) => [row.microsoft_audit_id, row]))

        const at = byId.get('at-cap')!
        assert.equal(at.target_resources_withheld, false, 'exactly at the cap is delivered')
        assert.equal(typeof at.target_resources_text, 'string')
        assert.equal(at.field_oversize, false)

        const over = byId.get('over-cap')!
        assert.equal(over.target_resources_withheld, true)
        assert.equal(over.target_resources_text, null, 'the over-limit field is null in the projection')
        assert.equal(over.field_oversize, true)
        assert.equal(over.initiated_by_withheld, false, 'the other field is unaffected')
        assert.deepEqual(JSON.parse(over.initiated_by_text), { b: 2 },
          'and remains delivered')

        const batch = await readTenantAuditEvidenceBatch(f.store, [f.scope(0)], AS_OF)
        const tenant = batch.tenants[0]!
        assert.equal(tenant.status, 'UNREAD')
        assert.equal(tenant.reason, 'PAYLOAD_FIELD_OVERSIZE')
        assert.equal(tenant.observations.length, 2,
          'the rows are retained, so this is never a complete empty read')
        assert.equal(tenant.withheldPayloads, 1)
        assert.equal(assessTenantAuditEvidence(tenant).auditAssessmentClean, false)
      } finally {
        await f.close()
      }
    })
}

// ---------------------------------------------------------------------------
// Family 5 — the independent per-tenant payload budget
// ---------------------------------------------------------------------------

test('the per-tenant payload budget withholds only past the boundary, and a quiet tenant stays complete',
  { skip: !enabled, timeout: 180_000 }, async () => {
    const f = await fixture(2)
    try {
      const field = paddedJsonb(AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES, 'x', 1)
      assert.equal(await f.octets(field), AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES)
      const perEvent = 2 * AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES
      const atBudget = AUDIT_EVIDENCE_MAX_TENANT_PAYLOAD_BYTES / perEvent
      assert.equal(atBudget, 32, 'thirty-two events of two capped fields reach the budget exactly')

      // Newest 32 events reach the budget exactly; the 33rd must still carry an
      // explicitly non-null, positive-sized payload so it crosses it.
      await f.seed(Array.from({ length: atBudget }, (_u, index) => ({
        tenantId: f.tenants[0]!, microsoftAuditId: auditId(index),
        eventDateTime: minutesBefore(index + 1),
        initiatedBySql: field, targetResourcesSql: field,
      })))
      await f.seed([{
        tenantId: f.tenants[0]!, microsoftAuditId: auditId(atBudget),
        eventDateTime: minutesBefore(atBudget + 1),
        initiatedBySql: `'{"c":3}'::jsonb`, targetResourcesSql: `'{"d":4}'::jsonb`,
      }])
      await f.seed([{
        tenantId: f.tenants[1]!, microsoftAuditId: 'quiet', eventDateTime: minutesBefore(2),
        initiatedBySql: `'{"a":1}'::jsonb`, targetResourcesSql: `'{"a":1}'::jsonb`,
      }])

      const query = buildAuditEvidenceQuery([f.scope(0), f.scope(1)], AS_OF)
      const raw = await f.pool.query(query.sql, [...query.params])
      const forBusy = raw.rows.filter((row) => row.customer_tenant_id === f.tenants[0])
      assert.equal(forBusy.length, atBudget + 1)
      const overBudget = forBusy.filter((row) => row.over_payload_budget === true)
      assert.equal(overBudget.length, 1, 'exactly the event past the boundary is over budget')
      assert.equal(overBudget[0]!.microsoft_audit_id, auditId(atBudget))
      assert.equal(overBudget[0]!.initiated_by_text, null, 'its payloads are withheld in the projection')
      assert.equal(overBudget[0]!.target_resources_text, null)
      assert.equal(overBudget[0]!.initiated_by_withheld, true)
      assert.equal(overBudget[0]!.field_oversize, false,
        'withheld for the tenant budget, not for an oversized field')

      const batch = await readTenantAuditEvidenceBatch(f.store, [f.scope(0), f.scope(1)], AS_OF)
      const busy = batch.tenants[0]!
      assert.equal(busy.status, 'UNREAD')
      assert.equal(busy.reason, 'PAYLOAD_BYTES_WITHHELD')
      assert.equal(busy.observations.length, atBudget + 1, 'no row is dropped')
      assert.equal(busy.withheldPayloads, 1)
      assert.equal(busy.observations[0]!.payloadWithheld, false, 'the newest evidence is retained')
      assert.equal(busy.observations.at(-1)!.payloadWithheld, true)
      assert.equal(assessTenantAuditEvidence(busy).auditAssessmentClean, false)

      const quiet = batch.tenants[1]!
      assert.equal(quiet.status, 'COMPLETE', 'the budget is per tenant, in the same query')
      assert.equal(quiet.observations.length, 1)
      assert.equal(assessTenantAuditEvidence(quiet).auditAssessmentClean, true)
    } finally {
      await f.close()
    }
  })

test('an oversized payload on the sentinel row alone leaves a capped window CAPPED, not UNREAD',
  { skip: !enabled, timeout: 180_000 }, async () => {
    const f = await fixture(1)
    try {
      const tiny = `'{"a":1}'::jsonb`
      const over = paddedJsonb(AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES + 1, 'x', 1)
      assert.equal(await f.octets(over), AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES + 1)
      await f.seed(Array.from({ length: AUDIT_EVIDENCE_TENANT_CAP }, (_u, index) => ({
        tenantId: f.tenants[0]!, microsoftAuditId: auditId(index),
        eventDateTime: minutesBefore(index + 1),
        initiatedBySql: tiny, targetResourcesSql: tiny,
      })))
      // The oldest event is the sentinel, and it alone carries the oversize.
      await f.seed([{
        tenantId: f.tenants[0]!, microsoftAuditId: auditId(AUDIT_EVIDENCE_TENANT_CAP),
        eventDateTime: minutesBefore(AUDIT_EVIDENCE_TENANT_CAP + 1),
        initiatedBySql: tiny, targetResourcesSql: over,
      }])

      const batch = await readTenantAuditEvidenceBatch(f.store, [f.scope(0)], AS_OF)
      const tenant = batch.tenants[0]!
      assert.equal(tenant.status, 'CAPPED',
        'the sentinel is never returned, so nothing of it is withheld from the caller')
      assert.equal(tenant.reason, 'TENANT_EVENT_CAP_REACHED')
      assert.equal(tenant.withheldPayloads, 0)
      assert.equal(tenant.observations.length, AUDIT_EVIDENCE_TENANT_CAP)
    } finally {
      await f.close()
    }
  })
