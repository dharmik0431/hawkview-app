import type { AlertCategory } from './alert-lifecycle.js'

/** What an alert type must declare before it may exist.
 *
 * "An alert type with no stated resolving condition is not ready to be built" is
 * a rule, and rules written only in prose get forgotten. Here every one of them
 * is a required field on a type, so the rule is enforced by the compiler at the
 * moment somebody adds an alert rather than by a reviewer noticing later.
 */

/** SEVERITY IS DEFINED BY REQUIRED ACTION, NOT BY HOW BAD THE EVENT SOUNDS.
 *
 * Today's vocabulary is `info · low · medium · high · critical`, and 301 alerts
 * are marked `high` and have been unread for weeks. A severity nobody acts on is
 * not a severity — it describes the author's feeling about an event rather than
 * what the recipient should do.
 *
 * These names cannot be read that way. Each one is an instruction, and the
 * routing tier follows from it rather than being decided separately. */
export type Severity =
  /** Gets worse while nobody looks, and the action is measured in minutes. */
  | 'ACT_NOW'
  /** Real and worth knowing, and nothing changes between 2am and 8am. */
  | 'ACT_TODAY'
  /** No action attached. A record belongs in a searchable list, not a queue
   * demanding to be cleared. */
  | 'RECORD_ONLY'

/** What evidence would show the condition has stopped.
 *
 * Every member describes something OBSERVED. There is deliberately no member
 * meaning "went quiet": silence is not resolution, and the type should make that
 * impossible to declare rather than merely discouraged. The one member that is
 * about an absence says `IN_READABLE_WINDOW` in its own name, and
 * `applyObservation` will not act on it without readable evidence — so an alert
 * type cannot opt out of the rule by wording its resolving condition carefully.
 */
export type ConditionClearedWhen =
  | Readonly<{ kind: 'COLLECTOR_REPORTS_SUCCESS'; because: string }>
  /** EVERY source this alert covers is readable again — not one of them.
   *
   * Added because the existing members were all too weak for an alert whose
   * claim is "HawkView cannot see this tenant". `CONNECTION_VERIFIED` says the
   * handshake works, which is a weaker claim than the one the alert opened on: a
   * tenant can reconnect with narrower consent, or reconnect cleanly while one
   * collector still returns PERMISSION_REQUIRED. And `COLLECTOR_REPORTS_SUCCESS`
   * is satisfied by ANY one collector succeeding, which is the same partial
   * visibility wearing a different word.
   *
   * The inverse of "cannot see" is "can see all of it". The plural is the whole
   * content of this member, which is why it is in the name. */
  | Readonly<{ kind: 'EVERY_COVERED_SOURCE_READABLE'; because: string }>
  | Readonly<{ kind: 'CONNECTION_VERIFIED'; because: string }>
  | Readonly<{ kind: 'CONFIGURATION_RESTORED'; because: string }>
  | Readonly<{
      kind: 'NO_FURTHER_EVENTS_IN_READABLE_WINDOW'
      /** How long the quiet must last — measured only across time HawkView could
       * actually see. A window during which collection was down does not count. */
      windowHours: number
      because: string
    }>

/** Evidence that CHANGES WHAT THIS IS, rather than adding more of the same.
 *
 * THERE IS NO `OCCURRENCE_COUNT` MEMBER, and that absence is the point. "More of
 * the same" must update quietly; escalation is for evidence of a different
 * character. A rule that let a type escalate on volume would reintroduce the
 * behaviour that produced 301 notifications, one per event.
 *
 * The signals are the ones the plan names: recency, privilege, whether a success
 * followed the failures, corroboration, spread — never the count alone. */
export type EscalationSignal =
  /** The thing the recipient most needs to hear: repeated failures and then a
   * successful sign-in from the same source. A flat "same incident, stay quiet"
   * rule swallows exactly this. */
  | 'SUCCESS_FOLLOWED_FAILURES'
  | 'SUBJECT_HOLDS_PRIVILEGED_ROLE'
  | 'CORROBORATED_BY_SECOND_SOURCE'
  | 'SPREAD_TO_ADDITIONAL_SUBJECTS'
  | 'PERSISTED_BEYOND_EXPECTED_WINDOW'

