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
  | Readonly<{ accuracy: 'EXACT'; value: number; scope: CountScope }>
  | Readonly<{ accuracy: 'AT_LEAST'; value: number; scope: CountScope }>
  | Readonly<{ accuracy: 'NOT_AVAILABLE'; value: null; scope: CountScope }>

/** Which questions this count is the answer to.
 *
 * An exact zero means "none of the checks that could run found anyone" — never
 * "everything is clean" — and the difference is invisible unless the scope
 * arrives with the number. A scoped zero whose scope sits one component away is
 * a bare zero in practice, so the scope is inside `Count` rather than beside it:
 * there is no way to render the figure without having held the qualification.
 *
 * This is the previous engine's headline defect stated precisely. Three rules
 * that never ran once produced the same zero as three rules that ran and found
 * nothing, because nothing in the number said which questions it answered. */
export type CountScope = Readonly<{
  /** Detectors whose verdict this count includes. */
  covered: readonly string[]
  /** Detectors this evidence could not support, each saying why in its own
   * words. Non-empty means the count answers a narrower question than the
   * product claims to ask. */
  notCovered: readonly Readonly<{ detectorId: string; because: string }>[]
}>

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
  /** We found something and could not tell whose it is. Kept apart from
   * UNINTERPRETED_EVENTS because that one is about evidence we could not read,
   * and this is about evidence we read perfectly well and could not attribute. */
  | 'UNRESOLVED_SUBJECT_IDENTITY'

/** Decided once. Every surface reads this rather than re-deriving it, because
 * two surfaces answering the same question against different bars is how a
 * headline came to disagree with the caption beneath it. */
export type ZeroClaim =
  | Readonly<{ permitted: true }>
  /** Every reason that applies, not the first one a precedence order happened to
   * reach. Several can hold at once — a window both over budget and carrying a
   * mailbox we could not attribute — and choosing between them means telling a
   * technician one true thing instead of two, which sends them to investigate
   * data quality when the real problem was identity binding.
   *
   * There is deliberately no precedence to get right. The tenant layer already
   * carries a list for exactly this reason; a single reason here was the same
   * collapse one level down, and the ordering was a decision nobody had written
   * down as a decision. Non-empty by construction: withheld with no reason is
   * the undifferentiated "not available" this design exists to remove. */
  | Readonly<{ permitted: false; because: readonly [WithheldReason, ...WithheldReason[]] }>

/** Two namespaces, and only one of them is people.
 *
 * A mailbox is promoted into the user namespace on proven binding alone: an
 * exact directory-GUID match whose record states `userPurpose = 'user'`. Never
 * on UPN, email address, or display name. A shared, room, or equipment mailbox
 * also has a directory GUID, so a GUID is not evidence of a human — and a
 * distinct-user total is a claim about humans.
 *
 * An unpromoted mailbox stays a mailbox: reported, visible, and actionable, but
 * never counted as a user and never deduplicated against a sign-in subject. The
 * two ref spaces are unrelated, so comparing them as strings would silently
 * either merge two different people or split one.
 */
export type Subject =
  | Readonly<{ kind: 'DIRECTORY_USER'; userRef: string }>
  | Readonly<{ kind: 'MAILBOX'; mailboxRef: string; binding: MailboxBinding }>

/** Why a mailbox is not a user — and these are not the same answer.
 *
 * `RESOLVED_NEGATIVE`: binding succeeded and said this is a shared, room, or
 * equipment mailbox. It is genuinely not a person, so a finding on it leaves the
 * user total at zero and that zero is exactly true.
 *
 * `UNRESOLVED`: binding was attempted and failed — stale, missing, duplicate, or
 * ambiguous. We found something and cannot tell whether a person is behind it.
 * The honest user count is not zero, it is unknown: somewhere between zero and
 * the number of such findings.
 *
 * Collapsing these two into a bare "not a user" is what let a count of zero mean
 * both "no one is affected" and "we could not tell who is affected". The core
 * refuses an exact user total whenever an unresolved one is present, so that
 * distinction is enforced here rather than left to the classifier to remember. */
