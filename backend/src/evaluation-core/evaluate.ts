import type {
  Assessment, Budget, Count, Coverage, Detector, DetectorReport, Evidence, EvidenceState, Finding,
  WithheldReason, ZeroClaim,
} from './contract.js'

/** Makes an unmapped case a compile error rather than a silent fall-through.
 * Every reason mapping here routes through it, because the defect it replaces
 * was a default arm that answered ten different questions with one sentence. */
export function unreachable(value: never): never {
  throw new Error(`Unhandled evaluation case: ${JSON.stringify(value)}`)
}

const total = (counts: Readonly<Record<string, number>>): number =>
  Object.values(counts).reduce((sum, count) => sum + count, 0)

/** Evidence we could not turn into an answer, whether we failed to read the row
 * or read it and could not interpret it. Both reduce what may be claimed, and
 * both stay separately reported — this sum exists only to gate, never to
 * display. Neither is ever added to `doesNotApply`. */
export const uninterpreted = (coverage: Coverage): number =>
  total(coverage.unknown) + total(coverage.unprocessable)

/** Events the rules correctly declined. Reported so a window made entirely of
 * them cannot look like a window that was examined. */
export const declined = (coverage: Coverage): number => total(coverage.doesNotApply)

/** Evidence we hold nothing of: no counts, because nothing was read to count. */
export const NO_COVERAGE: Coverage = Object.freeze({
  applies: 0, doesNotApply: {}, unknown: {}, unprocessable: {},
})

/** Read straight off the evidence, so the state cannot disagree with what the
 * caller actually has. Only the read branch can be partial, because only read
 * evidence has anything to be partial about. */
export function evidenceState(evidence: Evidence<unknown>): EvidenceState {
  switch (evidence.availability) {
    case 'NEVER_COLLECTED': return 'NEVER_COLLECTED'
    case 'UNREADABLE_NOW': return 'UNREADABLE_NOW'
    case 'READ': return uninterpreted(evidence.coverage) > 0 ? 'PARTIALLY_UNINTERPRETABLE' : 'FULLY_INTERPRETED'
    default: return unreachable(evidence)
  }
}

/** The single decision. Everything user-facing consumes this answer rather than
 * asking the same question again against a different bar.
 *
 * A failed detector is partial evidence about findings, so it withholds the
 * clean claim for the same reason partial evidence does: what it would have
 * found is unknown. It never erases what its neighbours found. */
export function zeroClaim(
  state: EvidenceState, coverage: Coverage, withinBudget: boolean, allDetectorsRan: boolean,
): ZeroClaim {
  if (!withinBudget) return { permitted: false, because: 'CAPACITY_EXCEEDED' }
  if (!allDetectorsRan) return { permitted: false, because: 'DETECTOR_FAILED' }
  switch (state) {
    case 'NEVER_COLLECTED': return { permitted: false, because: 'NEVER_COLLECTED' }
    case 'UNREADABLE_NOW': return { permitted: false, because: 'UNREADABLE_NOW' }
    case 'PARTIALLY_UNINTERPRETABLE': return { permitted: false, because: 'UNINTERPRETED_EVENTS' }
    case 'FULLY_INTERPRETED':
      // Nothing applicable means nothing was assessed. A zero drawn from an
      // empty denominator states a clean result the evidence never supported.
      return coverage.applies > 0 ? { permitted: true } : { permitted: false, because: 'NOTHING_APPLICABLE' }
    default: return unreachable(state)
  }
}

/** Distinct directory users carrying a finding.
 *
 * Mailbox-scoped findings are deliberately not counted and not deduplicated
 * against user refs: the two namespaces are unrelated, so a mailbox ref that
 * happened to equal a user ref would merge two different subjects, and one
 * person's mailbox and sign-in refs differing would split one. A mailbox enters
 * this total only once the classifier has promoted it on proven binding.
 *
 * Used by both the per-stream and the tenant path, so the two cannot drift into
 * counting differently — which is how a headline and its caption disagreed. */
export const distinctUsers = (findings: readonly Finding[]): number =>
  new Set(findings.flatMap(finding =>
    finding.subject.kind === 'DIRECTORY_USER' ? [finding.subject.userRef] : [])).size

