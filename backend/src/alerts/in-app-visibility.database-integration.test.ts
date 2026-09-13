import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import { alertTierFor, runIntake, type PipelineStore, type Watermark } from './finding-pipeline.js'
import { pipelineStore, type SqlRunner } from './pipeline-store.js'

/**
 * DOES THE BELL ACTUALLY SHOW IT?
 *
 * Every other test in this feature asks the database what was written. This one asks the READER,
 * through `NotificationsService.list` — the same method the notification panel calls — because
 * the defect being closed here is not a missing row, it is *an incident that is invisible in the
 * product*, and a test that queries `notifications` directly cannot tell those apart.
 *
 * The recurring HawkView defect is a true sentence in the wrong company: every part correct, the
 * assembled screen wrong. `alert_incidents` is a PROJECTION OVER `notifications`, so a pipeline
 * that wrote incidents and no notification rows made every incident a projection over the empty
 * set. Fourteen integration tests passed while the bell showed nothing, because none of them
 * asked the bell.
 *
 * NOTHING IS SENT. No provider client exists.
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
/** ITS OWN USER ID, NOT ONE ANOTHER TEST FILE ALSO USES. The first version borrowed
 * 77777777-… , which `finding-pipeline.database-integration.test.ts` inserts WITHOUT an
 * auth_provider_user_id — so `ON CONFLICT DO NOTHING` kept that row and the reader answered 403.
 * A test that depends on which other test ran first is testing the machine it ran on. */
const USER = 'aaaaaaaa-0000-4000-8000-00000000a11a'
const SUBJECT = 'auth|in-app-probe'
const T0 = '2026-09-12T09:00:00.000Z'

const WATERMARK: Watermark = {
  sendNothingObservedBeforeIso: '2026-09-12T00:00:00.000Z',
  because: 'the instant this pipeline was first switched on',
}

const runnerFor = (client: pg.Client): SqlRunner => ({
  query: async <T>(sql: string, params: readonly unknown[]) =>
    (await client.query(sql, [...params])).rows as T[],
  execute: async (sql: string, params: readonly unknown[]) =>
    (await client.query(sql, [...params])).rowCount ?? 0,
  transaction: async (run) => {
    await client.query('BEGIN')
    try {
      const result = await run(runnerFor(client))
      await client.query('COMMIT')
      return result
    } catch (cause) {
      await client.query('ROLLBACK')
      throw cause
    }
  },
})
const storeFor = (client: pg.Client): PipelineStore => pipelineStore(runnerFor(client))

/** Everything the reader needs to exist: an active organisation, an active membership, and a
 * preference row left at its DEFAULTS — in-app on, security family on, minimum severity info,
 * email off. Nothing here turns anything on that a new MSP would not already have. */
async function scaffold(client: pg.Client) {
  await client.query(
    `INSERT INTO organizations (id, name, slug, created_at, updated_at)
     VALUES ($1, 'Probe', 'probe', now(), now()) ON CONFLICT (id) DO NOTHING`, [ORG])
  await client.query(
    `INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, display_name, created_at, updated_at)
     VALUES ($1, $2, '99999999-9999-9999-9999-999999999999', 'Probe Tenant', now(), now())
     ON CONFLICT (id) DO NOTHING`, [TENANT, ORG])
  await client.query(
    `INSERT INTO users (id, email, auth_provider_user_id, updated_at)
     VALUES ($1, 'in-app-probe@an-msp.example', $2, now())
     ON CONFLICT (id) DO UPDATE SET auth_provider_user_id = EXCLUDED.auth_provider_user_id,
                                    disabled_at = NULL`, [USER, SUBJECT])
  await client.query(
    `INSERT INTO memberships (id, user_id, organization_id, role, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'MSP_OWNER', 'ACTIVE', now(), now())
     ON CONFLICT (user_id, organization_id) DO NOTHING`, [USER, ORG])
  await client.query(
    `INSERT INTO notification_preferences (id, user_id, organization_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now()) ON CONFLICT DO NOTHING`, [USER, ORG])
}

