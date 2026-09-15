import assert from 'node:assert/strict'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import test, { after, before } from 'node:test'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { PrismaPg } from '@prisma/adapter-pg'
import type { PrismaService } from '../prisma/prisma.service.js'
import { IdentityRiskService } from '../identity-risk/identity-risk.service.js'
import { IdentityRiskController } from '../identity-risk/identity-risk.controller.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { runIntake, type PipelineStore, type Watermark } from './finding-pipeline.js'
import { pipelineStore, type SqlRunner } from './pipeline-store.js'

/**
 * R001-B — WHERE AN AUTHORISED MSP CAN ACTUALLY INSPECT SUPPRESSED EVIDENCE.
 *
 * The ruling keeps evidence and inspectable history and suppresses the active notice. The settings
 * page now says *recorded as evidence you can look up*, and this file exists to find out whether
 * "look up" is true — **through the real reader and its real scope check**, not by pointing at a
 * row in SQL. An incident row existing is not a history UI.
 *
 * WHAT IS ASKED OF EACH READER: the notification reader must show NOTHING for a suppressed
 * finding, and some reader must still show the evidence. If none does, that is the finding.
 */

const RUN = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const URL = RUN ? assertDisposableTestDatabase().toString() : undefined

const T0 = '2026-09-12T09:00:00.000Z'
const WATERMARK: Watermark = {
  sendNothingObservedBeforeIso: '2026-01-01T00:00:00.000Z',
  because: 'the probe sends nothing; the watermark only has to be earlier than the fixture',
}

/** THE SAME GATE THE OTHER ALERT INTEGRATION FILES HOLD, and this file needs it more than they do.
 *
 * They reset by `DELETE FROM identity_risk_findings` with no organisation predicate, so a file
 * running in parallel deletes this test's finding out from under the reader — measured: passing
 * alone, and `findings: []` inside the suite with an otherwise healthy AVAILABLE envelope. The
 * lock serialises the files; the unscoped deletes are the underlying fault and are noted in the
 * handoff beside the shared-reset helper that would fix both. */
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

const insideTransaction = (c: pg.Client): SqlRunner => ({
  query: async <T,>(sql: string, p: readonly unknown[]) => (await c.query(sql, [...p])).rows as T[],
  execute: async (sql: string, p: readonly unknown[]) => (await c.query(sql, [...p])).rowCount ?? 0,
  transaction: (run) => run(insideTransaction(c)),
})
const runnerFor = (c: pg.Client): SqlRunner => ({
  query: async <T,>(sql: string, p: readonly unknown[]) => (await c.query(sql, [...p])).rows as T[],
  execute: async (sql: string, p: readonly unknown[]) => (await c.query(sql, [...p])).rowCount ?? 0,
  transaction: async (run) => {
    await c.query('BEGIN')
    try { const out = await run(insideTransaction(c)); await c.query('COMMIT'); return out }
    catch (e) { await c.query('ROLLBACK'); throw e }
  },
})
const storeFor = (c: pg.Client): PipelineStore => pipelineStore(runnerFor(c))

