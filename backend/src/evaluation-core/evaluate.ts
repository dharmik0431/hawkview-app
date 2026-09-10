import type {
  Assessment, Budget, Count, CountScope, Coverage, Detector, DetectorReport, Evidence, EvidenceState, Finding,
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
export function evidenceState<Event>(evidence: Evidence<Event>): EvidenceState {
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
export function zeroClaim(input: Readonly<{
  state: EvidenceState
  coverage: Coverage
  withinBudget: boolean
  allDetectorsRan: boolean
  /** False when any finding names a subject we could not attribute. A count of
   * people cannot be exact while we hold a finding and cannot say whose it is. */
  allSubjectsResolved: boolean
}>): ZeroClaim {
  const { state, coverage, withinBudget, allDetectorsRan, allSubjectsResolved } = input
  const reasons: WithheldReason[] = []
  if (!withinBudget) reasons.push('CAPACITY_EXCEEDED')
  if (!allDetectorsRan) reasons.push('DETECTOR_FAILED')
  if (!allSubjectsResolved) reasons.push('UNRESOLVED_SUBJECT_IDENTITY')

  const fromState = ((): WithheldReason | null => {
    switch (state) {
      case 'NEVER_COLLECTED': return 'NEVER_COLLECTED'
      case 'UNREADABLE_NOW': return 'UNREADABLE_NOW'
      case 'PARTIALLY_UNINTERPRETABLE': return 'UNINTERPRETED_EVENTS'
      // Nothing applicable means nothing was assessed. A zero drawn from an
      // empty denominator states a clean result the evidence never supported.
      case 'FULLY_INTERPRETED': return coverage.applies > 0 ? null : 'NOTHING_APPLICABLE'
      default: return unreachable(state)
    }
  })()
  if (fromState !== null) reasons.push(fromState)

  const [first, ...rest] = reasons
  return first === undefined ? { permitted: true } : { permitted: false, because: [first, ...rest] }
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

/** Findings we hold but cannot attribute to anyone.
 *
 * A mailbox whose binding failed might belong to a person or might be a meeting
 * room; nothing in the evidence says which. So while one of these is present the
 * user total is a range, not a number, and the exact claim is refused. This is
 * the structural half of the two-namespace rule: without it, "we could not tell
 * whose this is" and "nobody is affected" both render as a confident zero. */
export const unattributedFindings = (findings: readonly Finding[]): number =>
  findings.filter(finding => finding.subject.kind === 'MAILBOX' && finding.subject.binding === 'UNRESOLVED').length

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
export function countOf(distinctSubjects: number, permitted: boolean, scope: CountScope): Count {
  if (permitted) return { accuracy: 'EXACT', value: distinctSubjects, scope }
  return distinctSubjects > 0
    ? { accuracy: 'AT_LEAST', value: distinctSubjects, scope }
    : { accuracy: 'NOT_AVAILABLE', value: null, scope }
}

/** Derived from the reports once, so the scope and the detector list cannot
 * drift into telling different stories about the same run. */
export function scopeOf(reports: readonly DetectorReport[]): CountScope {
  return {
    covered: reports.flatMap(report => report.status === 'RAN' ? [report.detectorId] : []),
    notCovered: reports.flatMap(report =>
      report.status === 'INAPPLICABLE' ? [{ detectorId: report.detectorId, because: report.because }] : []),
  }
}

/** The most recent events, by the caller's own time accessor.
 *
 * Ties keep the later position, so a run over identical inputs selects
 * identically. Input order is preserved among the survivors: detectors may
 * depend on the sequence they were handed, and reordering here would change
 * what they see for reasons unrelated to the budget.
 */
function mostRecent<Event>(
  applies: readonly Event[], limit: number, timeOf: (event: Event) => number | string,
): readonly Event[] {
  if (limit <= 0) return []
  const ranked = applies
    .map((event, index) => ({ index, at: timeOf(event) }))
    .sort((left, right) => left.at < right.at ? 1 : left.at > right.at ? -1 : right.index - left.index)
    .slice(0, limit)
    .map(entry => entry.index)
    .sort((left, right) => left - right)
  return ranked.map(index => applies[index]!)
}

export function withheldExplanation(reason: WithheldReason): string {
  switch (reason) {
    case 'NEVER_COLLECTED': return 'This evidence has not been collected yet, so nothing has been assessed.'
    case 'UNREADABLE_NOW': return 'This evidence could not be read just now. It has not been reported as clear.'
    case 'UNINTERPRETED_EVENTS': return 'Some events in this window could not be interpreted, so a clean result cannot be claimed for it.'
    case 'NOTHING_APPLICABLE': return 'No event in this window was one these checks assess, so there was nothing to find.'
    case 'CAPACITY_EXCEEDED': return 'This window held more events than can be assessed at once, so it was not assessed in full.'
    case 'DETECTOR_FAILED': return 'One of the checks could not complete, so anything it would have found is unknown. The other checks reported normally.'
    case 'UNRESOLVED_SUBJECT_IDENTITY': return 'Something was found on a mailbox we could not match to a person, so the number of people affected cannot be stated exactly. The findings themselves are listed.'
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
    const claim = zeroClaim({
      state, coverage: NO_COVERAGE, withinBudget: true, allDetectorsRan: true, allSubjectsResolved: true,
    })
    return {
      state,
      coverage: NO_COVERAGE,
      detectors: [],
      findings: [],
      // Nothing ran, so nothing is covered. An empty scope beside a
      // not-available count says exactly that, without implying a check
      // was skipped for a reason of its own.
      count: countOf(0, claim.permitted, { covered: [], notCovered: [] }),
      claim,
    }
  }

  const { applies, coverage, timeOf } = input.evidence
  const withinBudget = applies.length <= input.budget.maxEvents
  // Over budget, keep the most recent: a window that overflows is precisely one
  // where something may be happening now, and showing last month's findings
  // while dropping today's is the worse failure. The claim is withheld as
  // CAPACITY_EXCEEDED either way, so nobody is told the window was complete.
  const applicable = withinBudget ? applies : mostRecent(applies, input.budget.maxEvents, timeOf)

  const findings: Finding[] = []
  const reports: DetectorReport[] = []
  // A detector that cannot run is that detector's failure alone. Erasing its
  // neighbours' findings would be the same veto this design exists to remove,
  // so the failure is isolated, reported, and costs only the exact claim.
  for (const detector of input.detectors) {
    try {
      const result = detector.run(applicable)
      if (result.status === 'INAPPLICABLE') {
        // A blank reason is a silent opt-out, and opting out silently is the
        // veto pattern again: the detector removes itself from the answer and
        // nothing tells a reader what stopped being checked. The type can
        // require the field but not that it says anything, so an empty one is
        // treated as the detector failing to produce a usable result — which
        // gates, the safe direction, and makes silence expensive rather than
        // free.
        if (result.because.trim() === '') {
          reports.push({ detectorId: detector.id, status: 'FAILED' })
          continue
        }
        // Narrows what the count answers rather than blocking it. Unlike a
        // crash, nothing was lost: this evidence was never going to carry the
        // answer, and saying so is more useful than withholding the tenant's
        // claim because of a licence it does not hold.
        reports.push({ detectorId: detector.id, status: 'INAPPLICABLE', because: result.because })
        continue
      }
      findings.push(...result.findings)
      reports.push({ detectorId: detector.id, status: 'RAN', considered: result.considered, matched: result.findings.length })
    } catch {
      reports.push({ detectorId: detector.id, status: 'FAILED' })
    }
  }

  const claim = zeroClaim({
    state,
    coverage,
    withinBudget,
    // An inapplicable detector is not a failed one. Only a crash leaves what it
    // would have found unknown; evidence that cannot carry a question narrows
    // the scope instead, which is why that distinction is a status and not a
    // boolean.
    allDetectorsRan: reports.every(report => report.status !== 'FAILED'),
    allSubjectsResolved: unattributedFindings(findings) === 0,
  })
  return {
    state,
    coverage,
    detectors: reports,
    findings,
    count: countOf(distinctUsers(findings), claim.permitted, scopeOf(reports)),
    claim,
  }
}
