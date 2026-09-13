import { ALERT_CATALOG, type AlertTypeId } from './alert-catalog.js'
import { OPENED } from './alert-lifecycle.js'
import { incidentGrouping } from './alert-incident-key.js'
import { defaultPreference } from './routing-policy.js'
import { IDENTITY_RISK_RULE_CATALOG, type IdentityRiskRulePresentation, type IdentityRiskRuleId }
  from '../identity-risk/identity-risk.catalog.js'

/** The catalogue's own closed set of investigation kinds. Imported as a type rather than
 * restated, so a fifth kind is a compile error here rather than a silent fall-through. */
type GuidanceCode = IdentityRiskRulePresentation['investigationGuidanceCode']

/**
 * THE WIRING. A persisted finding becomes an incident, and an incident becomes a send job.
 *
 * Everything before this was a library nobody called: three migrations, twenty modules, all
 * pure, and nothing joining them. This is the join.
 *
 * PURE CORE, THIN EDGE. `decide` takes rows and returns writes; `runIntake` does the I/O. The
 * end-to-end test drives the second against a real database, so the hops are proven together
 * rather than each one being proven alone — which is what a shelf of green unit tests already
 * was.
 */

// ---------------------------------------------------------------------------------------
// NO HISTORICAL SENDS. The record is backfilled; the sending is not.
// ---------------------------------------------------------------------------------------

/** Findings observed before this produce an INCIDENT but never a SEND JOB.
 *
 * THE SAME RULE THE MIGRATION FOLLOWS, for the same reason. Step 03 annotates rows rather than
 * re-delivering them, because proving a pipeline must not page somebody about something that
 * happened last month. Turning this on against a table with history in it and no watermark
 * would send the entire backlog at once — to a real MSP, about real incidents, all of them
 * stale, and there is no recalling an email.
 *
 * IT IS A REQUIRED PARAMETER WITH NO DEFAULT. A default here is the difference between a quiet
 * first run and an inbox with three hundred messages in it, and no value is safe enough to pick
 * on somebody's behalf. */
export interface Watermark {
  readonly sendNothingObservedBeforeIso: string
  /** Why this instant. Recorded because a watermark somebody cannot explain is one nobody dares
   * move. */
  readonly because: string
}

// ---------------------------------------------------------------------------------------
// WHAT COMES IN
// ---------------------------------------------------------------------------------------

/** A finding as stored, reduced to what the pipeline reads. */
export interface FindingRow {
  readonly id: string
  readonly organizationId: string
  readonly customerTenantId: string
  readonly ruleId: string
  readonly subjectType: string
  readonly subjectId: string
  readonly severity: string
  readonly state: string
  readonly observedAtIso: string
}

/** An incident row that already exists, so a second run does not re-open it. */
export interface ExistingIncident {
  readonly organizationId: string
  readonly incidentKey: string
}

/** What an MSP has said about a rule, and what a person has said about being emailed. Two
 * grains, two stores, two different facts — see the migration. */
export interface Dispositions {
  /** `organizationId|ruleId` → disposition. Absent means the catalogue default. */
  readonly byOrganizationAndRule: ReadonlyMap<string, string>
  /** `organizationId` → whether ANY user there can receive email. */
  readonly anyRecipientByOrganization: ReadonlyMap<string, boolean>
}

// ---------------------------------------------------------------------------------------
// THE RULE MAP, DERIVED FROM WHAT THE CATALOGUE DECLARES
// ---------------------------------------------------------------------------------------

/** Which catalogue alert type a risk rule becomes.
 *
 * **DERIVED FROM `investigationGuidanceCode`, NOT FROM THE RULE ID.** Two earlier versions of
 * this were wrong in two different ways, and both would have shipped:
 *
 * 1. It matched prefixes like `identity.credential`, a namespace no row can have — the real ids
 *    are constrained to `HV-ID-{EXP,CHG,APP,MBX,AUTH}-NNN`. Every production finding would have
 *    reported as unmappable. Found by the integration test refusing to seed.
 * 2. It then matched the real three-letter families, and **guessed their meaning from the
 *    letters**. `HV-ID-EXP-001.v1` is *"Privileged identity has an MFA enforcement gap"* — EXP
 *    is EXPOSURE, not expiring — so an entire family would have routed as
 *    `monitoring.consent_expiring`, which is a different thing entirely.
 *
 * The second is the more instructive: it was consistent, total over the real vocabulary, and
 * wrong. A three-letter abbreviation is not a specification.
 *
 * SO IT READS THE FIELD THE CATALOGUE ACTUALLY DECLARES. Every rule carries exactly one
 * `investigationGuidanceCode`, and the mapping is total over those FOUR values rather than over
 * twenty-four rule ids — so **a twenty-fifth rule inherits its kind rather than falling through
 * a gap nobody notices**, and the compiler demands a decision if a fifth code is ever added.
 *
 * TWO OF THE FOUR ARE DELIBERATE REFUSALS. A configuration change is exactly the privileged-or-
 * routine question the classifier exists to answer, and defaulting it here would file a real
 * privileged change as whatever this file guessed — the same refusal step 03 makes. A mailbox
 * rule has no catalogue type at all. Both report as unmapped. */
