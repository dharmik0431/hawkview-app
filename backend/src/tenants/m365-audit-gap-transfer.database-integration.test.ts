import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import type { Prisma } from '../generated/prisma/client.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { stageExpiredAuditGapTransfer, type AuditGapTransferTransaction, type SelectedAuditGapClaim, type StagedAuditGapTransfer } from './m365-audit-gap-transfer.js'
import { selectExpiredAuditGapPage, AUDIT_GAP_SELECTION_URI_BYTES, AUDIT_GAP_SELECTION_PAGE_BYTES } from './m365-audit-gap-selection.js'

// Actual helper SQL, hosted disposable service only. The final prepared cases
// add the inactive selector; no provider, owner-fence, outcome reader or
// production writer is exercised. Public-parent CI does not cover new cases.
const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
  && process.env.HAWKVIEW_CI_DISPOSABLE_POSTGRES === '1'
const options = { skip: !enabled, timeout: 30_000 }
const discovered = '2000-01-01T00:00:00.123456Z'
const ageDeadline = '2000-01-31T00:00:00.123456Z'
const beforeAge = '2000-01-31T00:00:00.123455Z'
const afterAge = '2000-01-31T00:00:00.123457Z'
const format = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
type Scope = { organizationId: string; tenantId: string }

async function transaction(run: (client: pg.Client) => Promise<void>) {
  const url = assertDisposableTestDatabase()
  assert.equal(url.port, '5432', 'Only the registered hosted disposable PostgreSQL service is permitted')
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000 })
  let began = false
  try {
    await client.connect()
    await client.query('BEGIN')
    began = true
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '2s'")
    await client.query("SET LOCAL TIME ZONE 'America/New_York'")
    await client.query("SET LOCAL DateStyle = 'SQL, DMY'")
    await run(client)
  } finally {
    try { if (began) await client.query('ROLLBACK') } finally { await client.end() }
  }
}

// No SQL interception or result scripting. pg transports the real helper's
// statements and parameters; production Prisma integration remains separate.
// pg's BIGINT string is passed back as a SQL parameter, not rounded to a Number.
function adapter(client: pg.Client, rejectedCodes: string[] = []): AuditGapTransferTransaction {
  return {
    async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
      try { return (await client.query(query, values)).rows as T } catch (error) {
        rejectedCodes.push((error as { code?: string }).code ?? 'UNKNOWN')
        throw error
      }
    },
  }
}

async function scope(client: pg.Client, organizationId: string = randomUUID()): Promise<Scope> {
  const tenantId = randomUUID()
  await client.query(`INSERT INTO public.organizations (id, name, slug, updated_at)
    VALUES ($1, 'Synthetic gap transfer fixture', $2, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO NOTHING`, [organizationId, organizationId])
  await client.query(`INSERT INTO public.customer_tenants
    (id, organization_id, microsoft_tenant_id, status, updated_at)
    VALUES ($1, $2, $3, 'ACTIVE', CURRENT_TIMESTAMP)`, [tenantId, organizationId, randomUUID()])
  return { organizationId, tenantId }
}

async function select(client: pg.Client, id: string): Promise<SelectedAuditGapClaim> {
  const result = await client.query(`SELECT id::text, organization_id::text AS "organizationId",
    customer_tenant_id::text AS "customerTenantId", microsoft_content_id AS "microsoftContentId",
    content_type AS "contentType", status, content_uri AS "contentUri", attempt_count AS "attemptCount",
    to_char(updated_at AT TIME ZONE 'UTC', $2) AS "updatedAt",
    to_char(discovered_at AT TIME ZONE 'UTC', $2) AS "discoveredAt",
    to_char(ledger_expires_at AT TIME ZONE 'UTC', $2) AS "ledgerExpiresAt",
    to_char(content_expires_at AT TIME ZONE 'UTC', $2) AS "contentExpiresAt"
    FROM public.m365_activity_contents WHERE id = $1`, [id, format])
  assert.equal(result.rowCount, 1)
  return result.rows[0] as SelectedAuditGapClaim
}

