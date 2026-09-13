// QA PRE-REGISTRATION — THE PUBLISH PATH, written before the code exists.
//
// I have read none of Engineer's implementation. The vocabulary below is imported from the
// catalogue rather than restated, because a register that spells its own `Severity` agrees with
// nothing and would drift the first time a tier is added.
//
// WHAT THIS STEP IS. The disposition is consulted today only by the Risky Users intake, which
// reaches two catalogue types. Every alert an MSP actually receives comes from the tenant-sync
// publish path, which never looks at the setting. The catalogue now owns the kind-to-type mapping,
// so the publish path can resolve its kind and consult the disposition — two of seven becomes
// seven of seven.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SEAM ATTACK, SPENT FIRST
//
// The obvious shape is `shouldPublish(kind, organizationId): Promise<boolean>`. **Seven of the ten
// properties below are unpinnable through it**, and two of those are the constraints that outrank
// the feature.
//
// 1. A BOOLEAN CANNOT SAY WHY IT SAID NO, AND THIS IS THE WHOLE JOB. Silence because the
//    organisation chose RECORD_ONLY and silence because the lookup failed are the same observable
//    outcome. Fail-open says the second must publish — but with a boolean, "we failed so we
//    returned true" is indistinguishable from "we read a setting that allowed it", so nobody can
//    ever check that fail-open is what happened rather than what was intended.
//
// 2. A `Promise` CAN REJECT INTO THE COLLECTOR. "Must not throw, must not extend a transaction,
//    must not be able to fail a collection" is not a property a try/catch can establish, because
//    the next person to edit the function can remove the catch and nothing will notice until a
//    sync fails. The strong form is that **the decision is PURE and SYNCHRONOUS over a snapshot
//    loaded elsewhere**: there is no I/O on the collector's path to fail, nothing to await, and
//    no transaction to hold open. Loading is a separate step whose failure is a VALUE.
//
// 3. AN UNMAPPED KIND AND A SILENCED KIND ARE BOTH `false`. A publication kind no catalogue type
//    covers must publish. Through a boolean that is a convention, and conventions are what the
//    last four defects in this feature were made of.
//
// 4. IT CANNOT SAY WHICH TYPE IT RESOLVED, so nobody can check the property that actually protects
//    the MSP: **the settings page and the publish path must agree about which type a kind is.**
//    The page walks the catalogue. If the publish path resolves kinds by any other route, somebody
//    silences a type on the page and keeps receiving it — which is this feature's signature defect,
//    and an end-to-end test of either half alone passes throughout.
//
// 5. A TIMEOUT HAS NO REPRESENTATION except a hang, and a hang inside a collection is the failure
//    mode the second constraint exists to forbid.
//
// 6. THERE IS NOWHERE TO REPORT AN UNREADABLE STORED VALUE OR KEY. Both are already reported at the
//    intake and on the settings endpoint; a third place that silently defaults them would make
//    "reported, never defaulted" true in two places out of three.
//
// WHAT MY OWN FIRST DRAFT COULD NOT EXPRESS — checked rather than assumed, because it has happened
// on every seam in this feature:
//
// 7. A PARTIALLY LOADED SNAPSHOT. My first shape had `Snapshot | null`, which forces all-or-nothing
//    across a tick that covers several organisations — so one organisation's failed read would
//    govern another's decisions, and the report would say the whole thing was unavailable. Real
//    loads fail per organisation. `DispositionSnapshot` therefore resolves PER ORGANISATION.
//
// 8. AND A SNAPSHOT THAT LOADED SUCCESSFULLY A LONG TIME AGO. Publishing on a stale read is correct
//    — it is the fail-open direction — but an operator asking "why did this send" gets no answer
//    unless the decision says the snapshot it used was stale. Staleness is a QUALIFIER on a
//    publish, not a fourth outcome.
// ═════════════════════════════════════════════════════════════════════════════
//
// WHICH HALF BINDS ME. P1-P10 are pre-registered and binding: they are what I will check, and if
// the built thing fails one I report it. If I later think a property was wrong I say so in a
// separately-labelled file rather than editing this one.
//
// THE TYPES ARE A PROPOSAL, NOT A REQUIREMENT. I do not get to design this step. They exist because
// I had to answer one question honestly — can these properties be checked at all through the
// obvious shape — and the answer was no for seven of ten. Any shape that keeps the decision off
// the collector's I/O path, that carries WHY, and that names the type it resolved will do. What I
// will not accept is a shape in which a property becomes UNASKABLE, because unaskable reads exactly
// like passing.
//
// WHAT THIS DELIBERATELY DOES NOT DECIDE: how the snapshot is loaded or cached, how long it may
// live, where in the sync it is taken, the wording of anything, or whether the publish path batches.

