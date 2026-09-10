import assert from 'node:assert/strict'
import test from 'node:test'
import {
  countOf, declined, evaluate, uninterpreted, withheldExplanations, zeroClaim,
} from './evaluate.js'
import type { Coverage, Detector, Finding, WithheldReason } from './contract.js'
import { figure } from './test-support.js'

/** The per-reason sentence, reached through the plural because the singular is
 * no longer exported. Clunkier here, and the clunkiness is the point: asking for
 * one reason should require saying you have exactly one. */
const sentenceFor = (reason: WithheldReason): string =>
  withheldExplanations({ permitted: false, because: [reason] })[0]!

type Event = Readonly<{ id: string; subject: string; match?: boolean; at?: number }>

const event = (id: string, extra: Partial<Event> = {}): Event => ({ id, subject: `user-${id}`, ...extra })

/** Stands in for what the classification layer reports. The core never builds
 * one of these, which is the point — it cannot classify, only consume. */
const coverage = (parts: Partial<Coverage> = {}): Coverage => ({
  collectionScope: { declared: true, asked: 'test fixture: all rows' },
  applies: 0, doesNotApply: {}, notYetCited: {}, unknown: {}, unprocessable: {}, ...parts,
})

/** Sign-in events carry a directory user, so this detector's findings are about
 * people and do count. Contrast the mailbox detector, whose findings are not. */
const user = (userRef: string) => (
  { kind: 'DIRECTORY_USER', userRef, correlation: { available: true, shape: 'DIRECTORY_OBJECT_ID', ref: 'guid-' + userRef } } as const)

const matching: Detector<Event> = {
  id: 'matches-flagged',
  monotonic: true,
  run: applicable => ({
    status: 'RAN', considered: applicable.length, declined: {},
    findings: applicable.filter(item => item.match)
      .map(item => ({ detectorId: 'matches-flagged', subject: user(item.subject), observedAt: '2026-09-10T00:00:00.000Z' })),
  }),
}
const silent: Detector<Event> = { id: 'silent', monotonic: true, run: applicable => ({ status: 'RAN', considered: applicable.length, declined: {}, findings: [] }) }
const broken: Detector<Event> = { id: 'broken', monotonic: true, run: () => { throw new Error('detector fault') } }

const run = (applies: readonly Event[], options: Partial<{
  coverage: Coverage; detectors: readonly Detector<Event>[]; maxEvents: number
}> = {}) => evaluate<Event>({
  evidence: {
    availability: 'READ',
    applies,
    coverage: options.coverage ?? coverage({ applies: applies.length }),
    timeOf: item => item.at ?? 0,
  },
  detectors: options.detectors ?? [matching, silent],
  budget: { maxEvents: options.maxEvents ?? 1000 },
})

/** Unread evidence carries no events and no coverage — the type admits no other
 * shape, which is the point of this branch existing. */
const unread = (availability: 'NEVER_COLLECTED' | 'UNREADABLE_NOW',
  detectors: readonly Detector<Event>[] = [matching, silent]) =>
  evaluate<Event>({ evidence: { availability }, detectors, budget: { maxEvents: 1000 } })

test('an event nobody could interpret never blocks a finding another event supports', () => {
  // The whole point. Under the previous design one unrecognized row took the
  // entire rule to not-evaluated, so this finding would have been suppressed.
  const result = run([event('1', { match: true })],
    { coverage: coverage({ applies: 1, unknown: { UNRECOGNIZED_OUTCOME: 1 } }) })
  assert.equal(result.findings.items.length, 1)
  assert.equal(uninterpreted(result.coverage), 1)
  // It reduces what we claim, and only that.
  assert.equal(result.state, 'PARTIALLY_UNINTERPRETABLE')
  assert.deepEqual(result.claim, { permitted: false, because: ['UNINTERPRETED_EVENTS'] })
  assert.deepEqual(figure(result.count), { accuracy: 'AT_LEAST', value: 1 })
})

test('a row we could not read and an outcome we could not interpret both gate, and stay apart', () => {
  const unreadRow = run([event('1')], { coverage: coverage({ applies: 1, unprocessable: { MALFORMED_ROW: 2 } }) })
  const unreadOutcome = run([event('1')], { coverage: coverage({ applies: 1, unknown: { UNRECOGNIZED_OUTCOME: 2 } }) })
  for (const result of [unreadRow, unreadOutcome]) {
    assert.equal(result.state, 'PARTIALLY_UNINTERPRETABLE')
    assert.deepEqual(result.claim, { permitted: false, because: ['UNINTERPRETED_EVENTS'] })
  }
  // Both gate, but the core never merges them — the maps travel through intact,
  // so a reader can still tell "could not read the row" from "could not tell
  // what it meant", which dispatch a technician to different places.
  assert.deepEqual(unreadRow.coverage.unprocessable, { MALFORMED_ROW: 2 })
  assert.deepEqual(unreadRow.coverage.unknown, {})
  assert.deepEqual(unreadOutcome.coverage.unknown, { UNRECOGNIZED_OUTCOME: 2 })
  assert.deepEqual(unreadOutcome.coverage.unprocessable, {})
})

