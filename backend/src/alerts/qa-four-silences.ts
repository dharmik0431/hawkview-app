// QA — THE ACCEPTANCE TEST FOR THE BLOCKER FIX. Not "did the stranding stop" but "are the three
// deliberate silences still silent". All four shapes that produce incident-with-no-job, seeded
// at once. Exactly ONE job must come out. Four would mean the fix rebuilt the watermark bug.
import pg from 'pg'
import { runIntake, type Dispositions, type IncidentWrite, type PipelineStore,
  type SendJobWrite, type Watermark } from './finding-pipeline.js'

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
let committed = false
let commitCalls = 0

const store: PipelineStore = {
  async findOpenFindings(sinceIso) {
    const { rows } = await client.query(
      `SELECT id, organization_id, customer_tenant_id, rule_id, subject_type, subject_id, severity,
              state, observed_at FROM identity_risk_findings
        WHERE state='OPEN' AND observed_at >= $1::timestamptz ORDER BY observed_at, id`, [sinceIso])
    return rows.map((r) => ({ id: r.id, organizationId: r.organization_id, customerTenantId: r.customer_tenant_id,
      ruleId: r.rule_id, subjectType: r.subject_type, subjectId: r.subject_id, severity: r.severity,
      state: r.state, observedAtIso: new Date(r.observed_at).toISOString() }))
  },
  async findExistingIncidents(orgIds) {
    if (orgIds.length === 0) return []
    const { rows } = await client.query('SELECT organization_id, incident_key FROM alert_incidents WHERE organization_id = ANY($1::uuid[])', [orgIds])
    return rows.map((r) => ({ organizationId: r.organization_id, incidentKey: r.incident_key }))
  },
  async loadDispositions(orgIds): Promise<Dispositions> {
    const byOrganizationAndRule = new Map<string, string>()
    const anyRecipientByOrganization = new Map<string, boolean>()
    if (orgIds.length === 0) return { byOrganizationAndRule, anyRecipientByOrganization }
    const d = await client.query('SELECT organization_id, rule_id, disposition FROM alert_rule_dispositions WHERE organization_id = ANY($1::uuid[])', [orgIds])
    for (const r of d.rows) byOrganizationAndRule.set(`${r.organization_id}|${r.rule_id}`, r.disposition)
    const p = await client.query('SELECT organization_id, bool_or(email_enabled) AS any FROM notification_preferences WHERE organization_id = ANY($1::uuid[]) GROUP BY organization_id', [orgIds])
    for (const r of p.rows) anyRecipientByOrganization.set(r.organization_id, r.any === true)
    return { byOrganizationAndRule, anyRecipientByOrganization }
  },
  async commit(incidents: readonly IncidentWrite[], jobs: readonly SendJobWrite[]) {
    commitCalls += 1
    await client.query('BEGIN')
    let incidentsWritten = 0, jobsWritten = 0
    try {
      for (const w of incidents) {
        const res = await client.query(
          `INSERT INTO alert_incidents (id,organization_id,incident_key,alert_type_id,ownership,condition,investigation,ownership_at,condition_at,investigation_at,created_at,updated_at)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz,$7::timestamptz,now(),now())
           ON CONFLICT (organization_id, incident_key) DO NOTHING`,
          [w.organizationId, w.incidentKey, w.alertTypeId, w.ownership, w.condition, w.investigation, w.atIso])
        incidentsWritten += res.rowCount ?? 0
      }
      for (const w of jobs) {
        const res = await client.query(
          `INSERT INTO alert_send_jobs (id,message_id,idempotency_key,state,attempts_made,max_attempts,not_before_at,created_at,updated_at)
           VALUES (gen_random_uuid(),$1,$2,'READY',0,$3,$4::timestamptz,now(),now()) ON CONFLICT (message_id) DO NOTHING`,
          [w.messageId, w.idempotencyKey, w.maxAttempts, w.notBeforeIso])
        jobsWritten += res.rowCount ?? 0
      }
      await client.query('COMMIT')
      committed = true
    } catch (e) { await client.query('ROLLBACK'); throw e }
    return { incidentsWritten, jobsWritten }
  },
}

const wm: Watermark = { sendNothingObservedBeforeIso: '2026-09-01T00:00:00.000Z', because: 'QA' }
const T0 = '2026-09-12T09:00:00.000Z'
const READ_SINCE = '2026-01-01T00:00:00.000Z'   // read everything, so the watermark decides, not the query
const n = async (t: string) => Number((await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n)

// PHASE 1 — a yield that would previously have stranded: after decide, before commit.
const deadline = Date.now() + 30_000
const report0 = await runIntake(store, wm, T0, deadline, READ_SINCE, () => (commitCalls === 0 && committed === false ? deadline + 1 : Date.now()))
const afterYield = { incidents: await n('alert_incidents'), jobs: await n('alert_send_jobs'), stillOpen: await n("identity_risk_findings WHERE state='OPEN'") }

// PHASE 2 — run to completion.
const report = await runIntake(store, wm, T0, Date.now() + 30_000, READ_SINCE)
const after = { incidents: await n('alert_incidents'), jobs: await n('alert_send_jobs') }
const jobRows = (await client.query('SELECT message_id FROM alert_send_jobs')).rows.map((r) => r.message_id)

console.log(JSON.stringify({
  QA_FOUR_SILENCES: {
    phase1_yieldBeforeCommit: { yieldedOnBudget: report0.yieldedOnBudget, ...afterYield,
      verdict: afterYield.incidents === 0 && afterYield.jobs === 0 && afterYield.stillOpen === 4
        ? 'UNTOUCHED — the yield left the findings entirely alone and still OPEN' : 'SPLIT' },
    phase2_runToCompletion: {
      findingsRead: report.findingsRead, incidentsWritten: report.incidentsWritten, jobsWritten: report.jobsWritten,
      skipped: report.skipped.map((s) => s.because).sort(),
      accountingProblems: report.accountingProblems,
      measured: after,
      jobsAre: jobRows,
      verdict: after.jobs === 1
        ? 'EXACTLY ONE — the three deliberate silences are still silent'
        : `WRONG: ${after.jobs} jobs — a fix that cannot tell the four apart`,
    },
  },
}, null, 2))
await client.end()
