import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import pg from 'pg'
import {
  cancelReason, cancelStatement, classifyCancellation, claimStatement, workerId,
} from './send-queue.js'
import { messageId } from './email-delivery.js'
import { ALERT_CATALOG } from './alert-catalog.js'
import {
  FINDINGS_PER_CHUNK, decide, noticeKeyFor, runIntake,
  type PipelineStore, type Watermark,
} from './finding-pipeline.js'
import { pipelineStore, type SqlRunner } from './pipeline-store.js'

/**
 * ONE TEST THAT STARTS AT A PERSISTED FINDING AND ENDS AT A SEND JOB.
 *
 * Not a unit test of each hop — those already existed and were the problem: twenty green modules
 * and nothing joining them. This inserts a real `identity_risk_findings` row through its real
 * foreign keys and asserts a real `alert_send_jobs` row comes out the other side.
 *
 * NOTHING IS SENT. There is no provider call here and no provider client exists yet; the
 * deliverable is a row in the queue, which is the thing that had no producer.
 */

const RUN = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const URL = process.env.DATABASE_URL

/**
 * ONE DATABASE, SO ONE FILE AT A TIME.
 *
 * These files truncate shared tables. `node --test` runs test FILES in parallel, so two of them
 * against one database interleave a truncate with another file's assertions — measured: run
 * together they failed two or three of seventeen, and which ones varied between runs. Run one at
 * a time they pass. **That is a property of the suite, not a flake to be re-run.**
 *
 * A POSTGRESQL ADVISORY LOCK RATHER THAN `--test-concurrency=1`, because the flag lives in
 * whoever's command line and CI's is `find … | xargs tsx --test` with no flag at all — so the
 * constraint would be satisfied by a habit. A session-level advisory lock is held by a
 * CONNECTION, so it serialises across processes, and it is released when the connection closes
 * even if a file dies badly.
 *
 * Every alerting integration file takes the SAME key. Adding a file means copying this block.
 */
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
  await gate.query('SELECT pg_advisory_unlock($1)', [INTEGRATION_GATE])
  await gate.end()
  gate = null
})

const ORG = '11111111-1111-1111-1111-111111111111'
const TENANT = '22222222-2222-2222-2222-222222222222'
const T0 = '2026-09-12T09:00:00.000Z'
const OLD = '2026-08-01T09:00:00.000Z'

const WATERMARK: Watermark = {
  sendNothingObservedBeforeIso: '2026-09-12T00:00:00.000Z',
  because: 'the instant this pipeline was first switched on, so history is recorded not sent',
}

/** A `pg.Client` as a `SqlRunner`.
 *
 * **THE TESTS BELOW NOW DRIVE THE STORE THAT SHIPS.** They used to drive a `storeFor` written in
 * this file by the same hand as the assertions — so the evidence was about a store nobody
 * deploys, and the one that does deploy was covered by nothing. The two had already drifted:
 * production's `findOpenFindings` ended `LIMIT 5000` and this file's had no limit at all, so no
 * test could reach that boundary. One disagreement found by reading means the set of
 * disagreements was not known to be empty.
 *
 * What remains here is only the adapter — three methods turning a `pg.Client` into the interface
 * `pipelineStore` takes. There is no SQL in this file to disagree with the SQL that ships.
 */
const runnerFor = (client: pg.Client): SqlRunner => ({
  query: async <T>(sql: string, params: readonly unknown[]) =>
    (await client.query(sql, [...params])).rows as T[],
  execute: async (sql: string, params: readonly unknown[]) =>
    (await client.query(sql, [...params])).rowCount ?? 0,
  transaction: async (run) => {
    await client.query('BEGIN')
    try {
      const result = await run(insideTransaction(client))
      await client.query('COMMIT')
      return result
    } catch (cause) {
      await client.query('ROLLBACK')
      throw cause
    }
  },
})

/** Inside the transaction, `transaction` is the identity — the same rule the production adapter
 * follows. A second BEGIN on one connection is not a nested transaction in PostgreSQL, and
 * silently making it a savepoint would let an inner rollback leave the outer transaction alive:
 * the partial write this seam exists to make impossible. */
const insideTransaction = (client: pg.Client): SqlRunner => ({
  query: async <T>(sql: string, params: readonly unknown[]) =>
    (await client.query(sql, [...params])).rows as T[],
  execute: async (sql: string, params: readonly unknown[]) =>
    (await client.query(sql, [...params])).rowCount ?? 0,
  transaction: (run) => run(insideTransaction(client)),
})

/** Run a tick and insist it ran. **A test that silently accepted a FAILED outcome would assert
 * over zeroes and pass**, which is precisely the confusion the outcome type was added to remove —
 * so the unwrapping asserts rather than defaults. */
const ranIntake = async (...args: Parameters<typeof runIntake>) => {
  const outcome = await runIntake(...args)
  if (outcome.kind !== 'RAN') {
    throw new Error(`the tick FAILED in ${outcome.phase}: ${outcome.because}`)
  }
  return outcome.report
}

const storeFor = (client: pg.Client): PipelineStore => pipelineStore(runnerFor(client))

/** The finding's real foreign-key chain. Inserted rather than mocked, because the point of this
 * test is that a row which the production evaluator could have written flows through. */
/** EVERYTHING THIS TEST NEEDS, CREATED BY THIS TEST.
 *
 * It previously depended on an organisation and a customer tenant that happened to be in the
 * database because somebody had inserted them by hand. On a freshly migrated one it failed on a
 * foreign key — so "proven against a real database" meant proven against a database that already
 * had the right rows. A test that depends on ambient state is testing the machine it ran on. */
async function scaffold(client: pg.Client) {
  await client.query(
    `INSERT INTO organizations (id, name, slug, created_at, updated_at)
     VALUES ($1, 'Probe', 'probe', now(), now()) ON CONFLICT (id) DO NOTHING`, [ORG])
  await client.query(
    `INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, display_name, created_at, updated_at)
     VALUES ($1, $2, '99999999-9999-9999-9999-999999999999', 'Probe Tenant', now(), now())
     ON CONFLICT (id) DO NOTHING`, [TENANT, ORG])
}

async function seed(client: pg.Client, over: Partial<{ ruleId: string; observedAt: string; id: string; subject: string }> = {}) {
  const runId = '33333333-3333-3333-3333-333333333333'
  const matchedId = '44444444-4444-4444-4444-444444444444'
  await client.query(`INSERT INTO identity_risk_evaluation_runs
      (id, organization_id, customer_tenant_id, run_key, engine_version, catalog_version, status,
       window_start, window_end, source_watermark_hash, source_content_hash, expires_at, completed_at, created_at)
      VALUES ($1,$2,$3,'seed-run','test','test','COMPLETED',
              now() - interval '1 hour', now(), 'h', 'h', now() + interval '30 days', now(), now())
      ON CONFLICT DO NOTHING`, [runId, ORG, TENANT])
  await client.query(`INSERT INTO identity_risk_matched_results
      (id, organization_id, customer_tenant_id, evaluation_run_id, result_key, rule_id, subject_type,
       subject_id, severity, confidence, coverage, observed_at, expires_at, created_at)
      VALUES ($1,$2,$3,$4,'seed-result','HV-ID-AUTH-001.v1','USER','seed','HIGH','HIGH','FULL',
              now(), now() + interval '30 days', now())
      ON CONFLICT DO NOTHING`, [matchedId, ORG, TENANT, runId])
  await client.query(`INSERT INTO identity_risk_findings
      (id, organization_id, customer_tenant_id, matched_result_id, dedupe_key, rule_id, rule_version,
       subject_type, subject_id, state, severity, confidence, coverage, observed_at, expires_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'v1','USER',$7,'OPEN','HIGH','HIGH','FULL',$8::timestamptz, now() + interval '30 days', now())`,
    [over.id ?? '55555555-5555-5555-5555-555555555555', ORG, TENANT, matchedId,
      `dedupe-${over.id ?? 'a'}`, over.ruleId ?? 'HV-ID-AUTH-001.v1',
      over.subject ?? 'user-1', over.observedAt ?? T0])
}