test('a lower bound is never zero, and zero arrives only through the exact branch', () => {
  const nothingFound = run([event('1')], { coverage: coverage({ applies: 1, unknown: { UNRECOGNIZED_OUTCOME: 1 } }) })
  assert.deepEqual(figure(nothingFound.count), { accuracy: 'NOT_AVAILABLE', value: null })

  const clean = run([event('1')])
  assert.deepEqual(figure(clean.count), { accuracy: 'EXACT', value: 0 })
  assert.deepEqual(clean.claim, { permitted: true })

  // Exhaustive: no combination of inputs yields a zero-valued lower bound.
  for (const permitted of [true, false]) {
    for (const subjects of [0, 1, 5]) {
      const count = countOf(subjects, permitted, { evidenceRequested: [], covered: [], notCovered: [] })
      assert.ok(!(count.accuracy === 'AT_LEAST' && count.value === 0))
      if (count.accuracy === 'EXACT') assert.equal(permitted, true, 'exact requires the claim to be permitted')
    }
  }
})

test('declined events do not reduce coverage and are never merged with unread evidence', () => {
  const result = run([event('1', { match: true })],
    { coverage: coverage({ applies: 1, doesNotApply: { NON_INTERACTIVE: 40, APPLICATION_ACTOR: 2 } }) })
  assert.equal(declined(result.coverage), 42)
  assert.equal(uninterpreted(result.coverage), 0)
  // Declining an event is the rules working, so a clean claim survives it.
  assert.equal(result.state, 'FULLY_INTERPRETED')
  assert.deepEqual(result.claim, { permitted: true })
  assert.deepEqual(figure(result.count), { accuracy: 'EXACT', value: 1 })
  // Broken out by reason, so background traffic cannot bury the exclusion an
  // investigator would care about beneath a large token-refresh number.
  assert.deepEqual(result.coverage.doesNotApply, { NON_INTERACTIVE: 40, APPLICATION_ACTOR: 2 })
})

test('a window where nothing applied cannot report a confident zero', () => {
  // The live production defect: everything set aside, nothing assessed, and a
  // headline zero captioned as though the evidence had been examined.
  const result = run([], { coverage: coverage({ applies: 0, doesNotApply: { NOT_A_CREDENTIAL_EVENT: 12 } }) })
  // Two reasons now, and both are true: no event applied, and no check assessed
  // anything. Reporting only the first would answer a question nobody asked.
  assert.deepEqual([...(result.claim.permitted === false ? result.claim.because : [])].sort(),
    ['NOTHING_APPLICABLE', 'NO_CHECK_EXAMINED_EVIDENCE'])
  assert.deepEqual(figure(result.count), { accuracy: 'NOT_AVAILABLE', value: null })
})

test('a partly declined window is judged by what applied, not by the ratio', () => {
  // Eight declined and four assessed still permits a clean claim: the four were
  // genuinely assessed and the eight genuinely did not apply. There is no
  // exclusion-rate threshold, which is what made the old defect fire at any rate.
  const result = run([event('1'), event('2'), event('3'), event('4')],
    { coverage: coverage({ applies: 4, doesNotApply: { NOT_A_CREDENTIAL_EVENT: 8 } }) })
  assert.deepEqual(result.claim, { permitted: true })
  assert.deepEqual(figure(result.count), { accuracy: 'EXACT', value: 0 })
  assert.ok(declined(result.coverage) > 0, 'the qualification travels beside the count')
})

test('the four states stay distinct, and each withholds as its own sentence', () => {
  const applied = coverage({ applies: 1 })
  assert.equal(unread('NEVER_COLLECTED').state, 'NEVER_COLLECTED')
  assert.equal(unread('UNREADABLE_NOW').state, 'UNREADABLE_NOW')
  assert.equal(run([event('1')], { coverage: applied }).state, 'FULLY_INTERPRETED')
  assert.equal(run([event('1')], { coverage: coverage({ applies: 1, unknown: { X: 1 } }) }).state, 'PARTIALLY_UNINTERPRETABLE')

  const reasons = [
    unread('NEVER_COLLECTED').claim,
    unread('UNREADABLE_NOW').claim,
    run([event('1')], { coverage: coverage({ applies: 1, unknown: { X: 1 } }) }).claim,
    run([], { coverage: coverage({ applies: 0 }) }).claim,
    run([event('1')], { coverage: applied, detectors: [broken] }).claim,
  ].map(claim => (claim.permitted ? [] : [...claim.because].sort()))
  // Five situations, five distinct answers, each carrying its own characteristic
  // reason. Collapsing them is how a label meaning "we could not read it" came
  // to mean "never collected".
  assert.equal(new Set(reasons.map(list => list.join('+'))).size, 5)
  const characteristic: readonly WithheldReason[] =
    ['NEVER_COLLECTED', 'UNREADABLE_NOW', 'UNINTERPRETED_EVENTS', 'NOTHING_APPLICABLE', 'DETECTOR_FAILED']
  characteristic.forEach((reason, index) =>
    assert.ok(reasons[index]?.includes(reason), `case ${index} should name ${reason}`))

  // Every reason reaches a reader as its own sentence — no two share wording.
  const everyReason: readonly WithheldReason[] = [...new Set(reasons.flat())]
  assert.equal(new Set(everyReason.map(sentenceFor)).size, everyReason.length)
})