async function source(client: pg.Client, owner: Scope, overrides: Partial<SelectedAuditGapClaim> = {}) {
  const claim: SelectedAuditGapClaim = {
    id: randomUUID(), organizationId: owner.organizationId, customerTenantId: owner.tenantId,
    microsoftContentId: ` synthetic-${randomUUID()} `, contentType: 'Audit.General', status: 'RETRY',
    contentUri: 'https://synthetic.invalid/blob?token=do-not-retain', attemptCount: 3,
    updatedAt: '2000-01-02T00:00:00.654321Z', discoveredAt: discovered,
    ledgerExpiresAt: beforeAge, contentExpiresAt: null, ...overrides,
  }
  await client.query(`INSERT INTO public.m365_activity_contents
    (id, organization_id, customer_tenant_id, microsoft_content_id, content_type, status,
     content_uri, attempt_count, updated_at, discovered_at, ledger_expires_at, content_expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [claim.id, claim.organizationId, claim.customerTenantId, claim.microsoftContentId, claim.contentType,
    claim.status, claim.contentUri, claim.attemptCount, claim.updatedAt, claim.discoveredAt,
    claim.ledgerExpiresAt, claim.contentExpiresAt])
  // Compare server-returned microseconds with the requested values, never a JS Date.
  assert.deepEqual(await select(client, claim.id), claim)
  return claim
}

async function snapshot(client: pg.Client, tenantId: string) {
  const rows: Record<string, string[]> = {}
  for (const table of ['m365_activity_contents', 'm365_audit_coverage_gaps', 'm365_audit_coverage_states']) {
    // Keep BIGINT and microseconds lossless, including max-generation fixtures.
    rows[table] = (await client.query(`SELECT to_jsonb(t)::text AS data FROM public.${table} t
      WHERE customer_tenant_id = $1 ORDER BY to_jsonb(t)::text`, [tenantId])).rows.map(row => row.data)
  }
  return rows
}

async function coverageState(client: pg.Client, tenantId: string) {
  const result = await client.query(`SELECT generation::text,
    to_char(incomplete_since AT TIME ZONE 'UTC', $2) AS "incompleteSince",
    to_char(last_gap_at AT TIME ZONE 'UTC', $2) AS "lastGapAt", has_purged_unrepaired_gap AS purged
    FROM public.m365_audit_coverage_states WHERE customer_tenant_id = $1`, [tenantId, format])
  assert.equal(result.rowCount, 1)
  return result.rows[0] as { generation: string; incompleteSince: string; lastGapAt: string; purged: boolean }
}

type TransferRace = {
  blocker: pg.Client
  waiter: pg.Client
  blockerPid: number
  waiterPid: number
  owner: Scope
  claim: SelectedAuditGapClaim
  secondClaim: SelectedAuditGapClaim | undefined
  start: (claim?: SelectedAuditGapClaim) => Promise<StagedAuditGapTransfer>
  track: <T>(operation: () => Promise<T>) => Promise<T>
}

// Committed synthetic fixtures are necessary for both connections to see them.
// Individual cases explicitly commit or roll back component writes. Cleanup is
// scoped to the newly generated organization after all in-flight work settles.
async function transferRace(
  overrides: (client: pg.Client) => Promise<Partial<SelectedAuditGapClaim>>,
  run: (race: TransferRace) => Promise<void>,
  settings: { lockSourceBeforeRun?: boolean; seedSecondSource?: boolean } = {},
) {
  const url = assertDisposableTestDatabase()
  assert.equal(url.port, '5432', 'Only the registered hosted disposable PostgreSQL service is permitted')
  const configuration = { connectionString: url.toString(), connectionTimeoutMillis: 5_000, query_timeout: 25_000 }
  const blocker = new pg.Client(configuration)
  const waiter = new pg.Client(configuration)
  const organizationId = randomUUID()
  const connected = new Set<pg.Client>()
  let pending: Promise<unknown> | undefined
  try {
    for (const client of [blocker, waiter]) {
      await client.connect()
      connected.add(client)
      await client.query("SET statement_timeout = '20s'")
      await client.query("SET lock_timeout = '18s'")
      await client.query("SET TIME ZONE 'UTC'")
      await client.query("SET DateStyle = 'ISO, MDY'")
    }
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
    const waiterPid = (await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
    assert.notEqual(blockerPid, waiterPid)
    await blocker.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const owner = await scope(blocker, organizationId)
    const claim = await source(blocker, owner, await overrides(blocker))
    const secondClaim = settings.seedSecondSource ? await source(blocker, owner) : undefined
    await blocker.query('COMMIT')
    await blocker.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    if (settings.lockSourceBeforeRun !== false)
      assert.equal((await blocker.query('SELECT id FROM public.m365_activity_contents WHERE id = $1 FOR UPDATE', [claim.id])).rowCount, 1)
    await waiter.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const track = <T>(operation: () => Promise<T>): Promise<T> => {
      assert.equal(pending, undefined, 'Track exactly one pending waiter operation per race')
      const operationResult = operation()
      pending = operationResult
      // Attach immediately to prevent an unhandled rejection during observation;
      // the original promise is still awaited by the assertion and by cleanup.
      void pending.catch(() => undefined)
      return operationResult
    }
    await run({ blocker, waiter, blockerPid, waiterPid, owner, claim, secondClaim, track,
      start: (selected = claim) => track(() => stageExpiredAuditGapTransfer(adapter(waiter), selected)) })
  } finally {
    const failures: unknown[] = []
    const clean = async (operation: () => Promise<unknown>) => {
      try { await operation() } catch (error) { failures.push(error) }
    }
    if (connected.has(blocker)) await clean(() => blocker.query('ROLLBACK'))
    if (pending) await pending.catch(() => undefined)
    if (connected.has(waiter)) await clean(() => waiter.query('ROLLBACK'))
    if (connected.has(blocker)) await clean(async () => {
      // This UUID was created solely by this fixture; never a broad table delete.
      await blocker.query('DELETE FROM public.organizations WHERE id = $1', [organizationId])
      for (const table of ['customer_tenants', 'm365_activity_contents', 'm365_audit_coverage_gaps', 'm365_audit_coverage_states']) {
        assert.equal((await blocker.query(`SELECT 1 FROM public.${table} WHERE organization_id = $1`, [organizationId])).rowCount, 0)
      }
    })
    await clean(() => waiter.end())
    await clean(() => blocker.end())
    if (failures.length) throw new AggregateError(failures, 'Synthetic transfer-race cleanup failed')
  }
}

const sourceLockQuery = /^\s*SELECT id FROM public\.m365_activity_contents WHERE id = \$1::uuid[\s\S]+FOR UPDATE\s*$/
const tenantLockQuery = /^\s*SELECT id FROM public\.customer_tenants\s+WHERE id = \$1::uuid AND organization_id = \$2::uuid FOR UPDATE\s*$/

async function rowWait(race: TransferRace, queryPattern: RegExp) {
  // A transaction can cache activity snapshots; explicitly refresh each poll.
  await race.blocker.query('SELECT pg_stat_clear_snapshot()')
  const result = await race.blocker.query(`SELECT state, wait_event_type, query,
    pg_blocking_pids(pid) AS blockers, clock_timestamp() >= $2::timestamptz AS expired
    FROM pg_stat_activity WHERE pid = $1 AND datname = current_database()`,
  [race.waiterPid, race.claim.contentExpiresAt])
  assert.equal(result.rowCount, 1, 'Owned waiter must still exist')
  const row = result.rows[0]
  const blocked = row.state === 'active' && row.wait_event_type === 'Lock'
    && row.blockers.length === 1 && row.blockers[0] === race.blockerPid
    && queryPattern.test(row.query)
  return { blocked, expired: row.expired as boolean | null }
}

async function untilRowWait(race: TransferRace,
  { afterExpiry = false, queryPattern = sourceLockQuery }: { afterExpiry?: boolean; queryPattern?: RegExp } = {}) {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    const observation = await rowWait(race, queryPattern)
    if (observation.blocked && (!afterExpiry || observation.expired === true)) return observation
    // Polling delay bounds work; only the server's blocker/query/clock evidence
    // satisfies this barrier. Elapsed wall time alone never passes the test.
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('Expected exact row-statement blocker/clock barrier was not observed')
}

test('HAW-75 transfer computes earliest microsecond deadline and tie precedence under nondefault session settings',
  options, async () => transaction(async client => {
    assert.equal((await client.query('SHOW TimeZone')).rows[0].TimeZone, 'America/New_York')
    assert.equal((await client.query('SHOW DateStyle')).rows[0].DateStyle, 'SQL, DMY')
    const outside = await scope(client)
    await source(client, outside)
    const outsideBefore = await snapshot(client, outside.tenantId)
    const cases = [
      { ledger: beforeAge, provider: null, expiry: beforeAge, reason: 'LEDGER_EXPIRED' },
      { ledger: afterAge, provider: beforeAge, expiry: beforeAge, reason: 'PROVIDER_URL_EXPIRED' },
      { ledger: beforeAge, provider: beforeAge, expiry: beforeAge, reason: 'PROVIDER_URL_EXPIRED' },
      { ledger: ageDeadline, provider: null, expiry: ageDeadline, reason: 'LEDGER_EXPIRED' },
      { ledger: ageDeadline, provider: ageDeadline, expiry: ageDeadline, reason: 'PROVIDER_URL_EXPIRED' },
      { ledger: afterAge, provider: afterAge, expiry: ageDeadline, reason: 'URL_AGE_EXPIRED' },
      { ledger: afterAge, provider: null, expiry: ageDeadline, reason: 'URL_AGE_EXPIRED' },
    ]
    for (const entry of cases) {
      const owner = await scope(client)
      const sibling = await scope(client, owner.organizationId)
      await source(client, sibling)
      const siblingBefore = await snapshot(client, sibling.tenantId)
      const claim = await source(client, owner, { ledgerExpiresAt: entry.ledger, contentExpiresAt: entry.provider })
      const lower = (await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', $1) AS at`, [format])).rows[0].at
      assert.deepEqual(await stageExpiredAuditGapTransfer(adapter(client), claim), { staged: true, reason: entry.reason })
      const evidence = await client.query(`SELECT g.content_id_sha256 AS digest, g.reason,
        g.source_status AS status, g.resolved_at,
        to_char(g.source_expired_at AT TIME ZONE 'UTC', $3) AS expiry,
        g.first_observed_at >= $2::timestamptz AND g.first_observed_at <= clock_timestamp() AS bounded,
        s.generation::text, s.incomplete_since = g.first_observed_at AS same_start,
        s.last_gap_at = g.first_observed_at AS same_end, s.has_purged_unrepaired_gap
        FROM public.m365_audit_coverage_gaps g JOIN public.m365_audit_coverage_states s
        USING (customer_tenant_id, organization_id) WHERE g.customer_tenant_id = $1`, [owner.tenantId, lower, format])
      assert.deepEqual(evidence.rows, [{ digest: createHash('sha256').update(claim.microsoftContentId).digest('hex'),
        reason: entry.reason, status: 'RETRY', resolved_at: null, expiry: entry.expiry, bounded: true,
        generation: '1', same_start: true, same_end: true, has_purged_unrepaired_gap: false }])
      assert.deepEqual((await snapshot(client, owner.tenantId)).m365_activity_contents, [])
      assert.deepEqual(await snapshot(client, sibling.tenantId), siblingBefore)
    }
    assert.deepEqual(await snapshot(client, outside.tenantId), outsideBefore)
  }))

test('HAW-75 transfer leaves an unexpired source and absent coverage unchanged', options,
  async () => transaction(async client => {
    const owner = await scope(client)
    const times = (await client.query(`SELECT to_char(at AT TIME ZONE 'UTC', $1) AS discovered,
      to_char((at + interval '24 hours') AT TIME ZONE 'UTC', $1) AS ledger
      FROM (SELECT clock_timestamp() AS at) observed`, [format])).rows[0]
    const claim = await source(client, owner, { discoveredAt: times.discovered, ledgerExpiresAt: times.ledger })
    const before = await snapshot(client, owner.tenantId)
    assert.deepEqual(await stageExpiredAuditGapTransfer(adapter(client), claim), { staged: false, reason: 'NOT_EXPIRED' })
    assert.deepEqual(await snapshot(client, owner.tenantId), before)
  }))

test('HAW-75 transfer rejects stale selected fields without deleting the current source', options,
  async () => transaction(async client => {
    // Static fixture expressions only. Each changed value has a separate source.
    const changes = [
      "updated_at = updated_at + interval '1 microsecond'", 'attempt_count = attempt_count + 1',
      "status = 'COMPLETED'", "content_uri = 'https://synthetic.invalid/replaced'",
      'content_expires_at = ledger_expires_at', "ledger_expires_at = ledger_expires_at + interval '1 microsecond'",
      "discovered_at = discovered_at + interval '1 microsecond'", "microsoft_content_id = microsoft_content_id || 'changed'",
      "content_type = 'Audit.Exchange'",
    ]
    for (const change of changes) {
      const owner = await scope(client)
      const claim = await source(client, owner)
      await client.query(`UPDATE public.m365_activity_contents SET ${change} WHERE id = $1`, [claim.id])
      const before = await snapshot(client, owner.tenantId)
      assert.deepEqual(await stageExpiredAuditGapTransfer(adapter(client), claim), { staged: false, reason: 'SOURCE_CHANGED_OR_ABSENT' })
      assert.deepEqual(await snapshot(client, owner.tenantId), before)
      if (change !== "status = 'COMPLETED'") {
        // Positive control: the same current unresolved row is transferable.
        assert.equal((await stageExpiredAuditGapTransfer(adapter(client), await select(client, claim.id))).staged, true)
      }
    }
  }))

