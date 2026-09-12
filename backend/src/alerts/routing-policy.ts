/** STEP 05: routing, recipients and policy. Types first, wiring after QA pre-registers.
 *
 * The product decision this hangs on: MSPs choose what they are alerted on, and our tiering is
 * the DEFAULT, NOT THE LAW. A privileged role grant can ring a phone at 2am or sit in a digest
 * — that is the MSP's call. The twenty rule identifiers made a wire contract in step 01 are
 * the grain that makes it sayable: "role grants ring me, application permissions go to the
 * digest" needs those to be separate names rather than one category.
 *
 * Two of the three guardrails are built here as TYPES rather than as rules, because a rule is
 * something a later code path routes around:
 *
 *   1. SILENCING A NOTIFICATION NEVER SILENCES THE RECORD — there is no preference value that
 *      means "off", and the record is not an output a preference can address.
 *   2. ONE CAUSE IS ONE MESSAGE PER MSP — a delivery has no tenant field to vary, so a
 *      per-tenant fan-out is not something you can write.
 *
 * Written without reading QA's step-05 reference, for the reason that held in step 04: a
 * pre-registration is only independent if it was not the specification I built from, and a
 * helpful example contaminates exactly as thoroughly as a bug.
 */

import { joinUnambiguously } from './alert-key-encoding.js'
import { alertType, type AlertTypeId } from './alert-catalog.js'
import type { AlertCategory } from './alert-lifecycle.js'
import type { RoutingTier, Severity } from './alert-type.js'

/** How loudly an MSP wants to hear about one rule.
 *
 * THERE IS NO `OFF`, AND THAT IS THE FIRST GUARDRAIL. Any rule can be turned down to
 * record-only; no rule can be made not-recorded. Expressed as a missing enum member rather
 * than as a validation, because a validation is a thing a later code path can skip and an
 * absent value is not a thing anyone can select.
 *
 * The floor is the quietest setting that exists, and it still produces a record. An MSP that
 * wants to hear nothing about a rule gets exactly that — and HawkView still knows, so the
 * question "why was I not told" has an answer six months later. */
export type DeliveryPreference =
  /** Wake somebody. */
  | 'RING'
  /** Reaches a person the same day. */
  | 'EMAIL'
  /** Batched into the periodic digest. */
  | 'DIGEST'
  /** No delivery at all. STILL RECORDED — see `RoutedRecord`. */
  | 'RECORD_ONLY'

/** What HawkView does by default, before an MSP expresses any preference.
 *
 * DERIVED FROM THE DECLARED SEVERITY rather than chosen per rule, so the default cannot drift
 * from the tiering the catalogue already states. An MSP overriding it is expressing a
 * preference; HawkView disagreeing with itself is a bug. */
export function defaultPreference(severity: Severity): DeliveryPreference {
  switch (severity) {
    case 'ACT_NOW': return 'RING'
    case 'ACT_TODAY': return 'EMAIL'
    case 'RECORD_ONLY': return 'RECORD_ONLY'
  }
}

/** Who hears about it.
 *
 * NEVER A CUSTOMER END USER, and that is why this carries a verification state rather than an
 * address. A customer end user has no relationship with HawkView and did not ask to hear from
 * it; a type that accepts any string invites one to be typed in. */
/** A recipient we can actually reach. */
export type VerifiedRecipient =
  | Readonly<{
      kind: 'MSP_SECURITY_INBOX'
      /** Verified, and the verification is the point — an unverified inbox is a guess about
       * who is listening. */
      address: string
      verifiedAt: Date
    }>
  | Readonly<{
      kind: 'DESIGNATED_OWNER'
      userId: string
      address: string
      verifiedAt: Date
    }>

/** A recipient, INCLUDING the honest refusal.
 *
 * `NONE_VERIFIED` is right to have — it is what a settings screen renders when nobody is
 * listening — and it is deliberately NOT assignable to a `Delivery`. It is a fact about
 * configuration, not a destination. */
export type Recipient =
  | VerifiedRecipient
  | Readonly<{ kind: 'NONE_VERIFIED'; because: string }>

/** When a delivery may go out.
 *
 * QUIET HOURS DEFER, THEY NEVER DROP. `HELD` carries the time it will go, so "you will hear
 * about this at 07:00" is sayable; there is no variant meaning "discarded because it was
 * inconvenient". An MSP can name types that always ring, and that list DEFAULTS TO EMPTY so
 * the choice is made rather than inherited. */