test('unread evidence cannot produce a finding, because it cannot carry an event', () => {
  // The gap this shape closes. Previously `readable: false` sat beside an events
  // array and nothing rejected the pair, so detectors ran over evidence the
  // caller had just declared unreadable and the assessment reported
  // UNREADABLE_NOW while carrying findings drawn from it. There is now no way to
  // express that: events live only on the READ branch.
  for (const availability of ['NEVER_COLLECTED', 'UNREADABLE_NOW'] as const) {
    const result = unread(availability, [matching, silent])
    assert.deepEqual(result.findings.items, [])
    // No detector is credited with having considered anything, because none ran.
    // Reporting them as RAN with considered:0 would read like healthy silence.
    assert.deepEqual(result.detectors, [])
    assert.deepEqual(result.coverage.applies, 0)
    assert.deepEqual(result.coverage.unknown, {})
    assert.deepEqual(result.coverage.unprocessable, {})
    assert.deepEqual(result.claim, { permitted: false, because: [availability] })
    assert.deepEqual(figure(result.count), { accuracy: 'NOT_AVAILABLE', value: null })
  }

  // A detector that would throw is never reached, so unread evidence reports its
  // own reason rather than being relabelled as a detector failure.
  assert.deepEqual(unread('UNREADABLE_NOW', [broken]).claim, { permitted: false, because: ['UNREADABLE_NOW'] })
})

test('the budget belongs to the caller and exceeding it withholds rather than truncating silently', () => {
  const events = Array.from({ length: 5 }, (_, index) => event(`${index}`, { match: index === 0 }))
  const result = run(events, { coverage: coverage({ applies: 5 }), maxEvents: 3 })
  assert.deepEqual(result.claim, { permitted: false, because: ['CAPACITY_EXCEEDED'] })
  assert.equal(result.detectors[0]?.status === 'RAN' && result.detectors[0].considered, 3)

  assert.deepEqual(run(events, { coverage: coverage({ applies: 5 }), maxEvents: 5 }).claim, { permitted: true })
})

test('truncation keeps the most recent events, however the input happens to be ordered', () => {
  const userRefs = (assessment: ReturnType<typeof run>) => assessment.findings.items.map(finding =>
    finding.subject.kind === 'DIRECTORY_USER' ? finding.subject.userRef : null)
  // `at` is the caller's own notion of when, which is the only thing the core
  // reads. There is no ordering claim to be right or wrong about.
  const at = (index: number) => event(`${index}`, { at: index, match: index === 4, subject: `user-${index}` })

  const ascending = [0, 1, 2, 3, 4].map(at)
  assert.deepEqual(userRefs(run(ascending, { coverage: coverage({ applies: 5 }), maxEvents: 2 })), ['user-4'])

  // Same events, reversed. Under a declared-order design this is precisely where
  // a wrong declaration would silently keep the stale half; here the answer
  // cannot change, because recency is read rather than asserted.
  assert.deepEqual(userRefs(run([...ascending].reverse(), { coverage: coverage({ applies: 5 }), maxEvents: 2 })), ['user-4'])

  // And unsorted, which no order enum could even describe. This is the case
  // that made the declaration the wrong shape rather than merely a risky one.
  assert.deepEqual(userRefs(run([2, 0, 4, 1, 3].map(at), { coverage: coverage({ applies: 5 }), maxEvents: 2 })), ['user-4'])

  // The stale end really is dropped: a match on the oldest event does not survive.
  const staleMatch = [0, 1, 2, 3, 4].map(index => event(`${index}`, { at: index, match: index === 0 }))
  assert.deepEqual(run(staleMatch, { coverage: coverage({ applies: 5 }), maxEvents: 2 }).findings.items, [])

  // Choosing a subset is never permission to imply the window was complete.
  assert.deepEqual(run(ascending, { coverage: coverage({ applies: 5 }), maxEvents: 2 }).claim,
    { permitted: false, because: ['CAPACITY_EXCEEDED'] })
})

test('the survivors keep the order they arrived in, not the order recency picked them', () => {
  // Detectors may depend on the sequence they are handed — Engineer 3 sorts and
  // asks us not to re-sort — so selecting a subset must not quietly reorder it.
  const seen: string[] = []
  const recorder: Detector<Event> = {
    id: 'recorder',
    monotonic: true,
    run: applicable => {
      seen.push(...applicable.map(item => item.id))
      return { status: 'RAN', considered: applicable.length, declined: {}, findings: [] }
    },
  }
  run([0, 1, 2, 3].map(index => event(`${index}`, { at: index })),
    { coverage: coverage({ applies: 4 }), maxEvents: 2, detectors: [recorder] })
  assert.deepEqual(seen, ['2', '3'], 'newest two, still in input order')
})