test('A PERSISTED FINDING REACHES A SEND JOB', { skip: !RUN || !URL }, async () => {
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_rule_dispositions, alert_withheld_notices CASCADE')
    await client.query('DELETE FROM identity_risk_findings')
    // One operator who has email on. The two grains meeting: the organisation will decide the
    // rule is urgent, and this is the person who can actually be reached about it.
    const operator = '77777777-7777-7777-7777-777777777777'
    await client.query(
      `INSERT INTO users (id, email, updated_at) VALUES ($1, 'operator@an-msp.example', now())
       ON CONFLICT DO NOTHING`, [operator])
    await client.query(
      `INSERT INTO notification_preferences (id, user_id, organization_id, email_enabled, updated_at)
       VALUES (gen_random_uuid(), $2, $1, true, now())
       ON CONFLICT DO NOTHING`, [ORG, operator])
    await seed(client)

    const report = await ranIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

    assert.equal(report.findingsRead, 1, 'the finding was read from the table')
    assert.equal(report.incidentsWritten, 1, 'an incident row was written')
    assert.equal(report.jobsWritten, 1, 'AND A SEND JOB EXISTS — the hop that had no producer')
    assert.deepEqual(report.accountingProblems, [])
    assert.equal(report.yieldedOnBudget, false)

    // MEASURED IN SQL RATHER THAN TRUSTED FROM THE REPORT.
    const jobs = await client.query('SELECT message_id, state, attempts_made, max_attempts FROM alert_send_jobs')
    assert.equal(jobs.rowCount, 1)
    assert.equal(jobs.rows[0].state, 'READY')
    assert.equal(jobs.rows[0].attempts_made, 0)
    const incidents = await client.query('SELECT alert_type_id, ownership, "condition" FROM alert_incidents')
    assert.equal(incidents.rowCount, 1)
    assert.equal(incidents.rows[0].alert_type_id, 'security.suspected_credential_attack')
    assert.equal(incidents.rows[0].ownership, 'UNACKNOWLEDGED')

    // A SECOND TICK SENDS NOTHING MORE, or every five minutes emails about the same incident.
    const again = await ranIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
    assert.equal(again.jobsWritten, 0)
    assert.equal((await client.query('SELECT count(*) FROM alert_send_jobs')).rows[0].count, '1')
  } finally {
    await client.end()
  }
})

test('NO HISTORICAL SENDS, against the real table', { skip: !RUN || !URL }, async () => {
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_withheld_notices CASCADE')
    await client.query('DELETE FROM identity_risk_findings')
    await seed(client, { observedAt: OLD, id: '66666666-6666-6666-6666-666666666666' })

    const report = await ranIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

    assert.equal(report.incidentsWritten, 1, 'the record is backfilled')
    assert.equal(report.jobsWritten, 0, 'and NOTHING is sent about last month')
    assert.equal(report.skipped[0]?.because, 'BEFORE_WATERMARK')
    assert.equal((await client.query('SELECT count(*) FROM alert_send_jobs')).rows[0].count, '0')
  } finally {
    await client.end()
  }
})

test('INTAKE YIELDS RATHER THAN BORROWING FROM THE COLLECTORS', { skip: !RUN || !URL }, async () => {
  // Collection outranks alerting, always. A deadline already past must produce no work and say
  // so, rather than running anyway — the cascade rule, checked against a real database because
  // that is where the time actually goes.
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_withheld_notices CASCADE')
    const report = await ranIntake(storeFor(client), WATERMARK, T0, Date.now() - 1, '2026-01-01T00:00:00.000Z')

    assert.equal(report.yieldedOnBudget, true)
    assert.equal(report.findingsRead, 0, 'it did not even read')
    assert.equal((await client.query('SELECT count(*) FROM alert_incidents')).rows[0].count, '0')
  } finally {
    await client.end()
  }
})

test('A BUDGET YIELD LEAVES NO HALF-DONE WORK, and the next run completes it', { skip: !RUN || !URL }, async () => {
  // THE LAUNCH BLOCKER. Two writes with a budget check between them left an incident with no
  // job; the next run skipped the finding as INCIDENT_ALREADY_OPEN and the email was never sent
  // — silently, because `neverSent` reports jobs that stopped and this alert never had one.
  //
  // Measured before the fix: yield gave 1 incident / 0 jobs, and a healthy run after it added
  // nothing. The database sat there forever.
  //
  // Not a rare crash path: the designed cascade behaviour, firing when the system is busiest.
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_withheld_notices CASCADE')
    await client.query('DELETE FROM identity_risk_findings')
    await seed(client, { id: '88888888-8888-8888-8888-888888888888' })

    // THE CLOCK RUNS OUT DURING THE RUN, WHICH IS THE ONLY WAY TO REACH THIS PATH.
    //
    // The first version of this test passed a deadline already in the past — and it PASSED
    // against the reinstated bug, because `runIntake` exits at its very first budget check and
    // never reaches the write phase at all. It asserted the right thing about a path it never
    // executed: a test that had never disagreed with anybody.
    //
    // Found by mutation: putting the strand back left it green. The injected clock is the
    // reason the `now` parameter exists, and not using it made the parameter decorative.
    const deadlineAt = Date.now() + 30_000
    let ticks = 0
    // Healthy for the reads and the decision; expired by the pre-write check, which is the
    // fourth call. Anything later and the writes have already happened.
    const runningOut = () => (++ticks >= 4 ? deadlineAt + 1 : Date.now())
    const yielded = await ranIntake(
      storeFor(client), WATERMARK, T0, deadlineAt, '2026-01-01T00:00:00.000Z', runningOut)
    assert.ok(ticks >= 4, 'the run must have reached the pre-write check, or this tests nothing')
    assert.equal(yielded.yieldedOnBudget, true)
    assert.equal(yielded.incidentsWritten, 0, 'NOT 1 — a yield gives up work, it does not half-do it')
    assert.equal(yielded.jobsWritten, 0)
    assert.equal(yielded.findingsRead, 1, 'and it did read, so the yield is at the write phase')
    assert.equal((await client.query('SELECT count(*) FROM alert_incidents')).rows[0].count, '0',
      'no incident, so nothing for the next run to skip over')

    // AND THE NEXT RUN COMPLETES IT, along the ordinary path rather than a recovery path.
    const healthy = await ranIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
    assert.equal(healthy.incidentsWritten, 1)
    assert.equal(healthy.jobsWritten, 1, 'the alert is sent, which is what the strand prevented')
    assert.equal((await client.query('SELECT count(*) FROM alert_send_jobs')).rows[0].count, '1')
  } finally {
    await client.end()
  }
})

test('AN UNMAPPED RULE PRODUCES NOTHING AND IS STILL ACCOUNTED FOR', { skip: !RUN || !URL }, async () => {
  // The negative control the earlier search could not reach: an invented rule id is refused by
  // the database, but HV-ID-MBX-001.v1 is a REAL rule the constraint permits and whose kind
  // (REVIEW_MAILBOX_RULE) has no catalogue type on purpose.
  //
  // This is the every-finding-appears-exactly-once invariant meeting the case it was written
  // for: the finding must be named as skipped rather than simply vanishing.
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_withheld_notices CASCADE')
    await client.query('DELETE FROM identity_risk_findings')
    await seed(client, { ruleId: 'HV-ID-MBX-001.v1', id: '99999999-9999-9999-9999-999999999999' })

    const report = await ranIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

    assert.equal(report.findingsRead, 1)
    assert.equal(report.incidentsWritten, 0, 'no incident, because it cannot be typed')
    assert.equal(report.jobsWritten, 0)
    assert.deepEqual(report.unmappedRules, ['HV-ID-MBX-001.v1'],
      'named, so somebody can decide — a count of skipped findings would not say which rule')
    assert.equal(report.skipped.length, 1)
    assert.equal(report.skipped[0]?.because, 'NO_ALERT_TYPE')
    assert.deepEqual(report.accountingProblems, [], 'and it did not vanish')
  } finally {
    await client.end()
  }
})

test('AN ORGANISATION WITH NO PREFERENCE ROW SENDS NOTHING', { skip: !RUN || !URL }, async () => {
  // ABSENCE MUST READ AS OFF, NOT AS UNSET. `bool_or` over no rows is NULL, and an organisation
  // with no preference row at all returns nothing from the query — so both have to be read as
  // "nobody here can be reached", or a brand-new MSP is emailed before anybody there has chosen
  // to be. The store seeds every organisation false before the query for exactly this.
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_withheld_notices CASCADE')
    await client.query('DELETE FROM identity_risk_findings')
    await client.query('DELETE FROM notification_preferences WHERE organization_id = $1', [ORG])
    await seed(client, { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })

    const report = await ranIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

    assert.equal(report.incidentsWritten, 1, 'the incident is still recorded and visible in the product')
    assert.equal(report.jobsWritten, 0, 'and nothing is sent to nobody')
    assert.equal(report.skipped[0]?.because, 'NO_ELIGIBLE_RECIPIENT',
      'named as a coverage gap rather than passing silently')
    assert.equal((await client.query('SELECT count(*) FROM alert_send_jobs')).rows[0].count, '0')

    // POSITIVE CONTROL: give that organisation one operator with email on, and the same finding
    // does produce a job — so the refusal is about the preference, not about the fixture.
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_withheld_notices CASCADE')
    const operator = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    await client.query(
      "INSERT INTO users (id, email, updated_at) VALUES ($1, 'op2@an-msp.example', now()) ON CONFLICT DO NOTHING",
      [operator])
    await client.query(
      `INSERT INTO notification_preferences (id, user_id, organization_id, email_enabled, updated_at)
       VALUES (gen_random_uuid(), $2, $1, true, now())`, [ORG, operator])

    const second = await ranIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
    assert.equal(second.jobsWritten, 1)
  } finally {
    await client.end()
  }
})

