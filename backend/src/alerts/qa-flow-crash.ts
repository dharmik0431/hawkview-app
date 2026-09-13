// QA — does a crash BETWEEN the incident write and the job write lose the alert forever?
// runIntake writes incidents, then jobs. If they are not one transaction, a failure in between
// leaves an incident that suppresses its own job on every later run.
import pg from 'pg'
import { runIntake, type Dispositions, type PipelineStore, type Watermark } from './finding-pipeline.js'
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
const count = async (t: string) => Number((await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n)

let incidentsCommitted = false
const makeStore = (failOnJobs: boolean): PipelineStore => ({
  async findOpenFindings(sinceIso) {
    const { rows } = await client.query(
      `SELECT id, organization_id, customer_tenant_id, rule_id, subject_type, subject_id, severity, state, observed_at
         FROM identity_risk_findings WHERE state='OPEN' AND observed_at >= $1::timestamptz ORDER BY observed_at, id`, [sinceIso])
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
    const byOrganizationAndRule = new Map<string, string>(); const anyRecipientByOrganization = new Map<string, boolean>()
    if (orgIds.length === 0) return { byOrganizationAndRule, anyRecipientByOrganization }
    const { rows } = await client.query('SELECT organization_id, bool_or(email_enabled) AS any FROM notification_preferences WHERE organization_id = ANY($1::uuid[]) GROUP BY organization_id', [orgIds])
    for (const r of rows) anyRecipientByOrganization.set(r.organization_id, r.any === true)
    return { byOrganizationAndRule, anyRecipientByOrganization }
  },
  async writeIncidents(writes) {
    let n = 0
    for (const w of writes) {
      const res = await client.query(
        `INSERT INTO alert_incidents (id,organization_id,incident_key,alert_type_id,ownership,condition,investigation,ownership_at,condition_at,investigation_at,created_at,updated_at)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz,$7::timestamptz,now(),now())
         ON CONFLICT (organization_id, incident_key) DO NOTHING`,
        [w.organizationId, w.incidentKey, w.alertTypeId, w.ownership, w.condition, w.investigation, w.atIso])
      n += res.rowCount ?? 0
    }
    incidentsCommitted = true
    return n
  },
  async writeJobs(writes) {
    // THE CRASH: the process dies after incidents are committed and before jobs are.
    if (failOnJobs) throw new Error('QA: simulated crash between the two writes')
    let n = 0
    for (const w of writes) {
      const res = await client.query(
        `INSERT INTO alert_send_jobs (id,message_id,idempotency_key,state,attempts_made,max_attempts,not_before_at,created_at,updated_at)
         VALUES (gen_random_uuid(),$1,$2,'READY',0,$3,$4::timestamptz,now(),now()) ON CONFLICT (message_id) DO NOTHING`,
        [w.messageId, w.idempotencyKey, w.maxAttempts, w.notBeforeIso])
      n += res.rowCount ?? 0
    }
    return n
  },
})

const wm: Watermark = { sendNothingObservedBeforeIso: '2026-09-01T00:00:00.000Z', because: 'QA' }
const T0 = '2026-09-12T09:00:00.000Z'
// THE REAL YIELD PATH: the budget expires AFTER incidents are written, which runIntake treats
// as the safe direction and reports as yieldedOnBudget.
const deadline = Date.now() + 30_000
let calls = 0
const clock = () => (incidentsCommitted ? deadline + 1 : Date.now())
const yielded = await runIntake(makeStore(false), wm, T0, deadline, '2026-09-01T00:00:00.000Z', clock)
const crashed = 'yieldedOnBudget=' + yielded.yieldedOnBudget + ' incidentsWritten=' + yielded.incidentsWritten + ' jobsWritten=' + yielded.jobsWritten
const afterCrash = { incidents: await count('alert_incidents'), jobs: await count('alert_send_jobs') }

// THE RECOVERY RUN. A healthy store, same findings. Does the alert ever get a job?
const recovery = await runIntake(makeStore(false), wm, T0, Date.now() + 30_000, '2026-09-01T00:00:00.000Z')
const afterRecovery = { incidents: await count('alert_incidents'), jobs: await count('alert_send_jobs') }

console.log(JSON.stringify({
  QA_FLOW_CRASH: {
    crashedWith: crashed,
    afterCrash,
    recoveryRun: { jobsWritten: recovery.jobsWritten, skipped: recovery.skipped.map((s) => s.because) },
    afterRecovery,
    verdict: afterRecovery.jobs === 0 && afterCrash.incidents > 0
      ? 'LOST — the incident was committed, the job never was, and every later run skips it as already open'
      : afterRecovery.jobs > 0 ? 'RECOVERS — a later run still produces the job' : 'inconclusive',
  },
}, null, 2))
await client.end()