test('one failing detector costs the exact claim without erasing its neighbours', () => {
  const result = run([event('1', { match: true })], { detectors: [matching, broken, silent] })

  // Erasing what the others found would be the same veto in a third costume.
  assert.equal(result.findings.items.length, 1)
  // The failure is visible and distinguishable, not swallowed and not a zero.
  assert.deepEqual(result.detectors.find(report => report.detectorId === 'broken'), { detectorId: 'broken', status: 'FAILED' })
  assert.equal(result.detectors.filter(report => report.status === 'RAN').length, 2)
  // And the count does not overclaim: the broken detector might have found more.
  assert.deepEqual(result.claim, { permitted: false, because: ['DETECTOR_FAILED'] })
  assert.deepEqual(figure(result.count), { accuracy: 'AT_LEAST', value: 1 })

  // A failure with nothing else found cannot produce a lower bound of zero.
  assert.deepEqual(figure(run([event('1')], { detectors: [broken, silent] }).count), { accuracy: 'NOT_AVAILABLE', value: null })
})

test('per-detector accounting separates a healthy silent detector, a filtering one, and a dead one', () => {
  // The position the previous engine left us in: three rules, 1,054 runs, zero
  // findings, and no way to tell "ran and matched nothing" from "never ran".
  // Three states now, and the third is no longer able to masquerade as the first.
  const filtering: Detector<Event> = {
    id: 'filtering', monotonic: true,
    // Assesses one event and says where the other went. Filtering internally is
    // legitimate; failing to account for what was set aside is not.
    run: applicable => ({
      status: 'RAN',
      considered: 1,
      declined: { NOT_THE_FAMILY_THIS_RULE_READS: applicable.length - 1 },
      findings: [],
    }),
  }
  const unaccounted: Detector<Event> = {
    id: 'unaccounted', monotonic: true,
    // Claims to have assessed nothing and does not say what happened to the
    // events. Under a range check this passed as a healthy-looking zero.
    run: () => ({ status: 'RAN', considered: 0, declined: {}, findings: [] }),
  }
  const result = run([event('1'), event('2')], { detectors: [silent, filtering, unaccounted] })

  assert.deepEqual(result.detectors, [
    { detectorId: 'silent', status: 'RAN', considered: 2, declined: {}, matched: 0 },
    { detectorId: 'filtering', status: 'RAN', considered: 1, declined: { NOT_THE_FAMILY_THIS_RULE_READS: 1 }, matched: 0 },
    { detectorId: 'unaccounted', status: 'FAILED' },
  ])
  assert.equal(result.findings.items.length, 0)
  // A detector that assessed less than it was handed and said so is healthy, so
  // it does not move the claim. One that cannot account for its input does.
  assert.deepEqual(result.claim.permitted === false && result.claim.because, ['DETECTOR_FAILED'])
})

test('a detector the evidence cannot support narrows the scope without blocking the claim', () => {
  // Three audit-only tenants must not sit permanently unable to report clean
  // because of a licence they do not hold. So an inapplicable detector is not a
  // failed one: nothing was lost, the question simply cannot be asked here.
  const unsupported: Detector<Event> = {
    id: 'conditional-access',
    monotonic: true,
    run: () => ({ status: 'INAPPLICABLE', because: 'The audit source does not carry conditional-access status.' }),
  }
  const result = run([event('1')], { detectors: [silent, unsupported] })

  assert.deepEqual(result.claim, { permitted: true }, 'inapplicable does not gate')
  assert.equal(result.count.accuracy, 'EXACT')
  assert.deepEqual(result.detectors[1], {
    detectorId: 'conditional-access',
    status: 'INAPPLICABLE',
    because: 'The audit source does not carry conditional-access status.',
  })

  // But the zero says which questions it answered. Without this it reads as
  // "everything is clean" — the 1,054-runs defect exactly: checks that never ran
  // producing the same zero as checks that ran and found nothing.
  assert.deepEqual(result.count.scope, {
    evidenceRequested: ['test fixture: all rows'],
    covered: ['silent'],
    notCovered: [{
      detectorId: 'conditional-access',
      because: 'The audit source does not carry conditional-access status.',
    }],
  })
})

test('a crashed detector and an inapplicable one are never the same answer', () => {
  // A crash might have found something, so it withholds. Inapplicable evidence
  // was never going to answer, so it narrows instead. Conflating them either
  // strands audit-only tenants or lets a crash quietly shrink the scope.
  const unsupported: Detector<Event> = {
    id: 'needs-risk-fields', monotonic: true,
    run: () => ({ status: 'INAPPLICABLE', because: 'This source carries no risk fields.' }),
  }
  const crashed = run([event('1')], { detectors: [silent, broken] })
  const skipped = run([event('1')], { detectors: [silent, unsupported] })

  assert.deepEqual(crashed.claim, { permitted: false, because: ['DETECTOR_FAILED'] })
  assert.deepEqual(skipped.claim, { permitted: true })
  // A crash never silently narrows scope: it is in neither list, because what it
  // would have covered is exactly what we do not know.
  assert.deepEqual(crashed.count.scope, { evidenceRequested: ['test fixture: all rows'], covered: ['silent'], notCovered: [] })
  assert.equal(skipped.count.scope.notCovered.length, 1)
})

test('a fully covered run says so, so full and partial coverage are distinguishable', () => {
  const result = run([event('1')], { detectors: [matching, silent] })
  assert.deepEqual(result.count.scope, { evidenceRequested: ['test fixture: all rows'], covered: ['matches-flagged', 'silent'], notCovered: [] })
})