const TYPE_FOR_GUIDANCE: Readonly<Record<GuidanceCode, AlertTypeId | null>> = {
  REVIEW_ACTIVITY: 'security.suspected_credential_attack',
  REVIEW_ACCESS: 'security.privileged_directory_change',
  REVIEW_CONFIGURATION: null,
  REVIEW_MAILBOX_RULE: null,
}

/** Null for a rule the catalogue does not declare, and for a declared rule whose kind has no
 * alert type. Both are reported rather than defaulted; they differ only in what somebody has to
 * do about it. */
export function alertTypeForRule(ruleId: string): AlertTypeId | null {
  const declared = IDENTITY_RISK_RULE_CATALOG[ruleId as IdentityRiskRuleId] as
    | { investigationGuidanceCode: GuidanceCode }
    | undefined
  return declared === undefined ? null : TYPE_FOR_GUIDANCE[declared.investigationGuidanceCode]
}

// ---------------------------------------------------------------------------------------
// WHAT GOES OUT
// ---------------------------------------------------------------------------------------

export interface IncidentWrite {
  readonly organizationId: string
  readonly incidentKey: string
  readonly alertTypeId: AlertTypeId
  readonly ownership: string
  readonly condition: string
  readonly investigation: string
  readonly atIso: string
}

export interface SendJobWrite {
  readonly messageId: string
  readonly idempotencyKey: string
  readonly organizationId: string
  readonly incidentKey: string
  readonly maxAttempts: number
  readonly notBeforeIso: string
}

/** Why a finding produced no send job. **EVERY FINDING APPEARS EXACTLY ONCE** across the writes
 * and these — a finding that simply vanished is the silence this whole feature is about. */
export type Skipped = Readonly<{
  findingId: string
  because:
    | 'NOT_OPEN'
    | 'NO_ALERT_TYPE'
    | 'BEFORE_WATERMARK'
    | 'INCIDENT_ALREADY_OPEN'
    | 'NO_ELIGIBLE_RECIPIENT'
    | 'RECORD_ONLY'
}>

export interface PipelineDecision {
  readonly incidents: readonly IncidentWrite[]
  readonly jobs: readonly SendJobWrite[]
  readonly skipped: readonly Skipped[]
  /** Distinct rule ids nothing could type. A count of findings is not enough — the rule id is
   * what somebody has to go and add. */
  readonly unmappedRules: readonly string[]
  /** Empty when every finding is accounted for exactly once. */
  readonly accountingProblems: readonly string[]
}

/** The default disposition for a type, when an MSP has expressed no preference.
 *
 * THROUGH `defaultPreference`, WHICH ALREADY OWNS THIS. The first version of this invented its
 * own severity vocabulary - CRITICAL and HIGH, which the catalogue does not have - and the
 * compiler refused it, because `Severity` is ACT_NOW | ACT_TODAY | RECORD_ONLY. Reading the
 * field at its declared type made the wrong constant impossible, and it caught a second
 * implementation of a mapping routing already states.
 *
 * Nothing is stored for a default: absence of a row means this, so the default cannot drift
 * from the tiering the catalogue declares. */
const defaultDispositionFor = (alertTypeId: AlertTypeId): string => {
  const declared = ALERT_CATALOG.find((type) => type.id === alertTypeId)
  return declared === undefined ? 'RECORD_ONLY' : defaultPreference(declared.severity)
}

