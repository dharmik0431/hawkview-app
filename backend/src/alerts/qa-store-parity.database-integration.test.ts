import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { runIntake, type PipelineStore, type Watermark } from './finding-pipeline.js'
import { pipelineStore, type SqlRunner } from './pipeline-store.js'

/**
 * QA — TWO PROPERTIES THAT WERE HAND-CHECKED ONCE AND ARE NOW GUARDS.
 *
 * A hand-check done once is not a property that stays true. Both of these were established by
 * hand against the production store and neither had a test, so the next refactor of that store
 * would have been unguarded in exactly the way the last one was — and we have just watched what
 * the guarded version catches.
 *
 * THEY DRIVE `pipelineStore`, the store that ships. The runner is wrapped rather than replaced,
 * so the SQL under test is the SQL in production.
 */
const RUN = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const URL = process.env.DATABASE_URL
const ORG = '11111111-1111-1111-1111-111111111111'
const TENANT = '22222222-2222-2222-2222-222222222222'
const WATERMARK: Watermark = { sendNothingObservedBeforeIso: '2026-09-01T00:00:00.000Z', because: 'QA' }

const runnerFor = (client: pg.Client): SqlRunner => ({
  query: async <T>(sql: string, params: readonly unknown[]) => (await client.query(sql, [...params])).rows as T[],
  execute: async (sql: string, params: readonly unknown[]) => (await client.query(sql, [...params])).rowCount ?? 0,
  transaction: async (run) => {
    await client.query('BEGIN')
    try { const r = await run(runnerInside(client)); await client.query('COMMIT'); return r }
    catch (e) { await client.query('ROLLBACK'); throw e }
  },
})
const runnerInside = (client: pg.Client): SqlRunner => ({
  query: async <T>(sql: string, params: readonly unknown[]) => (await client.query(sql, [...params])).rows as T[],
  execute: async (sql: string, params: readonly unknown[]) => (await client.query(sql, [...params])).rowCount ?? 0,
  transaction: async (run) => run(runnerInside(client)),
})

/** Fails the first statement whose SQL mentions `table`, INSIDE the transaction. */
const failingOn = (client: pg.Client, table: string): SqlRunner => {
  const wrap = (inner: SqlRunner): SqlRunner => ({
    query: inner.query,
    execute: async (sql, params) => {
      if (sql.includes(table)) throw new Error(`QA: injected failure on ${table}`)
      return inner.execute(sql, params)
    },
    transaction: (run) => inner.transaction((tx) => run(wrap(tx))),
  })
  return wrap(runnerFor(client))
}

const seed = async (c: pg.Client) => {
  await c.query(`INSERT INTO identity_risk_findings
    (id,organization_id,customer_tenant_id,matched_result_id,dedupe_key,rule_id,rule_version,
     subject_type,subject_id,severity,confidence,coverage,observed_at,expires_at,state,created_at)
    VALUES ($1,$2,$3,$4,$5,'HV-ID-AUTH-010.v1','v1','USER',$6,'HIGH','HIGH','FULL',
            now() - interval '1 minute', now() + interval '30 days', $7, now())`,
    ['a0000000-0000-4000-8000-000000000001', ORG, TENANT, '44444444-0000-4000-8000-000000000001',
      'qa-open', 'sub-open', 'OPEN'])
  await c.query(`INSERT INTO identity_risk_findings
    (id,organization_id,customer_tenant_id,matched_result_id,dedupe_key,rule_id,rule_version,
     subject_type,subject_id,severity,confidence,coverage,observed_at,expires_at,state,created_at)
    VALUES ($1,$2,$3,$4,$5,'HV-ID-AUTH-010.v1','v1','USER',$6,'HIGH','HIGH','FULL',
            now() - interval '1 minute', now() + interval '30 days', $7, now())`,
    ['b0000000-0000-4000-8000-000000000002', ORG, TENANT, '44444444-0000-4000-8000-000000000001',
      'qa-resolved', 'sub-resolved', 'RESOLVED'])
}
const counts = async (c: pg.Client) => ({
  incidents: Number((await c.query('SELECT count(*)::int AS n FROM alert_incidents')).rows[0].n),
  jobs: Number((await c.query('SELECT count(*)::int AS n FROM alert_send_jobs')).rows[0].n),
  notifications: Number((await c.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n),
})

test('A RESOLVED FINDING BESIDE AN OPEN ONE IS NOT READ', { skip: !RUN || !URL }, async () => {
  const c = new pg.Client({ connectionString: URL }); await c.connect()
  try {
    await c.query('DELETE FROM identity_risk_findings')
    await seed(c)
    const report = await runIntake(pipelineStore(runnerFor(c)), WATERMARK, new Date().toISOString(),
      Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
    // THE POINT: two rows exist and the filter must pick one. A store that dropped the state
    // predicate would read two and this would fail.
    assert.equal(report.findingsRead, 1, 'the OPEN finding is read and the RESOLVED one is not')
  } finally { await c.end() }
})

test('A FAILURE ON ANY OF THE THREE WRITES LEAVES NONE OF THEM', { skip: !RUN || !URL }, async () => {
  const c = new pg.Client({ connectionString: URL }); await c.connect()
  try {
    for (const table of ['notifications', 'alert_send_jobs', 'alert_incidents']) {
      await c.query('DELETE FROM alert_send_jobs')
      await c.query('DELETE FROM alert_incidents')
      await c.query('DELETE FROM notifications')
      await c.query('DELETE FROM identity_risk_findings')
      await seed(c)
      await assert.rejects(
        () => runIntake(pipelineStore(failingOn(c, table)), WATERMARK, new Date().toISOString(),
          Date.now() + 30_000, '2026-01-01T00:00:00.000Z'),
        /injected failure/, `the injected failure on ${table} must propagate`)
      const after = await counts(c)
      assert.deepEqual(after, { incidents: 0, jobs: 0, notifications: 0 },
        `a failure on ${table} left something behind: ${JSON.stringify(after)}`)
    }
    // AND THE CONTROL, or the three assertions above are satisfied by nothing ever being written.
    await c.query('DELETE FROM identity_risk_findings'); await seed(c)
    await runIntake(pipelineStore(runnerFor(c)), WATERMARK, new Date().toISOString(),
      Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
    assert.deepEqual(await counts(c), { incidents: 1, jobs: 1, notifications: 1 },
      'the healthy path writes all three')
  } finally { await c.end() }
})