test('HAW-75 retained-gap retry preserves evidence while a new identity advances sticky generation once', options,
  async () => transaction(async client => {
    const owner = await scope(client)
    const claim = await source(client, owner)
    assert.equal((await stageExpiredAuditGapTransfer(adapter(client), claim)).staged, true)
    await client.query(`UPDATE public.m365_audit_coverage_states SET has_purged_unrepaired_gap = true
      WHERE customer_tenant_id = $1`, [owner.tenantId])
    const before = await snapshot(client, owner.tenantId)
    const retry = await source(client, owner, { microsoftContentId: claim.microsoftContentId,
      ledgerExpiresAt: afterAge, contentExpiresAt: beforeAge })
    assert.deepEqual(await stageExpiredAuditGapTransfer(adapter(client), retry), { staged: true, reason: 'PROVIDER_URL_EXPIRED' })
    assert.deepEqual(await snapshot(client, owner.tenantId), before, 'Retained evidence and marker must not be rewritten')
    assert.equal((await stageExpiredAuditGapTransfer(adapter(client), await source(client, owner))).staged, true)
    const after = await snapshot(client, owner.tenantId)
    assert.equal(after.m365_audit_coverage_gaps!.length, 2)
    const priorState = JSON.parse(before.m365_audit_coverage_states![0]!) as Record<string, unknown>
    assert.deepEqual((await client.query(`SELECT generation::text, has_purged_unrepaired_gap,
      incomplete_since = $2::timestamptz AS start_preserved, last_gap_at >= $3::timestamptz AS end_monotonic
      FROM public.m365_audit_coverage_states WHERE customer_tenant_id = $1`,
    [owner.tenantId, priorState.incomplete_since, priorState.last_gap_at])).rows,
    [{ generation: '2', has_purged_unrepaired_gap: true, start_preserved: true, end_monotonic: true }])
  }))

test('HAW-75 a later SQL failure rolls back staged deletion, gap and marker together', options,
  async () => transaction(async client => {
    const owner = await scope(client)
    const claim = await source(client, owner)
    const before = await snapshot(client, owner.tenantId)
    await client.query('SAVEPOINT transfer_unit')
    assert.equal((await stageExpiredAuditGapTransfer(adapter(client), claim)).staged, true)
    const staged = await snapshot(client, owner.tenantId)
    assert.equal(staged.m365_activity_contents!.length, 0)
    assert.equal(staged.m365_audit_coverage_gaps!.length, 1)
    assert.equal(staged.m365_audit_coverage_states!.length, 1)
    await assert.rejects(client.query('SELECT 1 / 0'), { code: '22012' })
    await client.query('ROLLBACK TO SAVEPOINT transfer_unit')
    await client.query('RELEASE SAVEPOINT transfer_unit')
    assert.deepEqual(await snapshot(client, owner.tenantId), before)
    // PostgreSQL savepoint rollback, not a durable commit/unknown-result witness.
    assert.equal((await stageExpiredAuditGapTransfer(adapter(client), claim)).staged, true)
  }))

test('HAW-75 a real generation overflow rejects and rolls back the preceding gap insert', options,
  async () => transaction(async client => {
    const owner = await scope(client)
    const claim = await source(client, owner)
    await client.query(`INSERT INTO public.m365_audit_coverage_states
      (customer_tenant_id, organization_id, generation, incomplete_since, last_gap_at)
      VALUES ($1,$2,9223372036854775807,$3,$3)`, [owner.tenantId, owner.organizationId, discovered])
    const before = await snapshot(client, owner.tenantId)
    const rejectedCodes: string[] = []
    await client.query('SAVEPOINT transfer_overflow')
    await assert.rejects(stageExpiredAuditGapTransfer(adapter(client, rejectedCodes), claim), (error: unknown) => {
      assert.equal((error as Error).message, 'M365_AUDIT_GAP_STAGE_FAILED')
      assert.equal((error as Error).cause, undefined)
      return true
    })
    assert.deepEqual(rejectedCodes, ['22003'], 'Must reach actual BIGINT overflow, not an earlier fixture/SQL error')
    await assert.rejects(client.query('SELECT 1'), { code: '25P02' })
    await client.query('ROLLBACK TO SAVEPOINT transfer_overflow')
    await client.query('RELEASE SAVEPOINT transfer_overflow')
    assert.deepEqual(await snapshot(client, owner.tenantId), before)
    await client.query(`UPDATE public.m365_audit_coverage_states SET generation = 1 WHERE customer_tenant_id = $1`, [owner.tenantId])
    assert.equal((await stageExpiredAuditGapTransfer(adapter(client), claim)).staged, true)
  }))

test('HAW-75 source revision committed during an observed row wait invalidates the selected claim',
  { ...options, timeout: 45_000 }, async () => transferRace(async () => ({}), async race => {
    const { blocker, waiter, owner, claim } = race
    const pending = race.start()
    assert.equal((await untilRowWait(race)).blocked, true)
    assert.equal((await blocker.query(`UPDATE public.m365_activity_contents
      SET updated_at = updated_at + interval '1 microsecond' WHERE id = $1`, [claim.id])).rowCount, 1)
    const replacement = await select(blocker, claim.id)
    assert.equal(replacement.updatedAt, '2000-01-02T00:00:00.654322Z')
    await blocker.query('COMMIT')
    assert.deepEqual(await pending, { staged: false, reason: 'SOURCE_CHANGED_OR_ABSENT' })
    assert.deepEqual(await select(waiter, claim.id), replacement)
    const preserved = await snapshot(waiter, owner.tenantId)
    assert.equal(preserved.m365_activity_contents!.length, 1)
    assert.deepEqual(preserved.m365_audit_coverage_gaps, [])
    assert.deepEqual(preserved.m365_audit_coverage_states, [])
    // Positive control uses the fresh committed revision, still in the same
    // real transaction. Its staged writes must disappear on full rollback.
    assert.equal((await stageExpiredAuditGapTransfer(adapter(waiter), replacement)).staged, true)
    await waiter.query('ROLLBACK')
    assert.deepEqual(await snapshot(blocker, owner.tenantId), preserved)
  }))