// THE VOCABULARY IS IMPORTED, NOT RESTATED. `KeyShape` is the seven publication kinds; on the
// implementation branch it is an alias of the catalogue's own `PublicationKind`, and on this QA
// branch it is the literal union that predates that move. Either way it is THE OTHER SIDE OF THE
// BOUNDARY rather than a list I typed, which is the whole reason a register may not spell its own.
import type { KeyShape as PublicationKind } from './reconciliation.js'
import type { Severity } from './alert-type.js'

/** What one organisation's settings look like to the publish path, AND IT RESOLVES PER
 * ORGANISATION.
 *
 * A load that failed is a VALUE here, not a rejected promise, because the collector must not be
 * able to inherit a failure from this. */
export type OrganisationSettings =
  | Readonly<{ kind: 'READ'; byAlertTypeId: ReadonlyMap<string, Severity> }>
  /** The read failed, or never happened, for THIS organisation. Carries the reason so the decision
   * below can say which kind of not-knowing it was. */
  | Readonly<{ kind: 'UNREADABLE'; because: string }>

/** Stored rows the product cannot act on. The SAME two arms the intake and the settings endpoint
 * already report — one definition of unreadable, not a third. */
export type IgnoredSetting = Readonly<{
  alertTypeId: string
  storedValue: string
  because: 'UNKNOWN_ALERT_TYPE' | 'UNKNOWN_DISPOSITION'
}>

/** Everything the publish path is allowed to know, gathered BEFORE the collection it will be used
 * in. One timestamp for the whole thing, so a decision can say how old its evidence was. */
export interface DispositionSnapshot {
  readonly takenAt: Date
  readonly forOrganisation: (organizationId: string) => OrganisationSettings
  readonly ignored: readonly IgnoredSetting[]
}

/** WHY SOMETHING IS BEING PUBLISHED, and every arm but the first is a fail-open.
 *
 * These exist so that "it published" is never the end of the sentence. Silence on a failed read is
 * the defect; silence on a successful RECORD_ONLY read is the feature; and a publish that cannot
 * say which of these it was leaves an operator unable to tell a working policy from a broken
 * lookup. */
export type PublishReason =
  /** A setting was read and it permits this. The only arm that is not a fail-open. */
  | 'PERMITTED_BY_SETTING'
  /** No row for this type. The catalogue's own tier applies and it is not RECORD_ONLY. */
  | 'NO_SETTING_STORED'
  /** No catalogue type covers this publication kind. **AN UNMAPPED KIND IS NOT A SILENCED ONE.** */
  | 'KIND_HAS_NO_DECLARED_TYPE'
  /** The settings could not be read for this organisation. */
  | 'SETTINGS_UNREADABLE'
  /** A row exists whose stored value is outside the vocabulary. */
  | 'STORED_VALUE_UNREADABLE'
  /** A row exists whose key is not a catalogue id — a setting somebody made for something this
   * product cannot recognise. */
  | 'STORED_KEY_UNRECOGNISED'
  /** No snapshot at all was available when the decision was made. */
  | 'NO_SNAPSHOT'

/** WHAT THE PATH DECIDED, AND WITHHOLDING HAS EXACTLY ONE CONSTRUCTOR.
 *
 * **THIS IS THE FAIL-OPEN PROPERTY, MADE UNWRITEABLE.** `WITHHELD` requires a resolved
 * `alertTypeId` and the literal `'RECORD_ONLY'` — evidence that a real setting for a real type was
 * really read. There is no arm for "withheld because something went wrong", so the cheap
 * implementation that silences on a failed lookup has nothing to return. */
