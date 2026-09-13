/* eslint-disable no-console */
/**
 * THE FORECAST. What the first real run would send, before it sends it.
 *
 * D9 turned from a requirement into an instrument. Run it on the day findings first exist, and
 * on any day somebody changes the watermark.
 *
 * IT READS. It does not send, it does not write, and it opens no transaction: the only SQL it
 * issues is SELECT. There is no transport in this build to send through even by accident, but
 * that is a property of today's code rather than of this script, so this script does not lean
 * on it.
 *
 * IT ASKS THE PRODUCT WHAT IT WOULD DO rather than re-deriving it. `decide()` is the same
 * function intake calls, so this forecasts the real behaviour instead of a second opinion that
 * can drift from it. Where a figure CAN be counted independently of that decision it is, and
 * both are printed — a forecast that agrees with itself by construction is not a check.
 *
 * IT REFUSES A MISSING WATERMARK. There is no default, because the default available here is
 * "now", and a forecast from "now" describes a run nobody is going to make.
 */
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client.js'
import {
  alertTypeForRule, asAlertTypeId, decide, dispositionKey,
  type DispositionKey, type Dispositions, type ExistingIncident, type FindingRow,
} from '../src/alerts/finding-pipeline.js'
import { MAX_FINDINGS_PER_TICK } from '../src/alerts/pipeline-store.js'

// IMPORTED, NOT MIRRORED. This was a local 5000 with a comment saying it mirrored the store's
// query — two homes for one bound, and the comment already pointed at a file that no longer
// holds the SQL. A forecast whose limit can drift from the tick's limit forecasts a different
// tick.
const READ_LIMIT = MAX_FINDINGS_PER_TICK
const DEFAULT_WINDOW_HOURS = 24    // mirrors readSinceIso

const watermarkIso = process.env.HAWKVIEW_ALERT_WATERMARK_ISO
if (watermarkIso === undefined || watermarkIso === '' || Number.isNaN(Date.parse(watermarkIso))) {
  console.error('REFUSED. HAWKVIEW_ALERT_WATERMARK_ISO is unset or unparseable.')
  console.error('There is no default. The default available here is "now", and forecasting from')
  console.error('it would describe a run nobody is going to make. Choose the instant first.')
  process.exit(2)
}
const url = process.env.DATABASE_URL
if (url === undefined || url === '') { console.error('DATABASE_URL is not set.'); process.exit(2) }

const hours = Number(process.env.HAWKVIEW_ALERT_READ_WINDOW_HOURS ?? String(DEFAULT_WINDOW_HOURS))
const windowHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 168) : DEFAULT_WINDOW_HOURS
const now = new Date()
const readSinceIso = new Date(now.getTime() - windowHours * 3_600_000).toISOString()

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }) })

const rows = await prisma.$queryRawUnsafe<readonly {
  id: string; organization_id: string; customer_tenant_id: string; rule_id: string
  dedupe_key: string
  subject_type: string; subject_id: string; severity: string; state: string; observed_at: Date
}[]>(
  `SELECT id, organization_id, customer_tenant_id, rule_id, dedupe_key, subject_type, subject_id,
          severity, state, observed_at
     FROM identity_risk_findings
    WHERE state = 'OPEN' AND observed_at >= $1::timestamptz
    ORDER BY observed_at, id
    LIMIT ${READ_LIMIT}`, readSinceIso)

// HOW MANY THE LIMIT IS HIDING, counted separately because the read above cannot see past it.
const totals = await prisma.$queryRawUnsafe<{ total: number }[]>(
  `SELECT count(*)::int AS total FROM identity_risk_findings
    WHERE state = 'OPEN' AND observed_at >= $1::timestamptz`, readSinceIso)
const openInWindow = Number(totals[0]?.total ?? 0)

const findings: FindingRow[] = rows.map((row) => ({
  id: row.id, organizationId: row.organization_id, customerTenantId: row.customer_tenant_id,
  ruleId: row.rule_id, dedupeKey: row.dedupe_key,
  subjectType: row.subject_type, subjectId: row.subject_id,
  severity: row.severity, state: row.state, observedAtIso: row.observed_at.toISOString(),
}))
const organizationIds = [...new Set(findings.map((f) => f.organizationId))]

const existing: ExistingIncident[] = organizationIds.length === 0 ? [] :
  (await prisma.$queryRawUnsafe<{ organization_id: string; incident_key: string }[]>(
    'SELECT organization_id, incident_key FROM alert_incidents WHERE organization_id = ANY($1::uuid[])',
    organizationIds)).map((r) => ({ organizationId: r.organization_id, incidentKey: r.incident_key }))