/** Zero only ever arrives through the exact branch. A lower bound of zero is
 * unrepresentable here rather than merely discouraged.
 *
 * Takes a boolean rather than a claim on purpose. It needs only whether a clean
 * result was permitted, and accepting a whole claim meant callers had to supply
 * a `because` it then ignored — so a caller composing several withheld streams
 * had to pick one reason and discard the rest to satisfy the type, in a place
 * no assertion could observe. QA found exactly that by mutation: substituting a
 * wrong reason changed nothing and every test still passed. Narrowing the
 * parameter deletes the opportunity instead of testing for it. */
export function countOf(distinctSubjects: number, permitted: boolean): Count {
  if (permitted) return { accuracy: 'EXACT', value: distinctSubjects }
  return distinctSubjects > 0
    ? { accuracy: 'AT_LEAST', value: distinctSubjects }
    : { accuracy: 'NOT_AVAILABLE', value: null }
}

export function withheldExplanation(reason: WithheldReason): string {
  switch (reason) {
    case 'NEVER_COLLECTED': return 'This evidence has not been collected yet, so nothing has been assessed.'
    case 'UNREADABLE_NOW': return 'This evidence could not be read just now. It has not been reported as clear.'
    case 'UNINTERPRETED_EVENTS': return 'Some events in this window could not be interpreted, so a clean result cannot be claimed for it.'
    case 'NOTHING_APPLICABLE': return 'No event in this window was one these checks assess, so there was nothing to find.'
    case 'CAPACITY_EXCEEDED': return 'This window held more events than can be assessed at once, so it was not assessed in full.'
    case 'DETECTOR_FAILED': return 'One of the checks could not complete, so anything it would have found is unknown. The other checks reported normally.'
    default: return unreachable(reason)
  }
}

/** Runs the detectors over events that were classified elsewhere.
 *
 * The core never sees an unclassified event and holds no classifier, so
 * "classified exactly once" is structural rather than a rule someone has to
 * follow. Detectors receive only what applied and cannot influence coverage, so
 * an event nobody could interpret cannot suppress a finding another supports,
 * and no detector can veto another's.
 */
export function evaluate<Event>(input: Readonly<{
  /** Already classified and counted by the layer that knows what the fields
   * mean. Events exist only on the READ branch, so there is no way to hand this
   * function rows from evidence the caller has declared it could not read. */
  evidence: Evidence<Event>
  detectors: readonly Detector<Event>[]
  budget: Budget
}>): Assessment {
  const state = evidenceState(input.evidence)
  if (input.evidence.availability !== 'READ') {
    // Nothing was read, so nothing ran. An empty detector list is the honest
    // report — not a list of detectors credited with having considered zero
    // events, which reads like a healthy silent detector.
    const claim = zeroClaim(state, NO_COVERAGE, true, true)
    return { state, coverage: NO_COVERAGE, detectors: [], findings: [], count: countOf(0, claim.permitted), claim }
  }

  const { applies, coverage, order } = input.evidence
  const withinBudget = applies.length <= input.budget.maxEvents
  // Over budget, keep the most recent. Truncation is safe in one direction —
  // fewer events can break a window and miss a real pattern, but cannot invent
  // one — so this only decides which subset a technician sees, and a tool that
  // shows last month's attack while hiding today's is the worse choice. The
  // claim is withheld as CAPACITY_EXCEEDED either way, so nobody is misled
  // about completeness. Which end is recent comes from the caller's declared
  // order, because the core cannot read a timestamp off a generic event.
  const applicable = withinBudget
    ? applies
    : order === 'OLDEST_FIRST'
      ? applies.slice(applies.length - input.budget.maxEvents)
      : applies.slice(0, input.budget.maxEvents)

  const findings: Finding[] = []
  const reports: DetectorReport[] = []
  // A detector that cannot run is that detector's failure alone. Erasing its
  // neighbours' findings would be the same veto this design exists to remove,
  // so the failure is isolated, reported, and costs only the exact claim.
  for (const detector of input.detectors) {
    try {
      const result = detector.run(applicable)
      findings.push(...result.findings)
      reports.push({ detectorId: detector.id, status: 'RAN', considered: result.considered, matched: result.findings.length })
    } catch {
      reports.push({ detectorId: detector.id, status: 'FAILED' })
    }
  }

  const claim = zeroClaim(state, coverage, withinBudget, reports.every(report => report.status === 'RAN'))
  return {
    state,
    coverage,
    detectors: reports,
    findings,
    count: countOf(distinctUsers(findings), claim.permitted),
    claim,
  }
}