export type DeliveryTiming =
  | Readonly<{ kind: 'IMMEDIATE' }>
  | Readonly<{
      kind: 'HELD'
      until: Date
      /** In words, for the person who will ask why it was late. */
      because: string
    }>

/** One message to one MSP about one cause.
 *
 * NO TENANT FIELD, AND THAT IS THE SECOND GUARDRAIL. A fleet-wide collector failure is ONE
 * cause; at 100 MSPs by 15 tenants, one message per tenant is 1,500 messages from a single
 * incident, and that is the failure that destroys the channel on its first bad day.
 *
 * So a delivery is addressed to an ORGANISATION and carries the affected tenants as a list.
 * There is no per-tenant delivery to construct — not a limit applied afterwards, which is a
 * thing that can be bypassed, but an absence of the field you would have to vary. Coalescing
 * cannot be forgotten because un-coalesced is not expressible. */
export interface Delivery {
  readonly organizationId: string
  /** What makes these one message. See `causeKeyOf`. */
  readonly causeKey: string
  readonly tier: RoutingTier
  readonly timing: DeliveryTiming
  /** VERIFIED ONLY. A delivery to nobody is not a delivery, and while this took the full
   * `Recipient` union it could carry `NONE_VERIFIED` — so an organisation with no inbox
   * produced an entry in `delivered` that satisfied the accounting identity and read as
   * served. The bucket was honest and silence got in through a field inside it, which is
   * the same shape as every other finding in this feature. See `RoutingOutcome.unroutable`. */
  readonly recipient: VerifiedRecipient
  /** Which tick produced this, so "one delivery per cause per MSP per TICK" is checkable.
   * Without it the fan-out invariant has no window to be true over. */
  readonly tickAt: Date
  /** Every tenant this one cause affected. One entry or two hundred; still one message. */
  readonly affectedTenants: readonly string[]
  /** Incidents folded into this message, so the record and the message can be reconciled. */
  readonly incidentKeys: readonly string[]
}

/** The record, which exists whatever the preferences say.
 *
 * A REQUIRED FIELD OF THE RESULT, not an optional one and not a second call. `Routing.record`
 * cannot be absent, so there is no branch in which a preference suppressed it — the guarantee
 * is that the type does not permit the shape, rather than that the code remembers to produce
 * it. And the preference is not an input to building it. */
export interface RoutedRecord {
  readonly incidentKey: string
  readonly organizationId: string
  readonly customerTenantId: string
  readonly ruleId: string
  readonly severity: Severity
  /** SECURITY and MONITORING route independently and reach different people inside an MSP.
   * Kept on the record too, so a reader can see which channel it belonged to without
   * re-deriving it from the rule. */
  /** From the declaration when this record was built, kept so a reader sees which channel
   * it belonged to without re-deriving it. NOT an input to the cause key — see
   * `causeKeyOf`, which reads the catalogue. */
  readonly category: AlertCategory
  /** What actually happened to this, IN WORDS, including when nothing was sent.
   *
   * "Recorded only, at your setting" and "held until 07:00, quiet hours" are different
   * sentences and a person asking why they were not called needs the right one. */
  readonly deliveryOutcome: string
  /** Whether a delivery is waiting. An in-app view shows a held alert IMMEDIATELY, marked as
   * held, and it never disappears — deferral is visible from the moment it is decided. */
  readonly heldDeliveries: readonly Readonly<{ until: Date; because: string }>[]
}

/** What routing produced: always a record, and zero or more deliveries. */
export interface Routing {
  readonly record: RoutedRecord
  readonly deliveries: readonly Delivery[]
}

/** WHAT AN MSP WILL NOT HEAR ABOUT, as a first-class output.
 *
 * The plan's coverage-gaps requirement, and the thing that stops "make it configurable"
 * becoming "everybody turns it off and blames HawkView". Under-alerting by default is not a
 * virtue; it is the same failure as a screen quietly showing stale data.
 *
 * A LIST OF SENTENCES RATHER THAN A COUNT, because "8 rules are set to record-only" tells a
 * reader nothing they can act on and "you will not be called about privileged role grants"
 * tells them exactly one thing they might want to change. */
export interface CoverageStatement {
  readonly ruleId: string
  readonly preference: DeliveryPreference
  /** Plain words, for a settings screen. */
  readonly sentence: string
}

/** One preference change, with who and when.
 *
 * THE THIRD GUARDRAIL. An MSP asking why they were not told gets an answer with a date on it,
 * which turns a liability argument into a support conversation. One row per change; the
 * previous value is carried because "who set this" and "what did they change it from" are
 * different questions and only the second explains a gap. */
