/** The evaluation core: what a window of events supports being said about it.
 *
 * Pure. No database, no framework, no clock of its own, no budget of its own.
 * Everything it needs arrives as an argument so that a caller can bound it and
 * a test can drive it.
 *
 * The previous implementation stored coverage as a single boolean that many
 * unrelated facts could set, after which one reason code had to explain all of
 * them. That is why "incomplete window" came to mean "unknown outcome", and why
 * a single unrecognized row could take an entire rule to not-evaluated. Coverage
 * here is a vector instead, so there is nothing for a fall-through to collapse
 * into, and an event we cannot interpret reduces what we claim without ever
 * blocking a finding we can support.
 */

/** An event the rules correctly decline to act on. Not a coverage gap: the
 * rules worked. Kept apart from UNKNOWN because "this does not apply" and "we
 * could not tell" are different claims about how much a result is worth. */
export type DoesNotApplyReason =
  | 'NON_INTERACTIVE'
  | 'APPLICATION_ACTOR'
  | 'NOT_A_CREDENTIAL_EVENT'
  | 'OUTSIDE_WINDOW'

/** An event we could not interpret. This is the only kind that reduces
 * coverage, and it never prevents a finding drawn from the events we did
 * interpret. */
export type UnknownReason =
  | 'UNRECOGNIZED_OUTCOME'
  | 'MALFORMED_RECORD'
  | 'UNRESOLVED_IDENTITY'
  | 'INCONSISTENT_TIMESTAMPS'

export type Disposition =
  | Readonly<{ kind: 'APPLIES' }>
  | Readonly<{ kind: 'DOES_NOT_APPLY'; reason: DoesNotApplyReason }>
  | Readonly<{ kind: 'UNKNOWN'; reason: UnknownReason }>

export const DOES_NOT_APPLY_REASONS = [
  'NON_INTERACTIVE', 'APPLICATION_ACTOR', 'NOT_A_CREDENTIAL_EVENT', 'OUTSIDE_WINDOW',
] as const satisfies readonly DoesNotApplyReason[]
export const UNKNOWN_REASONS = [
  'UNRECOGNIZED_OUTCOME', 'MALFORMED_RECORD', 'UNRESOLVED_IDENTITY', 'INCONSISTENT_TIMESTAMPS',
] as const satisfies readonly UnknownReason[]

/** Counted by reason and never summed across the two groups. A lone
 * keep-me-signed-in interrupt and nine hundred reputation blocks are not the
 * same disclosure, and one total cannot tell them apart. */
export type Coverage = Readonly<{
  applies: number
  doesNotApply: Readonly<Record<DoesNotApplyReason, number>>
  unknown: Readonly<Record<UnknownReason, number>>
}>

/** Zero is reachable only through EXACT. A lower bound is never zero, because
 * "at least none" states nothing while looking like a measurement. */
export type Count =
  | Readonly<{ accuracy: 'EXACT'; value: number }>
  | Readonly<{ accuracy: 'AT_LEAST'; value: number }>
  | Readonly<{ accuracy: 'NOT_AVAILABLE'; value: null }>

/** The four states kept distinct, because collapsing any pair of them is how
 * every reporting defect in the previous implementation began. */
export type EvidenceState =
  | 'NEVER_COLLECTED'
  | 'UNREADABLE_NOW'
  | 'FULLY_INTERPRETED'
  | 'PARTIALLY_UNINTERPRETABLE'

/** Why a clean result could not be claimed. Distinct values because "we cannot
 * determine this window's coverage" and "this window held events we could not
 * read" send an investigator to different places. */
export type WithheldReason =
  | 'NEVER_COLLECTED'
  | 'UNREADABLE_NOW'
  | 'UNINTERPRETED_EVENTS'
  | 'NOTHING_APPLICABLE'
  | 'CAPACITY_EXCEEDED'

/** Decided once. Every surface reads this rather than re-deriving it, because
 * two surfaces answering the same question against different bars is how a
 * headline came to disagree with the caption beneath it. */
export type ZeroClaim =
  | Readonly<{ permitted: true }>
  | Readonly<{ permitted: false; because: WithheldReason }>

export type Finding = Readonly<{
  detectorId: string
  subject: string
  observedAt: string
}>

/** The count and what qualifies it, in one value. There is deliberately no way
 * to obtain the number alone: three honest counts beside a confident zero is a
 * better-documented version of the same lie, so the type makes the pair
 * inseparable rather than asking each caller to remember. */
export type Assessment = Readonly<{
  state: EvidenceState
  coverage: Coverage
  findings: readonly Finding[]
  count: Count
  claim: ZeroClaim
}>

/** Supplied by the caller and bounded by the request. The core holds no budget
 * of its own, so nothing below a caller can quietly impose a limit the caller
 * cannot widen. */
export type Budget = Readonly<{ maxEvents: number }>

/** Sorts one event relative to the whole rule set, not to any single rule.
 * Whether a given rule matches is not a coverage question — that distinction is
 * what stops "this is not an invalid-credential event" from reading as a gap. */
export type Classifier<Event> = (event: Event) => Disposition

/** Detectors plug in and swap out. They see only the events that applied, and
 * they cannot influence coverage, so no detector can veto another's finding. */
export type Detector<Event> = Readonly<{
  id: string
  findings: (applicable: readonly Event[]) => readonly Finding[]
}>