export type PublishDecision =
  | Readonly<{
      kind: 'PUBLISH'
      because: PublishReason
      /** The type this kind resolved to, or null when none does. **Present so the agreement
       * property below is checkable at all.** */
      alertTypeId: string | null
      /** True when the snapshot that produced this was older than the freshness the caller asked
       * for. A qualifier on a publish, never a reason to withhold. */
      onStaleEvidence: boolean
    }>
  | Readonly<{
      kind: 'WITHHELD'
      alertTypeId: string
      disposition: 'RECORD_ONLY'
    }>

/** One thing the collector is about to publish. */
export interface Publishable {
  readonly organizationId: string
  readonly publicationKind: PublicationKind
  readonly dedupeKey: string
}

export interface PublishOutcome {
  readonly decisions: readonly Readonly<{ publishable: Publishable; decision: PublishDecision }>[]
  /** Every ignored setting the snapshot carried, passed through rather than dropped. The intake
   * built this list and threw it away once already. */
  readonly ignored: readonly IgnoredSetting[]
}

/** THE SEAM. **Pure, synchronous, and total.**
 *
 * No `Promise`, so there is nothing to await inside a collection and nothing that can reject into
 * one. No I/O, so it cannot extend a transaction or time out. The snapshot is a parameter, which
 * is what moves the failure out of the collector's path and into a value.
 *
 * `snapshot: DispositionSnapshot | null` — null is a legitimate input, not an error, and it must
 * publish everything. */
export type PublishPlan = (input: Readonly<{
  publishables: readonly Publishable[]
  snapshot: DispositionSnapshot | null
  freshEnoughSince: Date
}>) => PublishOutcome

/** THE AGREEMENT PROPERTY, as a type the implementation must satisfy.
 *
 * The settings page walks the catalogue. If the publish path resolves a kind to a type by any other
 * route, an MSP silences something and keeps receiving it — and each half passes its own tests
 * throughout. So the resolution is stated here as one function, and P9 checks that the publish
 * path's answers equal the catalogue's for EVERY kind rather than for a sample. */
export type TypeForKind = (kind: PublicationKind) => string | null

/** THE PROPERTIES. Binding.
 *
 * P1  FAIL OPEN ON AN UNREADABLE ORGANISATION. `UNREADABLE` publishes, with `SETTINGS_UNREADABLE`.
 * P2  FAIL OPEN ON NO SNAPSHOT AT ALL. `null` publishes everything, with `NO_SNAPSHOT`.
 * P3  FAIL OPEN ON AN UNREADABLE VALUE OR KEY, and both are REPORTED rather than defaulted away.
 * P4  AN UNMAPPED KIND PUBLISHES, with `KIND_HAS_NO_DECLARED_TYPE`. It is not a silenced kind.
 * P5  WITHHOLDING HAS ONE CONSTRUCTOR AND IT CARRIES ITS EVIDENCE — a resolved type and a stored
 *     RECORD_ONLY. A failure cannot produce a withhold, because it cannot build one.
 * P6  EVERY REASON IS DISTINGUISHABLE IN THE OUTPUT. Policy-silence and failure-publish are never
 *     the same record, and no two fail-open paths share a reason.
 * P7  THE DECISION IS PURE AND SYNCHRONOUS. No promise, no I/O, no throw available on the
 *     collector's path.
 * P8  A COLLECTION COMPLETES WHEN THE LOOKUP FAILS — measured as the collection's own rows being
 *     written, not as the code catching something.
 * P9  THE PUBLISH PATH AND THE SETTINGS PAGE AGREE, for every publication kind, about which type a
 *     kind is. Checked over the whole vocabulary, not a sample.
 * P10 STALENESS QUALIFIES A PUBLISH AND NEVER CAUSES A WITHHOLD.
 */
export const PRE_REGISTERED_PUBLISH_PATH = [
  'P1 fail open on an unreadable organisation',
  'P2 fail open on no snapshot at all',
  'P3 fail open on an unreadable value or key, and report both',
  'P4 an unmapped kind publishes',
  'P5 withholding has one constructor and it carries its evidence',
  'P6 every reason is distinguishable in the output',
  'P7 the decision is pure and synchronous',
  'P8 a collection completes when the lookup fails',
  'P9 the publish path and the settings page agree for every kind',
  'P10 staleness qualifies a publish and never causes a withhold',
] as const