test('AN OPERATOR WITH EMAIL OFF IS STILL NO ELIGIBLE RECIPIENT', { skip: !RUN || !URL }, async () => {
  // The column defaults false, so the ordinary case is a row that exists and says no. That must
  // behave exactly like no row at all — otherwise the default would be off in the schema and on
  // in the pipeline.
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_withheld_notices CASCADE')
    await client.query('DELETE FROM identity_risk_findings')
    await client.query('DELETE FROM notification_preferences WHERE organization_id = $1', [ORG])
    const operator = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    await client.query(
      "INSERT INTO users (id, email, updated_at) VALUES ($1, 'off@an-msp.example', now()) ON CONFLICT DO NOTHING",
      [operator])
    // Inserted WITHOUT naming email_enabled, so the column default is what decides.
    await client.query(
      `INSERT INTO notification_preferences (id, user_id, organization_id, updated_at)
       VALUES (gen_random_uuid(), $2, $1, now())`, [ORG, operator])
    await seed(client, { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd' })

    const report = await ranIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
    assert.equal(report.jobsWritten, 0)
    assert.equal(report.skipped[0]?.because, 'NO_ELIGIBLE_RECIPIENT')
  } finally {
    await client.end()
  }
})

test('THE STOP BUTTON STOPS ATTEMPTED JOBS TOO, and says which may already have gone', { skip: !RUN || !URL }, async () => {
  // THE CLAIM THIS TEST EXISTS FOR. An earlier bound was `attempts_made = 0`, on the reasoning
  // that an attempted job had already reached a provider. But a job attempted once and refused
  // RETRYABLY is still READY with budget left — so the operator pressed stop and an email went
  // out afterwards. Proven here in SQL rather than in a matcher over a string, because the WHERE
  // clause is only a real rule if the database agrees with it.
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_withheld_notices CASCADE')

    const OTHER = '88888888-8888-8888-8888-888888888888'
    // `created_at` IS SET EXPLICITLY rather than left to its default, because the press instant is
    // what this test is partly about — a job created after it must survive.
    const put = (key: string, state: string, attempts: number, createdAt: string, org = ORG) => client.query(
      `INSERT INTO alert_send_jobs
         (id, message_id, idempotency_key, state, attempts_made, max_attempts, not_before_at,
          claimed_by, claimed_at, claim_expires_at, provider_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $1, $2::text, $3, 3, $4::timestamptz,
               CASE WHEN $2::text = 'CLAIMED' THEN 'w-1' END,
               CASE WHEN $2::text = 'CLAIMED' THEN $4::timestamptz END,
               CASE WHEN $2::text = 'CLAIMED' THEN $4::timestamptz + interval '1 minute' END,
               CASE WHEN $2::text = 'SENT' THEN 'p-1' END,
               $4::timestamptz, $4::timestamptz)`,
      [`incident/${org}|${key}`, state, attempts, createdAt])

    const OLD = '2026-09-12T08:00:00.000Z'
    const PRESS = '2026-09-12T09:00:00.000Z'
    const NEW = '2026-09-12T10:00:00.000Z'

    await put('k1', 'READY', 0, OLD)
    await put('k2', 'READY', 1, OLD)   // attempted and refused retryably — the one that used to escape
    await put('k3', 'SENT', 1, OLD)
    await put('k4', 'CLAIMED', 0, OLD) // a live claim at zero attempts: the subtle uncertain case
    await put('k5', 'GAVE_UP', 3, OLD)
    await put('k6', 'READY', 0, OLD, OTHER)
    await put('k7', 'READY', 0, NEW)   // written by the tick AFTER the operator pressed stop

    const order = {
      scope: { kind: 'ORGANISATION', organizationId: ORG, createdBeforeIso: PRESS } as const,
      by: 'ops@hawkview.example',
      because: cancelReason('duplicate storm from the 09:00 tick'),
    }
    const scoped = cancelStatement(order, PRESS)
    const stopped = await client.query(scoped.sql, [...scoped.params])
    const jobs = classifyCancellation(stopped.rows)
    assert.equal(jobs.length, 3, 'k1, k2 and k4 — including the attempted one')

    // PER JOB, NOT A COUNT. Told "3 stopped", an operator stops watching the inbox and tells the
    // customer it was caught — and two of these three may be at the provider.
    const outcome = (key: string) =>
      jobs.find((each) => each.messageId === `incident/${ORG}|${key}`)?.outcome
    assert.equal(outcome('k1'), 'STOPPED_BEFORE_ANY_ATTEMPT')
    assert.equal(outcome('k2'), 'MAY_HAVE_REACHED_PROVIDER', 'an attempt was already open')
    assert.equal(outcome('k4'), 'MAY_HAVE_REACHED_PROVIDER', 'a worker held the claim')

    const row = async (key: string, org = ORG) => (await client.query(
      `SELECT state, claimed_by, claim_expires_at, cancelled_at, cancelled_by, cancelled_because
         FROM alert_send_jobs WHERE message_id = $1`, [`incident/${org}|${key}`])).rows[0]

    assert.equal((await row('k1')).state, 'CANCELLED')
    assert.equal((await row('k2')).state, 'CANCELLED', 'STOP MEANS STOP')
    assert.equal((await row('k4')).state, 'CANCELLED')

    // WHO, WHEN AND WHY ARE ON THE ROW. Six months from now "why was this MSP never told" has to
    // be answerable from the record rather than from a log somebody still happens to have.
    assert.equal((await row('k2')).cancelled_by, 'ops@hawkview.example')
    assert.equal((await row('k2')).cancelled_because, 'duplicate storm from the 09:00 tick')
    assert.equal(new Date((await row('k2')).cancelled_at).toISOString(), PRESS)

    // AND THE CLAIM IS RELEASED WITH IT, or a cancelled job still looks held to `inFlight`.
    assert.equal((await row('k4')).claimed_by, null)
    assert.equal((await row('k4')).claim_expires_at, null)

    // HISTORY IS UNTOUCHED — the control. Without these the widened cancel is satisfied by
    // cancelling the whole table, which is a worse bug than the one it fixed.
    assert.equal((await row('k3')).state, 'SENT', 'a settled send is never relabelled')
    assert.equal((await row('k5')).state, 'GAVE_UP')
    assert.equal((await row('k3')).cancelled_at, null, 'and carries no cancellation')

    // THE NEIGHBOUR SURVIVES, which is the property the message-id prefix has to carry.
    assert.equal((await row('k6', OTHER)).state, 'READY')

    // AND SO DOES THE JOB THE NEXT TICK WROTE. That is a new intent formed after the press, and
    // whether to stop it is a second decision the operator makes by moving createdBeforeIso.
    assert.equal((await row('k7')).state, 'READY', 'created after the press')

    // A SECOND PRESS CHANGES NOTHING, because CANCELLED is excluded by its own state list.
    assert.equal((await client.query(scoped.sql, [...scoped.params])).rowCount, 0)

    // A LATER PRESS DOES CATCH IT, so the bound above is the reason k7 survived rather than a
    // scope that never matched it.
    const later = cancelStatement({ ...order, scope: { ...order.scope, createdBeforeIso: '2026-09-12T11:00:00.000Z' } }, NEW)
    assert.equal((await client.query(later.sql, [...later.params])).rowCount, 1)
    assert.equal((await row('k7')).state, 'CANCELLED')

    // EVERYTHING CATCHES THE NEIGHBOUR, or the organisation scope was doing nothing above.
    const all = cancelStatement({
      scope: { kind: 'EVERYTHING', createdBeforeIso: '2026-09-12T11:00:00.000Z' },
      by: 'ops@hawkview.example', because: cancelReason('stopping all sends'),
    }, NEW)
    assert.equal((await client.query(all.sql, [...all.params])).rowCount, 1)
    assert.equal((await row('k6', OTHER)).state, 'CANCELLED')

    // AND THE INCIDENTS SURVIVE. The incident is the record that something happened.
    assert.doesNotMatch(all.sql, /alert_incidents/)
  } finally {
    await client.end()
  }
})