test('HAW-75 source expires during an observed row wait and uses post-wait database time',
  { ...options, timeout: 45_000 }, async () => transferRace(async client => {
    const times = (await client.query(`WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS at)
      SELECT to_char(at AT TIME ZONE 'UTC', $1) AS discovered,
        to_char((at + interval '24 hours') AT TIME ZONE 'UTC', $1) AS ledger,
        to_char((at + interval '6 seconds') AT TIME ZONE 'UTC', $1) AS provider FROM observed`, [format])).rows[0]
    return { discoveredAt: times.discovered, ledgerExpiresAt: times.ledger, contentExpiresAt: times.provider }
  }, async race => {
    const { blocker, waiter, owner, claim } = race
    const original = await snapshot(blocker, owner.tenantId)
    assert.equal((await waiter.query(`SELECT transaction_timestamp() < $1::timestamptz
      AND clock_timestamp() < $1::timestamptz AS before_expiry`, [claim.contentExpiresAt])).rows[0].before_expiry, true)
    const pending = race.start()
    assert.equal((await untilRowWait(race)).expired, false, 'Must observe the actual source wait before expiry')
    assert.equal((await untilRowWait(race, { afterExpiry: true })).expired, true, 'Same source wait must persist across the database deadline')
    const releasedAfter = (await blocker.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', $1) AS at`, [format])).rows[0].at
    // Release the source unchanged: only time advances, not its selected fields.
    await blocker.query('COMMIT')
    assert.deepEqual(await pending, { staged: true, reason: 'PROVIDER_URL_EXPIRED' })
    assert.deepEqual((await waiter.query(`SELECT g.reason,
      to_char(g.source_expired_at AT TIME ZONE 'UTC', $3) AS expiry,
      g.first_observed_at >= $2::timestamptz AS after_release,
      g.first_observed_at > transaction_timestamp() AS after_transaction_start,
      s.generation::text, s.incomplete_since = g.first_observed_at AS same_start,
      s.last_gap_at = g.first_observed_at AS same_end
      FROM public.m365_audit_coverage_gaps g JOIN public.m365_audit_coverage_states s
      USING (customer_tenant_id, organization_id) WHERE g.customer_tenant_id = $1`,
    [owner.tenantId, releasedAfter, format])).rows,
    [{ reason: 'PROVIDER_URL_EXPIRED', expiry: claim.contentExpiresAt, after_release: true,
      after_transaction_start: true, generation: '1', same_start: true, same_end: true }])
    assert.deepEqual((await snapshot(waiter, owner.tenantId)).m365_activity_contents, [])
    assert.deepEqual(await snapshot(blocker, owner.tenantId), original, 'Staging is not a visible commit')
    await waiter.query('ROLLBACK')
    assert.deepEqual(await snapshot(blocker, owner.tenantId), original, 'Full rollback restores the committed source')
  }))

test('HAW-75 committed transfer prevents a blocked raw source update from resurrecting the deleted row',
  { ...options, timeout: 45_000 }, async () => transferRace(async () => ({}), async race => {
    const { blocker, waiter, claim, owner } = race
    assert.equal((await stageExpiredAuditGapTransfer(adapter(blocker), claim)).staged, true)
    const staged = await snapshot(blocker, owner.tenantId)
    assert.deepEqual(staged.m365_activity_contents, [])
    assert.equal(staged.m365_audit_coverage_gaps!.length, 1)
    assert.equal((await coverageState(blocker, owner.tenantId)).generation, '1')
    const uncommittedView = await snapshot(waiter, owner.tenantId)
    assert.equal(uncommittedView.m365_activity_contents!.length, 1)
    assert.deepEqual(uncommittedView.m365_audit_coverage_gaps, [])
    assert.deepEqual(uncommittedView.m365_audit_coverage_states, [])
    // Synthetic non-key UPDATE only: not the production completion transaction,
    // discovery INSERT/UPSERT, record/blob accounting or the HAW-21 owner fence.
    const pending = race.track(() => waiter.query(`UPDATE public.m365_activity_contents SET status = 'COMPLETED',
      updated_at = clock_timestamp() WHERE id = $1::uuid RETURNING id`, [claim.id]))
    await untilRowWait(race, {
      queryPattern: /^\s*UPDATE public\.m365_activity_contents SET status = 'COMPLETED',\s+updated_at = clock_timestamp\(\) WHERE id = \$1::uuid RETURNING id\s*$/,
    })
    await blocker.query('COMMIT')
    const result = await pending
    assert.equal(result.rowCount, 0)
    assert.deepEqual(result.rows, [])
    assert.deepEqual(await snapshot(waiter, owner.tenantId), staged)
    await waiter.query('COMMIT')
    assert.deepEqual(await snapshot(blocker, owner.tenantId), staged, 'Committed gap/state survives the late no-op write')
  }, { lockSourceBeforeRun: false }))

test('HAW-75 same-identity first-gap transfers serialize on the tenant without refreshing evidence',
  { ...options, timeout: 45_000 }, async () => transferRace(async () => ({}), async race => {
    const { blocker, waiter, claim, owner } = race
    const before = await snapshot(waiter, owner.tenantId)
    assert.deepEqual(before.m365_audit_coverage_gaps, [])
    assert.deepEqual(before.m365_audit_coverage_states, [])
    assert.deepEqual(await stageExpiredAuditGapTransfer(adapter(blocker), claim), { staged: true, reason: 'LEDGER_EXPIRED' })
    const first = await snapshot(blocker, owner.tenantId)
    assert.deepEqual(first.m365_activity_contents, [])
    assert.equal(first.m365_audit_coverage_gaps!.length, 1)
    assert.equal((await coverageState(blocker, owner.tenantId)).generation, '1')
    const pending = race.start()
    await untilRowWait(race, { queryPattern: tenantLockQuery })
    await blocker.query('COMMIT')
    assert.deepEqual(await pending, { staged: false, reason: 'SOURCE_CHANGED_OR_ABSENT' })
    assert.deepEqual(await snapshot(waiter, owner.tenantId), first, 'No duplicate evidence, generation bump or retention refresh')
    await waiter.query('COMMIT')
    assert.deepEqual(await snapshot(blocker, owner.tenantId), first)
  }, { lockSourceBeforeRun: false }))

test('HAW-75 distinct first-gap transfers preserve both identities and advance one sticky generation per gap',
  { ...options, timeout: 45_000 }, async () => transferRace(async () => ({}), async race => {
    const { blocker, waiter, claim, secondClaim, owner } = race
    assert.ok(secondClaim)
    assert.notEqual(secondClaim.microsoftContentId, claim.microsoftContentId)
    const before = await snapshot(waiter, owner.tenantId)
    assert.equal(before.m365_activity_contents!.length, 2)
    assert.deepEqual(before.m365_audit_coverage_gaps, [])
    assert.deepEqual(before.m365_audit_coverage_states, [])
    assert.deepEqual(await stageExpiredAuditGapTransfer(adapter(blocker), claim), { staged: true, reason: 'LEDGER_EXPIRED' })
    const first = await snapshot(blocker, owner.tenantId)
    const firstState = await coverageState(blocker, owner.tenantId)
    assert.equal(first.m365_audit_coverage_gaps!.length, 1)
    assert.equal(firstState.generation, '1')
    const pending = race.start(secondClaim)
    await untilRowWait(race, { queryPattern: tenantLockQuery })
    await blocker.query('COMMIT')
    assert.deepEqual(await pending, { staged: true, reason: 'LEDGER_EXPIRED' })
    const second = await snapshot(waiter, owner.tenantId)
    assert.deepEqual(second.m365_activity_contents, [])
    assert.equal(second.m365_audit_coverage_gaps!.length, 2)
    assert.ok(second.m365_audit_coverage_gaps!.includes(first.m365_audit_coverage_gaps![0]!))
    assert.deepEqual(second.m365_audit_coverage_gaps!.map(row => JSON.parse(row).content_id_sha256).sort(),
      [claim, secondClaim].map(row => createHash('sha256').update(row.microsoftContentId).digest('hex')).sort())
    const secondState = await coverageState(waiter, owner.tenantId)
    assert.equal(secondState.generation, '2')
    assert.equal(secondState.incompleteSince, firstState.incompleteSince)
    assert.equal(secondState.purged, false)
    assert.equal((await waiter.query('SELECT $1::timestamptz >= $2::timestamptz AS monotonic',
      [secondState.lastGapAt, firstState.lastGapAt])).rows[0].monotonic, true)
    await waiter.query('COMMIT')
    assert.deepEqual(await snapshot(blocker, owner.tenantId), second, 'Both committed identities and generation are visible')
  }, { lockSourceBeforeRun: false, seedSecondSource: true }))

test('HAW-75 real Prisma transactions preserve microseconds and large BIGINT generations through rollback and commit',
  { ...options, timeout: 45_000 }, async () => {
    // Both opt-ins and the hosted boundary apply before either client exists.
    const url = assertDisposableTestDatabase()
    assert.equal(url.port, '5432', 'Only the registered hosted disposable PostgreSQL service is permitted')
    const [{ PrismaClient }, { createAdapter }] = await Promise.all([
      import('../generated/prisma/client.js'), import('../prisma/prisma.service.js'),
    ])
    const observer = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000, query_timeout: 25_000 })
    // Use the production adapter factory, including its UTC session setup.
    // The helper receives the actual interactive transaction, with no proxy.
    const prisma = new PrismaClient({ adapter: createAdapter(url.toString()) })
    const organizationId = randomUUID()
    const initialGeneration = 9_007_199_254_740_993n
    const firstObserved = '2001-01-01T00:00:00.654321Z'
    let connected = false
    try {
      await observer.connect()
      connected = true
      await observer.query("SET statement_timeout = '20s'")
      await observer.query("SET lock_timeout = '5s'")
      await observer.query('BEGIN')
      const owner = await scope(observer, organizationId)
      const sibling = await scope(observer, organizationId)
      const claim = await source(observer, owner)
      await source(observer, sibling)
      const priorDigest = createHash('sha256').update(`prior-${randomUUID()}`).digest('hex')
      await observer.query(`INSERT INTO public.m365_audit_coverage_gaps
        (id, organization_id, customer_tenant_id, content_type, content_id_sha256,
         source_status, reason, source_expired_at, first_observed_at)
        VALUES ($1,$2,$3,'Audit.General',$4,'RETRY','LEDGER_EXPIRED',$5,$6)`,
      [randomUUID(), organizationId, owner.tenantId, priorDigest, beforeAge, firstObserved])
      await observer.query(`INSERT INTO public.m365_audit_coverage_states
        (customer_tenant_id, organization_id, generation, incomplete_since, last_gap_at, has_purged_unrepaired_gap)
        VALUES ($1,$2,$3,$4,$4,TRUE)`,
      [owner.tenantId, organizationId, initialGeneration.toString(), firstObserved])
      // Prisma uses another connection; it must see committed fixtures.
      await observer.query('COMMIT')
      const before = await snapshot(observer, owner.tenantId)
      const siblingBefore = await snapshot(observer, sibling.tenantId)
      const priorState = await coverageState(observer, owner.tenantId)
      const transactionOptions = { isolationLevel: 'ReadCommitted' as const, maxWait: 5_000, timeout: 15_000 }
      const stage = async (tx: Prisma.TransactionClient) => {
        assert.deepEqual(await tx.$queryRawUnsafe('SHOW TimeZone'), [{ TimeZone: 'UTC' }])
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'")
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'")
        await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/New_York'")
        await tx.$executeRawUnsafe("SET LOCAL DateStyle = 'SQL, DMY'")
        const states = await tx.$queryRawUnsafe<Array<{ generation: bigint }>>(`SELECT generation
          FROM public.m365_audit_coverage_states WHERE customer_tenant_id = $1::uuid`, owner.tenantId)
        assert.equal(states.length, 1)
        assert.equal(typeof states[0]!.generation, 'bigint', 'The real Prisma decoder must return a BigInt')
        assert.equal(states[0]!.generation, initialGeneration, 'No Number round trip above MAX_SAFE_INTEGER')
        const selected = await tx.$queryRawUnsafe<SelectedAuditGapClaim[]>(`SELECT id::text,
          organization_id::text AS "organizationId", customer_tenant_id::text AS "customerTenantId",
          microsoft_content_id AS "microsoftContentId", content_type AS "contentType", status,
          content_uri AS "contentUri", attempt_count AS "attemptCount",
          to_char(updated_at AT TIME ZONE 'UTC', $2) AS "updatedAt",
          to_char(discovered_at AT TIME ZONE 'UTC', $2) AS "discoveredAt",
          to_char(ledger_expires_at AT TIME ZONE 'UTC', $2) AS "ledgerExpiresAt",
          to_char(content_expires_at AT TIME ZONE 'UTC', $2) AS "contentExpiresAt"
          FROM public.m365_activity_contents WHERE id = $1::uuid`, claim.id, format)
        assert.deepEqual(selected, [claim], 'Prisma selection must preserve all six timestamp decimals')
        assert.deepEqual(await stageExpiredAuditGapTransfer(tx, selected[0]!), { staged: true, reason: 'LEDGER_EXPIRED' })
        const after = await tx.$queryRawUnsafe<Array<{ generation: bigint }>>(`SELECT generation
          FROM public.m365_audit_coverage_states WHERE customer_tenant_id = $1::uuid`, owner.tenantId)
        assert.equal(after[0]!.generation, initialGeneration + 1n, 'BigInt must survive helper read and parameter serialization')
      }
      const rollback = new Error('EXPECTED_PRISMA_TRANSFER_ROLLBACK')
      await assert.rejects(prisma.$transaction(async tx => {
        await stage(tx)
        throw rollback
      }, transactionOptions), error => error === rollback)
      assert.deepEqual(await snapshot(observer, owner.tenantId), before, 'Actual Prisma rejection rolls back all staged SQL')
      assert.deepEqual(await snapshot(observer, sibling.tenantId), siblingBefore)

      await prisma.$transaction(stage, transactionOptions)
      const committed = await snapshot(observer, owner.tenantId)
      assert.deepEqual(committed.m365_activity_contents, [])
      assert.equal(committed.m365_audit_coverage_gaps!.length, 2)
      assert.ok(committed.m365_audit_coverage_gaps!.includes(before.m365_audit_coverage_gaps![0]!))
      const digest = createHash('sha256').update(claim.microsoftContentId, 'utf8').digest('hex')
      const newGap = committed.m365_audit_coverage_gaps!.map(row => JSON.parse(row)).find(row => row.content_id_sha256 === digest)
      assert.ok(newGap)
      assert.equal(newGap.reason, 'LEDGER_EXPIRED')
      assert.ok(!JSON.stringify(committed).includes(claim.contentUri), 'Committed evidence contains no provider URL')
      const committedState = await coverageState(observer, owner.tenantId)
      assert.equal(committedState.generation, '9007199254740994')
      assert.equal(committedState.incompleteSince, priorState.incompleteSince)
      assert.equal(committedState.purged, true)
      assert.deepEqual(await snapshot(observer, sibling.tenantId), siblingBefore)
    } finally {
      const failures: unknown[] = []
      const clean = async (operation: () => Promise<unknown>) => {
        try { await operation() } catch (error) { failures.push(error) }
      }
      // Every interactive transaction has settled before cleanup. On setup
      // failure, roll back the observer before its scoped cascade deletion.
      if (connected) {
        await clean(() => observer.query('ROLLBACK'))
        await clean(async () => {
          await observer.query('DELETE FROM public.organizations WHERE id = $1', [organizationId])
          for (const table of ['customer_tenants', 'm365_activity_contents', 'm365_audit_coverage_gaps', 'm365_audit_coverage_states']) {
            assert.equal((await observer.query(`SELECT 1 FROM public.${table} WHERE organization_id = $1`, [organizationId])).rowCount, 0)
          }
        })
      }
      await clean(() => prisma.$disconnect())
      await clean(() => observer.end())
      if (failures.length) throw new AggregateError(failures, 'Synthetic Prisma transfer cleanup failed')
    }
  })