test('distinct subjects are counted once however many findings they carry', () => {
  const twice: Detector<Event> = {
    id: 'twice',
    monotonic: true,
    run: applicable => ({
      status: 'RAN', considered: applicable.length, declined: {},
      findings: applicable.flatMap((item): Finding[] => [0, 1].map(() =>
        ({ detectorId: 'twice', subject: user(item.subject), observedAt: '2026-09-10T00:00:00.000Z' }))),
    }),
  }
  const result = run([event('1'), event('1')], { coverage: coverage({ applies: 2 }), detectors: [twice] })
  assert.equal(result.findings.items.length, 4)
  assert.deepEqual(figure(result.count), { accuracy: 'EXACT', value: 1 })
})

test('the claim is computed once and the count cannot disagree with it', () => {
  // Two surfaces asking the same question against different bars is what let a
  // headline and its caption contradict each other. There is one answer here.
  for (const supplied of [coverage({ applies: 1 }), coverage({ applies: 1, unknown: { X: 1 } }), coverage({ applies: 0 })]) {
    const result = run([event('1')], { coverage: supplied })
    assert.equal(result.count.accuracy === 'EXACT', result.claim.permitted,
      'an exact count is available exactly when the claim is permitted')
    assert.deepEqual(
      zeroClaim({
        read: true,
        coverage: result.coverage,
        withinBudget: true,
        allDetectorsRan: true,
        allSubjectsResolved: true,
        anyCheckExaminedEvidence: true,
      }),
      result.claim,
      'recomputing from the reported coverage gives the same answer')
  }
})

test('every reason that applies is reported, so there is no precedence to get wrong', () => {
  // QA's second surviving mutant lived here. Narrowing the identity gate to
  // fire only when FULLY_INTERPRETED left the count identical and changed only
  // which true statement was made — so no assertion caught it, and a technician
  // would have been sent to chase data quality when the real problem was
  // identity binding. A list has no precedence to mutate.
  const unattributed = (id: string) => ({
    detectorId: 'mailbox', subject: { kind: 'MAILBOX', mailboxRef: id, binding: 'UNRESOLVED' } as const,
    observedAt: '2026-09-10T00:00:00.000Z',
  })
  const mailbox: Detector<Event> = {
    id: 'mailbox',
    monotonic: true,
    run: applicable => ({ status: 'RAN', considered: applicable.length, declined: {}, findings: applicable.map(item => unattributed(item.id)) }),
  }

  // Uninterpretable events AND an unattributed finding: an ordinary Tuesday.
  const both = run([event('1')], {
    coverage: coverage({ applies: 1, unknown: { X: 1 } }), detectors: [mailbox],
  })
  assert.equal(both.claim.permitted, false)
  assert.deepEqual(both.claim.permitted === false && [...both.claim.because].sort(),
    ['UNINTERPRETED_EVENTS', 'UNRESOLVED_SUBJECT_IDENTITY'])

  // Three at once, including a crashed detector and an over-budget window.
  const three = run([event('1'), event('2')], {
    coverage: coverage({ applies: 2, unknown: { X: 1 } }), detectors: [mailbox, broken], maxEvents: 1,
  })
  assert.deepEqual(three.claim.permitted === false && [...three.claim.because].sort(),
    ['CAPACITY_EXCEEDED', 'DETECTOR_FAILED', 'UNINTERPRETED_EVENTS', 'UNRESOLVED_SUBJECT_IDENTITY'])

  // Each reason still reaches the reader as its own sentence.
  const sentences = three.claim.permitted === false ? three.claim.because.map(sentenceFor) : []
  assert.equal(new Set(sentences).size, 4)
})

test('a withheld claim always names at least one reason', () => {
  // An undifferentiated "not available" is the defect this whole vocabulary
  // replaces, so the type makes the empty list unrepresentable and this pins
  // that no path produces one.
  const cases = [
    run([event('1')], { coverage: coverage({ applies: 1, unknown: { X: 1 } }) }),
    run([], { coverage: coverage({ applies: 0 }) }),
    run([event('1')], { detectors: [broken] }),
    unread('NEVER_COLLECTED'),
    unread('UNREADABLE_NOW'),
  ]
  for (const result of cases) {
    if (result.claim.permitted) continue
    assert.ok(result.claim.because.length >= 1, 'withheld without a reason is not a statement')
  }
})

test('a detector opting out without saying why is treated as having failed', () => {
  // The type can require a reason but not that it says anything, and a blank
  // one is a silent opt-out: the check removes itself from the answer and
  // nothing tells a reader what stopped being checked. Silence is made
  // expensive rather than free, in the gating direction.
  const mute: Detector<Event> = { id: 'mute', monotonic: true, run: () => ({ status: 'INAPPLICABLE', because: '   ' }) }
  const result = run([event('1')], { detectors: [silent, mute] })

  assert.deepEqual(result.detectors[1], { detectorId: 'mute', status: 'FAILED' })
  assert.deepEqual(result.claim.permitted === false && result.claim.because, ['DETECTOR_FAILED'])
  // And it cannot quietly shrink the scope, which is what a silent opt-out
  // would otherwise buy: absent from covered and from notCovered alike.
  assert.deepEqual(result.count.scope, { evidenceRequested: ['test fixture: all rows'], covered: ['silent'], notCovered: [] })
})

