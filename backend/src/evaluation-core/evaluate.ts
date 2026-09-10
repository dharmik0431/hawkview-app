import type {
  Assessment, Budget, CollectionScope, Count, CountScope, Coverage, Detector, DetectorReport, Evidence, EvidenceState, Finding,
  FindingGap, FindingSet,
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
  // Nothing was read, so the request is beside the point — the claim is already
  // withheld for never-collected or unreadable, and adding a second reason about
  // an unrecorded request would be noise rather than information.
  collectionScope: { declared: true, asked: 'none — no evidence was read' },
  applies: 0, doesNotApply: {}, notYetCited: {}, unknown: {}, unprocessable: {},
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
export type ClaimBasis =
  /** Nothing was read, so there are no events, no coverage, no detectors and no
   * findings to attribute. QA found the previous shape would accept "never
   * collected" alongside an unattributed finding — incoherent, unreachable
   * through `evaluate`, and reachable through this function, which is exported.
   * The same gap the Evidence union closed, one level along. */
  | Readonly<{ read: false; because: 'NEVER_COLLECTED' | 'UNREADABLE_NOW' }>
  | Readonly<{
    read: true
    coverage: Coverage
    withinBudget: boolean
    allDetectorsRan: boolean
    /** False when any finding names a subject we could not attribute. A count of
     * people cannot be exact while we hold a finding and cannot say whose it is. */
    allSubjectsResolved: boolean
    /** False when no check examined a single event. Distinct from a check that
     * could not run: these ran, accounted for everything, and assessed none of
     * it, which is honest and still cannot support a confident zero. */
    anyCheckExaminedEvidence: boolean
  }>

export function zeroClaim(basis: ClaimBasis): ZeroClaim {
  if (!basis.read) return { permitted: false, because: [basis.because] }

  const { coverage, withinBudget, allDetectorsRan, allSubjectsResolved, anyCheckExaminedEvidence } = basis
  const reasons: WithheldReason[] = []
  if (!withinBudget) reasons.push('CAPACITY_EXCEEDED')
  if (!allDetectorsRan) reasons.push('DETECTOR_FAILED')
  if (!allSubjectsResolved) reasons.push('UNRESOLVED_SUBJECT_IDENTITY')
  // The sum invariant proves a detector's accounting is COMPLETE. It proves
  // nothing was EXAMINED: considered 0 with 1,000 declined balances perfectly.
  // So the same guard as coverage.applies > 0, one layer further in.
  if (!anyCheckExaminedEvidence) reasons.push('NO_CHECK_EXAMINED_EVIDENCE')
  // A narrower request is a DIFFERENT QUESTION, not an incomplete answer to the
  // same one — which is why it narrows the scope rather than withholding. A
  // truncated window and a crashed detector are incomplete answers to the
  // question we did ask; 'interactive sign-ins only' is a complete answer to a
  // smaller one. An UNSTATED scope is neither: not a narrower question but an
  // unknown one, so it withholds.
  //
  // (I first defended this line by saying the alternative would leave the word
  // "complete" unreachable. QA was right that this is an argument from
  // consequence — what goes wrong elsewhere, not where truth puts the line —
  // and that kind of reasoning is how "we may have missed some" and "we never
  // asked" got conflated in the first place.)
  if (!coverage.collectionScope.declared) reasons.push('COLLECTION_SCOPE_UNDECLARED')
  // Derived here rather than passed in beside the coverage it describes: two
  // inputs saying the same thing is two inputs that can disagree.
  if (uninterpreted(coverage) > 0) reasons.push('UNINTERPRETED_EVENTS')
  // Nothing applicable means nothing was assessed. A zero drawn from an empty
  // denominator states a clean result the evidence never supported.
  else if (coverage.applies === 0) reasons.push('NOTHING_APPLICABLE')

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
/** A check that examined nothing covers nothing.
 *
 * `considered: 0` with everything declined is an honest report — the
 * fully-excluded case, complete accounting, nothing to look at — but it is not
 * a question that was answered, so it belongs beside the checks that could not
 * run rather than among the checks a zero rests on. Listing it as covered is
 * how "ran and found nothing" stayed believable over events nobody looked at. */
const examinedSomething = (report: DetectorReport): boolean =>
  report.status === 'RAN' && report.considered > 0

/** Whether this detector's silence is trustworthy — it either answered, or
 * declined for a stated reason. Only a crash leaves what it would have found
 * unknown.
 *
 * Written as explicit membership rather than "anything except FAILED", on
 * Engineer 3's finding: an exclusion definition ABSORBS NEW MEMBERS. A future
 * status would have been silently enrolled here as trustworthy and would have
 * quietly stopped gating the claim, which is the one direction that costs us a
 * real finding. The switch makes a new status a compile error instead. */
const answeredOrDeclined = (report: DetectorReport): boolean => {
  switch (report.status) {
    case 'RAN': return true
    case 'INAPPLICABLE': return true
    case 'FAILED': return false
    default: return unreachable(report)
  }
}

export function scopeOf(reports: readonly DetectorReport[], coverage: Coverage): CountScope {
  return {
    evidenceRequested: coverage.collectionScope.declared ? [coverage.collectionScope.asked] : [],
    scopeUnsettled: { ...coverage.notYetCited },
    covered: reports.flatMap(report => examinedSomething(report) ? [report.detectorId] : []),
    notCovered: reports.flatMap(report => {
      if (report.status === 'INAPPLICABLE') return [{ detectorId: report.detectorId, because: report.because }]
      if (report.status === 'RAN' && report.considered === 0) {
        return [{
          detectorId: report.detectorId,
          because: 'This check assessed none of the events it was given, so it has not cleared any of them.',
        }]
      }
      return []
    }),
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

/** Not exported. QA grepped every caller: outside this file, nothing used it,
 * so the convenient wrong call — withheldExplanation(claim.because[0]) — had no
 * legitimate user and could be deleted rather than discouraged. Reaching for one
 * reason where there may be four is now a compile error in the wiring instead of
 * a style question, which is what withheld[0]! taught us twice. */
function withheldExplanation(reason: WithheldReason): string {
  switch (reason) {
    case 'NEVER_COLLECTED': return 'This evidence has not been collected yet, so nothing has been assessed.'
    case 'UNREADABLE_NOW': return 'This evidence could not be read just now. It has not been reported as clear.'
    case 'UNINTERPRETED_EVENTS': return 'Some events in this window could not be interpreted, so a clean result cannot be claimed for it.'
    case 'NOTHING_APPLICABLE': return 'No event in this window was one these checks assess, so there was nothing to find.'
    case 'CAPACITY_EXCEEDED': return 'This window held more events than can be assessed at once, so it was not assessed in full.'
    case 'DETECTOR_FAILED': return 'One of the checks could not complete, so anything it would have found is unknown. The other checks reported normally.'
    case 'UNRESOLVED_SUBJECT_IDENTITY': return 'Something was found on a mailbox we could not match to a person, so the number of people affected cannot be stated exactly. The findings themselves are listed.'
    case 'COLLECTION_SCOPE_UNDECLARED': return 'There is no record of what was requested from Microsoft for this window, so what a clean result would cover cannot be stated.'
    case 'NO_CHECK_EXAMINED_EVIDENCE': return 'None of the checks assessed a single event in this window, so there is nothing for a clear result to rest on.'
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
    const claim = zeroClaim({ read: false, because: input.evidence.availability })
    return {
      state,
      coverage: NO_COVERAGE,
      detectors: [],
      findings: { items: [], complete: true },
      // Nothing ran, so nothing is covered. An empty scope beside a
      // not-available count says exactly that, without implying a check
      // was skipped for a reason of its own.
      count: countOf(0, claim.permitted, { evidenceRequested: [], scopeUnsettled: {}, covered: [], notCovered: [] }),
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
    // A truncated window is a different question from the one a non-monotonic
    // detector was written to answer. Running it anyway does not risk a missing
    // finding, it risks a fabricated one: an absence-keyed rule fires precisely
    // BECAUSE the disconfirming event was the one we dropped. So it does not
    // run, and says why — the same INAPPLICABLE machinery, a different cause.
    if (!withinBudget && !detector.monotonic) {
      reports.push({
        detectorId: detector.id,
        status: 'INAPPLICABLE',
        because: 'This check reads a whole window, and this window held more events than could be assessed at once.',
      })
      continue
    }
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
      // What it found is kept either way. Discarding real findings because a
      // counter was wrong would be the veto pattern in its smallest costume.
      findings.push(...result.findings)

      // The detector must account for every event it was handed: what it
      // assessed, plus where the rest went, in its own words.
      //
      // A range check would only have caught a detector claiming MORE than it
      // was given — the harmless direction, an embarrassing counter on a
      // detector that still looked at everything. Claiming FEWER passes a range
      // check happily, and that is the dangerous one: a detector that narrows
      // its own input and tells nobody has silently discarded evidence and then
      // supported a confident zero with the remainder. That is this project's
      // headline defect, and the detector interior was the one level with no
      // accounting at all.
      //
      // Filtering internally is legitimate — the interrupt rule acts only on
      // the post-password family. Failing to say where the rest went is not.
      const declinedTotal = total(result.declined)
      const accountsForItself =
        Number.isInteger(result.considered) && result.considered >= 0
        && Object.values(result.declined).every(count => Number.isInteger(count) && count >= 0)
        // A blank reason is a silent opt-out wearing a number, same as a blank
        // inapplicability reason.
        && Object.keys(result.declined).every(reason => reason.trim() !== '')
        && result.considered + declinedTotal === applicable.length
      if (!accountsForItself) {
        reports.push({ detectorId: detector.id, status: 'FAILED' })
        continue
      }
      reports.push({
        detectorId: detector.id,
        status: 'RAN',
        considered: result.considered,
        declined: result.declined,
        matched: result.findings.length,
      })
    } catch {
      reports.push({ detectorId: detector.id, status: 'FAILED' })
    }
  }

  const claim = zeroClaim({
    read: true,
    coverage,
    withinBudget,
    // An inapplicable detector is not a failed one. Only a crash leaves what it
    // would have found unknown; evidence that cannot carry a question narrows
    // the scope instead, which is why that distinction is a status and not a
    // boolean.
    allDetectorsRan: reports.every(answeredOrDeclined),
    allSubjectsResolved: unattributedFindings(findings) === 0,
    anyCheckExaminedEvidence: reports.some(examinedSomething),
  })
  return {
    state,
    coverage,
    detectors: reports,
    findings: findingSet(findings, {
      truncated: !withinBudget,
      detectorFailed: reports.some(report => report.status === 'FAILED'),
      checkNotRun: reports.some(report => report.status === 'INAPPLICABLE'),
      requestUnknown: !coverage.collectionScope.declared,
    }),
    count: countOf(distinctUsers(findings), claim.permitted, scopeOf(reports, coverage)),
    claim,
  }
}

/** Pairs the findings with whether they are all of them.
 *
 * A detector that could not run at all is deliberately NOT a gap here — that is
 * the count's scope, and merging the two would lose which of "we may have missed
 * some" and "we never asked this question" applies. */
export function findingSet(
  items: readonly Finding[],
  gaps: Readonly<{ truncated: boolean; detectorFailed: boolean; checkNotRun: boolean; requestUnknown: boolean }>,
): FindingSet {
  const because: FindingGap[] = []
  if (gaps.truncated) because.push('WINDOW_TRUNCATED')
  if (gaps.detectorFailed) because.push('DETECTOR_FAILED')
  // QA's catch: `complete` said nothing about WHICH questions it was complete
  // for, so a findings table could read "that is all of it" while the count's
  // scope said a check never ran. One question, two answers, either misleading
  // alone. The per-detector detail stays in CountScope; this is only the answer.
  if (gaps.checkNotRun) because.push('CHECK_NOT_RUN')
  if (gaps.requestUnknown) because.push('EVIDENCE_REQUEST_UNKNOWN')
  const [first, ...rest] = because
  return first === undefined ? { items, complete: true } : { items, complete: false, because: [first, ...rest] }
}

/** Every sentence a withheld claim needs to say, in one call.
 *
 * The per-reason function is deliberately not exported, so this is the only way
 * to ask. A caller reaching for one sentence where there may be four would
 * silently re-create, in the presentation layer, the one-reason collapse this
 * module removed twice inside itself — and that call now does not exist.
 *
 * Returns an array, and is named plural, because a field called `reason` is an
 * invitation and a field called `reasons` is a hint. That is a mitigation, not
 * a guarantee: a consumer can still take the first element, which is why this
 * is also something the acceptance gate checks rather than something the type
 * system settles. */
export function withheldExplanations(claim: ZeroClaim): readonly string[] {
  return claim.permitted ? [] : claim.because.map(withheldExplanation)
}