/** The whole decision, pure. */
export function decide(
  findings: readonly FindingRow[],
  existing: readonly ExistingIncident[],
  dispositions: Dispositions,
  watermark: Watermark,
  tickAtIso: string,
): PipelineDecision {
  const open = new Set(existing.map((each) => `${each.organizationId}|${each.incidentKey}`))
  const incidents: IncidentWrite[] = []
  const jobs: SendJobWrite[] = []
  const skipped: Skipped[] = []
  const unmapped = new Set<string>()
  const watermarkAt = Date.parse(watermark.sendNothingObservedBeforeIso)

  for (const finding of findings) {
    if (finding.state !== 'OPEN') {
      skipped.push({ findingId: finding.id, because: 'NOT_OPEN' })
      continue
    }
    const alertTypeId = alertTypeForRule(finding.ruleId)
    if (alertTypeId === null) {
      unmapped.add(finding.ruleId)
      skipped.push({ findingId: finding.id, because: 'NO_ALERT_TYPE' })
      continue
    }

    const grouping = incidentGrouping(
      { id: alertTypeId, subject: 'ACCOUNT' } as never,
      { organizationId: finding.organizationId, customerTenantId: finding.customerTenantId },
      { resolved: true, id: finding.subjectId })
    const incidentKey = grouping.groups ? grouping.key : `ungrouped:${finding.id}`
    const scoped = `${finding.organizationId}|${incidentKey}`

    // THE INCIDENT IS WRITTEN EVEN FOR HISTORY. The record is what makes the backlog visible in
    // the product; only the SENDING is withheld.
    if (!open.has(scoped)) {
      incidents.push({
        organizationId: finding.organizationId,
        incidentKey,
        alertTypeId,
        ownership: OPENED.ownership,
        condition: OPENED.condition,
        investigation: OPENED.investigation,
        atIso: finding.observedAtIso,
      })
      open.add(scoped)
    } else {
      skipped.push({ findingId: finding.id, because: 'INCIDENT_ALREADY_OPEN' })
      continue
    }

    if (Date.parse(finding.observedAtIso) < watermarkAt) {
      skipped.push({ findingId: finding.id, because: 'BEFORE_WATERMARK' })
      continue
    }
    const disposition = dispositions.byOrganizationAndRule.get(`${finding.organizationId}|${alertTypeId}`)
      ?? defaultDispositionFor(alertTypeId)
    if (disposition === 'RECORD_ONLY') {
      skipped.push({ findingId: finding.id, because: 'RECORD_ONLY' })
      continue
    }
    // COVERAGE GAP SHOWN RATHER THAN SILENT. An organisational urgency with nobody able to
    // receive it is not "no email needed" — it is an incident nobody will be told about, and it
    // has to be visible where the two grains meet.
    if (dispositions.anyRecipientByOrganization.get(finding.organizationId) !== true) {
      skipped.push({ findingId: finding.id, because: 'NO_ELIGIBLE_RECIPIENT' })
      continue
    }

    jobs.push({
      // ONE MESSAGE PER INCIDENT, and the id is derived from the incident rather than from the
      // finding — so a second finding on the same incident cannot produce a second email.
      messageId: `incident/${scoped}`,
      idempotencyKey: `incident/${scoped}`,
      organizationId: finding.organizationId,
      incidentKey,
      maxAttempts: 3,
      notBeforeIso: tickAtIso,
    })
  }

  const accountedFor = jobs.length + skipped.length
  return {
    incidents,
    jobs,
    skipped,
    unmappedRules: [...unmapped].sort(),
    accountingProblems: accountedFor === findings.length ? [] : [
      `${findings.length} findings in, ${accountedFor} accounted for (${jobs.length} produced a `
      + `job, ${skipped.length} named as skipped) — a finding must appear exactly once, or one `
      + 'vanished without anybody being able to say why.',
    ],
  }
}

// ---------------------------------------------------------------------------------------
// THE EDGE. Real reads, real writes, and a bounded window.
// ---------------------------------------------------------------------------------------

/** The narrow slice of Prisma this needs. An interface rather than the client, so the pipeline
 * can be driven by a transaction, by the client, or by a fake, and so nothing here can reach for
 * a model it was not given. */