test('a non-monotonic detector never sees a truncated window, because it would invent a finding', () => {
  // The concrete danger, written as the detector that motivated it: "password
  // accepted, MFA never completed" fires on the ABSENCE of a completion. Drop
  // the completion during truncation and it accuses a user who simply finished
  // signing in. That is a fabricated finding, not a missing one, and no claim
  // wording can undo naming the wrong person.
  const interrupt: Detector<Event> = {
    id: 'password-accepted-not-completed',
    monotonic: false,
    run: applicable => ({
      status: 'RAN',
      considered: applicable.length,
      declined: {},
      findings: applicable.some(item => item.match)
        ? []
        : [{ detectorId: 'password-accepted-not-completed', subject: user('user-1'), observedAt: '2026-09-10T00:00:00.000Z' }],
    }),
  }
  // The completion is the newest event, so recency-based truncation keeps it —
  // but nothing guarantees that in general, which is the point.
  const window = [0, 1, 2].map(index => event(`${index}`, { at: index, match: index === 0 }))

  // Whole window: the completion is present, so nothing is reported.
  assert.deepEqual(run(window, { coverage: coverage({ applies: 3 }), detectors: [interrupt] }).findings.items, [])

  // Truncated: rather than running on a window missing the disconfirming event,
  // it declines and says so.
  const truncated = run(window, { coverage: coverage({ applies: 3 }), maxEvents: 2, detectors: [interrupt] })
  assert.deepEqual(truncated.findings.items, [], 'no fabricated accusation')
  assert.deepEqual(truncated.detectors, [{
    detectorId: 'password-accepted-not-completed',
    status: 'INAPPLICABLE',
    because: 'This check reads a whole window, and this window held more events than could be assessed at once.',
  }])
  // And the tenant is told which question went unanswered, rather than the
  // check silently vanishing from a clean-looking result.
  assert.equal(truncated.count.scope.notCovered.length, 1)
})

test('a monotonic detector still runs on a truncated window, and its findings say they are partial', () => {
  // Monotonic means more events can only add findings, so what it reports from
  // a subset is sound — it just is not everything.
  const window = [0, 1, 2, 3].map(index => event(`${index}`, { at: index, match: true }))
  const result = run(window, { coverage: coverage({ applies: 4 }), maxEvents: 2, detectors: [matching] })

  assert.equal(result.findings.items.length, 2, 'real findings, still surfaced')
  assert.equal(result.findings.complete, false)
  assert.deepEqual(result.findings.complete === false && result.findings.because, ['WINDOW_TRUNCATED'])
  // The count was already protected; this is the half that was not. A technician
  // reading two findings can now tell there may be more.
  assert.deepEqual(figure(result.count), { accuracy: 'AT_LEAST', value: 2 })
})

test('findings say they are partial when a detector crashed, and complete when nothing was missed', () => {
  const crashed = run([event('1', { match: true })], { detectors: [matching, broken] })
  assert.equal(crashed.findings.items.length, 1)
  assert.deepEqual(crashed.findings.complete === false && crashed.findings.because, ['DETECTOR_FAILED'])

  const whole = run([event('1', { match: true })], { detectors: [matching, silent] })
  assert.equal(whole.findings.complete, true)

  // A check that could not run at all is deliberately NOT a findings gap — it
  // belongs to the count's scope. "We may have missed some" and "we never asked
  // this question" are different statements and must not merge.
  const unsupported: Detector<Event> = {
    id: 'unsupported', monotonic: true,
    run: () => ({ status: 'INAPPLICABLE', because: 'This source does not carry it.' }),
  }
  // QA's correction: this previously reported complete:true beside a scope
  // naming an unrun check — "yes" and "no" to the same question, split across
  // two objects. The reasons still differ; the ANSWER is now given once.
  const narrowed = run([event('1')], { detectors: [silent, unsupported] })
  assert.equal(narrowed.findings.complete, false)
  assert.deepEqual(narrowed.findings.complete === false && narrowed.findings.because, ['CHECK_NOT_RUN'])
  // And the per-detector detail, in the detector's own words, stays in the scope
  // rather than being flattened into the findings answer.
  assert.deepEqual(narrowed.count.scope.notCovered,
    [{ detectorId: 'unsupported', because: 'This source does not carry it.' }])
})