async function seedFinding(client: pg.Client, id: string, ruleId = 'HV-ID-AUTH-001.v1') {
  const runId = '33333333-3333-3333-3333-333333333333'
  const matchedId = '44444444-4444-4444-4444-444444444444'
  await client.query(`INSERT INTO identity_risk_evaluation_runs
      (id, organization_id, customer_tenant_id, run_key, engine_version, catalog_version, status,
       window_start, window_end, source_watermark_hash, source_content_hash, expires_at, completed_at, created_at)
      VALUES ($1,$2,$3,'seed-run','test','test','COMPLETED', now() - interval '1 hour', now(),
              'h','h', now() + interval '30 days', now(), now())
      ON CONFLICT DO NOTHING`, [runId, ORG, TENANT])
  await client.query(`INSERT INTO identity_risk_matched_results
      (id, organization_id, customer_tenant_id, evaluation_run_id, result_key, rule_id, subject_type,
       subject_id, severity, confidence, coverage, observed_at, expires_at, created_at)
      VALUES ($1,$2,$3,$4,'seed-result',$5,'USER','seed','HIGH','HIGH','FULL',
              now(), now() + interval '30 days', now())
      ON CONFLICT DO NOTHING`, [matchedId, ORG, TENANT, runId, ruleId])
  await client.query(`INSERT INTO identity_risk_findings
      (id, organization_id, customer_tenant_id, matched_result_id, dedupe_key, rule_id, rule_version,
       subject_type, subject_id, state, severity, confidence, coverage, observed_at, expires_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'v1','USER','user-1','OPEN','HIGH','HIGH','FULL',
              $7::timestamptz, now() + interval '30 days', now())`,
    [id, ORG, TENANT, matchedId, `dedupe-${id}`, ruleId, T0])
}

const readerFor = (prisma: PrismaClient) =>
  new NotificationsService(prisma as unknown as PrismaService)

test('AN INCIDENT IS VISIBLE IN THE PRODUCT, asked of the reader rather than the table', { skip: !RUN || !URL }, async () => {
  const client = new pg.Client({ connectionString: URL })
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL }) })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_rule_dispositions CASCADE')
    await client.query('DELETE FROM notifications')
    await client.query('DELETE FROM identity_risk_findings')

    const reader = readerFor(prisma)
    const identity = { subject: SUBJECT, email: 'in-app-probe@an-msp.example' }

    // THE CONTROL, AND IT COMES FIRST. If the panel already showed something, the assertion below
    // would pass without the pipeline having done anything at all.
    const before = await reader.list(identity)
    assert.equal(before.total, 0, 'the panel starts empty')

    await seedFinding(client, '55555555-5555-5555-5555-555555555555')
    const report = await runIntake(
      storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

    assert.equal(report.incidentsWritten, 1)
    assert.equal(report.notificationsWritten, 1, 'THE ROW THE BELL READS')

    // AND NOW THE READER SEES IT. This is the assertion the other fourteen tests could not make:
    // they proved rows exist, which an incident with no notification also satisfies.
    const after = await reader.list(identity)
    assert.equal(after.total, 1, 'THE ALERT IS IN THE PANEL')
    assert.equal(after.unreadCount, 1, 'and the badge counts it')

    const item = after.items[0]
    assert.equal(item.title, 'Suspected credential attack')
    assert.equal(item.eventType, 'security.suspected_credential_attack',
      'the security family, which is what securityEnabled gates')
    assert.equal(item.severity, 'critical', 'ACT_NOW, which is shown whatever the in-app switch says')
    assert.match(item.description, /user-1/, 'and it names the account somebody has to act on')

    // THE INCIDENT KEY TRAVELS WITH IT, which is what makes the row part of a projection rather
    // than a loose notification that happens to look similar.
    const keyed = await client.query(
      'SELECT incident_key, alert_type_id, severity FROM notifications WHERE dedupe_key = $1',
      ['identity-risk:dedupe-55555555-5555-5555-5555-555555555555'])
    assert.equal(keyed.rowCount, 1)

    // THE ALERT TYPE IS ON THE ROW, AND IT IS THE FACT. The tier is derived from it rather than
    // stored beside it — two columns describing how urgent something is disagree the first time
    // anybody edits one. `severity` is set as well because the reader's filter matches on it,
    // and this asserts the RELATIONSHIP between them rather than two remembered constants.
    assert.equal(keyed.rows[0].alert_type_id, 'security.suspected_credential_attack')
    const tier = alertTierFor(keyed.rows[0].alert_type_id)
    assert.equal(tier.kind === 'TIER' ? tier.tier : null, 'ACT_NOW')
    assert.equal(keyed.rows[0].severity, 'critical', 'the rendering agrees with the fact')

    // AND A NOTIFICATION THAT IS NOT AN ALERT CARRIES NO TIER — absence stays absence, rather
    // than collapsing into RECORD_ONLY, which is a decision somebody made.
    await client.query(
      `INSERT INTO notifications (id, organization_id, event_type, category, severity, title,
          description, dedupe_key, source, occurrence_count, first_occurred_at, last_occurred_at,
          created_at, updated_at)
        VALUES (gen_random_uuid(), $1, 'tenant.sync.failed', 'warning', 'high', 'Sync failed',
                'A collector could not finish.', 'tenant:probe:sync:mailbox', 'system', 1,
                now(), now(), now(), now())`, [ORG])
    const collector = await client.query(
      "SELECT alert_type_id FROM notifications WHERE dedupe_key = 'tenant:probe:sync:mailbox'")
    assert.equal(collector.rows[0].alert_type_id, null)
    assert.deepEqual(alertTierFor(collector.rows[0].alert_type_id), { kind: 'NOT_AN_ALERT' })
    const incidents = await client.query('SELECT incident_key FROM alert_incidents')
    assert.equal(keyed.rows[0].incident_key, incidents.rows[0].incident_key,
      'the notification and the incident share a key — the projection is not empty')
  } finally {
    await prisma.$disconnect()
    await client.end()
  }
})

