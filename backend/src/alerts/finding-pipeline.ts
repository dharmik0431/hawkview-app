import { ALERT_CATALOG, type AlertTypeId } from './alert-catalog.js'
import { type Severity } from './alert-type.js'
import { type NotificationCategory, type NotificationSeverity }
  from '../notifications/notifications.service.js'
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
  /** The finding's own identity. Needed because the notification row is unique on it — see
   * `notificationFor`. It was not selected at all until the in-app surface existed. */
  readonly dedupeKey: string
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
/** THE KEY A DISPOSITION IS LOOKED UP BY, AND IT IS A TYPE RATHER THAN A CONVENTION.
 *
 * **The measured bug this closes:** the column was called `rule_id`, the pipeline looked it up by
 * ALERT TYPE id, and a disposition stored as `HV-ID-AUTH-010.v1` was silently ignored — the row
 * existed, the write succeeded, the MSP saw their choice saved, and the email went anyway.
 *
 * Renaming the column fixes today's reader. It does not fix next month's, because `alertTypeForRule`
 * lives in this same file: **both vocabularies genuinely exist here and both were `string`**, so
 * nothing made the confusion a compile error. Now the only way to build a key is this function,
 * and it takes an `AlertTypeId`. A rule id does not typecheck.
 *
 * Same move as the claim's row count and the over-long alert type id, and for the same reason:
 * those two are closed rather than watched. */
export type DispositionKey = string & { readonly __dispositionKey: unique symbol }

export const dispositionKey = (organizationId: string, alertTypeId: AlertTypeId): DispositionKey =>
  `${organizationId}|${alertTypeId}` as DispositionKey

/** An alert type id if the catalogue declares one, otherwise null.
 *
 * THE ONLY DOOR FROM A DATABASE STRING TO AN `AlertTypeId`. A stored value the catalogue does not
 * contain is **reported, never defaulted** — see `Dispositions.unreadable`. An unreadable policy
 * must not silently become the catalogue default, because that is a setting the MSP made, ignored
 * without anybody being told. */
export function asAlertTypeId(value: string): AlertTypeId | null {
  return ALERT_CATALOG.some((type) => type.id === value) ? value as AlertTypeId : null
}