/** WHOSE incident this is — declared per type, never chosen globally.
 *
 * Both global answers fail, in opposite directions, and the asymmetry is why this
 * is a declaration rather than a constant:
 *
 *   TARGET everywhere  a compromised admin granting roles to twelve accounts
 *                      becomes twelve incidents — the 301 problem rebuilt, at the
 *                      tier that pages, by the step built to prevent it.
 *   ACTOR everywhere   a credential attack has no meaningful actor: the failures
 *                      come from many addresses and often resolve to nothing, so
 *                      every attacked account in a tenant collapses into one
 *                      unknown-actor incident. That HIDES an attack rather than
 *                      duplicating it, which is worse.
 *
 * So the role is part of the type declaration, REQUIRED rather than optional, so
 * the compiler enumerates every type and nothing inherits a default. Same shape as
 * `conditionClears`: a new alert type cannot be added without answering it.
 *
 * THE LOSS, STATED RATHER THAN DISCOVERED: cross-class correlation is unavailable.
 * "Y attacked X on Monday and granted themselves a role on Tuesday" is not
 * expressible by any per-class key. That is real and deferred, not overlooked. */
export type SubjectRole =
  /** The account or resource acted upon. */
  | 'TARGET'
  /** Who performed the change. */
  | 'ACTOR'
  /** An account a finding is ABOUT, rather than one that did something or had
   * something done to it.
   *
   * ADDED FOR STEP 04 AND FLAGGED, not folded in. A Risky Users finding concerns an
   * account nobody has necessarily touched — it is an assessment, not a change. The
   * nearest existing role, TARGET, reads as "the account or resource acted upon", and
   * keying a risk assessment that way would put a true-sounding sentence in the wrong
   * company: a reader seeing TARGET concludes somebody did something to this account,
   * which is precisely what the finding does not claim.
   *
   * MERGING WAS NEVER THE RISK. The role sits in the key beside the type id, and a
   * risky-user rule has its own id, so no choice of role here could have joined these
   * to an audit incident. The risk was the LABEL, which is the half a person reads. */
  | 'ACCOUNT'
  /** No person is involved and the tenant itself is the subject. */
  | 'TENANT'
  /** One specific feed.
   *
   * NOT IN THE ORIGINAL RULING, and the one place this extends it — flagged rather
   * than folded in. The ruling paired "tenant & collector health" under TENANT, but
   * the catalogue splits that across two types: `monitoring.tenant_disconnected`
   * is genuinely tenant-level, and `monitoring.collector_failing` is not. Giving
   * the second one TENANT merges two unrelated collectors failing for two
   * different reasons into one incident, which is the 334-into-15 collapse rebuilt
   * one category over. Two failing collectors are two fixes. */
  | 'COLLECTOR'

export interface EscalationThreshold {
  readonly signal: EscalationSignal
  /** Why this changes what the alert is. Read by a person deciding whether the
   * escalation was justified, so it has to be a sentence rather than a label. */
  readonly because: string
}

/** How long a quiet gap must be before the next activity is a NEW episode.
 *
 * A DIFFERENT FACT FROM THE RESOLVING CONDITION, and that distinction is the whole
 * reason this field exists. "How long until I believe it is over" and "how long a gap
 * means the next activity is a new burst" are genuinely different questions about a
 * type. Stating both is not duplication.
 *
 * The rule against second constants still holds, and the test is whether two numbers
 * mean the SAME thing. For a type resolving on a quiet timeout they do — so that type
 * DERIVES its interval and may not declare one, because two numbers meaning one thing
 * is exactly what drifts. For a type resolving on an OBSERVATION
 * (`CONFIGURATION_RESTORED`, `COLLECTOR_REPORTS_SUCCESS`) there is no timeout to
 * derive from, and a default would be a second constant wearing a disguise:
 * invisible, unreviewed, and no reviewer would ever see it.
 *
 * Both paths are required, neither defaults, and which path a type takes is a COMPILE
 * ERROR to get wrong rather than a convention — see `EpisodeGrouping`. */
export interface EpisodeInterval {
  readonly hours: number
  /** Why this number, including the evidence behind it. A reader revisiting it should
   * see the measurement rather than an assertion — and should be able to tell a
   * MEASURED value from a REASONED one, because those are not the same claim. */
  readonly because: string
}

/** The resolving condition and the episode interval as ONE choice, not two fields.
 *
 * `episodeInterval?: never` on the first variant is the load-bearing part: it makes
 * declaring an interval on a quiet-timeout type a compile error, so "two numbers
 * meaning the same thing" cannot be written at all. The second variant makes omitting
 * one on an observation type a compile error, so no type inherits an interval
 * silently. */
