import {
  DOES_NOT_APPLY_REASONS, UNKNOWN_REASONS,
  type Assessment, type Budget, type Classifier, type Count, type Coverage,
  type Detector, type DetectorReport, type EvidenceState, type Finding, type WithheldReason, type ZeroClaim,
} from './contract.js'

/** Makes an unmapped case a compile error rather than a silent fall-through.
 * Every reason mapping in this module routes through it, because the defect it
 * replaces was a default arm that answered ten questions with one sentence. */
export function unreachable(value: never): never {
  throw new Error(`Unhandled evaluation case: ${JSON.stringify(value)}`)
}

const emptyCoverage = (): Coverage => ({
  applies: 0,
  doesNotApply: Object.fromEntries(DOES_NOT_APPLY_REASONS.map(reason => [reason, 0])) as Coverage['doesNotApply'],
  unknown: Object.fromEntries(UNKNOWN_REASONS.map(reason => [reason, 0])) as Coverage['unknown'],
})

export const uninterpretedCount = (coverage: Coverage): number =>
  UNKNOWN_REASONS.reduce((total, reason) => total + coverage.unknown[reason], 0)

export const declinedCount = (coverage: Coverage): number =>
  DOES_NOT_APPLY_REASONS.reduce((total, reason) => total + coverage.doesNotApply[reason], 0)

/** Derives the state from what the classification actually produced, so the
 * state cannot disagree with the coverage it is meant to describe. A caller
 * supplies only the two conditions it alone knows. */
export function evidenceState(coverage: Coverage, collected: boolean, readable: boolean): EvidenceState {
  if (!collected) return 'NEVER_COLLECTED'
  if (!readable) return 'UNREADABLE_NOW'
  return uninterpretedCount(coverage) > 0 ? 'PARTIALLY_UNINTERPRETABLE' : 'FULLY_INTERPRETED'
}

/** The single decision. Everything user-facing consumes this answer instead of
 * asking the same question again with a different bar.
 *
 * A failed detector is partial evidence about findings, so it withholds the
 * clean claim for the same reason partial evidence does: what it would have
 * found is unknown. It does not erase what its neighbours found. */
export function zeroClaim(state: EvidenceState, coverage: Coverage, withinBudget: boolean, allDetectorsRan = true): ZeroClaim {
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

/** Zero only ever arrives through the exact branch. A lower bound of zero is
 * unrepresentable here rather than merely discouraged. */
export function countOf(distinctSubjects: number, claim: ZeroClaim): Count {
  if (claim.permitted) return { accuracy: 'EXACT', value: distinctSubjects }
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

/** Runs the classification once, then the detectors over what applied.
 *
 * Detectors never see the classification and cannot alter it, so an event no
 * detector matches is not thereby a gap, and an event we could not interpret
 * cannot suppress a finding that another event supports.
 */
export function evaluate<Event>(input: Readonly<{
  events: readonly Event[]
  classify: Classifier<Event>
  detectors: readonly Detector<Event>[]
  budget: Budget
  collected: boolean
  readable: boolean
}>): Assessment {
  const withinBudget = input.events.length <= input.budget.maxEvents
  const considered = withinBudget ? input.events : input.events.slice(0, input.budget.maxEvents)
  const coverage = emptyCoverage()
  const doesNotApply = { ...coverage.doesNotApply }
  const unknown = { ...coverage.unknown }
  const applicable: Event[] = []

  for (const event of considered) {
    const disposition = input.classify(event)
    switch (disposition.kind) {
      case 'APPLIES': applicable.push(event); break
      case 'DOES_NOT_APPLY': doesNotApply[disposition.reason] += 1; break
      case 'UNKNOWN': unknown[disposition.reason] += 1; break
      default: unreachable(disposition)
    }
  }

  const counted: Coverage = { applies: applicable.length, doesNotApply, unknown }
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

  const state = evidenceState(counted, input.collected, input.readable)
  const claim = zeroClaim(state, counted, withinBudget, reports.every(report => report.status === 'RAN'))
  return {
    state,
    coverage: counted,
    detectors: reports,
    findings,
    count: countOf(new Set(findings.map(finding => finding.subject)).size, claim),
    claim,
  }
}