export interface PreferenceChange {
  readonly organizationId: string
  readonly ruleId: string
  readonly from: DeliveryPreference
  readonly to: DeliveryPreference
  readonly changedByUserId: string
  readonly changedAt: Date
}

// ---------------------------------------------------------------------------------------
// THE SHAPE, AFTER QA'S SEAM ATTACK. Two properties the first cut could not express.
// ---------------------------------------------------------------------------------------

/** ROUTING HAPPENS OVER A SEQUENCE OF MOMENTS, NOT AT ONE.
 *
 * `route(incidents, preferences, now) -> Delivery[]` cannot express quiet hours deferring,
 * and the reason is exact: one call carries one `now` and has no later, so **held-and-
 * delivered and held-and-lost are the same output.** A held delivery that matures and goes
 * out, and one that is held and then quietly forgotten, both look like "held" at the only
 * moment the function can see.
 *
 * This is step 04's flat-list problem one feature over — there, "emitted then stopped" and
 * "never emitted" were the same input; here, "held then sent" and "held then lost" are the
 * same output. Both are fixed the same way: carry the sequence, not the snapshot.
 *
 * A tick with no incidents is not a wasted entry. It is the thing that lets a hold MATURE,
 * and without it the passage of time is not expressible at all. */
export type RoutingTick = Readonly<{
  at: Date
  /** May be empty — an empty tick is time passing, which is when holds come due. */
  incidents: readonly RoutableIncident[]
}>

/** What routing needs to know about an incident. Taken from step 04's queue rather than
 * re-derived, so the two cannot disagree about which incident this is. */
export interface RoutableIncident {
  readonly incidentKey: string
  readonly organizationId: string
  readonly customerTenantId: string
  /** THE DECLARED ALERT TYPE, and the authoritative source of category and subject role.
   *
   * `category` used to sit here as a caller-supplied field, and that was the whole of
   * direction 2: the tenant entered a security cause key only because somebody passed the
   * string SECURITY. The catalogue owns that fact and declares it beside the subject, so a
   * second copy is free to drift — exactly the rule step 02 settled for the subject, one
   * step later.
   *
   * Typed as `AlertTypeId`, so an id the catalogue does not declare does not compile. */
  readonly alertTypeId: AlertTypeId
  /** The FINER rule, for preferences. NOT the source of category.
   *
   * Two namespaces, deliberately separate: 7 catalogue types carry category and subject,
   * 28 change rules are the configurable grain. "Page me for a role grant but not for an
   * authentication method" needs the second; deriving a category needs the first. */
  readonly ruleId: string
  readonly severity: Severity
  /** The resolved subject from step 02 — for a collector failure the resource type, for a
   * directory change the actor. THE NON-TENANT PART OF THE CAUSE, and the field whose
   * absence meant `causeKeyOf` could not be written: without it, what makes two incidents
   * one cause was not in the seam at all, so any grouping was somebody's guess rather than
   * the product's rule. */
  readonly subjectId: string
}

/** An incident that produced no delivery BECAUSE THE MSP CHOSE THAT.
 *
 * EVENT-DRIVEN, AND THAT IS ITS LIMIT. An entry exists only when an incident actually arrives
 * on a silenced rule — so this alone cannot say what an MSP will not hear about. See
 * `silencedRules`, which is the half this cannot cover. */
export interface SuppressedIncident {
  readonly incidentKey: string
  readonly organizationId: string
  readonly ruleId: string
  /** Recorded regardless. The suppression is of delivery, never of the record. */
  readonly recordedAs: string
}

/** A delivery that has not gone out yet, carried across ticks so its fate is observable. */
export interface HeldDelivery {
  readonly delivery: Delivery
  readonly heldSince: Date
  readonly until: Date
  readonly because: string
}

/** Everything routing produced across the whole sequence.
 *
 * THE TWO INVARIANTS ARE THE ACCOUNTING IDENTITY FROM STEP 03, ARRIVING HERE. Every incident
 * appears exactly once in `records`, and lands in exactly one of `delivered`, `stillHeld`,
 * `suppressed` and `unroutable`. An incident in none of those buckets is silence nobody can find, which is
 * this step's whole failure mode — and an incident in two of them is a message somebody will
 * receive twice while the record says once.
 *
 * THERE IS NO DROPPED BUCKET, and that is a ruling made structural. A delivery limit may
 * AGGREGATE or DEFER; it may never drop. A limit that drops is silence produced by a feature
 * whose purpose is volume, exactly as a hold that expires is silence produced by a feature
 * whose purpose is timing — the same failure, and the limit is the more tempting one because
 * dropping is the simplest implementation and looks like working as designed. With no bucket
 * to put a dropped message in, it cannot be written and then explained. */
