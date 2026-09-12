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
export type Recipient =
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
  /** No verified recipient exists yet. Carried as a variant rather than an empty list so the
   * settings screen can say WHICH tenants have nobody listening, instead of showing a blank
   * where a name should be. */
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
  readonly recipient: Recipient
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