test('HAW-75 real selector traverses scoped precise claims and preserves stale rejection, rollback and committed isolation',
  { ...options, timeout: 45_000 }, async () => {
    // Prepared only: both markers and the hosted guard precede either client.
    const url = assertDisposableTestDatabase()
    assert.equal(url.port, '5432', 'Only the registered hosted disposable PostgreSQL service is permitted')
    const [{ PrismaClient }, { createAdapter }] = await Promise.all([
      import('../generated/prisma/client.js'), import('../prisma/prisma.service.js'),
    ])
    const observer = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000, query_timeout: 25_000 })
    const prisma = new PrismaClient({ adapter: createAdapter(url.toString()) })
    const organizationIds = [randomUUID(), randomUUID()]
    const generation = 9_007_199_254_740_993n
    const firstObserved = '1999-01-01T00:00:00.123456Z'
    const idPrefix = randomUUID().slice(0, 24)
    const orderedId = (ordinal: number) => idPrefix + ordinal.toString(16).padStart(12, '0')
    const transactionOptions = { isolationLevel: 'ReadCommitted' as const, maxWait: 5_000, timeout: 15_000 }
    const settings = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'")
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'")
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/New_York'")
      await tx.$executeRawUnsafe("SET LOCAL DateStyle = 'SQL, DMY'")
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW TimeZone'), [{ TimeZone: 'America/New_York' }])
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW DateStyle'), [{ DateStyle: 'SQL, DMY' }])
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW client_encoding'), [{ client_encoding: 'UTF8' }])
    }
    let connected = false
    try {
      await observer.connect()
      connected = true
      await observer.query("SET statement_timeout = '20s'")
      await observer.query("SET lock_timeout = '5s'")
      await observer.query("SET TIME ZONE 'UTC'")
      await observer.query('BEGIN')
      const owner = await scope(observer, organizationIds[0]!)
      const sibling = await scope(observer, organizationIds[0]!)
      const outside = await scope(observer, organizationIds[1]!)
      for (const [index, tenant] of [owner, sibling, outside].entries()) {
        await observer.query(`INSERT INTO public.m365_audit_coverage_states
          (customer_tenant_id, organization_id, generation, incomplete_since, last_gap_at, has_purged_unrepaired_gap)
          VALUES ($1,$2,$3,$4,$4,TRUE)`,
        [tenant.tenantId, tenant.organizationId, (generation + BigInt(index)).toString(), firstObserved])
      }
      const live = await source(observer, owner, { id: orderedId(1), status: 'PENDING',
        discoveredAt: '2100-01-01T00:00:00.123456Z', ledgerExpiresAt: '2100-01-30T00:00:00.123457Z',
        contentExpiresAt: '2100-01-29T00:00:00.123455Z' })
      await source(observer, owner, { id: orderedId(2), status: 'COMPLETED' })
      const expired: SelectedAuditGapClaim[] = []
      for (const [index, status] of ['PENDING', 'PROCESSING', 'RETRY', 'FAILED', 'INSUFFICIENT_CAPACITY'].entries()) {
        expired.push(await source(observer, owner, { id: orderedId(index + 3), status,
          updatedAt: `2000-01-02T00:00:00.65432${index}Z`,
          contentExpiresAt: index % 2 === 0 ? afterAge : null }))
      }
      await source(observer, owner, { id: orderedId(8), status: 'SYNTHETIC_UNKNOWN_STATUS' })
      await source(observer, sibling)
      await source(observer, outside)
      await observer.query('COMMIT')
      const before = await snapshot(observer, owner.tenantId)
      const siblingBefore = await snapshot(observer, sibling.tenantId)
      const outsideBefore = await snapshot(observer, outside.tenantId)
      const priorState = await coverageState(observer, owner.tenantId)
      const selectNext = (tx: Prisma.TransactionClient, afterId: string | null) =>
        selectExpiredAuditGapPage(tx, { organizationId: owner.organizationId,
          customerTenantId: owner.tenantId, afterId, limit: 1 })

      // Actual query/decoder, no proxy or scripted rows. READ ONLY rejects any
      // accidental write; candidate selection itself supplies no owner proof.
      await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
        await settings(tx)
        assert.deepEqual(await tx.$queryRawUnsafe('SHOW transaction_read_only'), [{ transaction_read_only: 'on' }])
        const first = await selectNext(tx, null)
        assert.match(first.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
        assert.deepEqual({ ...first, observedAt: 'clock' }, {
          observedAt: 'clock', examinedCount: 1, lastExaminedId: live.id, endOfPass: false, candidates: [],
        })
        let afterId = live.id
        for (const expected of expired) {
          const page = await selectNext(tx, afterId)
          assert.equal(page.examinedCount, 1)
          assert.equal(page.lastExaminedId, expected.id)
          assert.equal(page.endOfPass, false)
          assert.deepEqual(page.candidates, [expected], 'Actual selector retains every descriptor field and all six decimals')
          afterId = expected.id
        }
        const end = await selectNext(tx, afterId)
        assert.deepEqual({ ...end, observedAt: 'clock' }, {
          observedAt: 'clock', examinedCount: 0, lastExaminedId: null, endOfPass: true, candidates: [],
        })
        // Populated other scopes cannot widen either half of the scope pair.
        for (const wrong of [
          { organizationId: outside.organizationId, customerTenantId: owner.tenantId },
          { organizationId: owner.organizationId, customerTenantId: outside.tenantId },
        ]) {
          const page = await selectExpiredAuditGapPage(tx, { ...wrong, afterId: null, limit: 1 })
          assert.deepEqual({ ...page, observedAt: 'clock' }, {
            observedAt: 'clock', examinedCount: 0, lastExaminedId: null, endOfPass: true, candidates: [],
          })
        }
      }, transactionOptions)
      assert.deepEqual(await snapshot(observer, owner.tenantId), before, 'Read-only traversal does not mutate excluded or selected rows')

      // Commit a one-microsecond revision change after selection. This is a
      // sequential stale-descriptor control, not a concurrent writer race.
      const selected = expired[0]!
      await observer.query(`UPDATE public.m365_activity_contents
        SET updated_at = updated_at + interval '1 microsecond' WHERE id = $1`, [selected.id])
      const revised = await select(observer, selected.id)
      assert.notEqual(revised.updatedAt, selected.updatedAt)
      assert.equal(revised.updatedAt.slice(0, 23), selected.updatedAt.slice(0, 23), 'Revisions differ inside one millisecond')
      const revisedBefore = await snapshot(observer, owner.tenantId)
      await prisma.$transaction(async tx => {
        await settings(tx)
        assert.deepEqual(await stageExpiredAuditGapTransfer(tx, selected), {
          staged: false, reason: 'SOURCE_CHANGED_OR_ABSENT',
        })
      }, transactionOptions)
      assert.deepEqual(await snapshot(observer, owner.tenantId), revisedBefore)

      const stageFresh = async (tx: Prisma.TransactionClient) => {
        await settings(tx)
        const page = await selectNext(tx, live.id)
        assert.deepEqual(page.candidates, [revised])
        assert.deepEqual(await stageExpiredAuditGapTransfer(tx, page.candidates[0]!), { staged: true, reason: 'LEDGER_EXPIRED' })
        const states = await tx.$queryRawUnsafe<Array<{ generation: bigint }>>(`SELECT generation
          FROM public.m365_audit_coverage_states WHERE customer_tenant_id = $1::uuid`, owner.tenantId)
        assert.deepEqual(states, [{ generation: generation + 1n }])
        assert.deepEqual(await snapshot(observer, owner.tenantId), revisedBefore, 'Independent reader cannot see uncommitted staged writes')
      }
      const rollback = new Error('EXPECTED_SELECTOR_TRANSFER_ROLLBACK')
      await assert.rejects(prisma.$transaction(async tx => {
        await stageFresh(tx)
        throw rollback
      }, transactionOptions), error => error === rollback)
      assert.deepEqual(await snapshot(observer, owner.tenantId), revisedBefore, 'Selector-plus-transfer rollback preserves committed state')
      await prisma.$transaction(stageFresh, transactionOptions)
      const committed = await snapshot(observer, owner.tenantId)
      assert.deepEqual(committed.m365_activity_contents,
        revisedBefore.m365_activity_contents!.filter(row => JSON.parse(row).id !== selected.id),
        'Only the fresh selected row is removed; completed, unknown and unvisited rows remain')
      assert.equal(committed.m365_audit_coverage_gaps!.length, 1)
      const gap = JSON.parse(committed.m365_audit_coverage_gaps![0]!)
      assert.equal(gap.content_id_sha256, createHash('sha256').update(selected.microsoftContentId, 'utf8').digest('hex'))
      assert.equal(gap.reason, 'LEDGER_EXPIRED')
      assert.ok(!JSON.stringify(gap).includes(selected.contentUri))
      const state = await coverageState(observer, owner.tenantId)
      assert.equal(state.generation, (generation + 1n).toString())
      assert.equal(state.incompleteSince, priorState.incompleteSince)
      assert.equal(state.purged, true)
      assert.deepEqual(await snapshot(observer, sibling.tenantId), siblingBefore, 'Populated same-organization sibling state is preserved')
      assert.deepEqual(await snapshot(observer, outside.tenantId), outsideBefore, 'Populated outside-organization state is preserved')
    } finally {
      const failures: unknown[] = []
      const clean = async (operation: () => Promise<unknown>) => {
        try { await operation() } catch (error) { failures.push(error) }
      }
      if (connected) {
        await clean(() => observer.query('ROLLBACK'))
        for (const organizationId of organizationIds) await clean(async () => {
          await observer.query('DELETE FROM public.organizations WHERE id = $1', [organizationId])
          for (const table of ['customer_tenants', 'm365_activity_contents', 'm365_audit_coverage_gaps', 'm365_audit_coverage_states']) {
            assert.equal((await observer.query(`SELECT 1 FROM public.${table} WHERE organization_id = $1`, [organizationId])).rowCount, 0)
          }
        })
      }
      await clean(() => prisma.$disconnect())
      await clean(() => observer.end())
      if (failures.length) throw new AggregateError(failures, 'Synthetic selector-transfer cleanup failed')
    }
  })