/** An incident nobody can be told about, with the refusal a settings screen would show. */
export interface Unroutable {
  readonly incidentKey: string
  readonly organizationId: string
  readonly ruleId: string
  /** The refusal itself, carried rather than flattened to a boolean. */
  readonly recipient: Extract<Recipient, { kind: 'NONE_VERIFIED' }>
}

export interface RoutingOutcome {
  /** Every incident, exactly once, whatever happened to it. */
  readonly records: readonly RoutedRecord[]
  readonly delivered: readonly Delivery[]
  readonly stillHeld: readonly HeldDelivery[]
  readonly suppressed: readonly SuppressedIncident[]
  /** Incidents with nobody verified to tell.
   *
   * A FOURTH BUCKET, DELIBERATELY, AND SAY SO IF THAT IS THE WRONG READING. The instruction
   * was that NONE_VERIFIED belongs somewhere the accounting can see rather than inside the
   * bucket meaning "told"; I have taken that to mean its own place in the identity. Folding
   * it into `suppressed` was the alternative and it would be wrong: SUPPRESSED MEANS THE MSP
   * CHOSE THIS, UNROUTABLE MEANS WE HAVE NOBODY TO TELL. Conflating a choice with a gap is
   * the error this feature keeps finding, one layer down each time.
   *
   * The defect it closes: a Delivery once took the full `Recipient` union, so an
   * organisation with no inbox produced an entry in `delivered` that satisfied the
   * accounting identity and read as served. The bucket was honest and silence got in
   * through a field inside it. */
  readonly unroutable: readonly Unroutable[]
  /** WHAT THE MSP WILL NOT HEAR ABOUT, DERIVED FROM THE PREFERENCE SET RATHER THAN FROM WHAT
   * HAPPENED.
   *
   * QA'S SIXTH FINDING, AND IT IS THE ONE I WOULD HAVE MISSED. `suppressed` is event-driven,
   * so an entry exists only when an incident arrives on a silenced rule. An MSP who silences
   * a rule that then never fires produces output BYTE-IDENTICAL to an MSP who silenced
   * nothing and had a quiet week — and silenced-and-therefore-silent is exactly the state
   * this property exists to make visible.
   *
   * The generalisation is worth more than the instance: A PROPERTY ABOUT A CONFIGURATION
   * CANNOT BE CARRIED BY A LIST OF EVENTS. If the answer changes when nothing happens, it is
   * not derivable from what happened.
   *
   * Derived from the preferences, so an MSP who silenced nothing lists nothing — the control
   * that stops this passing by listing everything always. */
  readonly silencedRules: readonly CoverageStatement[]
  /** The invariants, checked on the output rather than asserted about it. Empty is healthy;
   * each entry names the incident and which rule it broke. */
  readonly accountingProblems: readonly string[]
}

/** WHAT MAKES TWO INCIDENTS ONE CAUSE. The function `Delivery.causeKey` referred to and that
 * did not exist — the reference was dangling, and any grouping written against it would have
 * been somebody's guess about the product's rule rather than the rule.
 *
 * ONLY MONITORING COALESCES. SECURITY FINDINGS NEVER COALESCE ACROSS TENANTS.
 *
 * A collector failing across fifteen tenants is ONE REASON — our collection broke, or
 * Microsoft's API did — and fifteen messages about it is the failure the plan names. Two
 * privileged role grants in two tenants are TWO REASONS that happen to share a rule, and
 * coalescing them HIDES ONE BEHIND THE OTHER: the 301 defect wearing a rate-limit costume.
 *
 * So the tenant is deliberately absent from a monitoring cause and deliberately present in a
 * security one. THE DIRECTION OF ERROR IS CHOSEN: over-send security, under-send monitoring
 * noise. Wrong about a fleet-wide security cause and an MSP gets duplicates; wrong the other
 * way and an attack in one tenant is hidden inside a message about another.
 *
 * Built with step 01's `joinUnambiguously` rather than a second encoding, so a subject id
 * containing a separator cannot collide two causes into one. */
