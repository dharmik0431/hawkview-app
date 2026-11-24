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

/**
 * Attempt EVERY closer, then surface whatever failed. A closer that rejects
 * must not stop the remaining ones from being attempted, and a cleanup failure
 * must not be swallowed.
 */
async function closeAll(label: string, closers: ReadonlyArray<() => Promise<unknown>>): Promise<void> {
  const failures: unknown[] = []
  for (const close of closers) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `${label}: cleanup failed`)
}

/**
 * Run a body, then cleanup, retaining BOTH failures. A bare `finally` that
 * awaits cleanup replaces the body's error with the cleanup error when both
 * fail, which hides the finding that matters.
 */
async function withCleanup(
  label: string,
  body: () => Promise<void>,
  closers: ReadonlyArray<() => Promise<unknown>>,
): Promise<void> {
  let bodyFailed = false
  let bodyError: unknown
  try { await body() } catch (error) { bodyFailed = true; bodyError = error }
  let cleanupFailed = false
  let cleanupError: unknown
  try { await closeAll(label, closers) } catch (error) { cleanupFailed = true; cleanupError = error }
  if (bodyFailed && cleanupFailed) {
    throw new AggregateError([bodyError, cleanupError], `${label}: the test failed AND cleanup failed`)
  }
  if (bodyFailed) throw bodyError
  if (cleanupFailed) throw cleanupError
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
  } catch (error) {
    // A tenant-create failure part way through would otherwise leave this
    // fixture's organization behind, because the caller never receives a
    // handle to close. Remove only what this fixture created, and report the
    // original failure even if that removal also fails.
    if (organizationId) {
      try { await prisma.organization.delete({ where: { id: organizationId } }) }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError],
          'fixture creation failed AND its partial scope could not be removed')
      }
    }
    throw error
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
      // Every owned client is attempted even when an earlier step rejects: a
      // delete failure previously still reached both closers, but a rejecting
      // `$disconnect` skipped `pool.end` and leaked the pool.
      const cleanup = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 2 }) })
      await closeAll('fixture close', [
        () => cleanup.organization.delete({ where: { id: organizationId } }),
        () => cleanup.$disconnect(),
        () => pool.end(),
      ])
    },
  }
}

/** `{"a": "<content>"}` — the octets of jsonb structure around the content. */
const JSONB_WRAPPER_OCTETS = 9

/**
 * Compose a jsonb expression whose `::text` is EXACTLY `bytes` octets.
 *
 * A two-octet character cannot reach an odd content length on its own. An
 * earlier version divided the content length by the character width and
 * asserted an integer, so the 4096-octet multibyte case computed 2043.5 and
 * threw before any SQL ran, and the over-boundary case asked for 4098 rather
 * than the 4097 it reported. The content is therefore as many multibyte
 * characters as fit PLUS a one-octet ASCII remainder when the target is odd,
 * which reaches both 4096 and 4097 exactly for either width.
 *
 * This arithmetic is only the construction. Every caller asserts the real
 * length with PostgreSQL's own `octet_length`, and the nonconnecting test below
 * checks the arithmetic and emitted SQL without claiming a physical pass.
 */
function paddedJsonbContent(bytes: number, character: string, characterBytes: number): {
  readonly sql: string
  readonly multibyteCount: number
  readonly asciiRemainder: number
  readonly contentOctets: number
} {
  const contentOctets = bytes - JSONB_WRAPPER_OCTETS
  assert.ok(contentOctets > 0, `cannot build a ${bytes}-octet payload`)
  const multibyteCount = Math.floor(contentOctets / characterBytes)
  const asciiRemainder = contentOctets - multibyteCount * characterBytes
  assert.ok(Number.isInteger(multibyteCount) && multibyteCount > 0,
    `cannot compose ${bytes} octets from ${characterBytes}-octet characters`)
  assert.ok(asciiRemainder >= 0 && asciiRemainder < characterBytes,
    `unexpected remainder ${asciiRemainder} for ${bytes} octets`)
  const parts = [`repeat('${character}', ${multibyteCount})`]
  // The remainder is ASCII, so each remaining character is exactly one octet.
  if (asciiRemainder > 0) parts.push(`repeat('x', ${asciiRemainder})`)
  return {
    sql: `jsonb_build_object('a', ${parts.join(' || ')})`,
    multibyteCount, asciiRemainder, contentOctets,
  }
}

