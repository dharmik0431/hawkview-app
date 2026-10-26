import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import pg, { type QueryConfig } from 'pg'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { commitActiveIntakeReceipt, INTAKE_RECEIPT_TRANSACTION_LIMITS,
  type IntakeReceiptRunner, type IntakeReceiptTransactionLimits } from './intake-continuation-writer.js'
import type { IntakeSourceSnapshot } from './intake-continuation-policy.js'
import type { SqlRunner } from './pipeline-store.js'

// This inactive seam is exercised only by the registered hosted disposable
// PostgreSQL job. No Microsoft, email, or production service is invoked.
const RUN = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const URL = RUN ? assertDisposableTestDatabase(process.env, { requireUtc: true }).toString() : undefined
const INTEGRATION_GATE = 8_192_026
let gate: pg.Client | null = null

before(async () => {
  if (!RUN || !URL) return
  gate = new pg.Client({ connectionString: URL })
  await gate.connect()
  await gate.query('SELECT pg_advisory_lock($1)', [INTEGRATION_GATE])
})

after(async () => {
  if (gate === null) return
  try { await gate.query('SELECT pg_advisory_unlock($1)', [INTEGRATION_GATE]) }
  finally { await gate.end(); gate = null }
})

type SelectedRow = IntakeSourceSnapshot & Readonly<{ activeAtSelection: boolean }>

async function selectSource(client: pg.Client, findingId: string): Promise<SelectedRow> {
  const rows = (await client.query<SelectedRow>(
    `SELECT f.id::text AS id, f.organization_id::text AS "organizationId",
            f.customer_tenant_id::text AS "customerTenantId",
            f.matched_result_id::text AS "matchedResultId", f.dedupe_key AS "dedupeKey",
            f.rule_id AS "ruleId", f.rule_version AS "ruleVersion",
            f.subject_type AS "subjectType", f.subject_id AS "subjectId", f.state,
            f.severity, f.confidence, f.coverage,
            to_char(f.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "observedAt",
            to_char(f.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "expiresAt",
            to_char(f.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
            (f.state IN ('OPEN', 'UPDATED') AND f.observed_at >= clock_timestamp() - INTERVAL '24 hours'
              AND f.observed_at <= clock_timestamp() AND f.expires_at > clock_timestamp())
              AS "activeAtSelection"
       FROM identity_risk_findings f WHERE f.id = $1::uuid`, [findingId])).rows
  assert.equal(rows.length, 1)
  return rows[0]!
}

async function boundedQuery<T>(client: pg.PoolClient, deadline: number,
  text: string, values: readonly unknown[]): Promise<{ rows: readonly T[]; rowCount: number | null }> {
  const remaining = Math.floor(deadline - performance.now())
  if (remaining <= 0) throw new Error('TEST_INTAKE_TRANSACTION_DEADLINE')
  const statement: QueryConfig & { query_timeout: number } = {
    text, values: [...values], query_timeout: remaining,
  }
  const result = await client.query(statement)
  return { rows: result.rows as T[], rowCount: result.rowCount }
}

type SqlProbe = { statements: string[]; decisionClockSamples: string[] }

function insideTransaction(client: pg.PoolClient, deadline: number, probe: SqlProbe): SqlRunner {
  return {
    query: async <T>(sql: string, params: readonly unknown[]) => {
      probe.statements.push(sql)
      const rows = (await boundedQuery<T>(client, deadline, sql, params)).rows
      if (sql.includes('clock_timestamp()') && sql.includes('decided_at_exact')) {
        const sample = rows[0] as { decided_at_exact?: string } | undefined
        probe.decisionClockSamples.push(sample?.decided_at_exact ?? '')
      }
      return rows
    },
    execute: async (sql: string, params: readonly unknown[]) => {
      probe.statements.push(sql)
      return (await boundedQuery(client, deadline, sql, params)).rowCount ?? 0
    },
    transaction: run => run(insideTransaction(client, deadline, probe)),
  }
}

function receiptRunner(pool: pg.Pool, probe: SqlProbe): IntakeReceiptRunner {
  const outside = async (): Promise<never> => { throw new Error('TEST_UNBOUNDED_INTAKE_SQL') }
  return {
    query: outside,
    execute: outside,
    transaction: outside,
    async transactionWithLimits<T>(limits: IntakeReceiptTransactionLimits,
      run: (tx: SqlRunner) => Promise<T>): Promise<T> {
      assert.deepEqual(limits, INTAKE_RECEIPT_TRANSACTION_LIMITS)
      const client = await pool.connect() // pool connectionTimeoutMillis enforces maxWaitMs
      const deadline = performance.now() + limits.timeoutMs
      let opened = false
      let discard = false
      try {
        await boundedQuery(client, deadline, 'BEGIN', [])
        opened = true
        const result = await run(insideTransaction(client, deadline, probe))
        await boundedQuery(client, deadline, 'COMMIT', [])
        opened = false
        return result
      } catch (error) {
        if (opened) {
          try { await client.query({ text: 'ROLLBACK', query_timeout: 500 } as QueryConfig) }
          catch { discard = true }
        }
        throw error
      } finally {
        client.release(discard)
      }
    },
  }
}