/** One MSP, one customer tenant, one operator who is a member of it, and one OPEN finding. */
async function world(client: pg.Client, prisma: PrismaClient, environment: string) {
  const organizationId = randomUUID()
  const customerTenantId = randomUUID()
  const subject = randomUUID()
  const userId = randomUUID()
  await prisma.organization.create({
    data: { id: organizationId, name: 'Reader probe', slug: `reader-${organizationId}` } })
  await prisma.customerTenant.create({
    data: { id: customerTenantId, organizationId, microsoftTenantId: randomUUID(),
      displayName: 'Probe tenant', status: 'ACTIVE' } })
  await prisma.user.create({
    data: { id: userId, authProviderUserId: subject, email: `${subject}@fixture.invalid` } })
  await prisma.membership.create({
    data: { userId, organizationId, role: 'MSP_OWNER', status: 'ACTIVE' } })

  // **A REAL SUBJECT REFERENCE, NOT AN INVENTED ONE.** The reader refuses to project a finding
  // whose subject is not a pseudonymised opaque reference — `hvr1_<kind>_<64 hex>`. The alert
  // pipeline never looks at the shape, so its own fixtures use "user-1" and pass; this reader is
  // the first thing in the system that cares, and a made-up id would make the test measure the
  // fixture rather than the reader. Fourth time an invented vocabulary has met a real constraint.
  const subjectRef = `hvr1_subject_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`
  const runId = randomUUID()
  const matchedId = randomUUID()
  const findingId = randomUUID()
  await client.query(`INSERT INTO identity_risk_evaluation_runs
      (id, organization_id, customer_tenant_id, run_key, engine_version, catalog_version, status,
       window_start, window_end, source_watermark_hash, source_content_hash, capability, expires_at, completed_at, created_at)
      VALUES ($1,$2,$3,'reader-run','hawkview-identity-engine/1','hawkview-identity-signals/v1','COMPLETED', now() - interval '1 hour', now(),
              'h','h','FULL', now() + interval '30 days', now() - interval '2 minutes', now())`, [runId, organizationId, customerTenantId])
  await client.query(`INSERT INTO identity_risk_matched_results
      (id, organization_id, customer_tenant_id, evaluation_run_id, result_key, rule_id, subject_type,
       subject_id, severity, confidence, coverage, observed_at, expires_at, created_at)
      VALUES ($1,$2,$3,$4,'reader-result','HV-ID-AUTH-001.v1','USER','seed','HIGH','HIGH','FULL',
              now(), now() + interval '30 days', now())`, [matchedId, organizationId, customerTenantId, runId])
  await client.query(`INSERT INTO identity_risk_findings
      (id, organization_id, customer_tenant_id, matched_result_id, dedupe_key, rule_id, rule_version,
       subject_type, subject_id, state, severity, confidence, coverage, observed_at, expires_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,'HV-ID-AUTH-001.v1','v1','USER',$7,'OPEN','HIGH','HIGH','FULL',
              $6::timestamptz, now() + interval '30 days', now())`,
    [findingId, organizationId, customerTenantId, matchedId, `dedupe-${findingId}`, T0, subjectRef])

  // The type is silenced BEFORE the tick, so this finding is suppressed on its first handling.
  await client.query(`INSERT INTO alert_rule_dispositions
      (id, organization_id, alert_type_id, disposition, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, 'security.suspected_credential_attack', 'RECORD_ONLY', now(), now())`,
    [organizationId])

  // THE READER RESOLVES THE RUN THROUGH THE ATTEMPT HEAD under a global config, not by picking
  // the newest completed row. Without this the reader answers NOT_EVALUATED and the test would be
  // measuring the absence of a fixture rather than the absence of a reader.
  await client.query(`INSERT INTO identity_risk_attempt_heads
      (organization_id, customer_tenant_id, environment, attempt_id, completed_run_id)
    VALUES ($1,$2,$3,$4,$5)`, [organizationId, customerTenantId, environment, randomUUID(), runId])

  return { organizationId, customerTenantId, subject, userId, findingId }
}