test('a detector whose account of itself is impossible is not trusted to have run', () => {
  // `considered` is what makes "ran and found nothing" believable rather than
  // merely silent, and it is self-reported. A detector cannot have looked at
  // more events than it was handed, so a figure outside that range means the
  // account is untrustworthy — and an untrustworthy account of a clean result
  // is worth less than no account at all.
  const overclaims: Detector<Event> = {
    id: 'overclaims', monotonic: true,
    run: () => ({ status: 'RAN', considered: 1000, declined: {}, findings: [] }),
  }
  const negative: Detector<Event> = {
    id: 'negative', monotonic: true,
    run: () => ({ status: 'RAN', considered: -1, declined: {}, findings: [] }),
  }
  for (const bad of [overclaims, negative]) {
    const result = run([event('1')], { detectors: [bad] })
    assert.deepEqual(result.detectors, [{ detectorId: bad.id, status: 'FAILED' }])
    assert.ok(result.claim.permitted === false && result.claim.because.includes('DETECTOR_FAILED'))
  }

  // But what it found is still kept. Discarding real findings over a wrong
  // counter would be the veto pattern in its smallest costume.
  const foundButMiscounted: Detector<Event> = {
    id: 'miscounts', monotonic: true,
    run: applicable => ({
      status: 'RAN',
      considered: applicable.length + 5,
      declined: {},
      findings: [{ detectorId: 'miscounts', subject: user('user-1'), observedAt: '2026-09-10T00:00:00.000Z' }],
    }),
  }
  const kept = run([event('1')], { detectors: [foundButMiscounted] })
  assert.equal(kept.findings.items.length, 1)
  assert.deepEqual(figure(kept.count), { accuracy: 'AT_LEAST', value: 1 })

  // A detector reporting more findings than events considered is NOT impossible
  // — one event can support several findings — so that stays permitted.
  const many: Detector<Event> = {
    id: 'many', monotonic: true,
    run: applicable => ({
      status: 'RAN',
      considered: applicable.length,
      declined: {},
      findings: [0, 1, 2].map(() => ({ detectorId: 'many', subject: user('user-1'), observedAt: '2026-09-10T00:00:00.000Z' })),
    }),
  }
  assert.equal(run([event('1')], { detectors: [many] }).claim.permitted, true)
})

test('a claim cannot be asked about unread evidence that somehow has findings', () => {
  // QA's observation: the previous shape accepted NEVER_COLLECTED alongside an
  // unattributed finding. Unreachable through evaluate, reachable through this
  // exported function — the same gap the Evidence union closed, one level along.
  // The unread branch now carries no coverage and no flags to contradict it.
  assert.deepEqual(zeroClaim({ read: false, because: 'NEVER_COLLECTED' }),
    { permitted: false, because: ['NEVER_COLLECTED'] })
  assert.deepEqual(zeroClaim({ read: false, because: 'UNREADABLE_NOW' }),
    { permitted: false, because: ['UNREADABLE_NOW'] })

  // And the read branch derives its own interpretability from the coverage it
  // was given, rather than being told it separately by something that could
  // disagree with it.
  assert.deepEqual(
    zeroClaim({
      read: true,
      coverage: coverage({ applies: 1, unknown: { X: 1 } }),
      withinBudget: true, allDetectorsRan: true, allSubjectsResolved: true, anyCheckExaminedEvidence: true,
    }),
    { permitted: false, because: ['UNINTERPRETED_EVENTS'] })
})