test('THE READ-THEN-WRITE CANCEL REPORTS A TAKEN JOB AS STOPPED — the shape being rejected', { skip: !RUN || !URL }, async () => {
  // THE CONTROL FOR THE TEST BELOW, and it exists because a safety test that has never seen the
  // defect is not evidence. This is the cancel anybody would script by hand at 3am: read which
  // jobs look stoppable, then update them. The gap between the two is where a worker claims one.
  //
  // It is written HERE, in the test, and is not reachable from the product — the point is to show
  // the failure mode is real and that this instrument can detect it, so that the one-statement
  // form passing the next test means something.
  const a = new pg.Client({ connectionString: URL })
  const b = new pg.Client({ connectionString: URL })
  await a.connect(); await b.connect()
  try {
    await scaffold(a)
    await a.query('TRUNCATE alert_send_jobs, alert_withheld_notices CASCADE')
    const PRESS = '2026-09-12T09:00:00.000Z'
    const key = `incident/${ORG}|naive`
    await a.query(
      `INSERT INTO alert_send_jobs
         (id, message_id, idempotency_key, state, attempts_made, max_attempts, not_before_at,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $1, 'READY', 0, 3, '2026-09-12T08:00:00.000Z'::timestamptz,
               '2026-09-12T08:00:00.000Z'::timestamptz, now())`, [key])

    // STEP 1 of the naive cancel: read what looks stoppable. The row is READY and unclaimed, so
    // the operator is about to be told it was stopped before any attempt.
    const seen = (await b.query(
      `SELECT message_id, state AS state_before, attempts_made, (claimed_by IS NOT NULL) AS was_claimed
         FROM alert_send_jobs
        WHERE state NOT IN ('SENT', 'EXHAUSTED', 'GAVE_UP', 'CANCELLED')
          AND created_at < $1::timestamptz`, [PRESS])).rows
    const wouldReport = classifyCancellation(seen)
    assert.equal(wouldReport[0]?.outcome, 'STOPPED_BEFORE_ANY_ATTEMPT')

    // THE GAP. A worker claims the job here — which in production is a five-minute-wide window,
    // not a contrived one.
    const claim = claimStatement(messageId(key), workerId('w-1'), PRESS, 60_000)
    assert.equal((await a.query(claim.sql, [...claim.params])).rowCount, 1, 'the worker took it')

    // STEP 2: write, keyed on what step 1 saw.
    await b.query(
      `UPDATE alert_send_jobs SET state = 'CANCELLED', claimed_by = NULL, claimed_at = NULL,
              claim_expires_at = NULL, cancelled_at = $1::timestamptz, cancelled_by = 'ops',
              cancelled_because = 'naive', updated_at = $1::timestamptz
        WHERE message_id = ANY($2::varchar[])`,
      [PRESS, seen.map((row) => row.message_id)])

    // THE DEFECT, MEASURED. The operator has been told the job was stopped before any attempt,
    // and a worker holds a permit for it and may be inside `attemptSend` right now. Somebody told
    // a message was stopped stops watching the inbox and tells the customer it was caught.
    const after = (await a.query('SELECT state FROM alert_send_jobs WHERE message_id = $1', [key])).rows[0]
    assert.equal(after.state, 'CANCELLED', 'the naive cancel overwrote the claim')
    assert.equal(wouldReport[0]?.outcome, 'STOPPED_BEFORE_ANY_ATTEMPT',
      'and reported it as safely stopped — this is the report the one-statement form exists to prevent')
  } finally {
    await a.end(); await b.end()
  }
})

test('THE ONE-STATEMENT CANCEL LEAVES NO GAP FOR A CLAIM', { skip: !RUN || !URL }, async () => {
  // THE SAME SCENARIO AS THE CONTROL ABOVE, against the real `cancelStatement`. The cancel is held
  // open in a transaction after it has run, and the claim is issued into that window.
  //
  // ⚠ WHAT THIS DOES AND DOES NOT ESTABLISH, because the first version of this test overstated it.
  // It proves the operator-visible property: a job reported STOPPED_BEFORE_ANY_ATTEMPT is not
  // claimable afterwards. It does NOT isolate `FOR UPDATE` — measured, deleting `FOR UPDATE` from
  // the CTE leaves this test green, because the UPDATE's own row lock already excludes the claim
  // in this interleaving. `FOR UPDATE` closes a narrower window — a claim committing between the
  // statement's snapshot and the UPDATE's lock, which would leave the CTE's pre-image stale and
  // reproduce the control's report. That window is sub-millisecond and is not forced by any test
  // here; it is closed by construction and argued, not measured. Said plainly rather than left
  // for somebody to assume the mutation was checked.
  const a = new pg.Client({ connectionString: URL })
  const b = new pg.Client({ connectionString: URL })
  await a.connect(); await b.connect()
  try {
    await scaffold(a)
    await a.query('TRUNCATE alert_send_jobs, alert_withheld_notices CASCADE')
    const PRESS = '2026-09-12T09:00:00.000Z'
    const key = `incident/${ORG}|forced`
    await a.query(
      `INSERT INTO alert_send_jobs
         (id, message_id, idempotency_key, state, attempts_made, max_attempts, not_before_at,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $1, 'READY', 0, 3, '2026-09-12T08:00:00.000Z'::timestamptz,
               '2026-09-12T08:00:00.000Z'::timestamptz, now())`, [key])

    const cancel = cancelStatement({
      scope: { kind: 'EVERYTHING', createdBeforeIso: PRESS }, by: 'ops', because: cancelReason('racing'),
    }, PRESS)
    const claim = claimStatement(messageId(key), workerId('w-1'), PRESS, 60_000)

    await b.query('BEGIN')
    const stopped = classifyCancellation((await b.query(cancel.sql, [...cancel.params])).rows)
    assert.equal(stopped.length, 1)
    assert.equal(stopped[0]?.outcome, 'STOPPED_BEFORE_ANY_ATTEMPT',
      'the cancel read a clean READY row — this is the report that must survive being true')

    // Issued into the open window and deliberately not awaited: it is blocked on the row lock now
    // and will not resolve until the COMMIT below. Long enough that an UNBLOCKED claim finishes
    // inside it — which is exactly what the control above demonstrates happening.
    const claiming = a.query(claim.sql, [...claim.params])
    await new Promise((resolve) => setTimeout(resolve, 400))
    await b.query('COMMIT')

    assert.equal((await claiming).rowCount, 0,
      'a worker claimed a job the operator had just been told was stopped before any attempt')
    const after = (await a.query(
      'SELECT state, cancelled_by, claimed_by FROM alert_send_jobs WHERE message_id = $1', [key])).rows[0]
    assert.equal(after.state, 'CANCELLED')
    assert.equal(after.claimed_by, null, 'and nothing holds it')
    assert.equal(after.cancelled_by, 'ops')
  } finally {
    await a.end(); await b.end()
  }
})

test('AND A CANCELLED JOB CANNOT THEN BE CLAIMED, which is the other order', { skip: !RUN || !URL }, async () => {
  // The forced window above tests a claim arriving DURING a cancel. This is a claim arriving
  // after one has committed — the ordinary case, and the one that makes CANCELLED terminal
  // rather than merely recorded.
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_withheld_notices CASCADE')
    const PRESS = '2026-09-12T09:00:00.000Z'
    const key = `incident/${ORG}|after-cancel`
    await client.query(
      `INSERT INTO alert_send_jobs
         (id, message_id, idempotency_key, state, attempts_made, max_attempts, not_before_at,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $1, 'READY', 0, 3, '2026-09-12T08:00:00.000Z'::timestamptz,
               '2026-09-12T08:00:00.000Z'::timestamptz, now())`, [key])

    const cancel = cancelStatement({
      scope: { kind: 'EVERYTHING', createdBeforeIso: PRESS }, by: 'ops', because: cancelReason('stop'),
    }, PRESS)
    const stopped = classifyCancellation((await client.query(cancel.sql, [...cancel.params])).rows)
    assert.equal(stopped.length, 1)
    assert.equal(stopped[0]?.outcome, 'STOPPED_BEFORE_ANY_ATTEMPT', 'nothing had touched it')

    // If a cancelled job could still be claimed the operator would press stop and the next worker
    // would pick it straight back up — the R2 defect, which is why CANCELLED is in the claim's
    // excluded state list.
    const claim = claimStatement(messageId(key), workerId('w-1'), PRESS, 60_000)
    assert.equal((await client.query(claim.sql, [...claim.params])).rowCount, 0)
    assert.equal((await client.query(
      'SELECT state FROM alert_send_jobs WHERE message_id = $1', [key])).rows[0].state, 'CANCELLED')
  } finally {
    await client.end()
  }
})