test('A SECOND FINDING ON ONE INCIDENT IS A SECOND ROW, not nothing', { skip: !RUN || !URL }, async () => {
  // An incident is the SET of rows sharing a key. The pipeline skips a second finding as
  // INCIDENT_ALREADY_OPEN so no second incident is written — but the notification is written
  // before that branch, or the product would show the first occurrence of a burst and none of
  // the rest.
  const client = new pg.Client({ connectionString: URL })
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL }) })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_rule_dispositions CASCADE')
    await client.query('DELETE FROM notifications')
    await client.query('DELETE FROM identity_risk_findings')

    await seedFinding(client, '55555555-5555-5555-5555-555555555555')
    await seedFinding(client, '66666666-6666-6666-6666-666666666666')
    const report = await runIntake(
      storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

    assert.equal(report.findingsRead, 2)
    assert.equal(report.incidentsWritten, 1, 'one incident — the second finding groups into it')
    assert.equal(report.notificationsWritten, 2, 'BUT TWO ROWS, because the incident is their set')
    assert.ok(report.skipped.some((each) => each.because === 'INCIDENT_ALREADY_OPEN'))

    const rows = await client.query(
      'SELECT incident_key, count(*)::int AS n FROM notifications GROUP BY incident_key')
    assert.equal(rows.rowCount, 1, 'both rows carry the same incident key')
    assert.equal(rows.rows[0].n, 2)

    const reader = readerFor(prisma)
    const list = await reader.list({ subject: SUBJECT, email: 'in-app-probe@an-msp.example' })
    assert.equal(list.total, 2, 'and the panel shows both')
  } finally {
    await prisma.$disconnect()
    await client.end()
  }
})

test('A FINDING HELD BACK FROM SENDING IS STILL VISIBLE IN-APP', { skip: !RUN || !URL }, async () => {
  // IN-APP AND EMAIL ARE SEPARATE CHANNELS. emailEnabled defaults false, so a brand-new MSP has
  // nobody to email — and that must not make the alert invisible in the product too. Before the
  // notification row existed, "no eligible recipient" meant the incident existed and nothing
  // anywhere showed it.
  const client = new pg.Client({ connectionString: URL })
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL }) })
  await client.connect()
  try {
    await scaffold(client)
    await client.query('TRUNCATE alert_send_jobs, alert_incidents, alert_rule_dispositions CASCADE')
    await client.query('DELETE FROM notifications')
    await client.query('DELETE FROM identity_risk_findings')
    // The preference row is left at its defaults, so email_enabled is false.
    await seedFinding(client, '55555555-5555-5555-5555-555555555555')

    const report = await runIntake(
      storeFor(client), WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

    assert.equal(report.jobsWritten, 0, 'nothing is queued to send')
    assert.equal(report.skipped[0]?.because, 'NO_ELIGIBLE_RECIPIENT')
    assert.equal(report.notificationsWritten, 1, 'AND IT IS STILL IN THE PRODUCT')

    const reader = readerFor(prisma)
    const list = await reader.list({ subject: SUBJECT, email: 'in-app-probe@an-msp.example' })
    assert.equal(list.total, 1, 'the panel shows an alert nobody will be emailed about')
  } finally {
    await prisma.$disconnect()
    await client.end()
  }
})
