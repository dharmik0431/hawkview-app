/** The evaluation core: what a window of events supports being said about it.
 *
 * Pure. No database, no framework, no clock of its own, no budget of its own,
 * and deliberately no knowledge of what any Microsoft field means. Classifying
 * an event requires knowing that error 50053 is a lockout and that a missing
 * `isInteractive` is background traffic; the moment this module knows that it
 * stops being an evaluation engine and becomes a Microsoft adapter. So events
 * arrive already sorted, from the layer that does know.
 *
 * The engine this replaces stored coverage as a single boolean that many
 * unrelated facts could set, after which one reason code had to explain all of
 * them. That is why "incomplete window" came to mean "unknown outcome", and why
 * one unrecognized row took an entire rule to not-evaluated across 1,054
 * production runs. Coverage is a vector here, so a fall-through has nothing to
 * collapse into, and an event nobody could interpret reduces what we claim
 * without ever blocking a finding we can support.
 */

/** What the classifier concluded, counted by its own reason vocabulary.
 *
 * The core reads only two things from this — how much applied, and whether
 * anything went uninterpreted — and passes the rest through untouched. The
 * reason names live with the classifier, where they can be exhaustive against
 * what the data actually produces; keeping a second copy here is how two closed
 * sets drift into mapping a reason onto its nearest neighbour.
 *
 * `doesNotApply` is never summed with the other two. An event the rules
 * correctly declined is not a coverage gap, and merging it with evidence we
 * failed to read is the collapse this whole design exists to prevent.
 */
export type Coverage = Readonly<{
  /** Events in scope for the rules. The denominator any claim rests on. */
  applies: number
  /** Correctly out of scope. The rules worked; these do not reduce coverage. */
  doesNotApply: Readonly<Record<string, number>>
  /** Processed, but the outcome could not be interpreted. */
  unknown: Readonly<Record<string, number>>
  /** Could not be processed into an event at all. Distinct from `unknown`,
   * because "we could not read this row" and "we read it and could not tell
   * what it meant" send an investigator to different places. */
  unprocessable: Readonly<Record<string, number>>
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

/** Why a clean result could not be claimed. Distinct values, each reaching the
 * reader as its own sentence, because an undifferentiated "not available" is
 * the same defect as an undifferentiated "incomplete window". */
export type WithheldReason =
  | 'NEVER_COLLECTED'
  | 'UNREADABLE_NOW'
  | 'UNINTERPRETED_EVENTS'
  | 'NOTHING_APPLICABLE'
  | 'CAPACITY_EXCEEDED'
  | 'DETECTOR_FAILED'

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

/** A detector reports how many events it actually looked at after its own
 * filtering, not how many it was handed. Without that, a detector that is
 * genuinely inapplicable and one that is silently dead produce identical
 * output — which is exactly the position the previous engine left us in, with
 * three rules that have never once run against real evidence. */
export type DetectorResult = Readonly<{ considered: number; findings: readonly Finding[] }>

/** Detectors plug in and swap out. They see only the events that applied, they
 * cannot influence coverage, and one failing cannot erase what another found. */
export type Detector<Event> = Readonly<{
  id: string
  run: (applicable: readonly Event[]) => DetectorResult
}>

/** Diagnostic, deliberately separate from coverage. A detector that considered
 * 500 events and matched none is healthy; one that considered none is either
 * inapplicable or broken, and only this tells them apart. A failed detector
 * reports no counts, because what it would have considered is unknown. */
export type DetectorReport =
  | Readonly<{ detectorId: string; status: 'RAN'; considered: number; matched: number }>
  | Readonly<{ detectorId: string; status: 'FAILED' }>

/** The count and what qualifies it, in one value. There is deliberately no way
 * to obtain the number alone: three honest counts beside a confident zero is a
 * better-documented version of the same lie, so the type makes the pair
 * inseparable rather than asking each caller to remember. */
export type Assessment = Readonly<{
  state: EvidenceState
  coverage: Coverage
  detectors: readonly DetectorReport[]
  findings: readonly Finding[]
  count: Count
  claim: ZeroClaim
}>

/** Supplied by the caller and bounded by the request. The core holds no budget
 * of its own, so nothing below a caller can quietly impose a limit the caller
 * cannot widen. */
export type Budget = Readonly<{ maxEvents: number }>