export type EpisodeGrouping =
  | Readonly<{
      conditionClears: Extract<ConditionClearedWhen, { kind: 'NO_FURTHER_EVENTS_IN_READABLE_WINDOW' }>
      /** DERIVED from `windowHours` above. Declaring one here does not compile. */
      episodeInterval?: never
    }>
  | Readonly<{
      conditionClears: Exclude<ConditionClearedWhen, { kind: 'NO_FURTHER_EVENTS_IN_READABLE_WINDOW' }>
      /** Required: there is no timeout to derive from. */
      episodeInterval: EpisodeInterval
    }>

interface AlertTypeBase {
  readonly id: string
  readonly severity: Severity
  /** Whose incident this is. See `SubjectRole` — required so that adding a type
   * forces the question rather than inheriting a default. */
  readonly subject: SubjectRole
  /** The wording a recipient sees. "Suspected", not "confirmed": repeated
   * lockouts are an investigation signal, and they also come from stale
   * credentials on a phone or a misconfigured service account. */
  readonly summary: string
  readonly escalations: readonly EscalationThreshold[]
  /** Whether this type opens an investigation at all.
   *
   * FOUND BY TRYING TO DECLARE THE CATALOGUE, and worth stating because the plan
   * does not resolve it. A routine directory change is a SECURITY-category event
   * with nothing to do about it — and "security investigations may only be closed
   * by a person" would therefore put every routine record into a queue that only
   * a person can empty. That is precisely what produced 301 unclosable `high`
   * alerts nobody ever acted on.
   *
   * So RECORD_ONLY types do not open an investigation. They have an owner and an
   * observed condition and belong in a searchable list, exactly as the plan says
   * a record should. The pairing — RECORD_ONLY if and only if no investigation —
   * is asserted in `alert-catalog.test.ts`, because it is a relationship between
   * two fields rather than a shape a union can express without making every
   * declaration harder to read. */
}

/** OPERATIONAL MAY AUTO-CLOSE. SECURITY MAY NOT — and that is a compile error,
 * not a code review.
 *
 * A collector that succeeds has demonstrably recovered. An account that stopped
 * being attacked has not been shown to be safe. Declaring a SECURITY type that
 * closes itself does not typecheck, so the rule cannot be lost to a careless
 * copy-paste of an operational declaration. */
export type AlertTypeDeclaration =
  /** A record. No investigation is opened, so there is no `investigationCloses`
   * to state — the field is absent rather than set to something meaningless. */
  | (AlertTypeBase & EpisodeGrouping & Readonly<{
      opensInvestigation: false
      category: AlertCategory
    }>)
  | (AlertTypeBase & EpisodeGrouping & Readonly<{
      opensInvestigation: true
      category: Extract<AlertCategory, 'OPERATIONAL'>
      investigationCloses: 'AUTOMATICALLY_WHEN_CONDITION_CLEARS' | 'ONLY_BY_A_PERSON'
    }>)
  | (AlertTypeBase & EpisodeGrouping & Readonly<{
      opensInvestigation: true
      category: Extract<AlertCategory, 'SECURITY'>
      investigationCloses: 'ONLY_BY_A_PERSON'
    }>)

/** The routing tier follows from the severity rather than being chosen
 * separately, so a type cannot claim it needs acting on now and then be filed
 * somewhere nobody looks. Delivery itself is step 06 and 07; this is only the
 * statement of where it belongs. */
export type RoutingTier = 'PHONE' | 'EMAIL' | 'IN_APP'

export function routingTier(severity: Severity): RoutingTier {
  switch (severity) {
    case 'ACT_NOW': return 'PHONE'
    case 'ACT_TODAY': return 'EMAIL'
    case 'RECORD_ONLY': return 'IN_APP'
  }
}

/** Whether the system may close this type's investigation on its own. Derived
 * from the declaration rather than re-decided per call site.
 *
 * False for a record, because there is no investigation to close — which is a
 * different answer from "a person must close it" and should not be confused with
 * it by a caller looking for something to do. */
export function mayAutoClose(declaration: AlertTypeDeclaration): boolean {
  return declaration.opensInvestigation
    && declaration.investigationCloses === 'AUTOMATICALLY_WHEN_CONDITION_CLEARS'
}
