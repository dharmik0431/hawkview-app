import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import pg from 'pg'
import {
  cancelReason, cancelStatement, classifyCancellation, claimStatement, workerId,
} from './send-queue.js'
import { messageId } from './email-delivery.js'
import { runIntake, type PipelineStore, type Watermark } from './finding-pipeline.js'
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
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_rule_dispositions CASCADE')
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

    const report = await runIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

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
    const again = await runIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
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
    await client.query('TRUNCATE alert_send_jobs, alert_incidents CASCADE')
    await client.query('DELETE FROM identity_risk_findings')
    await seed(client, { observedAt: OLD, id: '66666666-6666-6666-6666-666666666666' })

    const report = await runIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

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
    await client.query('TRUNCATE alert_send_jobs, alert_incidents CASCADE')
    const report = await runIntake(storeFor(client), WATERMARK, T0, Date.now() - 1, '2026-01-01T00:00:00.000Z')

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
    await client.query('TRUNCATE alert_send_jobs, alert_incidents CASCADE')
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
    const yielded = await runIntake(
      storeFor(client), WATERMARK, T0, deadlineAt, '2026-01-01T00:00:00.000Z', runningOut)
    assert.ok(ticks >= 4, 'the run must have reached the pre-write check, or this tests nothing')
    assert.equal(yielded.yieldedOnBudget, true)
    assert.equal(yielded.incidentsWritten, 0, 'NOT 1 — a yield gives up work, it does not half-do it')
    assert.equal(yielded.jobsWritten, 0)
    assert.equal(yielded.findingsRead, 1, 'and it did read, so the yield is at the write phase')
    assert.equal((await client.query('SELECT count(*) FROM alert_incidents')).rows[0].count, '0',
      'no incident, so nothing for the next run to skip over')

    // AND THE NEXT RUN COMPLETES IT, along the ordinary path rather than a recovery path.
    const healthy = await runIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
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
    await client.query('TRUNCATE alert_send_jobs, alert_incidents CASCADE')
    await client.query('DELETE FROM identity_risk_findings')
    await seed(client, { ruleId: 'HV-ID-MBX-001.v1', id: '99999999-9999-9999-9999-999999999999' })

    const report = await runIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

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
    await client.query('TRUNCATE alert_send_jobs, alert_incidents CASCADE')
    await client.query('DELETE FROM identity_risk_findings')
    await client.query('DELETE FROM notification_preferences WHERE organization_id = $1', [ORG])
    await seed(client, { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })

    const report = await runIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

    assert.equal(report.incidentsWritten, 1, 'the incident is still recorded and visible in the product')
    assert.equal(report.jobsWritten, 0, 'and nothing is sent to nobody')
    assert.equal(report.skipped[0]?.because, 'NO_ELIGIBLE_RECIPIENT',
      'named as a coverage gap rather than passing silently')
    assert.equal((await client.query('SELECT count(*) FROM alert_send_jobs')).rows[0].count, '0')

    // POSITIVE CONTROL: give that organisation one operator with email on, and the same finding
    // does produce a job — so the refusal is about the preference, not about the fixture.
    await client.query('TRUNCATE alert_send_jobs, alert_incidents CASCADE')
    const operator = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    await client.query(
      "INSERT INTO users (id, email, updated_at) VALUES ($1, 'op2@an-msp.example', now()) ON CONFLICT DO NOTHING",
      [operator])
    await client.query(
      `INSERT INTO notification_preferences (id, user_id, organization_id, email_enabled, updated_at)
       VALUES (gen_random_uuid(), $2, $1, true, now())`, [ORG, operator])

    const second = await runIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
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
    await client.query('TRUNCATE alert_send_jobs, alert_incidents CASCADE')
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

    const report = await runIntake(storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
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
    await client.query('TRUNCATE alert_send_jobs CASCADE')

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
    await a.query('TRUNCATE alert_send_jobs CASCADE')
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
    await a.query('TRUNCATE alert_send_jobs CASCADE')
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
    await client.query('TRUNCATE alert_send_jobs CASCADE')
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
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_rule_dispositions CASCADE')
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

    const report = await runIntake(
      storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

    // IT STILL DOES NOT SILENCE — it names no alert type, so it cannot. That part is unchanged
    // and is correct: a broken row must not silence an alert by accident either.
    assert.equal(report.jobsWritten, 1, 'the catalogue default still applies')

    // BUT IT IS NO LONGER SILENT. The value is carried out verbatim so somebody can go and look,
    // rather than the MSP believing a choice took effect that the product never saw.
    const dispositions = await storeFor(client).loadDispositions([ORG])
    assert.deepEqual(dispositions.unreadable, ['HV-ID-AUTH-010.v1'])
    assert.equal(dispositions.byOrganizationAndAlertType.size, 0, 'and it is not keyed')

    // AND THE SAME PREFERENCE AT THE RIGHT GRAIN DOES SILENCE — the control, without which the
    // assertions above are satisfied by a lookup that never matches anything.
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_rule_dispositions CASCADE')
    await client.query('DELETE FROM identity_risk_findings')
    await client.query(
      `INSERT INTO alert_rule_dispositions
         (id, organization_id, alert_type_id, disposition, updated_at)
       VALUES (gen_random_uuid(), $1, 'security.suspected_credential_attack', 'RECORD_ONLY', now())`,
      [ORG])
    await seed(client, { id: '66666666-6666-6666-6666-666666666666' })

    const silenced = await runIntake(
      storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')
    assert.equal(silenced.jobsWritten, 0, 'stored at the right grain, it silences')
    assert.equal(silenced.skipped[0]?.because, 'RECORD_ONLY')
    assert.equal(silenced.incidentsWritten, 1, 'and the incident is still recorded — there is no OFF')
    assert.deepEqual((await storeFor(client).loadDispositions([ORG])).unreadable, [])
  } finally {
    await client.end()
  }
})