test('HAW-75 selector enforces physical URI and exact serialized-page byte gates without skipping or mutation',
  { ...options, timeout: 60_000 }, async () => {
    const url = assertDisposableTestDatabase()
    assert.equal(url.port, '5432', 'Only the registered hosted disposable PostgreSQL service is permitted')
    assert.equal(AUDIT_GAP_SELECTION_URI_BYTES, 6_291_456, 'Pin the reviewed inactive URI envelope')
    assert.equal(AUDIT_GAP_SELECTION_PAGE_BYTES, 8_388_608, 'Pin the reviewed inactive page envelope')
    const [{ PrismaClient }, { createAdapter }] = await Promise.all([
      import('../generated/prisma/client.js'), import('../prisma/prisma.service.js'),
    ])
    const observer = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000, query_timeout: 25_000 })
    const prisma = new PrismaClient({ adapter: createAdapter(url.toString()) })
    const organizationId = randomUUID()
    const prefix = randomUUID().slice(0, 24)
    const marker = 'SYNTHETIC_SELECTOR_PAYLOAD:'
    const markerBytes = Buffer.byteLength(marker, 'utf8')
    type Observation = { bytes: number; digest: string; refusal: string | null }
    let connected = false
    try {
      await observer.connect()
      connected = true
      await observer.query("SET statement_timeout = '20s'")
      await observer.query("SET lock_timeout = '5s'")
      await observer.query("SET TIME ZONE 'UTC'")
      await observer.query('BEGIN')
      const owner = await scope(observer, organizationId)
      const sibling = await scope(observer, organizationId)
      // Keep source()'s exact-descriptor check small. Large synthetic strings
      // are built in PostgreSQL later and never included in assertion output.
      const first = await source(observer, owner, { id: prefix + '000000000001' })
      await source(observer, owner, { id: prefix + '000000000002' })
      await source(observer, sibling)
      for (const tenant of [owner, sibling]) await observer.query(`INSERT INTO public.m365_audit_coverage_states
        (customer_tenant_id, organization_id, generation, incomplete_since, last_gap_at, has_purged_unrepaired_gap)
        VALUES ($1,$2,7,'1999-01-01T00:00:00.123456Z','1999-01-01T00:00:00.123456Z',TRUE)`,
      [tenant.tenantId, organizationId])
      await observer.query('COMMIT')
      const input = { organizationId, customerTenantId: owner.tenantId, afterId: null, limit: 1 }
      const fingerprints = async () => {
        const result: Record<string, Array<{ digest: string }>> = {}
        for (const table of ['m365_activity_contents', 'm365_audit_coverage_gaps', 'm365_audit_coverage_states']) {
          result[table] = (await observer.query(`SELECT md5(to_jsonb(t)::text) AS digest
            FROM public.${table} t WHERE organization_id = $1 ORDER BY digest`, [organizationId])).rows
        }
        return result
      }
      const uriInfo = async () => {
        const rows = (await observer.query(`SELECT octet_length(content_uri) AS bytes, md5(content_uri) AS digest
          FROM public.m365_activity_contents WHERE id = $1`, [first.id])).rows
        assert.equal(rows.length, 1)
        return rows[0] as { bytes: number; digest: string }
      }
      const exercise = async (refusal: 'URI_LIMIT' | 'PAGE_LIMIT' | null, expectedPageBytes?: number) => {
        const before = await fingerprints()
        const expectedUri = await uriInfo()
        let measured: Observation | undefined
        for (const instrumented of [false, true]) {
          const observations: Observation[] = []
          await prisma.$transaction(async tx => {
            await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
            await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'")
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'")
            assert.deepEqual(await tx.$queryRawUnsafe('SHOW server_encoding'), [{ server_encoding: 'UTF8' }])
            assert.deepEqual(await tx.$queryRawUnsafe('SHOW client_encoding'), [{ client_encoding: 'UTF8' }])
            // Direct Prisma is the acceptance control. A second execution
            // embeds the unchanged selector SQL and parameters, adding only
            // server measurements of the returned field. No rows are scripted.
            const transport: AuditGapTransferTransaction = instrumented ? {
              async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
                const rows = await tx.$queryRawUnsafe<Array<{ page: string; bytes: number; digest: string }>>(`
                  WITH selector_measurement AS MATERIALIZED (${query})
                  SELECT page, octet_length(page) AS bytes, md5(page) AS digest FROM selector_measurement`, ...values)
                assert.equal(rows.length, 1)
                const row = rows[0]!
                assert.equal(typeof row.page, 'string')
                assert.equal(Buffer.byteLength(row.page, 'utf8'), row.bytes, 'Client/server returned-field byte lengths agree')
                assert.equal(createHash('md5').update(row.page, 'utf8').digest('hex'), row.digest, 'Client/server returned-field digests agree')
                assert.ok(row.bytes <= AUDIT_GAP_SELECTION_PAGE_BYTES)
                if (refusal) {
                  const expectedRefusal = JSON.stringify({ refused: refusal })
                  assert.equal(row.bytes, Buffer.byteLength(expectedRefusal, 'utf8'), 'Refusal transports only the fixed code length')
                  assert.equal(row.digest, createHash('md5').update(expectedRefusal, 'utf8').digest('hex'),
                    'Refusal transports only the fixed code digest, without a row or cursor')
                  assert.ok(!row.page.includes(marker))
                }
                observations.push({ bytes: row.bytes, digest: row.digest, refusal })
                return [{ page: row.page }] as T
              },
            } : tx
            if (refusal) {
              await assert.rejects(selectExpiredAuditGapPage(transport, input), error => {
                assert.ok(error instanceof Error)
                assert.equal(error.message, `M365_AUDIT_GAP_SELECTION_${refusal}`)
                assert.equal('cause' in error, false)
                assert.equal('lastExaminedId' in error, false)
                assert.equal('candidates' in error, false)
                return true
              })
            } else {
              const page = await selectExpiredAuditGapPage(transport, input)
              assert.equal(page.examinedCount, 1)
              assert.equal(page.endOfPass, false)
              assert.equal(page.lastExaminedId, first.id)
              assert.equal(page.candidates.length, 1)
              const selected = page.candidates[0]!
              assert.equal(selected.id, first.id)
              assert.equal(Buffer.byteLength(selected.contentUri, 'utf8'), expectedUri.bytes)
              assert.equal(createHash('md5').update(selected.contentUri, 'utf8').digest('hex'), expectedUri.digest)
            }
          }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 15_000 })
          assert.equal(observations.length, instrumented ? 1 : 0)
          if (instrumented) measured = observations[0]!
          assert.deepEqual(await fingerprints(), before, 'Each read/refusal preserves every scoped source, gap and sticky-state fingerprint')
        }
        assert.ok(measured)
        if (expectedPageBytes !== undefined) assert.equal(measured.bytes, expectedPageBytes)
        return measured
      }

      // Exact URI edge, then +1 byte: a valid later row may not be substituted
      // for the oversized low-ID row. Both direct and observed calls refuse.
      await observer.query('UPDATE public.m365_activity_contents SET content_uri = $2 || repeat($3, $4::integer) WHERE id = $1',
        [first.id, marker, 'x', AUDIT_GAP_SELECTION_URI_BYTES - markerBytes])
      assert.equal((await uriInfo()).bytes, AUDIT_GAP_SELECTION_URI_BYTES)
      await exercise(null)
      await observer.query("UPDATE public.m365_activity_contents SET content_uri = content_uri || 'x' WHERE id = $1", [first.id])
      assert.equal((await uriInfo()).bytes, AUDIT_GAP_SELECTION_URI_BYTES + 1)
      await exercise('URI_LIMIT')

      const room = AUDIT_GAP_SELECTION_URI_BYTES - markerBytes
      await observer.query(`UPDATE public.m365_activity_contents
        SET content_uri = $2 || repeat('é', $3::integer) || repeat('x', $4::integer) WHERE id = $1`,
      [first.id, marker, Math.floor(room / 2), room % 2])
      assert.equal((await uriInfo()).bytes, AUDIT_GAP_SELECTION_URI_BYTES)
      await exercise(null)
      await observer.query("UPDATE public.m365_activity_contents SET content_uri = content_uri || 'x' WHERE id = $1", [first.id])
      await exercise('URI_LIMIT')

      // PostgreSQL's real jsonb::text escaping determines the page envelope.
      // Measure a safe base, then add ASCII bytes to reach the exact field cap.
      // The clock's six-decimal UTC representation has constant width here.
      await observer.query(`UPDATE public.m365_activity_contents
        SET content_uri = $2 || repeat(chr(1), 1200000) WHERE id = $1`, [first.id, marker])
      const base = await exercise(null)
      const padding = AUDIT_GAP_SELECTION_PAGE_BYTES - base.bytes
      assert.ok(Number.isInteger(padding) && padding > 0)
      assert.ok((await uriInfo()).bytes + padding + 1 < AUDIT_GAP_SELECTION_URI_BYTES)
      await observer.query("UPDATE public.m365_activity_contents SET content_uri = content_uri || repeat('x', $2::integer) WHERE id = $1", [first.id, padding])
      await exercise(null, AUDIT_GAP_SELECTION_PAGE_BYTES)
      await observer.query("UPDATE public.m365_activity_contents SET content_uri = content_uri || 'x' WHERE id = $1", [first.id])
      assert.ok((await uriInfo()).bytes < AUDIT_GAP_SELECTION_URI_BYTES, 'Page overflow is distinct from URI overflow')
      await exercise('PAGE_LIMIT')
    } finally {
      const failures: unknown[] = []
      const clean = async (operation: () => Promise<unknown>) => {
        try { await operation() } catch (error) { failures.push(error) }
      }
      if (connected) {
        await clean(() => observer.query('ROLLBACK'))
        await clean(async () => {
          await observer.query('DELETE FROM public.organizations WHERE id = $1', [organizationId])
          for (const table of ['customer_tenants', 'm365_activity_contents', 'm365_audit_coverage_gaps', 'm365_audit_coverage_states']) {
            assert.equal((await observer.query(`SELECT 1 FROM public.${table} WHERE organization_id = $1`, [organizationId])).rowCount, 0)
          }
        })
      }
      await clean(() => prisma.$disconnect())
      await clean(() => observer.end())
      if (failures.length) throw new AggregateError(failures, 'Synthetic selector-payload cleanup failed')
    }
  })

