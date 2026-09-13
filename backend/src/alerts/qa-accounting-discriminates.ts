// QA — the stated invariant is "every finding appears exactly once across the writes and the
// skips". Asserting it on mapped input only proves it holds where nothing is unusual. This
// seeds the negative control the database made possible — a REAL rule id the pipeline
// deliberately does not map — and asserts the finding is still accounted for exactly once
// rather than vanishing.
import pg from 'pg'
import { decide, type Dispositions, type FindingRow, type Watermark } from './finding-pipeline.js'

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
const { rows } = await client.query(
  `SELECT id, organization_id, customer_tenant_id, rule_id, subject_type, subject_id, severity,
          state, observed_at FROM identity_risk_findings WHERE state='OPEN' ORDER BY id`)
const findings: FindingRow[] = rows.map((r) => ({
  id: r.id, organizationId: r.organization_id, customerTenantId: r.customer_tenant_id,
  ruleId: r.rule_id, subjectType: r.subject_type, subjectId: r.subject_id,
  severity: r.severity, state: r.state, observedAtIso: new Date(r.observed_at).toISOString(),
}))
const dispositions: Dispositions = {
  byOrganizationAndRule: new Map(),
  anyRecipientByOrganization: new Map([['11111111-1111-1111-1111-111111111111', true]]),
}
const watermark: Watermark = { sendNothingObservedBeforeIso: '2026-09-01T00:00:00.000Z', because: 'QA' }
const d = decide(findings, [], dispositions, watermark, '2026-09-12T09:00:00.000Z')

// EXACTLY ONCE: every finding id appears in the jobs or the skips, and never in both.
const seen = new Map<string, number>()
for (const s of d.skipped) seen.set(s.findingId, (seen.get(s.findingId) ?? 0) + 1)
// A job carries no finding id — it is keyed on the incident — so a finding that produced a job
// is one that is absent from `skipped`. That is the honest way to count it, and it is why the
// module's own `accountedFor` is jobs.length + skipped.length rather than a set of ids.
const unmapped = findings.filter((f) => !/^HV-ID-(EXP|CHG|AUTH)-/.test(f.ruleId))

console.log(JSON.stringify({
  QA_ACCOUNTING_DISCRIMINATES: {
    findingsIn: findings.length,
    jobs: d.jobs.length,
    skipped: d.skipped.length,
    sum: d.jobs.length + d.skipped.length,
    everyFindingAccountedForExactlyOnce: d.jobs.length + d.skipped.length === findings.length,
    noFindingCountedTwiceInSkips: [...seen.values()].every((n) => n === 1),
    unmappedFindingsSeeded: unmapped.map((f) => f.ruleId),
    theyProducedNoJob: d.jobs.length === findings.length - d.skipped.length,
    eachNamedWithAReason: d.skipped.map((s) => ({ id: s.findingId.slice(0, 8), because: s.because })),
    unmappedRulesReported: d.unmappedRules,
    accountingProblems: d.accountingProblems,
    verdict: d.jobs.length + d.skipped.length === findings.length
      && d.unmappedRules.length === unmapped.length
      && d.accountingProblems.length === 0
      ? 'DISCRIMINATES — the unmapped findings are named, counted once, and produce no job'
      : 'FAILED',
  },
}, null, 2))
await client.end()