export interface Dispositions {
  /** Keyed by `dispositionKey(organizationId, alertTypeId)`, which is the only way to build one.
   * Absent means the catalogue default — nothing is seeded, so a stored row exists only where an
   * MSP has overridden it. */
  readonly byOrganizationAndAlertType: ReadonlyMap<DispositionKey, string>
  /** Stored values that name no alert type in the catalogue, verbatim.
   *
   * **REPORTED, NOT DEFAULTED, AND NOT DROPPED SILENTLY.** A row here is a preference an MSP set
   * that the product cannot act on — historically because it was written at the wrong grain. It
   * surfaces in the intake report so somebody can go and look, rather than becoming the
   * catalogue default and reading as if the MSP had never chosen. */
  readonly unreadable: readonly string[]
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

/** The urgency tier for a notification, derived from its alert type.
 *
 * **THREE ANSWERS, AND THE THIRD IS NOT THE FIRST.** A tier, or `null` for a row that is not an
 * alert at all. `null` is *did not say* — a sync failure, a connection problem, anything with no
 * alert type — and it must never render as `RECORD_ONLY`, which is a decision somebody made to
 * stop being told about a type they had. A silenced alert type and an unconfigured one looking
 * the same is the defect a mutation sweep found by deleting `RECORD_ONLY` and killing nothing.
 *
 * **AN UNRECOGNISED ID IS REPORTED, NOT DEFAULTED.** A stored id the catalogue does not contain
 * comes back as `UNKNOWN_ALERT_TYPE` rather than quietly becoming a tier — an unreadable value is
 * a fact about the data and defaulting it is how a setting somebody made gets silently ignored.
 * That is the same rule the disposition column follows.
 *
 * DERIVED HERE AND RETURNED BY THE API, so the client renders what it is sent. Deriving it again
 * on the client is the same fact in two places with a network hop between them. */
export type NotificationTier =
  | Readonly<{ kind: 'TIER'; tier: Severity }>
  | Readonly<{ kind: 'NOT_AN_ALERT' }>
  | Readonly<{ kind: 'UNKNOWN_ALERT_TYPE'; alertTypeId: string }>

export function alertTierFor(alertTypeId: string | null | undefined): NotificationTier {
  if (alertTypeId === null || alertTypeId === undefined || alertTypeId === '') {
    return { kind: 'NOT_AN_ALERT' }
  }
  const declared = ALERT_CATALOG.find((type) => type.id === alertTypeId)
  return declared === undefined
    ? { kind: 'UNKNOWN_ALERT_TYPE', alertTypeId }
    : { kind: 'TIER', tier: declared.severity }
}

/** A notification row — the thing that makes an incident visible IN THE PRODUCT.
 *
 * **WITHOUT THIS THE BELL SHOWS NOTHING.** `alert_incidents`' own migration header says an
 * incident is *a projection over `notifications`, not a parent of them — the set of rows sharing
 * an incident_key*. The pipeline wrote the incident and the send job and no notification row at
 * all, so every incident was a projection over the EMPTY SET: nothing in the list, nothing in the
 * unread count, and read and dismiss with nothing to act on. An incident with no notification is
 * invisible in-app for exactly the reason an incident with no job was invisible by email.
 *
 * ONE ROW PER FINDING, NOT PER INCIDENT, because that is what the projection means and what the
 * unique constraint allows: `notifications` is unique on `(organization_id, dedupe_key)` and a
 * dedupe key belongs to a finding. Many rows then share one `incident_key`, which is the shape
 * the step-03 work already established.
 *
 * WRITTEN FOR FINDINGS THAT PRODUCE NO SEND, TOO. In-app and email are separate channels: a
 * finding held back by the watermark, by RECORD_ONLY, or by there being nobody to email is still
 * a thing that happened and still belongs in the product. Only the SENDING is withheld. */
export interface NotificationWrite {
  readonly organizationId: string
  readonly customerTenantId: string
  readonly dedupeKey: string
  /** **THE FACT.** Which alert type this row is. The urgency tier is derived from it through
   * `ALERT_CATALOG` — see `alertTierFor` — and never stored beside it. */
  readonly alertTypeId: AlertTypeId
  /** **THE FAMILY, AND THE READER'S SWITCH KEYS ON IT.** `notifications.service.ts` decides which
   * rows a person sees by matching `eventType` against four prefixes — `security.`, anything
   * containing `connection`, anything containing `sync`, `account.` — and gating each on the
   * matching preference. An alert type id is already `security.<something>`, so it lands in the
   * security family and is governed by `securityEnabled`, which defaults true. A value outside
   * those four falls into the *no known family* arm and is always shown. Neither is a guess:
   * both were read out of the filter. */
  readonly eventType: string
  /** RENDERINGS OF `alertTypeId`, not independent facts. Both are derived at write time because
   * the reader's visibility filter matches on them; if either ever disagrees with the alert
   * type, the alert type is right. */
  readonly category: NotificationCategory
  readonly severity: NotificationSeverity
  readonly title: string
  readonly description: string
  readonly incidentKey: string
  readonly atIso: string
}

/** How an alert type's declared urgency reads in the notification list.
 *
 * A `Record` OVER THE CLOSED SEVERITY UNION, so adding a tier to the catalogue is a compile error
 * here rather than a row that quietly takes a default. The last time this feature invented a
 * severity vocabulary the compiler caught it; this is the same protection, kept.
 *
 * ⚠ `critical` IS ALWAYS SHOWN, WHATEVER THE USER'S IN-APP SWITCH SAYS — that is the existing
 * product rule in `visibilityFilter`, not a new one, and mapping ACT_NOW onto it is deliberate:
 * ACT_NOW is the tier that routes to a phone, so a person who muted in-app notifications should
 * still see the one they would have been rung about. Stated because it is a real consequence of
 * a mapping that otherwise looks like decoration. */
const NOTIFICATION_TONE: Readonly<Record<Severity, {
  readonly category: NotificationCategory
  readonly severity: NotificationSeverity
}>> = {
  ACT_NOW: { category: 'error', severity: 'critical' },
  ACT_TODAY: { category: 'warning', severity: 'high' },
  RECORD_ONLY: { category: 'info', severity: 'info' },
}

/** The notification for one finding, or null when the type is not in the catalogue.
 *
 * THE DEDUPE KEY IS NAMESPACED. `notifications` is unique on `(organization_id, dedupe_key)` and
 * that table is shared with the collectors, whose keys look like `tenant:<id>:sync:<resource>`.
 * A bare finding key could in principle collide with one of theirs and silently overwrite it;
 * the prefix makes that impossible. `reconciliation.ts`'s `parseDedupeKey` reads the result as
 * `UNRECOGNISED`, which costs nothing — these rows carry their `incident_key` from birth, so
 * they are never the rows reconciliation has to key. */
export function notificationFor(
  finding: FindingRow,
  alertTypeId: AlertTypeId,
  incidentKey: string,
): NotificationWrite | null {
  const declared = ALERT_CATALOG.find((type) => type.id === alertTypeId)
  if (declared === undefined) return null
  const tone = NOTIFICATION_TONE[declared.severity]
  return {
    organizationId: finding.organizationId,
    customerTenantId: finding.customerTenantId,
    dedupeKey: `identity-risk:${finding.dedupeKey}`,
    alertTypeId,
    // DERIVED FROM THE ALERT TYPE, not chosen here. `event_type` is what the reader's family
    // filter matches against, so for an alert it must BE the alert type id.
    eventType: alertTypeId,
    category: tone.category,
    severity: tone.severity,
    title: declared.summary,
    // The rule and the subject, because a title alone tells somebody an alert type fired and not
    // which account it fired about — and the account is the thing they act on.
    description: `${declared.summary} — ${finding.subjectType.toLowerCase()} ${finding.subjectId} (${finding.ruleId}).`,
    incidentKey,
    atIso: finding.observedAtIso,
  }
}

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
  /** The in-app half. See `NotificationWrite` — without these every incident is a projection
   * over the empty set and the bell shows nothing. */
  readonly notifications: readonly NotificationWrite[]
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
  const notifications: NotificationWrite[] = []
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