test('HAW-75 selector uses earliest nullable expiry and a live clock within one read-only transaction',
  { ...options, timeout: 60_000 }, async () => {
    const url = assertDisposableTestDatabase()
    assert.equal(url.port, '5432', 'Only the registered hosted disposable PostgreSQL service is permitted')
    const [{ PrismaClient }, { createAdapter }] = await Promise.all([
      import('../generated/prisma/client.js'), import('../prisma/prisma.service.js'),
    ])
    const observer = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000, query_timeout: 25_000 })
    const prisma = new PrismaClient({ adapter: createAdapter(url.toString()) })
    const organizationId = randomUUID()
    const futureDiscovery = '2100-01-01T00:00:00.123456Z'
    const futureAge = '2100-01-31T00:00:00.123456Z'
    const futureLedger = '2100-02-01T00:00:00.123457Z'
    const cases: Array<{ name: string; discoveredAt: string; ledgerExpiresAt: string; contentExpiresAt: string | null; eligible: boolean }> = [
      { name: 'provider alone elapsed', discoveredAt: futureDiscovery, ledgerExpiresAt: futureLedger, contentExpiresAt: beforeAge, eligible: true },
      { name: 'ledger alone elapsed', discoveredAt: futureDiscovery, ledgerExpiresAt: beforeAge, contentExpiresAt: futureAge, eligible: true },
      { name: 'age alone elapsed', discoveredAt: discovered, ledgerExpiresAt: futureLedger, contentExpiresAt: futureAge, eligible: true },
      { name: 'null provider and ledger elapsed', discoveredAt: futureDiscovery, ledgerExpiresAt: beforeAge, contentExpiresAt: null, eligible: true },
      { name: 'null provider and age elapsed', discoveredAt: discovered, ledgerExpiresAt: futureLedger, contentExpiresAt: null, eligible: true },
      { name: 'null provider all future', discoveredAt: futureDiscovery, ledgerExpiresAt: futureLedger, contentExpiresAt: null, eligible: false },
      { name: 'all nonnull future', discoveredAt: futureDiscovery, ledgerExpiresAt: futureLedger, contentExpiresAt: futureAge, eligible: false },
      { name: 'provider-ledger past tie', discoveredAt: futureDiscovery, ledgerExpiresAt: beforeAge, contentExpiresAt: beforeAge, eligible: true },
      { name: 'ledger-age past tie', discoveredAt: discovered, ledgerExpiresAt: ageDeadline, contentExpiresAt: futureAge, eligible: true },
      { name: 'provider-age past tie', discoveredAt: discovered, ledgerExpiresAt: futureLedger, contentExpiresAt: ageDeadline, eligible: true },
      { name: 'all past tie', discoveredAt: discovered, ledgerExpiresAt: ageDeadline, contentExpiresAt: ageDeadline, eligible: true },
      { name: 'all future tie', discoveredAt: futureDiscovery, ledgerExpiresAt: futureAge, contentExpiresAt: futureAge, eligible: false },
    ]
    const settings = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'")
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'")
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/New_York'")
      await tx.$executeRawUnsafe("SET LOCAL DateStyle = 'SQL, DMY'")
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW transaction_read_only'), [{ transaction_read_only: 'on' }])
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW TimeZone'), [{ TimeZone: 'America/New_York' }])
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW DateStyle'), [{ DateStyle: 'SQL, DMY' }])
    }
    type ClockOracle = { bracketed: boolean; eligible: boolean; providerReached: boolean | null; transactionStartedBeforeProvider: boolean | null }
    const checkedRead = async (tx: Prisma.TransactionClient, claim: SelectedAuditGapClaim, afterId: string | null) => {
      const before = await tx.$queryRawUnsafe<Array<{ at: string }>>(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', $1) AS at`, format)
      assert.equal(before.length, 1)
      const page = await selectExpiredAuditGapPage(tx, { organizationId: claim.organizationId,
        customerTenantId: claim.customerTenantId, afterId, limit: 1 })
      // Same real transaction, unchanged source and exact returned UTC6 clock;
      // no Date/Number rounding, clock override, SQL rewriting or response proxy.
      const rows = await tx.$queryRawUnsafe<ClockOracle[]>(`SELECT
        $2::timestamptz >= $3::timestamptz AND $2::timestamptz <= clock_timestamp() AS bracketed,
        LEAST(ledger_expires_at, discovered_at + interval '720 hours', content_expires_at) <= $2::timestamptz AS eligible,
        $2::timestamptz >= content_expires_at AS "providerReached",
        transaction_timestamp() < content_expires_at AS "transactionStartedBeforeProvider"
        FROM public.m365_activity_contents WHERE id = $1::uuid`, claim.id, page.observedAt, before[0]!.at)
      assert.equal(rows.length, 1)
      const oracle = rows[0]!
      assert.equal(oracle.bracketed, true, 'Returned observation lies between real before/after database clocks')
      assert.equal(page.examinedCount, 1)
      assert.equal(page.lastExaminedId, claim.id)
      assert.equal(page.endOfPass, false)
      assert.deepEqual(page.candidates, oracle.eligible ? [claim] : [])
      return oracle
    }
    let connected = false
    try {
      await observer.connect()
      connected = true
      await observer.query("SET statement_timeout = '20s'")
      await observer.query("SET lock_timeout = '5s'")
      await observer.query("SET TIME ZONE 'UTC'")
      await observer.query('BEGIN')
      const owner = await scope(observer, organizationId)
      const clockOwner = await scope(observer, organizationId)
      const prefix = randomUUID().slice(0, 24)
      const claims: SelectedAuditGapClaim[] = []
      for (const [index, fixture] of cases.entries()) claims.push(await source(observer, owner, {
        id: prefix + (index + 1).toString(16).padStart(12, '0'), discoveredAt: fixture.discoveredAt,
        ledgerExpiresAt: fixture.ledgerExpiresAt, contentExpiresAt: fixture.contentExpiresAt,
      }))
      const clockClaim = await source(observer, clockOwner, { discoveredAt: futureDiscovery,
        ledgerExpiresAt: futureLedger, contentExpiresAt: futureAge })
      for (const tenant of [owner, clockOwner]) await observer.query(`INSERT INTO public.m365_audit_coverage_states
        (customer_tenant_id, organization_id, generation, incomplete_since, last_gap_at, has_purged_unrepaired_gap)
        VALUES ($1,$2,9,'1999-01-01T00:00:00.123456Z','1999-01-01T00:00:00.123456Z',TRUE)`,
      [tenant.tenantId, organizationId])
      await observer.query('COMMIT')
      const ownerBefore = await snapshot(observer, owner.tenantId)
      const clockBefore = await snapshot(observer, clockOwner.tenantId)
      await prisma.$transaction(async tx => {
        await settings(tx)
        let afterId: string | null = null
        for (const [index, claim] of claims.entries()) {
          const oracle = await checkedRead(tx, claim, afterId)
          assert.equal(oracle.eligible, cases[index]!.eligible, cases[index]!.name)
          afterId = claim.id
        }
      }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 20_000 })
      assert.deepEqual(await snapshot(observer, owner.tenantId), ownerBefore)
      assert.deepEqual(await snapshot(observer, clockOwner.tenantId), clockBefore)

      await prisma.$transaction(async tx => {
        await settings(tx)
        // This separate connection commits a future deadline after the real
        // read-only transaction has started. READ COMMITTED sees that revision.
        await observer.query(`UPDATE public.m365_activity_contents
          SET content_expires_at = clock_timestamp() + interval '3 seconds' WHERE id = $1`, [clockClaim.id])
        const revised = await select(observer, clockClaim.id)
        const revisedBefore = await snapshot(observer, clockOwner.tenantId)
        let oracle = await checkedRead(tx, revised, null)
        assert.equal(oracle.transactionStartedBeforeProvider, true)
        assert.equal(oracle.providerReached, false, 'Initial sample must precede the deadline; do not silently skip a late fixture')
        assert.equal(oracle.eligible, false)
        // Wall-clock wait controls test liveness only. Actual expiry and clock
        // advancement are decided by the observed database values above.
        const stop = performance.now() + 7_000
        while (!oracle.providerReached && performance.now() < stop) {
          await new Promise(resolve => setTimeout(resolve, 100))
          oracle = await checkedRead(tx, revised, null)
          assert.equal(oracle.transactionStartedBeforeProvider, true)
        }
        assert.equal(oracle.providerReached, true, 'Database clock must cross the committed provider deadline')
        assert.equal(oracle.eligible, true, 'Same transaction must now return the expired candidate')
        assert.deepEqual(await snapshot(observer, clockOwner.tenantId), revisedBefore)
      }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 20_000 })
      assert.deepEqual(await snapshot(observer, owner.tenantId), ownerBefore, 'Other scope remains unchanged across the clock control')
    } finally {
      const failures: unknown[] = []
      const clean = async (operation: () => Promise<unknown>) => {
        try { await operation() } catch (error) { failures.push(error) }
      }
      if (connected) {
        await clean(() => observer.query('ROLLBACK'))
        await clean(async () => {
          await observer.query('DELETE FROM public.organizations WHERE id = $1', [organizationId])
          for (const table of ['customer_tenants', 'm365_activity_contents', 'm365_audit_coverage_gaps', 'm365_audit_coverage_states']) {
            assert.equal((await observer.query(`SELECT 1 FROM public.${table} WHERE organization_id = $1`, [organizationId])).rowCount, 0)
          }
        })
      }
      await clean(() => prisma.$disconnect())
      await clean(() => observer.end())
      if (failures.length) throw new AggregateError(failures, 'Synthetic selector-expiry cleanup failed')
    }
  })