test('inactive writer samples the DB clock after an active finding expires and claims no effects',
  { skip: !RUN || !URL, timeout: 120_000 }, async () => {
    const organizationId = randomUUID()
    const customerTenantId = randomUUID()
    const runId = randomUUID()
    const matchedResultId = randomUUID()
    const findingId = randomUUID()
    const crossingFindingId = randomUUID()
    const incidentKey = `ci-intake-${findingId}`
    const crossingIncidentKey = `ci-intake-${crossingFindingId}`
    const seed = new pg.Client({ connectionString: URL })
    const pool = new pg.Pool({ connectionString: URL, max: 1,
      connectionTimeoutMillis: INTAKE_RECEIPT_TRANSACTION_LIMITS.maxWaitMs })
    let holder: pg.Client | null = null
    let seedConnected = false
    let effectCalls = 0
    let bodyFailed = false
    try {
      await seed.connect()
      seedConnected = true
      await pool.query('SELECT 1')
      await seed.query(`INSERT INTO organizations (id, name, slug, created_at, updated_at)
        VALUES ($1::uuid, 'Inactive intake CI probe', $2, now(), now())`,
      [organizationId, `intake-${organizationId}`])
      await seed.query(`INSERT INTO customer_tenants
        (id, organization_id, microsoft_tenant_id, display_name, created_at, updated_at)
        VALUES ($1::uuid, $2::uuid, $3::uuid, 'Inactive intake CI tenant', now(), now())`,
      [customerTenantId, organizationId, randomUUID()])
      await seed.query(`INSERT INTO identity_risk_evaluation_runs
        (id, organization_id, customer_tenant_id, run_key, engine_version, catalog_version, status,
         window_start, window_end, source_watermark_hash, source_content_hash, expires_at,
         completed_at, created_at)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ci', 'ci', 'COMPLETED',
                now() - INTERVAL '1 hour', now(), 'ci', 'ci', now() + INTERVAL '30 days', now(), now())`,
      [runId, organizationId, customerTenantId, `intake-${runId}`])
      await seed.query(`INSERT INTO identity_risk_matched_results
        (id, organization_id, customer_tenant_id, evaluation_run_id, result_key, rule_id,
         subject_type, subject_id, severity, confidence, coverage, observed_at, expires_at, created_at)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'HV-ID-AUTH-001.v1',
                'USER', 'ci-subject', 'HIGH', 'HIGH', 'FULL', now() - INTERVAL '1 hour',
                now() + INTERVAL '30 days', now())`,
      [matchedResultId, organizationId, customerTenantId, runId, `intake-${matchedResultId}`])
      await seed.query(`INSERT INTO identity_risk_findings
        (id, organization_id, customer_tenant_id, matched_result_id, dedupe_key, rule_id,
         rule_version, subject_type, subject_id, state, severity, confidence, coverage,
         observed_at, expires_at, updated_at)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'HV-ID-AUTH-001.v1',
                'v1', 'USER', 'ci-subject', 'OPEN', 'HIGH', 'HIGH', 'FULL',
                clock_timestamp() - INTERVAL '1 hour', clock_timestamp() + INTERVAL '15 seconds', now())`,
      [findingId, organizationId, customerTenantId, matchedResultId, `intake-${findingId}`])

      const selected = await selectSource(seed, findingId)
      assert.equal(selected.activeAtSelection, true, 'finding must be active at selection')
      const snapshot: IntakeSourceSnapshot = selected
      // A database-time barrier changes no source field, so the writer's full
      // selected-versus-locked CAS still matches after the expiry boundary.
      await seed.query(`SELECT pg_sleep(GREATEST(0,
        EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())) + 0.05)::double precision)`,
      [snapshot.expiresAt])
      const afterExpiry = (await seed.query<{ expired: boolean }>(
        'SELECT clock_timestamp() >= $1::timestamptz AS expired', [snapshot.expiresAt])).rows[0]
      assert.equal(afterExpiry?.expired, true)

      const probe: SqlProbe = { statements: [], decisionClockSamples: [] }
      const runner = receiptRunner(pool, probe)
      const writeActiveEffect = async (tx: SqlRunner) => {
        effectCalls += 1
        await tx.execute(`INSERT INTO alert_incidents
          (id, organization_id, incident_key, alert_type_id, ownership, "condition", investigation,
           ownership_at, condition_at, investigation_at, updated_at)
          VALUES (gen_random_uuid(), $1::uuid, $2, 'security.suspected_credential_attack',
                  'UNACKNOWLEDGED', 'ACTIVE', 'OPEN', now(), now(), now(), now())`,
        [organizationId, incidentKey])
      }
      assert.deepEqual(await commitActiveIntakeReceipt(runner, snapshot, 'ci-map-a',
        'COMPLETED', writeActiveEffect), { kind: 'REFUSED', reason: 'HISTORICAL_ONLY' })
      assert.equal(effectCalls, 0)
      const sourceLock = probe.statements.findIndex(sql =>
        sql.includes('FROM identity_risk_findings f') && sql.includes('FOR UPDATE OF f NOWAIT'))
      const receiptLock = probe.statements.findIndex(sql =>
        sql.includes('FROM alert_finding_intake_status') && sql.includes('FOR UPDATE'))
      const clockQueries = probe.statements.flatMap((sql, index) =>
        sql.includes('clock_timestamp()') && sql.includes('decided_at_exact') ? [index] : [])
      assert.equal(clockQueries.length, 1, 'the writer must query the PostgreSQL decision clock once')
      assert.ok(sourceLock >= 0 && receiptLock > sourceLock && clockQueries[0]! > receiptLock,
        'the PostgreSQL decision clock must be sampled after both finding and receipt locks')
      assert.equal(probe.decisionClockSamples.length, 1)
      assert.ok(Date.parse(probe.decisionClockSamples[0]!) > Date.parse(snapshot.expiresAt),
        'the writer must classify using a post-expiry PostgreSQL clock sample')
      const rows = (await seed.query<{ receipts: number; incidents: number; notifications: number; jobs: number }>(
        `SELECT
          (SELECT count(*)::int FROM alert_finding_intake_status WHERE finding_id = $1::uuid) AS receipts,
          (SELECT count(*)::int FROM alert_incidents WHERE organization_id = $2::uuid) AS incidents,
          (SELECT count(*)::int FROM notifications WHERE organization_id = $2::uuid) AS notifications,
          (SELECT count(*)::int FROM alert_send_jobs WHERE message_id LIKE $3) AS jobs`,
        [findingId, organizationId, `incident/${organizationId}|%`])).rows[0]
      assert.deepEqual(rows, { receipts: 0, incidents: 0, notifications: 0, jobs: 0 })

      // Another worker holding this exact finding prevents admission before
      // either a decision clock or effect can be reached; NOWAIT is retryable.
      holder = new pg.Client({ connectionString: URL })
      await holder.connect()
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM identity_risk_findings WHERE id = $1::uuid FOR UPDATE', [findingId])
      await assert.rejects(commitActiveIntakeReceipt(runner, snapshot, 'ci-map-a',
        'COMPLETED', writeActiveEffect), (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03')
      assert.equal(effectCalls, 0)
      assert.equal(probe.decisionClockSamples.length, 1,
        'a failed finding lock must not sample a second decision clock')

      // A separate finding starts active. Its DB-only effect is written, then
      // the callback waits until expiry while the bounded transaction remains
      // open. The second real PostgreSQL clock sample must abort that entire
      // transaction, not leave a receipt or incident behind.
      await seed.query(`INSERT INTO identity_risk_findings
        (id, organization_id, customer_tenant_id, matched_result_id, dedupe_key, rule_id,
         rule_version, subject_type, subject_id, state, severity, confidence, coverage,
         observed_at, expires_at, updated_at)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'HV-ID-AUTH-001.v1',
                'v1', 'USER', 'ci-subject', 'OPEN', 'HIGH', 'HIGH', 'FULL',
                clock_timestamp() - INTERVAL '1 hour', clock_timestamp() + INTERVAL '2 seconds', now())`,
      [crossingFindingId, organizationId, customerTenantId, matchedResultId,
        `intake-${crossingFindingId}`])
      let crossingProbe: SqlProbe | undefined
      let crossingSource: SelectedRow | undefined
      // A heavily loaded CI worker may reach the first clock after a short
      // expiry. That is a valid historical refusal, not the rollback case
      // under test. Re-arm the still-unclaimed source at most three times.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await seed.query(`UPDATE identity_risk_findings
          SET expires_at = clock_timestamp() + INTERVAL '2 seconds',
              updated_at = clock_timestamp()
          WHERE id = $1::uuid`, [crossingFindingId])
        const selectedCrossing = await selectSource(seed, crossingFindingId)
        if (!selectedCrossing.activeAtSelection) continue
        const attemptProbe: SqlProbe = { statements: [], decisionClockSamples: [] }
        try {
          const result = await commitActiveIntakeReceipt(receiptRunner(pool, attemptProbe),
            selectedCrossing, 'ci-map-a', 'COMPLETED', async tx => {
              await tx.execute(`INSERT INTO alert_incidents
                (id, organization_id, incident_key, alert_type_id, ownership, "condition", investigation,
                 ownership_at, condition_at, investigation_at, updated_at)
                VALUES (gen_random_uuid(), $1::uuid, $2, 'security.suspected_credential_attack',
                        'UNACKNOWLEDGED', 'ACTIVE', 'OPEN', now(), now(), now(), now())`,
              [organizationId, crossingIncidentKey])
              await tx.query(`SELECT pg_sleep(GREATEST(0,
                EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())) + 0.02)::double precision)`,
              [selectedCrossing.expiresAt])
            })
          assert.deepEqual(result, { kind: 'REFUSED', reason: 'HISTORICAL_ONLY' },
            'only a pre-effect expiry may be retried by this test')
          assert.equal(attemptProbe.decisionClockSamples.length, 1)
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'INTAKE_ACTIVE_EFFECT_BOUNDARY_CROSSED') {
            throw error
          }
          crossingProbe = attemptProbe
          crossingSource = selectedCrossing
          break
        }
      }
      assert.ok(crossingProbe && crossingSource, 'a bounded attempt must exercise post-effect rollback')
      assert.equal(crossingProbe.decisionClockSamples.length, 2)
      assert.ok(crossingProbe.decisionClockSamples[0]! < crossingSource.expiresAt)
      assert.ok(crossingProbe.decisionClockSamples[1]! >= crossingSource.expiresAt)
      const crossingRows = (await seed.query<{ receipts: number; incidents: number }>(
        `SELECT
          (SELECT count(*)::int FROM alert_finding_intake_status WHERE finding_id = $1::uuid) AS receipts,
          (SELECT count(*)::int FROM alert_incidents WHERE organization_id = $2::uuid
             AND incident_key = $3) AS incidents`,
        [crossingFindingId, organizationId, crossingIncidentKey])).rows[0]
      assert.deepEqual(crossingRows, { receipts: 0, incidents: 0 })
    } catch (error) {
      bodyFailed = true
      throw error
    } finally {
      const cleanupErrors: unknown[] = []
      const attempt = async (action: () => Promise<unknown>) => {
        try { await action() } catch (error) { cleanupErrors.push(error) }
      }
      if (holder) {
        const held = holder
        await attempt(() => held.query('ROLLBACK'))
        await attempt(() => held.end())
      }
      await attempt(() => pool.end())
      if (seedConnected) {
        await attempt(() => seed.query('DELETE FROM alert_incidents WHERE organization_id = $1::uuid AND incident_key = $2',
          [organizationId, crossingIncidentKey]))
        await attempt(() => seed.query('DELETE FROM alert_finding_intake_status WHERE finding_id = $1::uuid', [crossingFindingId]))
        await attempt(() => seed.query('DELETE FROM identity_risk_findings WHERE id = $1::uuid', [crossingFindingId]))
        await attempt(() => seed.query('DELETE FROM alert_incidents WHERE organization_id = $1::uuid AND incident_key = $2',
          [organizationId, incidentKey]))
        await attempt(() => seed.query('DELETE FROM alert_finding_intake_status WHERE finding_id = $1::uuid', [findingId]))
        await attempt(() => seed.query('DELETE FROM identity_risk_findings WHERE id = $1::uuid', [findingId]))
        await attempt(() => seed.query('DELETE FROM identity_risk_matched_results WHERE id = $1::uuid', [matchedResultId]))
        await attempt(() => seed.query('DELETE FROM identity_risk_evaluation_runs WHERE id = $1::uuid', [runId]))
        await attempt(() => seed.query('DELETE FROM customer_tenants WHERE id = $1::uuid', [customerTenantId]))
        await attempt(() => seed.query('DELETE FROM organizations WHERE id = $1::uuid', [organizationId]))
      }
      await attempt(() => seed.end())
      if (cleanupErrors.length && !bodyFailed) {
        throw new AggregateError(cleanupErrors, 'HAW-19 physical test cleanup failed')
      }
    }
  })