test('R001-B — a suppressed finding is absent from the notification reader and present in the evidence reader',
  { skip: !RUN || !URL }, async () => {
    const client = new pg.Client({ connectionString: URL })
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL }) })
    await client.connect()
    const prior = {
      mode: process.env.HAWKVIEW_IDENTITY_RISK_MODE,
      rollout: process.env.HAWKVIEW_IDENTITY_RISK_ROLLOUT,
      environment: process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT,
      scope: process.env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE,
      provider: process.env.HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER,
    }
    try {
      // **THE READER IS BEHIND A RUNTIME GATE, AND THAT IS PART OF THE ANSWER.** `pilotReadAllowed`
      // consults `riskRuntimeConfig()`, so whether an MSP can inspect anything at all is a
      // deployment decision rather than a property of the code. Enabled here deliberately, so the
      // rest of the test measures the reader and not the gate.
      const environment = `reader-${randomUUID().slice(0, 8)}`
      process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
      process.env.HAWKVIEW_IDENTITY_RISK_ROLLOUT = 'global'
      process.env.HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER = 'wrapped-v1'
      process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT = environment
      delete process.env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE

      const scope = await world(client, prisma, environment)

      const report = await runIntake(
        storeFor(client), WATERMARK, T0, Date.now() + 60_000, '2026-01-01T00:00:00.000Z')
      assert.equal(report.kind, 'RAN')
      if (report.kind !== 'RAN') return
      assert.equal(report.report.notificationsWritten, 0, 'the notice is suppressed')
      assert.equal(report.report.noticesWithheld, 1, 'and the decision is recorded')
      assert.equal(report.report.incidentsWritten, 1, 'and the incident is the evidence')

      const identity = { subject: scope.subject, email: `${scope.subject}@fixture.invalid` }

      // 1. THE NOTIFICATION READER — the surface the bell and the inbox use — shows nothing.
      //    Asked of the reader rather than of the table, because that is what an MSP sees.
      const inbox = await new NotificationsService(prisma as unknown as PrismaService).list(identity)
      assert.equal(inbox.total, 0, 'NOTHING IN THE INBOX, and nothing in the unread count')

      // 2. THE EVIDENCE READER still has it — **through the controller**, which is the authorised
      //    path an MSP's request actually takes. Driving the service alone would skip the layer
      //    that turns a request's identity into the scope check.
      const risk = new IdentityRiskService(prisma as unknown as PrismaService)
      const reader = new IdentityRiskController(risk)
      const request = { auth: identity } as never

      const seen = await reader.findings(request, scope.customerTenantId, undefined, undefined)
      assert.equal(seen.findings.length, 1,
        `THE EVIDENCE IS INSPECTABLE through GET identity-signals/findings. Envelope: ${JSON.stringify(seen.findings.length === 0 ? seen : {})}`)

      // AND THE SINGLE-FINDING ROUTE, because a list and a detail can disagree: the list is what
      // a screen renders and the detail is what somebody opens to act on.
      const detail = await reader.findingDetail(request, scope.customerTenantId, seen.findings[0]!.id)
      assert.ok(detail, 'GET identity-signals/findings/:findingId returned nothing')
      assert.equal((detail as { finding?: { id?: string } }).finding?.id ?? (detail as { id?: string }).id,
        seen.findings[0]!.id, 'the detail route returns the same finding the list showed')

      // 3. TENANT SCOPE. A second MSP, with its own organisation and its own tenant, must not see
      //    it — and asking for somebody else's tenant id must be refused rather than answered
      //    emptily, because an empty answer and a forbidden one are different facts.
      const otherPrisma = prisma
      const otherOrg = randomUUID()
      const otherSubject = randomUUID()
      const otherUser = randomUUID()
      await otherPrisma.organization.create({
        data: { id: otherOrg, name: 'Other MSP', slug: `other-${otherOrg}` } })
      await otherPrisma.user.create({
        data: { id: otherUser, authProviderUserId: otherSubject, email: `${otherSubject}@fixture.invalid` } })
      await otherPrisma.membership.create({
        data: { userId: otherUser, organizationId: otherOrg, role: 'MSP_OWNER', status: 'ACTIVE' } })

      const intruder = { auth: { subject: otherSubject, email: `${otherSubject}@fixture.invalid` } } as never
      await assert.rejects(
        () => reader.findings(intruder, scope.customerTenantId, undefined, undefined),
        /Tenant access denied|Forbidden/,
        'ANOTHER MSP IS REFUSED on the list, not quietly given an empty list')

      // BOTH ROUTES, because a denial on the list and a leak on the detail is the shape that gets
      // shipped — the list is the one everybody remembers to scope.
      await assert.rejects(
        () => reader.findingDetail(intruder, scope.customerTenantId, seen.findings[0]!.id),
        /Tenant access denied|Forbidden/,
        'ANOTHER MSP IS REFUSED on the detail route too')
    } finally {
      for (const [key, value] of Object.entries({
        HAWKVIEW_IDENTITY_RISK_MODE: prior.mode,
        HAWKVIEW_IDENTITY_RISK_ROLLOUT: prior.rollout,
        HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: prior.environment,
        HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: prior.scope,
        HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: prior.provider,
      })) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
      await prisma.$disconnect()
      await client.end()
    }
  })