export type MailboxBinding = 'RESOLVED_NEGATIVE' | 'UNRESOLVED'

export type Finding = Readonly<{
  detectorId: string
  subject: Subject
  observedAt: string
}>

/** A detector reports how many events it actually looked at after its own
 * filtering, not how many it was handed. Without that, a detector that is
 * genuinely inapplicable and one that is silently dead produce identical
 * output — which is exactly the position the previous engine left us in, with
 * three rules that have never once run against real evidence. */
export type DetectorResult =
  | Readonly<{ status: 'RAN'; considered: number; findings: readonly Finding[] }>
  /** This evidence source cannot answer this detector's question at all — the
   * audit feed carries no conditional-access status, say. Requires a reason in
   * the detector's own words, held to the same standard as an exclusion
   * citation: a detector that could silently declare itself inapplicable would
   * be the veto pattern in one more costume. */
  | Readonly<{ status: 'INAPPLICABLE'; because: string }>

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
  /** Did not run, and should not have. Distinct from FAILED: a detector that
   * crashed might have found something, so it withholds the clean claim; one
   * the evidence cannot support was never going to answer, so it narrows the
   * claim's scope instead of blocking it. Conflating them would either make
   * three audit-only tenants permanently unable to report clean, or let a
   * crash quietly shrink the scope. */
  | Readonly<{ detectorId: string; status: 'INAPPLICABLE'; because: string }>

/** The count and what qualifies it, in one value. There is deliberately no way
 * to obtain the number alone: three honest counts beside a confident zero is a
 * better-documented version of the same lie, so the type makes the pair
 * inseparable rather than asking each caller to remember. */
export type Assessment = Readonly<{
  state: EvidenceState
  coverage: Coverage
  detectors: readonly DetectorReport[]
  /** Every finding, in both namespaces. Never filtered to what `count` counts. */
  findings: readonly Finding[]
  /** Distinct **directory users** with a finding — not findings, and not
   * subjects. Mailbox-scoped findings are absent from this number by design, so
   * a count of zero beside a non-empty `findings` is coherent rather than a
   * contradiction: no human was identified, and these mailboxes were still
   * found. A surface that renders this number as "nothing found" is wrong; it
   * has to read the findings.
   *
   * A mailbox whose binding could not be resolved must not be silently absent
   * from the user total — the classifier reports it in `coverage.unknown`, which
   * withholds the exact claim through the machinery already here. */
  count: Count
  claim: ZeroClaim
}>

/** Supplied by the caller and bounded by the request. The core holds no budget
 * of its own, so nothing below a caller can quietly impose a limit the caller
 * cannot widen. */
export type Budget = Readonly<{ maxEvents: number }>

/** What the caller has of a stream — and the events, when there are any, are
 * reachable only through the branch that says there are.
 *
 * This replaces a pair of booleans beside an events array, which let a caller
 * declare evidence unreadable and hand over rows from it in the same breath.
 * Nothing rejected that, so detectors would run over evidence we had just said
 * we could not read, and the assessment would report UNREADABLE_NOW while
 * carrying findings drawn from it. No caller did that, which is exactly the
 * problem: it was true by convention, and the next caller inherits no
 * convention. Coverage likewise belongs only to the read branch — evidence
 * never read has no counts to report, only a reason.
 */
export type Evidence<Event> =
  | Readonly<{ availability: 'NEVER_COLLECTED' }>
  | Readonly<{ availability: 'UNREADABLE_NOW' }>
  | Readonly<{
    availability: 'READ'
    applies: readonly Event[]
    coverage: Coverage
    /** When an event happened, as a sortable key.
     *
     * Truncation has to keep the most recent events, and the core is generic
     * over the event type so it cannot find a timestamp on its own. The first
     * version of this had the caller declare which end was newest — but a
     * declaration can be wrong, and a wrong one silently discards exactly the
     * events a technician needs. An accessor removes the declaration instead
     * of verifying it: there is no longer an ordering claim to be mistaken,
     * because the core reads the time itself.
     *
     * This is an ordering key, not a licence to interpret events. The core
     * compares the values and never inspects them. */
    timeOf: (event: Event) => number | string
  }>
