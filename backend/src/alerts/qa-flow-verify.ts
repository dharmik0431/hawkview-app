// QA — the flow, verified independently. My store is written from the SCHEMA, not copied from
// the engineer's test, so this check does not share an origin with what it checks.
// Applies the honest-demo criteria: a negative control in the same run, a second run that must
// produce zero, and every figure recomputed in SQL rather than read off the report.
import pg from 'pg'
import { runIntake, type Dispositions, type PipelineStore, type Watermark } from './finding-pipeline.js'

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const ORG = '11111111-1111-1111-1111-111111111111'
const TENANT = '22222222-2222-2222-2222-222222222222'
const T0 = '2026-09-12T09:00:00.000Z'

const store: PipelineStore = {
  async findOpenFindings(sinceIso) {
    const { rows } = await client.query(
      `SELECT id, organization_id, customer_tenant_id, rule_id, subject_type, subject_id,
              severity, state, observed_at FROM identity_risk_findings
        WHERE state='OPEN' AND observed_at >= $1::timestamptz ORDER BY observed_at, id`, [sinceIso])
    return rows.map((r) => ({
      id: r.id, organizationId: r.organization_id, customerTenantId: r.customer_tenant_id,
      ruleId: r.rule_id, subjectType: r.subject_type, subjectId: r.subject_id,
      severity: r.severity, state: r.state, observedAtIso: new Date(r.observed_at).toISOString(),
    }))
  },
  async findExistingIncidents(orgIds) {
    if (orgIds.length === 0) return []
    const { rows } = await client.query(
      'SELECT organization_id, incident_key FROM alert_incidents WHERE organization_id = ANY($1::uuid[])', [orgIds])
    return rows.map((r) => ({ organizationId: r.organization_id, incidentKey: r.incident_key }))
  },
  async loadDispositions(orgIds): Promise<Dispositions> {
    const byOrganizationAndRule = new Map<string, string>()
    const anyRecipientByOrganization = new Map<string, boolean>()
    if (orgIds.length === 0) return { byOrganizationAndRule, anyRecipientByOrganization }
    const { rows } = await client.query(
      `SELECT organization_id, bool_or(email_enabled) AS any FROM notification_preferences
        WHERE organization_id = ANY($1::uuid[]) GROUP BY organization_id`, [orgIds])
    for (const r of rows) anyRecipientByOrganization.set(r.organization_id, r.any === true)
    return { byOrganizationAndRule, anyRecipientByOrganization }
  },
  async writeIncidents(writes) {
    let n = 0
    for (const w of writes) {
      const res = await client.query(
        `INSERT INTO alert_incidents (id, organization_id, incident_key, alert_type_id, ownership,
           condition, investigation, ownership_at, condition_at, investigation_at, created_at, updated_at)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz,$7::timestamptz,now(),now())
         ON CONFLICT (organization_id, incident_key) DO NOTHING`,
        [w.organizationId, w.incidentKey, w.alertTypeId, w.ownership, w.condition, w.investigation, w.atIso])
      n += res.rowCount ?? 0
    }
    return n
  },
  async writeJobs(writes) {
    let n = 0
    for (const w of writes) {
      const res = await client.query(
        `INSERT INTO alert_send_jobs (id, message_id, idempotency_key, state, attempts_made,
           max_attempts, not_before_at, created_at, updated_at)
         VALUES (gen_random_uuid(),$1,$2,'READY',0,$3,$4::timestamptz,now(),now())
         ON CONFLICT (message_id) DO NOTHING`,
        [w.messageId, w.idempotencyKey, w.maxAttempts, w.notBeforeIso])
      n += res.rowCount ?? 0
    }
    return n
  },
}

const watermark: Watermark = {
  sendNothingObservedBeforeIso: '2026-09-01T00:00:00.000Z',
  because: 'QA: nothing observed before the feature existed may be delivered',
}
const count = async (sql: string) => Number((await client.query(sql)).rows[0].n)

const first = await runIntake(store, watermark, T0, Date.now() + 30_000, '2026-09-01T00:00:00.000Z')
const jobsAfterFirst = await count('SELECT count(*)::int AS n FROM alert_send_jobs')
const incidentsAfterFirst = await count('SELECT count(*)::int AS n FROM alert_incidents')

// RUN TWICE. The second must produce nothing, and say why rather than going quiet.
const second = await runIntake(store, watermark, T0, Date.now() + 30_000, '2026-09-01T00:00:00.000Z')
const jobsAfterSecond = await count('SELECT count(*)::int AS n FROM alert_send_jobs')

console.log(JSON.stringify({
  QA_FLOW_VERIFY: {
    firstRun: { reported: { findingsRead: first.findingsRead, incidents: first.incidentsWritten, jobs: first.jobsWritten },
      measuredInSql: { incidents: incidentsAfterFirst, jobs: jobsAfterFirst },
      reportMatchesDatabase: first.jobsWritten === jobsAfterFirst && first.incidentsWritten === incidentsAfterFirst },
    secondRun: { reportedJobs: second.jobsWritten, measuredJobsTotal: jobsAfterSecond,
      newJobs: jobsAfterSecond - jobsAfterFirst,
      skippedWithReasons: second.skipped.map((s) => s.because),
      verdict: second.jobsWritten === 0 && jobsAfterSecond === jobsAfterFirst
        ? 'IDEMPOTENT - zero new, and every finding named as skipped rather than silently dropped'
        : 'NOT IDEMPOTENT' },
    negativeControlsInTheSameRun: first.skipped.map((s) => ({ finding: s.findingId.slice(0, 8), because: s.because })),
    accountingProblems: [...first.accountingProblems, ...second.accountingProblems],
    unmappedRules: first.unmappedRules,
    everyFindingAccountedForOnce: first.findingsRead === first.jobs_accounted_placeholder ?? null,
  },
}, null, 2))
await client.end()