test('A DISPOSITION STORED AT THE WRONG GRAIN IS REPORTED, not silently ignored', { skip: !RUN || !URL }, async () => {
  // THE MEASURED BUG. The column was called `rule_id` and the pipeline looked it up by ALERT TYPE
  // id, so a disposition written as `HV-ID-AUTH-010.v1` — which is what any author reading the
  // old column name would write — was silently ignored and the email went anyway. The row
  // existed, the write succeeded, the MSP saw their choice saved, and nothing changed.
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_rule_dispositions, alert_withheld_notices CASCADE')
    await client.query('DELETE FROM identity_risk_findings')
    const operator = '77777777-7777-7777-7777-777777777777'
    await client.query(
      `INSERT INTO users (id, email, updated_at) VALUES ($1, 'operator@an-msp.example', now())
       ON CONFLICT DO NOTHING`, [operator])
    await client.query(
      `INSERT INTO notification_preferences (id, user_id, organization_id, email_enabled, updated_at)
       VALUES (gen_random_uuid(), $2, $1, true, now()) ON CONFLICT DO NOTHING`, [ORG, operator])

    // A preference written at the WRONG grain — a rule id where an alert type id belongs.
    await client.query(
      `INSERT INTO alert_rule_dispositions
         (id, organization_id, alert_type_id, disposition, updated_at)
       VALUES (gen_random_uuid(), $1, 'HV-ID-AUTH-010.v1', 'RECORD_ONLY', now())`, [ORG])
    await seed(client)

    const report = await ranIntake(
      storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

    // IT STILL DOES NOT SILENCE — it names no alert type, so it cannot. That part is unchanged
    // and is correct: a broken row must not silence an alert by accident either.
    assert.equal(report.jobsWritten, 1, 'the catalogue default still applies')

    // BUT IT IS NO LONGER SILENT. The value is carried out verbatim so somebody can go and look,
    // rather than the MSP believing a choice took effect that the product never saw.
    const dispositions = await storeFor(client).loadDispositions([ORG])
    assert.deepEqual(dispositions.unreadable, [
      { alertTypeId: 'HV-ID-AUTH-010.v1', disposition: 'RECORD_ONLY', because: 'UNKNOWN_ALERT_TYPE' },
    ])
    assert.equal(dispositions.byOrganizationAndAlertType.size, 0, 'and it is not keyed')

    // AND THE SAME PREFERENCE AT THE RIGHT GRAIN DOES SILENCE — the control, without which the
    // assertions above are satisfied by a lookup that never matches anything.
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_rule_dispositions, alert_withheld_notices CASCADE')
    await client.query('DELETE FROM identity_risk_findings')
    await client.query(
      `INSERT INTO alert_rule_dispositions
         (id, organization_id, alert_type_id, disposition, updated_at)
       VALUES (gen_random_uuid(), $1, 'security.suspected_credential_attack', 'RECORD_ONLY', now())`,
      [ORG])
    await seed(client, { id: '66666666-6666-6666-6666-666666666666' })

    const silenced = await ranIntake(
      storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
    assert.equal(silenced.jobsWritten, 0, 'stored at the right grain, it silences')
    assert.equal(silenced.skipped[0]?.because, 'RECORD_ONLY')
    assert.equal(silenced.incidentsWritten, 1, 'and the incident is still recorded — there is no OFF')
    assert.deepEqual((await storeFor(client).loadDispositions([ORG])).unreadable, [])
  } finally {
    await client.end()
  }
})

test('BOTH KINDS OF UNREADABLE DISPOSITION ARE REPORTED, and neither silences anything', { skip: !RUN || !URL }, async () => {
  // TWO SETTINGS AN MSP MADE THAT THE PRODUCT CANNOT ACT ON, and they used to be reported
  // unevenly: an unreadable VALUE appeared on its row, an unreadable KEY appeared nowhere at all
  // — the tick collected it and threw the list away. One field over from the defect the column
  // rename closed.
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_rule_dispositions, alert_withheld_notices CASCADE')
    await client.query('DELETE FROM identity_risk_findings')

    // An unknown KEY — what this column held before the rename.
    await client.query(
      `INSERT INTO alert_rule_dispositions (id, organization_id, alert_type_id, disposition, updated_at)
       VALUES (gen_random_uuid(), $1, 'HV-ID-AUTH-010.v1', 'RECORD_ONLY', now())`, [ORG])
    // An unknown VALUE — what it held before the vocabulary changed. The CHECK refuses it now, so
    // it goes in with the constraint briefly dropped: this is the state a database migrated
    // before 20260913100000 is actually in, which is why that migration exists.
    await client.query('ALTER TABLE alert_rule_dispositions DROP CONSTRAINT alert_rule_dispositions_disposition_check')
    await client.query(
      `INSERT INTO alert_rule_dispositions (id, organization_id, alert_type_id, disposition, updated_at)
       VALUES (gen_random_uuid(), $1, 'security.suspected_credential_attack', 'EMAIL', now())`, [ORG])

    const loaded = await storeFor(client).loadDispositions([ORG])

    assert.equal(loaded.byOrganizationAndAlertType.size, 0, 'neither is keyed, so neither bites')
    assert.deepEqual([...loaded.unreadable].sort((a, b) => a.because.localeCompare(b.because)), [
      { alertTypeId: 'HV-ID-AUTH-010.v1', disposition: 'RECORD_ONLY', because: 'UNKNOWN_ALERT_TYPE' },
      { alertTypeId: 'security.suspected_credential_attack', disposition: 'EMAIL', because: 'UNKNOWN_DISPOSITION' },
    ])

    // AND THE TICK CARRIES THEM OUT. The list was computed and discarded before; an operator
    // reading the intake log now sees the settings that are being ignored.
    await seed(client)
    const report = await ranIntake(
      storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
    assert.equal(report.unreadableDispositions.length, 2)

    // NEITHER SILENCED ANYTHING — the catalogue default applied, so the alert still went. The
    // harm was only ever that the MSP believed otherwise.
    assert.equal(report.jobsWritten, 1)
  } finally {
    await client.query(
      `ALTER TABLE alert_rule_dispositions ADD CONSTRAINT alert_rule_dispositions_disposition_check
       CHECK (disposition IN ('ACT_NOW', 'ACT_TODAY', 'RECORD_ONLY')) NOT VALID`).catch(() => undefined)
    await client.end()
  }
})

test('A TICK LARGER THAN ONE CHUNK COMMITS IN SEVERAL, against the real tables', { skip: !RUN || !URL }, async () => {
  // **THE DEFECT THIS CLOSES WAS MEASURED, NOT REASONED.** The transaction budget was exhausted
  // between two and five times BELOW the per-tick cap — 500 and 1000 fine, 2000 and 3000 failing
  // with "the timeout was 5000 ms, however 5002 ms passed" — so the limit chosen to make the work
  // bounded did not bound it. And it was intermittent: three ticks at 2000 gave 0, then 2000,
  // then 2000.
  //
  // This crosses a real chunk boundary against real tables, so the chunking is proven together
  // with the store rather than only in a fake.
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_rule_dispositions, alert_withheld_notices CASCADE')
    await client.query('DELETE FROM notifications')
    await client.query('DELETE FROM identity_risk_findings')
    const operator = '77777777-7777-7777-7777-777777777777'
    await client.query(
      `INSERT INTO users (id, email, updated_at) VALUES ($1, 'operator@an-msp.example', now())
       ON CONFLICT DO NOTHING`, [operator])
    await client.query(
      `INSERT INTO notification_preferences (id, user_id, organization_id, email_enabled, updated_at)
       VALUES (gen_random_uuid(), $2, $1, true, now()) ON CONFLICT DO NOTHING`, [ORG, operator])

    // The FK chain once, then one row per finding — each its own subject, so each is its own
    // incident and the counts below are exact rather than grouped.
    const runId = '33333333-3333-3333-3333-333333333333'
    const matchedId = '44444444-4444-4444-4444-444444444444'
    await client.query(`INSERT INTO identity_risk_evaluation_runs
        (id, organization_id, customer_tenant_id, run_key, engine_version, catalog_version, status,
         window_start, window_end, source_watermark_hash, source_content_hash, expires_at, completed_at, created_at)
        VALUES ($1,$2,$3,'bulk','test','test','COMPLETED', now() - interval '1 hour', now(),
                'h','h', now() + interval '30 days', now(), now())
        ON CONFLICT DO NOTHING`, [runId, ORG, TENANT])
    await client.query(`INSERT INTO identity_risk_matched_results
        (id, organization_id, customer_tenant_id, evaluation_run_id, result_key, rule_id, subject_type,
         subject_id, severity, confidence, coverage, observed_at, expires_at, created_at)
        VALUES ($1,$2,$3,$4,'bulk-result','HV-ID-AUTH-001.v1','USER','seed','HIGH','HIGH','FULL',
                now(), now() + interval '30 days', now())
        ON CONFLICT DO NOTHING`, [matchedId, ORG, TENANT, runId])

    const total = FINDINGS_PER_CHUNK + 50
    await client.query(`INSERT INTO identity_risk_findings
        (id, organization_id, customer_tenant_id, matched_result_id, dedupe_key, rule_id, rule_version,
         subject_type, subject_id, state, severity, confidence, coverage, observed_at, expires_at, updated_at)
      SELECT gen_random_uuid(), $1, $2, $3, 'bulk-' || i, 'HV-ID-AUTH-001.v1', 'v1',
             'USER', 'user-' || i, 'OPEN', 'HIGH', 'HIGH', 'FULL',
             $4::timestamptz, now() + interval '30 days', now()
        FROM generate_series(1, $5) AS i`, [ORG, TENANT, matchedId, T0, total])

    const report = await ranIntake(
      storeFor(client), WATERMARK, T0, Date.now() + 300_000, '2026-01-01T00:00:00.000Z')

    assert.equal(report.findingsRead, total)
    assert.equal(report.chunksCommitted, 2, 'it really crossed a boundary')
    assert.equal(report.yieldedOnBudget, false)
    assert.equal(report.truncated, false, 'well under the per-tick cap')
    assert.equal(report.findingsUnprocessed, 0)

    // EVERY FINDING LANDED, ACROSS BOTH CHUNKS. Counted in SQL rather than trusted from the
    // report — the report is the thing under test.
    const counts = await client.query(
      `SELECT (SELECT count(*)::int FROM alert_incidents) AS incidents,
              (SELECT count(*)::int FROM notifications WHERE source = 'identity-risk') AS notifications,
              (SELECT count(*)::int FROM alert_send_jobs) AS jobs`)
    assert.equal(counts.rows[0].incidents, total)
    assert.equal(counts.rows[0].notifications, total)
    assert.equal(counts.rows[0].jobs, total)
    assert.deepEqual(report.accountingProblems, [])

    // AND A SECOND TICK ADDS NOTHING, so the chunk boundary has not made anything reprocessable.
    const again = await ranIntake(
      storeFor(client), WATERMARK, T0, Date.now() + 300_000, '2026-01-01T00:00:00.000Z')
    assert.equal(again.jobsWritten, 0)
    assert.equal(again.incidentsWritten, 0)
    assert.equal((await client.query('SELECT count(*)::int AS n FROM alert_send_jobs')).rows[0].n, total)
  } finally {
    await client.end()
  }
})

