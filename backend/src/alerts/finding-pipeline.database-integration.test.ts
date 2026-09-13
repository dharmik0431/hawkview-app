import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { runIntake, type Dispositions, type ExistingIncident, type FindingRow,
  type IncidentWrite, type PipelineStore, type SendJobWrite, type Watermark } from './finding-pipeline.js'

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

const ORG = '11111111-1111-1111-1111-111111111111'
const TENANT = '22222222-2222-2222-2222-222222222222'
const T0 = '2026-09-12T09:00:00.000Z'
const OLD = '2026-08-01T09:00:00.000Z'

const WATERMARK: Watermark = {
  sendNothingObservedBeforeIso: '2026-09-12T00:00:00.000Z',
  because: 'the instant this pipeline was first switched on, so history is recorded not sent',
}

/** The store, against real SQL. Deliberately raw rather than through Prisma's client: these
 * tables are new and the point is to prove the columns exist and the constraints hold, not to
 * prove the ORM can spell them. */
const storeFor = (client: pg.Client): PipelineStore => ({
  async findOpenFindings(sinceIso) {
    const { rows } = await client.query(
      `SELECT id, organization_id, customer_tenant_id, rule_id, subject_type, subject_id,
              severity, state, observed_at
         FROM identity_risk_findings
        WHERE state = 'OPEN' AND observed_at >= $1::timestamptz
        ORDER BY observed_at, id`, [sinceIso])
    return rows.map((row): FindingRow => ({
      id: row.id,
      organizationId: row.organization_id,
      customerTenantId: row.customer_tenant_id,
      ruleId: row.rule_id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      severity: row.severity,
      state: row.state,
      observedAtIso: new Date(row.observed_at).toISOString(),
    }))
  },
  async findExistingIncidents(organizationIds) {
    if (organizationIds.length === 0) return []
    const { rows } = await client.query(
      'SELECT organization_id, incident_key FROM alert_incidents WHERE organization_id = ANY($1::uuid[])',
      [organizationIds])
    return rows.map((row): ExistingIncident => ({
      organizationId: row.organization_id, incidentKey: row.incident_key,
    }))
  },
  async loadDispositions(organizationIds) {
    const byOrganizationAndRule = new Map<string, string>()
    const anyRecipientByOrganization = new Map<string, boolean>()
    if (organizationIds.length === 0) return { byOrganizationAndRule, anyRecipientByOrganization }

    const dispositions = await client.query(
      'SELECT organization_id, rule_id, disposition FROM alert_rule_dispositions WHERE organization_id = ANY($1::uuid[])',
      [organizationIds])
    for (const row of dispositions.rows) {
      byOrganizationAndRule.set(`${row.organization_id}|${row.rule_id}`, row.disposition)
    }
    // THE TWO GRAINS MEETING. The organisation decides what is urgent; a person decides whether
    // they are emailed. This asks whether ANYBODY there can be.
    const recipients = await client.query(
      `SELECT organization_id, bool_or(email_enabled) AS any_recipient
         FROM notification_preferences
        WHERE organization_id = ANY($1::uuid[])
        GROUP BY organization_id`, [organizationIds])
    for (const id of organizationIds) anyRecipientByOrganization.set(id, false)
    for (const row of recipients.rows) {
      anyRecipientByOrganization.set(row.organization_id, row.any_recipient === true)
    }
    return { byOrganizationAndRule, anyRecipientByOrganization }
  },
  // ONE TRANSACTION, BOTH WRITES. Two calls with a budget check between them left an incident
  // with no job, which the next run skips as INCIDENT_ALREADY_OPEN — permanently silent. A
  // crash between them does the same, and no logic inside runIntake could catch that one.
  async commit(incidents: readonly IncidentWrite[], jobs: readonly SendJobWrite[]) {
    let incidentsWritten = 0
    let jobsWritten = 0
    await client.query('BEGIN')
    try {
      for (const each of incidents) {
        const { rowCount } = await client.query(
          `INSERT INTO alert_incidents
             (id, organization_id, incident_key, alert_type_id, ownership, "condition", investigation,
              ownership_at, condition_at, investigation_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz, $7::timestamptz, now())
           ON CONFLICT (organization_id, incident_key) DO NOTHING`,
          [each.organizationId, each.incidentKey, each.alertTypeId, each.ownership, each.condition,
            each.investigation, each.atIso])
        incidentsWritten += rowCount ?? 0
      }
      for (const each of jobs) {
        const { rowCount } = await client.query(
          `INSERT INTO alert_send_jobs
             (id, message_id, idempotency_key, state, attempts_made, max_attempts, not_before_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'READY', 0, $3, $4::timestamptz, now())
           ON CONFLICT (message_id) DO NOTHING`,
          [each.messageId, each.idempotencyKey, each.maxAttempts, each.notBeforeIso])
        jobsWritten += rowCount ?? 0
      }
      await client.query('COMMIT')
    } catch (cause) {
      await client.query('ROLLBACK')
      throw cause
    }
    return { incidentsWritten, jobsWritten }
  },
})

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