    // THE NOTIFICATION IS WRITTEN FIRST AND FOR EVERY FINDING THAT GETS THIS FAR, including one
    // whose incident is already open. An incident is the SET of rows sharing its key, so a second
    // finding on the same incident is a second row rather than nothing — and the `continue` below
    // would otherwise drop it. This is the in-app channel; it is not gated by the watermark, by
    // the disposition or by there being an email recipient, all of which govern SENDING only.
    const notification = notificationFor(finding, alertTypeId, incidentKey)
    if (notification !== null) notifications.push(notification)

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
    const disposition = dispositions.byOrganizationAndAlertType.get(
      dispositionKey(finding.organizationId, alertTypeId)) ?? defaultDispositionFor(alertTypeId)
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
    notifications,
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
  commit(
    incidents: readonly IncidentWrite[],
    notifications: readonly NotificationWrite[],
    jobs: readonly SendJobWrite[],
  ): Promise<Readonly<{ incidentsWritten: number; notificationsWritten: number; jobsWritten: number }>>
}

export interface IntakeReport {
  readonly findingsRead: number
  readonly incidentsWritten: number
  readonly notificationsWritten: number
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
    findingsRead, incidentsWritten: 0, notificationsWritten: 0, jobsWritten: 0, skipped: [], unmappedRules: [],
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
      findingsRead: findings.length, incidentsWritten: 0, notificationsWritten: 0, jobsWritten: 0,
      skipped: decision.skipped, unmappedRules: decision.unmappedRules,
      accountingProblems: decision.accountingProblems, yieldedOnBudget: true,
    }
  }

  const { incidentsWritten, notificationsWritten, jobsWritten } =
    await store.commit(decision.incidents, decision.notifications, decision.jobs)

  return {
    findingsRead: findings.length,
    incidentsWritten,
    notificationsWritten,
    jobsWritten,
    skipped: decision.skipped,
    unmappedRules: decision.unmappedRules,
    accountingProblems: decision.accountingProblems,
    yieldedOnBudget: false,
  }
}