test('A NOTIFICATION NAMING A TYPE THE CATALOGUE NO LONGER HAS IS COUNTED', { skip: !RUN || !URL }, async () => {
  // **IT IS BADGED NOWHERE ON PURPOSE.** `alertTierFor` answers UNKNOWN_ALERT_TYPE and the inbox
  // shows no tier — a catalogue id this build does not have is not something a reader can act on.
  // That is right for the reader and it means the fact reaches NOBODY unless an operator is told,
  // so it is counted where they already look.
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_rule_dispositions, alert_withheld_notices CASCADE')
    await client.query('DELETE FROM notifications')

    const put = (alertTypeId: string | null, key: string) => client.query(
      `INSERT INTO notifications (id, organization_id, event_type, category, severity, title,
          description, dedupe_key, source, alert_type_id, occurrence_count,
          first_occurred_at, last_occurred_at, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, 'security.x', 'error', 'critical', 't', 'd', $2,
                'identity-risk', $3, 1, now(), now(), now(), now())`,
      [ORG, key, alertTypeId])

    // One the catalogue declares, one it does not, and one that is not an alert at all.
    await put('security.suspected_credential_attack', 'k-known')
    await put('security.retired_in_an_older_build', 'k-unknown')
    await put(null, 'k-collector')

    const declared = ALERT_CATALOG.map((type) => type.id)
    assert.equal(await storeFor(client).countUnknownAlertTypes([ORG], declared), 1,
      'only the one the catalogue no longer declares')

    // NOT VACUOUS IN EITHER DIRECTION. A row with no alert type is not an unknown type — absence
    // is not an unknown — and a declared one is not counted either.
    await client.query("DELETE FROM notifications WHERE dedupe_key = 'k-unknown'")
    assert.equal(await storeFor(client).countUnknownAlertTypes([ORG], declared), 0)

    // AND AN ORGANISATION THE TICK DID NOT TOUCH IS NOT COUNTED, or the number would grow with
    // the fleet rather than with the problem.
    await put('security.retired_in_an_older_build', 'k-unknown-2')
    assert.equal(
      await storeFor(client).countUnknownAlertTypes(['99999999-0000-4000-8000-000000009999'], declared),
      0)
    assert.equal(await storeFor(client).countUnknownAlertTypes([ORG], declared), 1)
  } finally {
    await client.end()
  }
})

// ---------------------------------------------------------------------------------------
// THE SIX ACCEPTANCE CASES FOR RECORD_ONLY, against the real tables.
//
// The contract is the FINDING'S suppression history, not an incident's existence. Two earlier
// designs inferred it from an adjacent row and both were wrong: incident state is permanently
// true once open, and a disposition timestamp against `observed_at` moves on unrelated edits and
// mis-sorts delayed ingestion and retries. These run against the two tables that record the
// decision, because the whole claim is that the decision is durable.
// ---------------------------------------------------------------------------------------

/** Everything these cases need, and nothing carried between them. */
async function freshWithRecipient(client: pg.Client) {
  await scaffold(client)
  await client.query(
    'TRUNCATE alert_send_jobs, alert_incidents, alert_rule_dispositions, alert_withheld_notices CASCADE')
  await client.query('DELETE FROM notifications')
  await client.query('DELETE FROM identity_risk_findings')
  const operator = '77777777-7777-7777-7777-777777777777'
  await client.query(
    `INSERT INTO users (id, email, updated_at) VALUES ($1, 'operator@an-msp.example', now())
     ON CONFLICT DO NOTHING`, [operator])
  await client.query(
    `INSERT INTO notification_preferences (id, user_id, organization_id, email_enabled, updated_at)
     VALUES (gen_random_uuid(), $2, $1, true, now()) ON CONFLICT DO NOTHING`, [ORG, operator])
}

const silence = (client: pg.Client) => client.query(
  `INSERT INTO alert_rule_dispositions
     (id, organization_id, alert_type_id, disposition, created_at, updated_at)
   VALUES (gen_random_uuid(), $1, 'security.suspected_credential_attack', 'RECORD_ONLY', now(), now())
   ON CONFLICT (organization_id, alert_type_id) DO UPDATE SET disposition = 'RECORD_ONLY'`, [ORG])

const unsilence = (client: pg.Client) => client.query(
  'DELETE FROM alert_rule_dispositions WHERE organization_id = $1', [ORG])

const tick = (client: pg.Client) => ranIntake(
  storeFor(client), WATERMARK, T0, Date.now() + 60_000, '2026-01-01T00:00:00.000Z')

const noticeState = async (client: pg.Client) => (await client.query(
  `SELECT dedupe_key, occurrence_count, resolved_at IS NULL AS unresolved
     FROM notifications WHERE source = 'identity-risk' ORDER BY dedupe_key`)).rows

test('CASE 1 — reprocessing a finding neither duplicates it nor reopens what somebody dismissed',
  { skip: !RUN || !URL }, async () => {
    // **THE SECOND CONFIRMED DEFECT, AND IT IS OLDER THAN THE RECORD_ONLY WORK.** The review
    // argued the gate was unnecessary because `notifications` is unique on
    // (organization_id, dedupe_key). The ROW cannot duplicate; the write is ON CONFLICT DO UPDATE,
    // which bumps `occurrence_count` and sets `resolved_at = NULL`. The tick re-reads every OPEN
    // finding in a rolling 24-hour window with no cursor, so a dismissed alert came back
    // undismissed on the next tick for as long as the finding stayed open.
    const client = new pg.Client({ connectionString: URL })
    await client.connect()
    try {
      await freshWithRecipient(client)
      await seed(client)
      await tick(client)
      assert.deepEqual(await noticeState(client),
        [{ dedupe_key: 'identity-risk:dedupe-a', occurrence_count: 1, unresolved: true }])

      // A person reads it and dismisses it.
      await client.query("UPDATE notifications SET resolved_at = now() WHERE source = 'identity-risk'")

      // The finding is still OPEN, so the next tick reads it again.
      const again = await tick(client)
      assert.equal(again.notificationsWritten, 0, 'nothing was written for it a second time')
      assert.deepEqual(await noticeState(client),
        [{ dedupe_key: 'identity-risk:dedupe-a', occurrence_count: 1, unresolved: false }],
        'IT STAYED DISMISSED, and the occurrence count did not climb on its own')
      assert.equal((await client.query('SELECT count(*)::int AS n FROM alert_send_jobs')).rows[0].n, 1,
        'and no second email')
    } finally {
      await client.end()
    }
  })

test('CASE 2 — a finding first handled while record-only is never told, across re-enabling and restart',
  { skip: !RUN || !URL }, async () => {
    const client = new pg.Client({ connectionString: URL })
    await client.connect()
    try {
      await freshWithRecipient(client)
      await silence(client)
      await seed(client)

      const off = await tick(client)
      assert.equal(off.incidentsWritten, 1, 'THE EVIDENCE REMAINS — inspectable history')
      assert.equal(off.notificationsWritten, 0, 'and no active notice')
      assert.equal(off.noticesWithheld, 1, 'the decision is recorded, not merely taken')
      const withheld = await client.query(
        'SELECT dedupe_key, alert_type_id, because FROM alert_withheld_notices')
      assert.deepEqual(withheld.rows, [{
        dedupe_key: 'identity-risk:dedupe-a',
        alert_type_id: 'security.suspected_credential_attack',
        because: 'RECORD_ONLY',
      }])

      // THE MSP TURNS IT BACK ON. Every later tick is also the restart case: nothing is held in
      // memory between ticks, so a process that died and came back reads exactly this state.
      await unsilence(client)
      const back = await tick(client)
      assert.equal(back.notificationsWritten, 0, 'NO REPLAY')
      assert.equal((await noticeState(client)).length, 0, 'nothing in the inbox at all')

      const andAgain = await tick(client)
      assert.equal(andAgain.notificationsWritten, 0, 'still nothing, tick after tick')
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM alert_withheld_notices')).rows[0].n, 1,
        'and the decision was not retaken, so "withheld since" does not creep forward')
    } finally {
      await client.end()
    }
  })