test('what was asked of the provider travels with the count, and an unrecorded ask withholds it', () => {
  // Coverage is computed over the rows we were handed, so full coverage of a
  // partial view reports 100% while saying nothing about traffic nobody asked
  // for. A narrow-but-named request is a smaller question honestly asked.
  const narrow = run([event('1')], {
    coverage: coverage({ applies: 1, collectionScope: { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' } }),
  })
  assert.deepEqual(narrow.claim, { permitted: true }, 'a smaller question still has an exact answer')
  assert.deepEqual(narrow.count.scope.evidenceRequested, ['GRAPH_INTERACTIVE_ONLY'])
  assert.equal(narrow.findings.complete, true)

  // An unrecorded request is different in kind: we cannot say what a clean
  // result would cover, and no scope note rescues that.
  const unknownAsk = run([event('1')], {
    coverage: coverage({ applies: 1, collectionScope: { declared: false } }),
  })
  assert.deepEqual(unknownAsk.claim.permitted === false && unknownAsk.claim.because, ['COLLECTION_SCOPE_UNDECLARED'])
  assert.deepEqual(unknownAsk.count.scope.evidenceRequested, [], 'nothing to name')
  assert.deepEqual(unknownAsk.findings.complete === false && unknownAsk.findings.because, ['EVIDENCE_REQUEST_UNKNOWN'])

  // It is its own sentence, not folded into "we could not read the evidence" —
  // evidence we may never have requested is not evidence we failed to read.
  assert.notEqual(sentenceFor('COLLECTION_SCOPE_UNDECLARED'), sentenceFor('UNINTERPRETED_EVENTS'))
})

test('a detector that silently narrows its own input is rejected, which a range check missed', () => {
  // The direction that matters, and the one my first version let through. A
  // range check catches a detector claiming MORE than it was handed — an
  // embarrassing counter on a detector that still looked at everything. It
  // passes a detector claiming FEWER, which is the headline defect one level
  // down: discard most of the evidence quietly, then support a confident zero
  // with the remainder.
  const silentlyNarrows: Detector<Event> = {
    id: 'narrows', monotonic: true,
    run: () => ({ status: 'RAN', considered: 5, declined: {}, findings: [] }),
  }
  const thousand = Array.from({ length: 1000 }, (_, index) => event(`${index}`, { at: index }))
  const narrowed = run(thousand, { coverage: coverage({ applies: 1000 }), detectors: [silentlyNarrows] })

  assert.deepEqual(narrowed.detectors, [{ detectorId: 'narrows', status: 'FAILED' }])
  assert.deepEqual([...(narrowed.claim.permitted === false ? narrowed.claim.because : [])].sort(),
    ['DETECTOR_FAILED', 'NO_CHECK_EXAMINED_EVIDENCE'])
  // Note this figure is inside any plausible range check: 5 of 1000 is neither
  // negative nor greater than the input. Only the sum catches it.
  assert.ok(5 < thousand.length)

  // The same detector accounting for the rest is healthy, and assessing 5 of a
  // thousand is a legitimate thing for a rule with a narrow family to do.
  const accountsForIt: Detector<Event> = {
    id: 'narrows', monotonic: true,
    run: applicable => ({
      status: 'RAN',
      considered: 5,
      declined: { NOT_THE_FAMILY_THIS_RULE_READS: applicable.length - 5 },
      findings: [],
    }),
  }
  const honest = run(thousand, { coverage: coverage({ applies: 1000 }), detectors: [accountsForIt] })
  assert.deepEqual(honest.claim, { permitted: true })
  assert.deepEqual(honest.detectors[0],
    { detectorId: 'narrows', status: 'RAN', considered: 5, declined: { NOT_THE_FAMILY_THIS_RULE_READS: 995 }, matched: 0 })
})

test('setting events aside under a blank reason is a silent opt-out wearing a number', () => {
  const blankReason: Detector<Event> = {
    id: 'blank', monotonic: true,
    run: applicable => ({ status: 'RAN', considered: 1, declined: { '  ': applicable.length - 1 }, findings: [] }),
  }
  const result = run([event('1'), event('2')], { detectors: [blankReason] })
  assert.deepEqual(result.detectors, [{ detectorId: 'blank', status: 'FAILED' }])
})

test('a detector that balanced its books without examining anything cannot support a zero', () => {
  // QA's hole in the sum invariant. `considered: 0, declined: 1000` balances
  // perfectly, accounts for every event, and looked at none of them — and a
  // legitimate reason attached makes it more plausible rather than less. The
  // sum proves the accounting is COMPLETE; it proves nothing was EXAMINED.
  const declinesEverything: Detector<Event> = {
    id: 'declines-all', monotonic: true,
    run: applicable => ({
      status: 'RAN',
      considered: 0,
      declined: { NOT_THE_FAMILY_THIS_RULE_READS: applicable.length },
      findings: [],
    }),
  }
  const thousand = Array.from({ length: 1000 }, (_, index) => event(`${index}`, { at: index }))
  const result = run(thousand, { coverage: coverage({ applies: 1000 }), detectors: [declinesEverything] })

  // The report is honest and stays RAN — this is the fully-excluded case, not a
  // broken detector, and its accounting is complete.
  assert.deepEqual(result.detectors, [{
    detectorId: 'declines-all', status: 'RAN', considered: 0,
    declined: { NOT_THE_FAMILY_THIS_RULE_READS: 1000 }, matched: 0,
  }])
  // But it cannot be one of the checks a confident zero rests on.
  assert.deepEqual(result.claim.permitted === false && result.claim.because, ['NO_CHECK_EXAMINED_EVIDENCE'])
  assert.deepEqual(figure(result.count), { accuracy: 'NOT_AVAILABLE', value: null })
  // And it is absent from `covered`, so it is not credited with clearing
  // anything — which is how "ran and found nothing" stayed believable over
  // events nobody looked at.
  assert.deepEqual(result.count.scope.covered, [])
  assert.equal(result.count.scope.notCovered.length, 1)

  // One check that did examine something is enough to carry the claim, and the
  // abstaining one still shows as not covering anything.
  const alongside = run(thousand, {
    coverage: coverage({ applies: 1000 }), detectors: [declinesEverything, silent],
  })
  assert.deepEqual(alongside.claim, { permitted: true })
  assert.deepEqual(alongside.count.scope.covered, ['silent'])
  assert.equal(alongside.count.scope.notCovered.length, 1)
})

test('a withheld claim explains itself in as many sentences as it has reasons', () => {
  // QA's sixth face: the core knows a claim can be withheld for four reasons at
  // once, and a surface rendering "the reason" re-creates the collapse we
  // removed twice inside the core, from outside it, looking entirely natural.
  const unattributedMailbox: Detector<Event> = {
    id: 'mailbox', monotonic: true,
    run: applicable => ({
      status: 'RAN', considered: applicable.length, declined: {},
      findings: applicable.map(item => ({
        detectorId: 'mailbox',
        subject: { kind: 'MAILBOX', mailboxRef: item.id, binding: 'UNRESOLVED' } as const,
        observedAt: '2026-09-10T00:00:00.000Z',
      })),
    }),
  }
  const many = run([event('1'), event('2')], {
    coverage: coverage({ applies: 2, unknown: { X: 1 } }),
    detectors: [unattributedMailbox, broken],
    maxEvents: 1,
  })

  const reasons = many.claim.permitted === false ? many.claim.because : []
  assert.ok(reasons.length >= 3, 'several reasons hold at once')
  const sentences = withheldExplanations(many.claim)
  assert.equal(sentences.length, reasons.length, 'one sentence per reason, none dropped')
  assert.equal(new Set(sentences).size, sentences.length, 'and no two reasons share wording')

  // A permitted claim has nothing to explain, rather than an empty-string
  // explanation that a surface would render as a blank caption.
  assert.deepEqual(withheldExplanations({ permitted: true }), [])
})
