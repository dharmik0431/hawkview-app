import { ALERT_CATALOG, type AlertTypeId } from './alert-catalog.js'
import { type Severity } from './alert-type.js'
import { type NotificationCategory, type NotificationSeverity }
  from '../notifications/notifications.service.js'
import { OPENED } from './alert-lifecycle.js'
import { incidentGrouping } from './alert-incident-key.js'
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

export type UnreadableDisposition = Readonly<{
  alertTypeId: string
  disposition: string
  because: 'UNKNOWN_ALERT_TYPE' | 'UNKNOWN_DISPOSITION'
}>

export interface Dispositions {
  /** Keyed by `dispositionKey(organizationId, alertTypeId)`, which is the only way to build one.
   * Absent means the catalogue default — nothing is seeded, so a stored row exists only where an
   * MSP has overridden it. */
  readonly byOrganizationAndAlertType: ReadonlyMap<DispositionKey, Severity>
  /** Stored rows the product cannot act on, verbatim and with the reason.
   *
   * **REPORTED, NOT DEFAULTED, AND NOT DROPPED SILENTLY.** Each is a preference an MSP set that
   * has no effect — the catalogue default applies instead — so the harm is entirely that they
   * believe otherwise. It surfaces in the intake report and on the settings endpoint rather than
   * being computed and thrown away.
   *
   * TWO REASONS, KEPT APART. An unknown KEY is what this column held before the rename; an
   * unknown VALUE is what it held before the vocabulary changed. They have different remedies. */
  readonly unreadable: readonly UnreadableDisposition[]
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
export const TYPE_FOR_GUIDANCE: Readonly<Record<GuidanceCode, AlertTypeId | null>> = {
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
 * DERIVED HERE AND RETURNED BY THE API on every notification list item, so the client renders
 * what it is sent. Deriving it again on the client is the same fact in two places with a network
 * hop between them.
 *
 * THIS SENTENCE WAS WRITTEN BEFORE THE CALLER EXISTED. For one commit it asserted a call that was
 * not there, the DTO sent only the legacy five-value severity, and the inbox rendered no badge at
 * all for every alert-backed row. **A comment is a claim: grep for the caller before writing that
 * something is returned by the API.** The fourth zero-caller instance in this feature and the
 * first to assert its own caller in prose. */
export type NotificationTier =
  | Readonly<{ kind: 'TIER'; tier: Severity }>
  | Readonly<{ kind: 'NOT_AN_ALERT' }>
  | Readonly<{ kind: 'UNKNOWN_ALERT_TYPE'; alertTypeId: string }>

export function alertTierFor(
  alertTypeId: string | null | undefined,
  storedSeverity: string,
): NotificationTier {
  if (alertTypeId === null || alertTypeId === undefined || alertTypeId === '') {
    return { kind: 'NOT_AN_ALERT' }
  }
  if (!ALERT_CATALOG.some((type) => type.id === alertTypeId)) {
    return { kind: 'UNKNOWN_ALERT_TYPE', alertTypeId }
  }
  // **FROM THE ROW, NOT FROM THE CATALOGUE, AND THAT IS THE WHOLE CORRECTION.** This read the
  // catalogue's declared severity — so once the EFFECTIVE tier began owning the row's severity,
  // the DTO carried two fields disagreeing about one fact: an MSP who set ACT_TODAY got
  // `severity: 'high'` beside `tier: ACT_NOW`. The derivation was correct and something
  // downstream re-answered the question.
  //
  // The row's severity and its tier are written from ONE value in ONE write, so reading the tier
  // back out of the severity cannot disagree with it. Lossless because the tone map gives the
  // three tiers three distinct severities, which is asserted below rather than assumed.
  const tier = TIER_BY_SEVERITY.get(storedSeverity)
  return tier === undefined
    ? { kind: 'UNKNOWN_ALERT_TYPE', alertTypeId }
    : { kind: 'TIER', tier }
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
 * **IT IS APPLIED TO THE EFFECTIVE TIER**, which is the organisation's disposition where one is
 * set and readable and the catalogue's severity otherwise. One derivation, one owner — so
 * ACT_TODAY on a catalogue-ACT_NOW type renders as `high` rather than `critical`, and an MSP can
 * see their choice took effect.
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

/** The tone table, inverted. Built from it rather than restated, so the two cannot drift. */
const TIER_BY_SEVERITY: ReadonlyMap<string, Severity> = new Map(
  (Object.keys(NOTIFICATION_TONE) as Severity[]).map(
    (tier) => [NOTIFICATION_TONE[tier].severity, tier]))

// IF TWO TIERS EVER RENDER AS ONE SEVERITY, THE INVERSION ABOVE SILENTLY LOSES ONE OF THEM — the
// map would hold whichever came last and a real tier would read back as another. A runtime check
// at module load rather than a comment, because the failure is invisible at the call site.
if (TIER_BY_SEVERITY.size !== Object.keys(NOTIFICATION_TONE).length) {
  throw new Error(
    'NOTIFICATION_TONE maps two tiers to one severity, so a tier cannot be recovered from a row.')
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
  effectiveTier: Severity,
): NotificationWrite | null {
  const declared = ALERT_CATALOG.find((type) => type.id === alertTypeId)
  if (declared === undefined) return null
  // **THE EFFECTIVE TIER, NOT THE CATALOGUE'S.** Written from the catalogue in every case, an
  // MSP who raised urgency had made a choice the product recorded, displayed and never acted on
  // — and one who lowered it still got the row marked critical. Two of the three settings were
  // inert and the third only worked because RECORD_ONLY is also the thing that stops the job.
  const tone = NOTIFICATION_TONE[effectiveTier]
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
 * **IT IS THE CATALOGUE'S DECLARED SEVERITY, UNCHANGED.** The disposition column now holds a
 * tier rather than a channel, so the default is the tier the catalogue already states — not a
 * mapping of it. That removes a second home for the same judgement: previously this ran the
 * severity through `defaultPreference` to get RING or EMAIL, so the stored default and the
 * declared severity were two spellings of one fact with a function between them.
 *
 * `defaultPreference` still exists and is still right — it answers a DIFFERENT question, which
 * is how to reach somebody about a given tier. That is the product's decision; this one is the
 * MSP's.
 *
 * Nothing is stored for a default: absence of a row means this, so the default cannot drift from
 * the tiering the catalogue declares. An id the catalogue does not declare is the quietest
 * answer rather than a guess — but it cannot arise through `decide`, which only reaches here
 * with an id `alertTypeForRule` produced. */
const defaultDispositionFor = (alertTypeId: AlertTypeId): Severity => {
  const declared = ALERT_CATALOG.find((type) => type.id === alertTypeId)
  return declared === undefined ? 'RECORD_ONLY' : declared.severity
}

/** The only door from a stored string to a tier.
 *
 * **THE MAP HOLDS `Severity`, NOT `string`, SO `decide` NEEDS NO GUARD AT ALL.** It had one, and
 * a mutation that removed it killed no test — because the store never puts an unreadable value in
 * the map, so both versions fell back identically and the test was describing the fallback rather
 * than the guard. Narrowing the map's value type removed the guard instead of testing it: an
 * unreadable value is now unwriteable there, and the store reports it. */
export const asDisposition = (value: string): Severity | null =>
  value === 'ACT_NOW' || value === 'ACT_TODAY' || value === 'RECORD_ONLY' ? value : null

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

    // **THE EFFECTIVE TIER, DERIVED ONCE AND USED FOR BOTH DECISIONS.** The notification's
    // severity and whether a job is produced are the same judgement — what this organisation
    // considers this type to be — so they read one value. Computing it twice, or reading the
    // catalogue for one and the disposition for the other, is how two of the three settings
    // ended up inert.
    //
    // An unreadable stored value is not in this map at all — the store collects those into
    // `unreadable` — so the catalogue default applies and the fact is reported rather than
    // silently becoming a tier.
    const effectiveTier: Severity =
      dispositions.byOrganizationAndAlertType.get(
        dispositionKey(finding.organizationId, alertTypeId)) ?? defaultDispositionFor(alertTypeId)

    // THE NOTIFICATION IS WRITTEN FIRST AND FOR EVERY FINDING THAT GETS THIS FAR, including one
    // whose incident is already open. An incident is the SET of rows sharing its key, so a second
    // finding on the same incident is a second row rather than nothing — and the `continue` below
    // would otherwise drop it. This is the in-app channel; it is not gated by the watermark, by
    // the disposition or by there being an email recipient, all of which govern SENDING only.
    const notification = notificationFor(finding, alertTypeId, incidentKey, effectiveTier)
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
    if (effectiveTier === 'RECORD_ONLY') {
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
  /** Stored dispositions whose `alert_type_id` names no declared alert type, verbatim.
   *
   * **A SETTING SOMEBODY MADE THAT THE PRODUCT CANNOT ACT ON.** The store already computes this —
   * see `Dispositions.unreadable` — and until now the list was built and thrown away, so
   * "reported, never defaulted" was true where the disposition VALUE was unreadable and false
   * where its KEY was. One field over from the defect the column rename closed.
   *
   * It does not silence anything: an unreadable key never reaches the lookup, so the catalogue
   * default applies and the alert still goes. The harm is entirely that the MSP believes
   * otherwise. */
  readonly unreadableDispositions: readonly UnreadableDisposition[]
  readonly accountingProblems: readonly string[]
  /** True when the window ran out before the work finished. **THE CASCADE RULE:** intake yields
   * rather than borrowing from what comes after it, because collection outranks alerting always
   * — and a slow intake that ate the collectors' admission budget would show up as tenants
   * quietly not being collected, which reads as the tenants being quiet. */
  readonly yieldedOnBudget: boolean
  /** **MORE FINDINGS EXISTED THAN THE TICK'S CAP.** A tick that read its limit and one that read
   * everything produced the same report, so *we are behind* was not observable. The store reads
   * one row past the cap to answer this without a second query. */
  readonly truncated: boolean
  /** How many chunks were committed. Each is one transaction across all three tables. */
  readonly chunksCommitted: number
  /** Findings this tick did not get to — a yield between chunks, or the cap. Still OPEN, so the
   * next tick redoes exactly them. */
  readonly findingsUnprocessed: number
}

/** Run one tick.
 *
 * `deadlineAt` IS THIS STAGE'S OWN WINDOW, not the request's. It is checked between phases and
 * never inside a write, so yielding leaves the database consistent rather than half-written. */
/** Where a tick was when it failed.
 *
 * **WORK DECLINED AND WORK LOST ARE DIFFERENT FACTS, and a failure that cannot say which phase it
 * was in cannot say how much it lost.** A tick that failed reading has written nothing and knows
 * nothing; a tick that failed WRITING had a decision in hand and lost all of it. Those need
 * different responses and they used to produce the same line. */
export type IntakePhase =
  /** Reading the findings. Nothing has been decided and nothing written. */
  | 'READING'
  /** Loading existing incidents and dispositions. Still nothing written. */
  | 'LOADING'
  /** The commit. **A decision existed and none of it landed** — all three tables or none, so
   * there is no partial state, but the whole tick's work is gone and the findings stay OPEN. */
  | 'WRITING'
  /** **WE DO NOT KNOW.** `runIntake` rejected rather than returning, so it died somewhere no
   * phase guard covers — which today is `decide` and the `findings.length` test, both of which
   * sit AFTER a decision may exist.
   *
   * IT IS HERE BECAUSE THE TYPE COULD NOT SAY IT. The backstop logged `phase: 'UNKNOWN'` and
   * returned `phase: 'READING'`, so a programmatic consumer was told nothing was decided,
   * nothing written and nothing lost — **the most reassuring of the four and, for the path that
   * actually reaches that branch, the least likely to be true.** The comment above it already
   * said UNKNOWN was the honest answer; the log took that advice and the return value could not.
   *
   * A tick reporting this has lost an unknown amount of work. Treat it as WRITING until somebody
   * establishes otherwise, not as READING. */
  | 'UNKNOWN'

/** What the tick was carrying when it failed. Zero before a decision exists. */
export interface AttemptedWork {
  readonly findingsRead: number
  readonly incidents: number
  readonly notifications: number
  readonly jobs: number
}

/** What a tick did, as a value rather than as a report-or-null.
 *
 * **A YIELD AND A FAILURE ARE NOT THE SAME EVENT.** A yield is the system declining work it could
 * not fit inside the window — routine, expected, and it leaves everything reprocessable. A
 * failure is work it attempted and lost. Both leave the findings OPEN, so the next tick redoes
 * them either way, and that similarity is exactly why they must not read alike: an intermittent
 * failure that looks like a yield gets explained away once and never looked at again. */
export type IntakeOutcome =
  | Readonly<{ kind: 'RAN'; report: IntakeReport }>
  | Readonly<{ kind: 'FAILED'; phase: IntakePhase; because: string; attempted: AttemptedWork }>

const NOTHING_ATTEMPTED: AttemptedWork = {
  findingsRead: 0, incidents: 0, notifications: 0, jobs: 0,
}

const failure = (
  phase: IntakePhase, cause: unknown, attempted: AttemptedWork = NOTHING_ATTEMPTED,
): IntakeOutcome => ({
  kind: 'FAILED',
  phase,
  because: cause instanceof Error ? cause.message : String(cause),
  attempted,
})

/** THE FIRST HALF OF THE FIRST-RUN BOUND: how many findings one tick may read at all.
 *
 * A tick reads at most 24 hours of findings (`HAWKVIEW_ALERT_READ_WINDOW_HOURS`) AND at most this
 * many rows. Above this in one window a tick takes the first 5000 by `observed_at` and the rest
 * wait — which is now SAID rather than silent, because the report carries `truncated`.
 *
 * The bound is correct and is not to be removed: an unbounded read inside an admission budget
 * spends a budget shared with collection, and collection outranks alerting.
 *
 * **IT LIVES HERE RATHER THAN IN THE STORE** because the store imports this module and moving it
 * the other way made the import circular — and a constant read during module initialisation on
 * the wrong side of a cycle is `undefined` rather than an error. */
export const MAX_FINDINGS_PER_TICK = 5000

/** How many findings go into ONE transaction.
 *
 * **THE DECLARED BOUND AND THE EFFECTIVE BOUND WERE DIFFERENT NUMBERS.** `MAX_FINDINGS_PER_TICK`
 * is 5000, and the transaction budget was measured exhausting between two and five times below
 * it — 500 and 1000 fine, 2000, 3000 and 5001 all failing with *the timeout was 5000 ms, however
 * 5002 ms passed*. The limit chosen to make the work bounded did not bound it.
 *
 * **AND IT WAS INTERMITTENT, WHICH IS WORSE THAN STUCK.** Three consecutive ticks at 2000 gave 0,
 * then 2000, then 2000: timing decides. A tick that writes nothing and then works on the retry is
 * exactly what gets explained away once and never looked at again.
 *
 * NOT A SMALLER `MAX_FINDINGS_PER_TICK`, because any single constant is a guess about an
 * environment that cannot be measured from here. Those figures come from a loopback socket;
 * production is a container talking to a managed database across a network, and each finding is
 * three round trips — an incident, a notification and a job. **Production is worse, not better,
 * so the direction is the finding and the threshold is not.**
 *
 * SIZED FOR THE SLOW ENVIRONMENT ON PURPOSE. 200 findings is 600 statements, an order of
 * magnitude under the smallest measured failure on the fast one. The cost of it being too small
 * is more transactions; the cost of it being too large is a tick that writes nothing at all.
 */
export const FINDINGS_PER_CHUNK = 200

/** The whole tick, in chunks.
 *
 * **EACH CHUNK IS ONE TRANSACTION ACROSS ALL THREE TABLES**, which is the atomicity the stranding
 * blocker turned on, applied per chunk rather than per tick. The budget is checked BETWEEN
 * chunks and never inside one — the same rule as the original blocker: *a yield may give up work,
 * it may never leave work half done.* Yielding between chunks leaves earlier chunks fully written
 * and later findings entirely untouched and still OPEN, so the next tick resumes along a path
 * already proven.
 *
 * WHAT CARRIES BETWEEN CHUNKS is the set of incident keys already opened. Two findings on one
 * incident can fall in different chunks, and without carrying them the second chunk would decide
 * the incident was new — writing a duplicate the unique index would swallow, and a second job the
 * message id would swallow, while the accounting quietly said two. The database would survive it
 * and the report would lie.
 */
export async function runIntake(
  store: PipelineStore,
  watermark: Watermark,
  tickAtIso: string,
  deadlineAt: number,
  readSinceIso: string,
  now: () => number = Date.now,
): Promise<IntakeOutcome> {
  const empty = (yielded: boolean, findingsRead = 0): IntakeReport => ({
    findingsRead, incidentsWritten: 0, notificationsWritten: 0, jobsWritten: 0, skipped: [],
    unmappedRules: [], unreadableDispositions: [], accountingProblems: [], yieldedOnBudget: yielded,
    truncated: false, chunksCommitted: 0, findingsUnprocessed: 0,
  })
  const ran = (report: IntakeReport): IntakeOutcome => ({ kind: 'RAN', report })
  if (now() >= deadlineAt) return ran(empty(true))

  let read: readonly FindingRow[]
  try {
    read = await store.findOpenFindings(readSinceIso)
  } catch (cause) {
    return failure('READING', cause)
  }

  // **TRUNCATION IS A FACT THE TICK CAN STATE**, because the store reads one row past the cap. A
  // tick that read its limit and a tick that read everything used to produce the same report, so
  // *we are behind* was not observable at all — and the backlog it hides is exactly the shape of
  // the first real load, a collection gap being fixed and producing findings for many tenants at
  // once.
  const truncated = read.length > MAX_FINDINGS_PER_TICK
  const findings = truncated ? read.slice(0, MAX_FINDINGS_PER_TICK) : read
  if (findings.length === 0) return ran({ ...empty(false), truncated })
  if (now() >= deadlineAt) return ran({ ...empty(true, findings.length), truncated })

  const organizationIds = [...new Set(findings.map((each) => each.organizationId))]
  let existing: readonly ExistingIncident[]
  let dispositions: Dispositions
  try {
    [existing, dispositions] = await Promise.all([
      store.findExistingIncidents(organizationIds),
      store.loadDispositions(organizationIds),
    ])
  } catch (cause) {
    return failure('LOADING', cause, { ...NOTHING_ATTEMPTED, findingsRead: findings.length })
  }
  if (now() >= deadlineAt) {
    return ran({ ...empty(true, findings.length), truncated, findingsUnprocessed: findings.length })
  }

  const opened: ExistingIncident[] = [...existing]
  const skipped: Skipped[] = []
  const unmapped = new Set<string>()
  const accountingProblems: string[] = []
  let incidentsWritten = 0
  let notificationsWritten = 0
  let jobsWritten = 0
  let chunksCommitted = 0
  let processed = 0

  for (let at = 0; at < findings.length; at += FINDINGS_PER_CHUNK) {
    // **BETWEEN CHUNKS, NEVER INSIDE ONE.** Checking inside would be the original blocker exactly:
    // a yield partway through a chunk's three writes leaves an incident with no job, which every
    // later run skips as already-open and nothing reports.
    if (now() >= deadlineAt) {
      return ran({
        findingsRead: findings.length,
        incidentsWritten, notificationsWritten, jobsWritten,
        skipped, unmappedRules: [...unmapped].sort(),
        unreadableDispositions: dispositions.unreadable,
        accountingProblems,
        yieldedOnBudget: true,
        truncated,
        chunksCommitted,
        findingsUnprocessed: findings.length - processed,
      })
    }

    const chunk = findings.slice(at, at + FINDINGS_PER_CHUNK)
    const decision = decide(chunk, opened, dispositions, watermark, tickAtIso)

    const attempted: AttemptedWork = {
      findingsRead: chunk.length,
      incidents: decision.incidents.length,
      notifications: decision.notifications.length,
      jobs: decision.jobs.length,
    }
    let written: { incidentsWritten: number; notificationsWritten: number; jobsWritten: number }
    try {
      written = await store.commit(decision.incidents, decision.notifications, decision.jobs)
    } catch (cause) {
      // **THE CHUNKS BEFORE THIS ONE ARE COMMITTED AND STAY COMMITTED.** Only this chunk is lost,
      // and its findings are still OPEN, so the next tick redoes exactly them. That is the whole
      // point of chunking: a failure costs one chunk rather than the tick.
      return failure('WRITING', cause, attempted)
    }

    incidentsWritten += written.incidentsWritten
    notificationsWritten += written.notificationsWritten
    jobsWritten += written.jobsWritten
    skipped.push(...decision.skipped)
    for (const rule of decision.unmappedRules) unmapped.add(rule)
    accountingProblems.push(...decision.accountingProblems)
    // CARRIED FORWARD, so a later chunk knows this incident is already open.
    opened.push(...decision.incidents.map((each) => ({
      organizationId: each.organizationId, incidentKey: each.incidentKey,
    })))
    chunksCommitted += 1
    processed += chunk.length
  }

  return ran({
    findingsRead: findings.length,
    incidentsWritten,
    notificationsWritten,
    jobsWritten,
    skipped,
    unmappedRules: [...unmapped].sort(),
    unreadableDispositions: dispositions.unreadable,
    accountingProblems,
    yieldedOnBudget: false,
    truncated,
    chunksCommitted,
    findingsUnprocessed: findings.length - processed,
  })
}