test('CASE 3 — new evidence on the same organisation, tenant, subject and type IS surfaced',
  { skip: !RUN || !URL }, async () => {
    // R001-A. The incident is already open and stays open; a DIFFERENT finding on the same subject
    // is material escalation and must not be silenced with the backlog. A different-subject test
    // does not cover this — it is a different incident and never meets the gate.
    const client = new pg.Client({ connectionString: URL })
    await client.connect()
    try {
      await freshWithRecipient(client)
      await seed(client, { id: '55555555-5555-5555-5555-555555555555', subject: 'user-1' })
      const first = await tick(client)
      assert.equal(first.notificationsWritten, 1)
      assert.equal(first.incidentsWritten, 1)

      // A later tick, the type never silenced, same subject so THE SAME INCIDENT.
      await seed(client, { id: '66666666-6666-6666-6666-666666666666', subject: 'user-1' })
      const second = await tick(client)

      assert.equal(second.notificationsWritten, 1, 'THE NEW EVIDENCE IS SURFACED')
      assert.equal(second.incidentsWritten, 0, 'on the incident that was already open')
      const rows = await noticeState(client)
      assert.deepEqual(rows.map((row) => row.dedupe_key),
        ['identity-risk:dedupe-55555555-5555-5555-5555-555555555555',
          'identity-risk:dedupe-66666666-6666-6666-6666-666666666666'],
        'two rows, because an incident IS the set of rows sharing its key')
    } finally {
      await client.end()
    }
  })

test('CASE 4 — after re-enabling, new findings work on existing incidents and on new ones',
  { skip: !RUN || !URL }, async () => {
    const client = new pg.Client({ connectionString: URL })
    await client.connect()
    try {
      await freshWithRecipient(client)
      await silence(client)
      await seed(client, { id: '55555555-5555-5555-5555-555555555555', subject: 'user-1' })
      await tick(client)
      await unsilence(client)

      // One on the SAME subject (existing incident), one on a new subject (new incident).
      await seed(client, { id: '66666666-6666-6666-6666-666666666666', subject: 'user-1' })
      await seed(client, { id: '88888888-8888-8888-8888-888888888888', subject: 'user-2' })
      const after = await tick(client)

      assert.equal(after.notificationsWritten, 2, 'both new findings are told')
      assert.equal(after.incidentsWritten, 1, 'and only the new subject opens an incident')
      const keys = (await noticeState(client)).map((row) => row.dedupe_key)
      assert.ok(!keys.includes('identity-risk:dedupe-55555555-5555-5555-5555-555555555555'),
        'AND THE SUPPRESSED ONE IS STILL SILENT, in the same tick as the two that are not')
      assert.equal(keys.length, 2)
    } finally {
      await client.end()
    }
  })

test('CASE 6 — another organisation can neither suppress nor expose this evidence',
  { skip: !RUN || !URL }, async () => {
    // The key is (organization_id, dedupe_key) in both tables, so this holds by the key rather
    // than by a WHERE clause somebody has to remember. Proven with a real second organisation
    // holding a withheld notice at the SAME dedupe key — a fixture where the two sides disagree,
    // because one where they agree could not tell the scoping from its absence.
    const client = new pg.Client({ connectionString: URL })
    await client.connect()
    try {
      await freshWithRecipient(client)
      const other = '99999999-0000-0000-0000-000000000001'
      await client.query(
        `INSERT INTO organizations (id, name, slug, created_at, updated_at)
         VALUES ($1, 'Other', 'other-msp', now(), now()) ON CONFLICT (id) DO NOTHING`, [other])
      await client.query(
        `INSERT INTO alert_withheld_notices
           (id, organization_id, dedupe_key, alert_type_id, finding_id, because, withheld_at)
         VALUES (gen_random_uuid(), $1, 'identity-risk:dedupe-a',
                 'security.suspected_credential_attack', gen_random_uuid(), 'RECORD_ONLY', now())`,
        [other])

      await seed(client)
      const report = await tick(client)

      assert.equal(report.notificationsWritten, 1,
        'the other organisation’s withheld notice did not silence this one')
      assert.equal(report.noticesWithheld, 0)
    } finally {
      await client.end()
    }
  })

// ---------------------------------------------------------------------------------------
// R004 — "separate unique indexes on the two tables do not by themselves make the two
// outcomes mutually exclusive."
//
// That is correct, and it was the load-bearing claim in the comment above `decide`. A unique
// index prevents duplicates WITHIN a table and says nothing about the pair. What follows
// establishes what is actually true, at the three levels it can be attacked: one tick, many
// ticks, and two ticks at once.
// ---------------------------------------------------------------------------------------

test('R004 — ONE TICK DECIDES ONCE, AND THE DECISION COMMITS WITH THE EVIDENCE OR NOT AT ALL',
  { skip: !RUN || !URL }, async () => {
    // **THE INJECTED FAILURE GOES BETWEEN THE TWO WRITES.** One tick carrying both outcomes:
    // user-1 is told, user-2 is withheld. The withheld insert is made to fail, and the
    // NOTIFICATION for the other finding must not survive either — that is what "one
    // transaction" means, and it is the property a second `runner.transaction` would silently
    // break while every other test stayed green.
    const client = new pg.Client({ connectionString: URL })
    await client.connect()
    try {
      await freshWithRecipient(client)
      // A silenced type and an unsilenced one, so a single tick produces one of each.
      await client.query(
        `INSERT INTO alert_rule_dispositions
           (id, organization_id, alert_type_id, disposition, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'security.privileged_directory_change', 'RECORD_ONLY', now(), now())
         ON CONFLICT (organization_id, alert_type_id) DO UPDATE SET disposition = 'RECORD_ONLY'`,
        [ORG])
      await seed(client, { id: '55555555-5555-5555-5555-555555555555', subject: 'user-1' })
      await seed(client, {
        id: '66666666-6666-6666-6666-666666666666',
        subject: 'user-2',
        // A REAL RULE ID, refused by `identity_risk_finding_rule_check` if invented: the id has
        // to match ^HV-ID-(EXP|CHG|APP|MBX|AUTH)-[0-9]{3}.v1$ AND resolve through the catalogue
        // to REVIEW_ACCESS, which is the guidance that maps to privileged_directory_change.
        ruleId: 'HV-ID-CHG-001.v1',
      })

      // A runner that is the real one until it sees the withholding write, then fails.
      const base = runnerFor(client)
      const failing: SqlRunner = {
        ...base,
        transaction: (run) => base.transaction((tx) => run({
          ...tx,
          execute: async (sql, params) => {
            if (sql.includes('alert_withheld_notices')) {
              throw new Error('injected: the withholding write failed')
            }
            return tx.execute(sql, params)
          },
        })),
      }

      const outcome = await runIntake(
        pipelineStore(failing), WATERMARK, T0, Date.now() + 60_000, '2026-01-01T00:00:00.000Z')
      assert.equal(outcome.kind, 'FAILED', 'the tick reported the failure rather than swallowing it')

      // NEITHER SURVIVES. Not the withheld row, and not the notification written beside it.
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM alert_withheld_notices')).rows[0].n, 0)
      assert.equal((await noticeState(client)).length, 0,
        'THE NOTIFICATION ROLLED BACK TOO — the two writes are one transaction')
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM alert_incidents')).rows[0].n, 0,
        'and so did the evidence, so nothing is half-decided')

      // THE CONTROL: without the injected failure the very same tick writes both, so the
      // assertions above are about the rollback and not about a tick that does nothing.
      const healthy = await tick(client)
      assert.equal(healthy.notificationsWritten, 1)
      assert.equal(healthy.noticesWithheld, 1)
    } finally {
      await client.end()
    }
  })

test('R004 — A FINDING ALREADY TOLD IS NEVER ALSO RECORDED AS WITHHELD, and the reverse',
  { skip: !RUN || !URL }, async () => {
    // The sequential attack: decide one way, change the setting, tick again. Both directions,
    // because a gate that reads only one of the two tables passes one of them and fails the
    // other.
    const client = new pg.Client({ connectionString: URL })
    await client.connect()
    try {
      await freshWithRecipient(client)
      await seed(client)
      await tick(client)
      assert.equal((await noticeState(client)).length, 1, 'told')

      // NOW SILENCE IT. The finding is still OPEN so the next tick reads it again.
      await silence(client)
      const afterSilencing = await tick(client)
      assert.equal(afterSilencing.noticesWithheld, 0,
        'IT WAS ALREADY TOLD, so there is nothing to withhold')
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM alert_withheld_notices')).rows[0].n, 0,
        'no withheld row for a finding that has a notification')

      // AND THE REVERSE, on a second finding: withheld first, then re-enabled.
      await unsilence(client)
      await silence(client)
      await seed(client, { id: '66666666-6666-6666-6666-666666666666', subject: 'user-2' })
      await tick(client)
      await unsilence(client)
      await tick(client)
      const keys = (await noticeState(client)).map((row) => row.dedupe_key)
      assert.ok(!keys.includes('identity-risk:dedupe-66666666-6666-6666-6666-666666666666'),
        'no notification for a finding that has a withheld row')
    } finally {
      await client.end()
    }
  })