const byOrganizationAndAlertType = new Map<DispositionKey, string>()
const anyRecipientByOrganization = new Map<string, boolean>()
const unreadable: string[] = []
if (organizationIds.length > 0) {
  // `alert_type_id`, RENAMED FROM `rule_id`, and the key is built by the one function that only
  // accepts an AlertTypeId. A stored value the catalogue does not declare is collected rather
  // than keyed — it is a preference the product cannot act on, and it is printed below rather
  // than silently absent, which is the shape of the bug the rename closed.
  for (const r of await prisma.$queryRawUnsafe<{ organization_id: string; alert_type_id: string; disposition: string }[]>(
    'SELECT organization_id, alert_type_id, disposition FROM alert_rule_dispositions WHERE organization_id = ANY($1::uuid[])',
    organizationIds)) {
    const alertTypeId = asAlertTypeId(r.alert_type_id)
    if (alertTypeId === null) { unreadable.push(r.alert_type_id); continue }
    byOrganizationAndAlertType.set(dispositionKey(r.organization_id, alertTypeId), r.disposition)
  }
  for (const r of await prisma.$queryRawUnsafe<{ organization_id: string; any_recipient: boolean }[]>(
    `SELECT organization_id, bool_or(email_enabled) AS any_recipient FROM notification_preferences
      WHERE organization_id = ANY($1::uuid[]) GROUP BY organization_id`, organizationIds))
    anyRecipientByOrganization.set(r.organization_id, r.any_recipient === true)
}
const dispositions: Dispositions = { byOrganizationAndAlertType, anyRecipientByOrganization, unreadable }

const decision = decide(findings, existing, dispositions,
  { sendNothingObservedBeforeIso: new Date(Date.parse(watermarkIso)).toISOString(),
    because: 'HAWKVIEW_ALERT_WATERMARK_ISO, for a forecast' }, now.toISOString())

// COUNTED INDEPENDENTLY OF decide(), from the catalogue, so the two can be seen to disagree.
const unmappedIndependently = findings.filter((f) => alertTypeForRule(f.ruleId) === null).length
const distinctUnmappedRules = new Set(
  findings.filter((f) => alertTypeForRule(f.ruleId) === null).map((f) => f.ruleId)).size
const jobsByOrganization = new Map<string, number>()
for (const job of decision.jobs) {
  jobsByOrganization.set(job.organizationId, (jobsByOrganization.get(job.organizationId) ?? 0) + 1)
}
const byReason: Record<string, number> = {}
for (const s of decision.skipped) byReason[s.because] = (byReason[s.because] ?? 0) + 1

console.log('')
console.log('  THE GATES THIS FORECAST IS OPERATING UNDER')
console.log(`    watermark        ${watermarkIso}  — nothing observed before this is ever sent`)
console.log(`    read window      ${windowHours}h, so from ${readSinceIso}`)
console.log(`    read limit       ${READ_LIMIT} rows per tick`)
console.log(`    unmapped rules   ${distinctUnmappedRules} distinct in this window, of 6 in the catalogue`)
console.log('')
console.log('  WHAT IS IN THE WINDOW')
console.log(`    ${openInWindow} open findings observed since ${readSinceIso}`)
if (openInWindow > READ_LIMIT) {
  console.log(`    *** ${openInWindow - READ_LIMIT} ARE BEYOND THE ${READ_LIMIT}-ROW LIMIT and would wait for a later tick`)
}
console.log('')
console.log('  WHAT ONE TICK WOULD DO')
console.log(`    ${decision.jobs.length} messages would be SENT`)
console.log(`    ${decision.incidents.length} incidents would be recorded`)
console.log(`    ${decision.notifications.length} in-app notifications would appear in the panel`)
console.log(`    ${decision.skipped.length} findings would be withheld:`)
for (const [reason, count] of Object.entries(byReason).sort()) console.log(`        ${count}  ${reason}`)
console.log('')
console.log('  MESSAGES PER ORGANISATION')
if (jobsByOrganization.size === 0) console.log('    (none)')
for (const [org, count] of [...jobsByOrganization].sort((x, y) => y[1] - x[1])) console.log(`    ${count}  ${org}`)
if (unreadable.length > 0) {
  console.log('')
  console.log('  *** PREFERENCES THIS PRODUCT CANNOT ACT ON')
  console.log('      Stored against an id the catalogue does not declare — most likely written at')
  console.log('      the wrong grain. They are NOT silencing anything, and the MSP believes they are:')
  for (const value of [...new Set(unreadable)].sort()) console.log(`        ${value}`)
}
console.log('')
console.log('  THE SAME FIGURE COUNTED TWICE, so a disagreement is visible')
console.log(`    unmapped, as decide() reports it     : ${byReason.NO_ALERT_TYPE ?? 0}`)
console.log(`    unmapped, counted from the catalogue : ${unmappedIndependently}`)
console.log((byReason.NO_ALERT_TYPE ?? 0) === unmappedIndependently
  ? '    they agree.'
  : '    *** THEY DISAGREE — do not act on this forecast until somebody explains why.')
console.log('')
console.log('NOTHING WAS SENT AND NOTHING WAS WRITTEN. This run issued SELECT statements only.')
await prisma.$disconnect()