export function causeKeyOf(incident: RoutableIncident): string {
  // FROM THE DECLARATION, NOT FROM THE CALLER. Both halves — the category that chooses the
  // branch, and the subject role that decides whether the subject re-introduces the tenant.
  const declaration = alertType(incident.alertTypeId)

  if (declaration.category === 'SECURITY') {
    return joinUnambiguously([
      'hawkview-cause/v1', 'SECURITY', incident.organizationId, incident.alertTypeId,
      // The tenant IS the point here: two tenants are two causes, always.
      incident.customerTenantId, incident.subjectId,
    ])
  }

  // WHEN THE DECLARED SUBJECT IS THE TENANT, THE SUBJECT GOES TOO.
  //
  // `monitoring.tenant_disconnected` and `monitoring.consent_expiring` both declare
  // `subject: 'TENANT'`, so their subjectId IS the tenant id. Dropping `customerTenantId`
  // while keeping `subjectId` let the tenant back in through the subject, and fifteen
  // disconnected tenants became fifteen causes — one Microsoft outage, fifteen messages per
  // MSP. That is the 1,500-message case arriving through the very rules the operational
  // branch exists to coalesce.
  //
  // Dropping one copy of the tenant while keeping the other is incoherent: if the subject
  // IS the tenant, the branch removes it in both places or in neither.
  //
  // Safe because coalescing is PER TICK — `fanOutProblems` allows the same fifteen across
  // different ticks, so two outages a week apart stay two causes. Without that control this
  // ruling would forbid legitimate recurrence. And the message names the tenants it covers:
  // `affectedTenants` exists for exactly this case.
  const subjectIsTheTenant = declaration.subject === 'TENANT'
  return joinUnambiguously([
    'hawkview-cause/v1', 'OPERATIONAL', incident.organizationId, incident.alertTypeId,
    ...(subjectIsTheTenant ? [] : [incident.subjectId]),
  ])
}

/** THE FAN-OUT INVARIANT, WHICH THE MISSING FIELD DOES NOT PROVIDE.
 *
 * A `Delivery` genuinely cannot be ADDRESSED to a tenant — there is no `customerTenantId` to
 * vary, and that is a compile error. But FIFTEEN DELIVERIES EACH NAMING ONE TENANT IN
 * `affectedTenants` COMPILE FINE AND SHARE A CAUSE KEY. The absent field stops the address; it
 * does not stop the fan-out, and the fan-out is the 1,500 messages.
 *
 * So the guarantee needs an accounting rule as well as a missing field: ONE DELIVERY PER CAUSE
 * KEY PER MSP PER TICK. Reported by name rather than as a count, so a reader knows which cause
 * to go and look at. */
export function fanOutProblems(deliveries: readonly Delivery[]): readonly string[] {
  const seen = new Map<string, number>()
  for (const delivery of deliveries) {
    const window = joinUnambiguously([
      delivery.organizationId, delivery.causeKey, delivery.tickAt.toISOString(),
    ])
    seen.set(window, (seen.get(window) ?? 0) + 1)
  }
  return [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([window, count]) =>
      `${count} deliveries for one cause in one tick — ${window}. One cause is one message per MSP.`)
    .sort()
}

/** THE HELD-THEN-SILENCED CONTRADICTION, and the ruling that settles it.
 *
 * An alert held under EMAIL, whose rule is silenced to RECORD_ONLY while the hold is pending,
 * and which then matures: delivering it makes the outcome assert two things at once — the
 * message went out, and `silencedRules` says the MSP will not hear about that rule.
 *
 * THE PREFERENCE AT DELIVERY TIME WINS, so it becomes suppressed rather than delivered. The
 * MSP's most recent expressed intent is the one to honour; delivering something they have just
 * silenced is exactly what makes people stop trusting a settings screen; and A HELD ALERT IS BY
 * DEFINITION NOT THE ALWAYS-RING KIND, since anything that bypasses quiet hours was never held.
 * The record survives regardless.
 *
 * THE REVERSE IS ALREADY RIGHT AND STAYS: silenced on arrival then un-silenced leaves a
 * suppression in history and nothing in the standing statement. One is what happened, the other
 * is what is configured — and conflating them is the same error as deriving coverage from
 * events. */
export function contradictions(outcome: RoutingOutcome): readonly string[] {
  const silenced = new Set(outcome.silencedRules.map((statement) => statement.ruleId))
  const deliveredRules = new Set(
    outcome.records
      .filter((record) => outcome.delivered.some((d) => d.incidentKeys.includes(record.incidentKey)))
      .map((record) => record.ruleId))
  return [...deliveredRules]
    .filter((ruleId) => silenced.has(ruleId))
    .map((ruleId) =>
      `${ruleId} was delivered while the standing statement says it is silenced. `
      + 'The preference at delivery time wins: this should be suppressed.')
    .sort()
}