const paddedJsonb = (bytes: number, character: string, characterBytes: number): string =>
  paddedJsonbContent(bytes, character, characterBytes).sql

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
      // table in THIS connection. Compared by OBJECT IDENTITY and by
      // pg_class/pg_namespace, not by regclass text: PostgreSQL omits the
      // schema from regclass output when the relation is visible on the
      // search_path, so an equality against 'public.directory_audit_logs' text
      // rejects the correct default-path connection. Recorded as a
      // connection-context assumption, not as proof of deployed permissions or
      // search_path, and the production query and search_path are unchanged.
      const resolved = await f.pool.query(
        `SELECT to_regclass('directory_audit_logs') IS NOT NULL AS resolves,
                to_regclass('directory_audit_logs')
                  OPERATOR(pg_catalog.=) 'public.directory_audit_logs'::regclass AS is_public_relation,
                n.nspname AS schema_name,
                c.relname AS relation_name,
                current_setting('search_path') AS search_path
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace
          WHERE c.oid OPERATOR(pg_catalog.=) to_regclass('directory_audit_logs')`)
      assert.equal(resolved.rows.length, 1, 'the unqualified relation must resolve to exactly one object')
      assert.equal(resolved.rows[0].resolves, true)
      assert.equal(resolved.rows[0].is_public_relation, true,
        'the resolved object identity must BE public.directory_audit_logs')
      assert.equal(resolved.rows[0].schema_name, 'public')
      assert.equal(resolved.rows[0].relation_name, 'directory_audit_logs')

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
    await withCleanup('prisma raw path', async () => {
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
      // The client and the fixture are both attempted even if the first
      // rejects, which a sequential `finally` did not guarantee.
    }, [() => prisma.$disconnect(), () => f.close()])
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
    let second: Awaited<ReturnType<typeof fixture>>
    try {
      second = await fixture(1)
    } catch (error) {
      // Creating the second fixture failed, so the first would otherwise leak.
      await closeAll('crossed-scope setup', [() => first.close()])
      throw error
    }
    await withCleanup('crossed scopes', async () => {
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
      // Both owned fixtures are attempted below even if one close rejects, and
      // a cleanup failure never replaces a body failure.
    }, [() => first.close(), () => second.close()])
  })