export interface PipelineStore {
  findOpenFindings(sinceIso: string): Promise<readonly FindingRow[]>
  findExistingIncidents(organizationIds: readonly string[]): Promise<readonly ExistingIncident[]>
  loadDispositions(organizationIds: readonly string[]): Promise<Dispositions>
  /** BOTH WRITES OR NEITHER, IN ONE TRANSACTION. They were two calls, and a budget yield
   * between them left an incident with no job — which the next run skips as
   * `INCIDENT_ALREADY_OPEN`, so the alert is never sent and nothing reports it. `neverSent`
   * covers jobs that exist, and this incident has none.
   *
   * A crash between the two writes strands an alert identically, and no logic inside
   * `runIntake` can catch that one. The seam had to change; a recovery path could not have
   * fixed it. */
  commit(incidents: readonly IncidentWrite[], jobs: readonly SendJobWrite[]):
    Promise<Readonly<{ incidentsWritten: number; jobsWritten: number }>>
}

export interface IntakeReport {
  readonly findingsRead: number
  readonly incidentsWritten: number
  readonly jobsWritten: number
  readonly skipped: readonly Skipped[]
  readonly unmappedRules: readonly string[]
  readonly accountingProblems: readonly string[]
  /** True when the window ran out before the work finished. **THE CASCADE RULE:** intake yields
   * rather than borrowing from what comes after it, because collection outranks alerting always
   * — and a slow intake that ate the collectors' admission budget would show up as tenants
   * quietly not being collected, which reads as the tenants being quiet. */
  readonly yieldedOnBudget: boolean
}

/** Run one tick.
 *
 * `deadlineAt` IS THIS STAGE'S OWN WINDOW, not the request's. It is checked between phases and
 * never inside a write, so yielding leaves the database consistent rather than half-written. */
export async function runIntake(
  store: PipelineStore,
  watermark: Watermark,
  tickAtIso: string,
  deadlineAt: number,
  readSinceIso: string,
  now: () => number = Date.now,
): Promise<IntakeReport> {
  const empty = (yielded: boolean, findingsRead = 0): IntakeReport => ({
    findingsRead, incidentsWritten: 0, jobsWritten: 0, skipped: [], unmappedRules: [],
    accountingProblems: [], yieldedOnBudget: yielded,
  })
  if (now() >= deadlineAt) return empty(true)

  const findings = await store.findOpenFindings(readSinceIso)
  if (findings.length === 0) return empty(false)
  if (now() >= deadlineAt) return empty(true, findings.length)

  const organizationIds = [...new Set(findings.map((each) => each.organizationId))]
  const [existing, dispositions] = await Promise.all([
    store.findExistingIncidents(organizationIds),
    store.loadDispositions(organizationIds),
  ])
  if (now() >= deadlineAt) return empty(true, findings.length)

  const decision = decide(findings, existing, dispositions, watermark, tickAtIso)
  // THE BUDGET IS CHECKED HERE, BEFORE THE WRITE PHASE, AND NOT AGAIN INSIDE IT.
  //
  // WHAT THIS LINE USED TO SAY, AND WHY IT WAS WRONG. There were two writes with a check
  // between them, and the comment called yielding there "the safe direction" because it left
  // incidents recorded and no job. **It was the permanently silent direction.** An incident
  // with no job is skipped by the next run as `INCIDENT_ALREADY_OPEN`, so the email is never
  // sent — and nothing reports it, because `neverSent` reports jobs that stopped and this
  // alert never had one. Measured: yield gives 1 incident / 0 jobs, the next healthy run adds
  // nothing, and the database sits there forever.
  //
  // It is not a rare crash path. It is the designed cascade behaviour firing exactly when the
  // system is busiest, which is when an alert matters most.
  //
  // A YIELD MAY GIVE UP WORK; IT MAY NEVER LEAVE WORK HALF DONE. Yielding here leaves the
  // finding untouched and still OPEN, so the next run redoes it from the top along a path that
  // is already proven — rather than a recovery path that would have to reconstruct intent it
  // never recorded. And it could not: FOUR paths produce "incident open, no job", and three of
  // them withhold the job ON PURPOSE. A recovery that could not tell them apart would deliver
  // every incident the watermark silenced.
  if (now() >= deadlineAt) {
    return {
      findingsRead: findings.length, incidentsWritten: 0, jobsWritten: 0,
      skipped: decision.skipped, unmappedRules: decision.unmappedRules,
      accountingProblems: decision.accountingProblems, yieldedOnBudget: true,
    }
  }

  const { incidentsWritten, jobsWritten } = await store.commit(decision.incidents, decision.jobs)

  return {
    findingsRead: findings.length,
    incidentsWritten,
    jobsWritten,
    skipped: decision.skipped,
    unmappedRules: decision.unmappedRules,
    accountingProblems: decision.accountingProblems,
    yieldedOnBudget: false,
  }
}
