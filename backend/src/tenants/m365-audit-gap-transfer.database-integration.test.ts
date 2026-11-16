import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { stageExpiredAuditGapTransfer, type AuditGapTransferTransaction, type SelectedAuditGapClaim } from './m365-audit-gap-transfer.js'

// Actual helper SQL, hosted disposable service only. No provider, owner-fence,
// production selection adapter, outcome reader or concurrent writer is exercised.
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