test('results follow the requested scope order, against a deliberately opposite SQL order',
  { skip: !enabled, timeout: 60_000 }, async () => {
    const f = await fixture(3)
    try {
      // Three random UUIDs can already arrive in request order, so a reader
      // that passed SQL order straight through would pass about one time in
      // six. The request is therefore built as the EXACT REVERSE of the order
      // the statement itself produces, and that opposition is asserted against
      // the real raw rows rather than inferred from the SQL text.
      const sqlOrder = [...f.tenants].sort()
      const requested: AuditEvidenceScope[] = [...sqlOrder].reverse()
        .map((customerTenantId) => ({ organizationId: f.organizationId, customerTenantId }))
      const auditIdFor = new Map(f.tenants.map((id, index) => [id, `tenant-${index}`]))
      for (const tenantId of f.tenants) {
        await f.seed([{
          tenantId, microsoftAuditId: auditIdFor.get(tenantId)!, eventDateTime: minutesBefore(5),
        }])
      }

      const query = buildAuditEvidenceQuery(requested, AS_OF)
      const raw = await f.pool.query(query.sql, [...query.params])
      const rawOrder = raw.rows.map((row) => row.customer_tenant_id)
      assert.equal(rawOrder.length, 3, 'one row per tenant')
      assert.deepEqual(rawOrder, sqlOrder,
        'the statement returns tenants in ascending customer_tenant_id order')
      assert.deepEqual(rawOrder, [...requested].reverse().map((scope) => scope.customerTenantId),
        'which is exactly the reverse of what was requested')
      assert.notDeepEqual(rawOrder, requested.map((scope) => scope.customerTenantId),
        'so SQL order and request order cannot coincide by chance')

      const batch = await readTenantAuditEvidenceBatch(f.store, requested, AS_OF)
      assert.deepEqual(batch.tenants.map((t) => t.scope.customerTenantId),
        requested.map((scope) => scope.customerTenantId),
        'the decoded result follows the REQUEST, not the raw SQL order')
      assert.deepEqual(batch.tenants.map((t) => t.observations[0]!.microsoftAuditId),
        requested.map((scope) => auditIdFor.get(scope.customerTenantId)!),
        'and each tenant carries its own event')
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
        // Exactly the cap, and exactly one octet over it, for BOTH widths.
        const atCap = paddedJsonb(AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES, character, characterBytes)
        const overCap = paddedJsonb(AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES + 1, character, characterBytes)
        // Lengths established by PostgreSQL, not by JavaScript string length.
        assert.equal(await f.octets(atCap), AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES)
        assert.equal(await f.octets(overCap), AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES + 1)

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

// ---------------------------------------------------------------------------
// NONCONNECTING checks of this suite's own harness.
//
// These run without any database, opt-in or marker, and they are NOT physical
// passes: they verify the fixture generator's arithmetic and the cleanup
// helpers' behaviour, not PostgreSQL. Every physical case above remains gated
// and is reported as NOT RUN locally. The real octet lengths are asserted by
// PostgreSQL's own octet_length inside those gated cases.
// ---------------------------------------------------------------------------

test('the payload generator composes exact octet targets for both character widths', () => {
  for (const [character, characterBytes] of [['x', 1], ['é', 2]] as const) {
    for (const target of [
      AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES,
      AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES + 1,
    ]) {
      const built = paddedJsonbContent(target, character, characterBytes)
      const label = `${target} octets of ${characterBytes}-octet content`
      assert.equal(built.contentOctets, target - JSONB_WRAPPER_OCTETS, label)
      assert.equal(
        built.multibyteCount * characterBytes + built.asciiRemainder,
        target - JSONB_WRAPPER_OCTETS,
        `${label}: the composed parts must total the content length exactly`)
      assert.ok(built.multibyteCount > 0, label)
      assert.ok(built.asciiRemainder === 0 || characterBytes > 1,
        'a one-octet character never needs a remainder')
      assert.ok(built.sql.startsWith("jsonb_build_object('a', repeat("), label)
      // Counted, not matched as a substring: the single-byte padding character
      // IS 'x', so looking for "repeat('x'" cannot distinguish the remainder.
      assert.equal(built.sql.split('repeat(').length - 1, built.asciiRemainder > 0 ? 2 : 1,
        `${label}: a second repeat() appears only when a remainder is needed`)
    }
  }
})

test('the 4096-octet multibyte target composes rather than throwing, and 4097 needs no remainder', () => {
  // The two exact cases independent review found. Previously 4096 with a
  // two-octet character computed (4096 - 9) / 2 = 2043.5 and the integer
  // assertion threw before any SQL ran, and the over-boundary case asked for
  // 4098 while reporting 4097.
  const atCap = paddedJsonbContent(4096, 'é', 2)
  assert.equal(atCap.multibyteCount, 2043)
  assert.equal(atCap.asciiRemainder, 1, '4087 content octets is odd, so one ASCII octet completes it')
  assert.equal(atCap.multibyteCount * 2 + atCap.asciiRemainder, 4087)

  const overCap = paddedJsonbContent(4097, 'é', 2)
  assert.equal(overCap.multibyteCount, 2044)
  assert.equal(overCap.asciiRemainder, 0, '4088 content octets is even')
  assert.equal(overCap.multibyteCount * 2, 4088)

  // And the single-byte pair, for completeness.
  assert.equal(paddedJsonbContent(4096, 'x', 1).multibyteCount, 4087)
  assert.equal(paddedJsonbContent(4097, 'x', 1).multibyteCount, 4088)
  assert.equal(paddedJsonbContent(4096, 'x', 1).asciiRemainder, 0)
})

test('closeAll attempts every closer and reports what failed', async () => {
  const attempted: string[] = []
  const ok = (name: string) => async () => { attempted.push(name) }
  const bad = (name: string) => async () => { attempted.push(name); throw new Error(name) }

  // A rejecting closer must not stop the ones after it.
  attempted.length = 0
  await assert.rejects(
    () => closeAll('t', [bad('first'), ok('second'), bad('third')]),
    (error: unknown) => error instanceof AggregateError && error.errors.length === 2)
  assert.deepEqual(attempted, ['first', 'second', 'third'],
    'every closer is attempted even after one rejects')

  // A single failure surfaces as itself rather than being wrapped.
  attempted.length = 0
  await assert.rejects(() => closeAll('t', [ok('a'), bad('only')]),
    (error: unknown) => error instanceof Error && error.message === 'only')
  assert.deepEqual(attempted, ['a', 'only'])

  attempted.length = 0
  await closeAll('t', [ok('a'), ok('b')])
  assert.deepEqual(attempted, ['a', 'b'], 'the all-clear path runs them in order')
})

test('withCleanup retains a body failure and a cleanup failure together', async () => {
  const seen: string[] = []
  // Body fails, cleanup succeeds: the body error survives unchanged.
  await assert.rejects(
    () => withCleanup('t', async () => { throw new Error('body') },
      [async () => { seen.push('closed') }]),
    (error: unknown) => error instanceof Error && error.message === 'body')
  assert.deepEqual(seen, ['closed'], 'cleanup still ran')

  // Body succeeds, cleanup fails: the cleanup error surfaces.
  await assert.rejects(
    () => withCleanup('t', async () => {}, [async () => { throw new Error('cleanup') }]),
    (error: unknown) => error instanceof Error && error.message === 'cleanup')

  // BOTH fail: neither is hidden. A bare `finally` would have discarded the
  // body error here, which is the finding this guards.
  await assert.rejects(
    () => withCleanup('t', async () => { throw new Error('body') },
      [async () => { throw new Error('cleanup') }]),
    (error: unknown) => error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors.some((e) => e instanceof Error && e.message === 'body') &&
      error.errors.some((e) => e instanceof Error && e.message === 'cleanup'))

  // All clear.
  await withCleanup('t', async () => { seen.push('body-ok') }, [async () => { seen.push('close-ok') }])
  assert.deepEqual(seen, ['closed', 'body-ok', 'close-ok'])
})