test('R004 — TWO TICKS AT ONCE, DRIVEN RATHER THAN REASONED ABOUT',
  { skip: !RUN || !URL }, async () => {
    // **THE ONLY WAY TO GET BOTH ROWS**, and it needs three things at once: two ticks
    // overlapping, the same finding in both, and the disposition CHANGING between their reads.
    // Nothing serialises the tick today — no advisory lock, no in-flight guard — and a second
    // instance of the service would overlap by itself.
    //
    // Driven with two connections: A reads while the type is live, the setting is then
    // silenced, B runs to completion, and only then does A commit.
    const a = new pg.Client({ connectionString: URL })
    const b = new pg.Client({ connectionString: URL })
    await a.connect()
    await b.connect()
    try {
      await freshWithRecipient(a)
      await seed(a)

      // A reads the world with the type LIVE and decides to tell somebody.
      const storeA = storeFor(a)
      const read = await storeA.findOpenFindings('2026-01-01T00:00:00.000Z')
      const liveDispositions = await storeA.loadDispositions([ORG])
      const decisionA = decide(read, [], liveDispositions, WATERMARK, T0, new Set())
      assert.equal(decisionA.notifications.length, 1, 'A is going to tell somebody')

      // Between A's read and A's write, the MSP silences the type and B runs a whole tick.
      await silence(b)
      const reportB = await ranIntake(
        storeFor(b), WATERMARK, T0, Date.now() + 60_000, '2026-01-01T00:00:00.000Z')
      assert.equal(reportB.noticesWithheld, 1, 'B withheld it')

      // Only now does A commit, on the world as it was when A read it.
      await storeA.commit(
        decisionA.incidents, decisionA.notifications, decisionA.jobs, decisionA.withheld)

      // **THE ASSERTION IS THE USER-VISIBLE OUTCOME, NOT THE ROW SHAPE.** An earlier version of
      // this test asserted that BOTH rows appear, which made the regression green by pinning the
      // unwanted state: characterising a race is not repairing it. What an MSP is owed is simpler
      // and stronger — B durably withheld this finding, so a stale A must not turn it into an
      // active notice.
      const notified = await noticeState(a)
      assert.deepEqual(notified, [],
        'A STALE WRITER DID NOT RESURRECT A WITHHELD FINDING — nothing in the inbox, nothing in '
        + 'the unread count')
      assert.equal(
        (await a.query('SELECT count(*)::int AS n FROM alert_withheld_notices')).rows[0].n, 1,
        'and the withholding decision stands')

      // The gate is still order-independent: a finding in either table is decided, so no later
      // tick re-decides it whichever row landed first.
      const decided = await storeFor(a).findDecidedNoticeKeys([ORG], read.map(noticeKeyFor))
      assert.equal(decided.size, 1, 'the finding is decided exactly once, however many rows exist')

      const third = await ranIntake(
        storeFor(a), WATERMARK, T0, Date.now() + 60_000, '2026-01-01T00:00:00.000Z')
      assert.equal(third.notificationsWritten, 0, 'and a later tick re-decides nothing')
      assert.equal(third.noticesWithheld, 0)
    } finally {
      await a.end()
      await b.end()
    }
  })

test('A2 — AN OVERLAPPING TICK CANNOT UN-DISMISS WHAT A PERSON DISMISSED',
  { skip: !RUN || !URL }, async () => {
    // **THE RACE CODEX NAMED, DRIVEN RATHER THAN REASONED ABOUT.** The decision read happens
    // BEFORE the write transaction opens, so two overlapping ticks can both read "no decision for
    // this finding" and both proceed. CASE 1 proves the sequential re-read is safe and cannot see
    // this: by the time the second tick reads, the first has committed.
    //
    // The interleaving below is the worst ordering rather than a convenient one:
    //   A reads and decides to notify, and stalls before committing
    //   B runs a whole tick and writes the notification
    //   a person reads it and DISMISSES it
    //   A finally commits
    // If A's insert takes the conflict branch as an UPDATE, it clears `resolved_at` and bumps
    // `occurrence_count` — un-dismissing something a person dismissed, which is the defect CASE 1
    // exists to prevent, reachable again through a second concurrent tick.
    //
    // `occurrence_count` is not cosmetic either: apply/revert digests it as a watched field, so a
    // spurious bump makes an apply's version predicate stop matching.
    const a = new pg.Client({ connectionString: URL })
    const b = new pg.Client({ connectionString: URL })
    await a.connect()
    await b.connect()
    try {
      await freshWithRecipient(a)
      await seed(a)

      // A reads the world and decides. Nothing is written yet.
      const storeA = storeFor(a)
      const read = await storeA.findOpenFindings('2026-01-01T00:00:00.000Z')
      const [dispositionsA, decidedA] = await Promise.all([
        storeA.loadDispositions([ORG]),
        storeA.findDecidedNoticeKeys([ORG], read.map(noticeKeyFor)),
      ])
      assert.equal(decidedA.size, 0, 'A sees no prior decision, which is what makes it proceed')
      const decisionA = decide(read, [], dispositionsA, WATERMARK, T0, decidedA)
      assert.equal(decisionA.notifications.length, 1, 'A is going to write a notification')

      // B runs a whole tick on the real path and writes it first.
      const reportB = await ranIntake(
        storeFor(b), WATERMARK, T0, Date.now() + 60_000, '2026-01-01T00:00:00.000Z')
      assert.equal(reportB.notificationsWritten, 1, 'B wrote it')

      // A PERSON READS IT AND DISMISSES IT.
      await b.query("UPDATE notifications SET resolved_at = now() WHERE source = 'identity-risk'")

      // Only now does A commit, on the world as it was when A read it.
      await storeA.commit(
        decisionA.incidents, decisionA.notifications, decisionA.jobs, decisionA.withheld)

      assert.deepEqual(await noticeState(a),
        [{ dedupe_key: 'identity-risk:dedupe-a', occurrence_count: 1, unresolved: false }],
        'THE DISMISSAL SURVIVED A CONCURRENT TICK, and the count did not move')

      // THE CONTROL. The same store, writing a notification for a finding nothing has decided
      // about, must still produce a row — or the assertion above is satisfied by a write path
      // that has quietly stopped working.
      await seed(a, { id: '66666666-6666-6666-6666-666666666666', subject: 'user-2' })
      const after = await ranIntake(
        storeFor(a), WATERMARK, T0, Date.now() + 60_000, '2026-01-01T00:00:00.000Z')
      assert.equal(after.notificationsWritten, 1, 'a genuinely new finding is still written')
    } finally {
      await a.end()
      await b.end()
    }
  })

test('A2 — A MIXED BATCH LEAVES NEITHER WHEN THE NOTIFICATION WRITE FAILS',
  { skip: !RUN || !URL }, async () => {
    // The reverse window of the atomicity test above: that one fails at the withholding write,
    // which is LAST, so it proves the earlier writes roll back. This fails at the NOTIFICATION
    // write, which is before the withholding one, and proves nothing downstream escapes the
    // transaction — the failure a `.then()` after the transaction would pass.
    //
    // A MIXED BATCH, NOT ONE FINDING IN BOTH STATES. Forcing a single finding to be notified and
    // withheld at once would manufacture a condition the design says cannot occur, and a test
    // built on an impossible fixture proves nothing about the real path. Here user-1 is told and
    // user-2 is withheld, which is an ordinary tick.
    const client = new pg.Client({ connectionString: URL })
    await client.connect()
    try {
      await freshWithRecipient(client)
      await client.query(
        `INSERT INTO alert_rule_dispositions
           (id, organization_id, alert_type_id, disposition, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'security.privileged_directory_change', 'RECORD_ONLY', now(), now())
         ON CONFLICT (organization_id, alert_type_id) DO UPDATE SET disposition = 'RECORD_ONLY'`,
        [ORG])
      await seed(client, { id: '55555555-5555-5555-5555-555555555555', subject: 'user-1' })
      await seed(client, {
        id: '66666666-6666-6666-6666-666666666666',
        subject: 'user-2',
        ruleId: 'HV-ID-CHG-001.v1',
      })

      const base = runnerFor(client)
      const failing: SqlRunner = {
        ...base,
        transaction: (run) => base.transaction((tx) => run({
          ...tx,
          execute: async (sql, params) => {
            if (sql.includes('INSERT INTO notifications')) {
              throw new Error('injected: the notification write failed')
            }
            return tx.execute(sql, params)
          },
        })),
      }

      const outcome = await runIntake(
        pipelineStore(failing), WATERMARK, T0, Date.now() + 60_000, '2026-01-01T00:00:00.000Z')
      assert.equal(outcome.kind, 'FAILED')

      const counts = await client.query(
        `SELECT (SELECT count(*)::int FROM notifications WHERE source = 'identity-risk') AS notified,
                (SELECT count(*)::int FROM alert_withheld_notices) AS withheld,
                (SELECT count(*)::int FROM alert_incidents) AS incidents,
                (SELECT count(*)::int FROM alert_send_jobs) AS jobs`)
      assert.deepEqual(counts.rows[0], { notified: 0, withheld: 0, incidents: 0, jobs: 0 },
        'NEITHER FINDING LEFT ANYTHING BEHIND — one transaction, both outcomes')

      // THE CONTROL, so the assertion above is not satisfied by a tick that writes nothing.
      const healthy = await tick(client)
      assert.equal(healthy.notificationsWritten, 1)
      assert.equal(healthy.noticesWithheld, 1)
    } finally {
      await client.end()
    }
  })
