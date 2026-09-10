import assert from 'node:assert/strict'
import test from 'node:test'
import { countOf, declined, evaluate, uninterpreted, withheldExplanation, zeroClaim } from './evaluate.js'
import type { Coverage, Detector, Finding } from './contract.js'
import { figure } from './test-support.js'

type Event = Readonly<{ id: string; subject: string; match?: boolean; at?: number }>

const event = (id: string, extra: Partial<Event> = {}): Event => ({ id, subject: `user-${id}`, ...extra })

/** Stands in for what the classification layer reports. The core never builds
 * one of these, which is the point — it cannot classify, only consume. */
const coverage = (parts: Partial<Coverage> = {}): Coverage => ({
  applies: 0, doesNotApply: {}, unknown: {}, unprocessable: {}, ...parts,
})

/** Sign-in events carry a directory user, so this detector's findings are about
 * people and do count. Contrast the mailbox detector, whose findings are not. */
const user = (userRef: string) => ({ kind: 'DIRECTORY_USER', userRef } as const)

const matching: Detector<Event> = {
  id: 'matches-flagged',
  run: applicable => ({
    status: 'RAN', considered: applicable.length,
    findings: applicable.filter(item => item.match)
      .map(item => ({ detectorId: 'matches-flagged', subject: user(item.subject), observedAt: '2026-09-10T00:00:00.000Z' })),
  }),
}
const silent: Detector<Event> = { id: 'silent', run: applicable => ({ status: 'RAN', considered: applicable.length, findings: [] }) }
const broken: Detector<Event> = { id: 'broken', run: () => { throw new Error('detector fault') } }

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
  assert.equal(result.findings.length, 1)
  assert.equal(uninterpreted(result.coverage), 1)
  // It reduces what we claim, and only that.
  assert.equal(result.state, 'PARTIALLY_UNINTERPRETABLE')
  assert.deepEqual(result.claim, { permitted: false, because: 'UNINTERPRETED_EVENTS' })
  assert.deepEqual(figure(result.count), { accuracy: 'AT_LEAST', value: 1 })
})

test('a row we could not read and an outcome we could not interpret both gate, and stay apart', () => {
  const unreadRow = run([event('1')], { coverage: coverage({ applies: 1, unprocessable: { MALFORMED_ROW: 2 } }) })
  const unreadOutcome = run([event('1')], { coverage: coverage({ applies: 1, unknown: { UNRECOGNIZED_OUTCOME: 2 } }) })
  for (const result of [unreadRow, unreadOutcome]) {
    assert.equal(result.state, 'PARTIALLY_UNINTERPRETABLE')
    assert.deepEqual(result.claim, { permitted: false, because: 'UNINTERPRETED_EVENTS' })
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
      const count = countOf(subjects, permitted, { covered: [], notCovered: [] })
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
  assert.deepEqual(result.claim, { permitted: false, because: 'NOTHING_APPLICABLE' })
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
  ].map(claim => (claim.permitted ? 'permitted' : claim.because))
  // Five distinct reasons, five distinct sentences. Collapsing them is how a
  // label meaning "we could not read it" came to mean "never collected".
  assert.equal(new Set(reasons).size, 5)
  assert.equal(new Set(reasons.map(reason => reason === 'permitted' ? reason : withheldExplanation(reason))).size, 5)
})

test('unread evidence cannot produce a finding, because it cannot carry an event', () => {
  // The gap this shape closes. Previously `readable: false` sat beside an events
  // array and nothing rejected the pair, so detectors ran over evidence the
  // caller had just declared unreadable and the assessment reported
  // UNREADABLE_NOW while carrying findings drawn from it. There is now no way to
  // express that: events live only on the READ branch.
  for (const availability of ['NEVER_COLLECTED', 'UNREADABLE_NOW'] as const) {
    const result = unread(availability, [matching, silent])
    assert.deepEqual(result.findings, [])
    // No detector is credited with having considered anything, because none ran.
    // Reporting them as RAN with considered:0 would read like healthy silence.
    assert.deepEqual(result.detectors, [])
    assert.deepEqual(result.coverage, { applies: 0, doesNotApply: {}, unknown: {}, unprocessable: {} })
    assert.deepEqual(result.claim, { permitted: false, because: availability })
    assert.deepEqual(figure(result.count), { accuracy: 'NOT_AVAILABLE', value: null })
  }

  // A detector that would throw is never reached, so unread evidence reports its
  // own reason rather than being relabelled as a detector failure.
  assert.deepEqual(unread('UNREADABLE_NOW', [broken]).claim, { permitted: false, because: 'UNREADABLE_NOW' })
})

test('the budget belongs to the caller and exceeding it withholds rather than truncating silently', () => {
  const events = Array.from({ length: 5 }, (_, index) => event(`${index}`, { match: index === 0 }))
  const result = run(events, { coverage: coverage({ applies: 5 }), maxEvents: 3 })
  assert.deepEqual(result.claim, { permitted: false, because: 'CAPACITY_EXCEEDED' })
  assert.equal(result.detectors[0]?.status === 'RAN' && result.detectors[0].considered, 3)

  assert.deepEqual(run(events, { coverage: coverage({ applies: 5 }), maxEvents: 5 }).claim, { permitted: true })
})

test('truncation keeps the most recent events, however the input happens to be ordered', () => {
  const userRefs = (assessment: ReturnType<typeof run>) => assessment.findings.map(finding =>
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
  assert.deepEqual(run(staleMatch, { coverage: coverage({ applies: 5 }), maxEvents: 2 }).findings, [])

  // Choosing a subset is never permission to imply the window was complete.
  assert.deepEqual(run(ascending, { coverage: coverage({ applies: 5 }), maxEvents: 2 }).claim,
    { permitted: false, because: 'CAPACITY_EXCEEDED' })
})

test('the survivors keep the order they arrived in, not the order recency picked them', () => {
  // Detectors may depend on the sequence they are handed — Engineer 3 sorts and
  // asks us not to re-sort — so selecting a subset must not quietly reorder it.
  const seen: string[] = []
  const recorder: Detector<Event> = {
    id: 'recorder',
    run: applicable => {
      seen.push(...applicable.map(item => item.id))
      return { status: 'RAN', considered: applicable.length, findings: [] }
    },
  }
  run([0, 1, 2, 3].map(index => event(`${index}`, { at: index })),
    { coverage: coverage({ applies: 4 }), maxEvents: 2, detectors: [recorder] })
  assert.deepEqual(seen, ['2', '3'], 'newest two, still in input order')
})

test('one failing detector costs the exact claim without erasing its neighbours', () => {
  const result = run([event('1', { match: true })], { detectors: [matching, broken, silent] })

  // Erasing what the others found would be the same veto in a third costume.
  assert.equal(result.findings.length, 1)
  // The failure is visible and distinguishable, not swallowed and not a zero.
  assert.deepEqual(result.detectors.find(report => report.detectorId === 'broken'), { detectorId: 'broken', status: 'FAILED' })
  assert.equal(result.detectors.filter(report => report.status === 'RAN').length, 2)
  // And the count does not overclaim: the broken detector might have found more.
  assert.deepEqual(result.claim, { permitted: false, because: 'DETECTOR_FAILED' })
  assert.deepEqual(figure(result.count), { accuracy: 'AT_LEAST', value: 1 })

  // A failure with nothing else found cannot produce a lower bound of zero.
  assert.deepEqual(figure(run([event('1')], { detectors: [broken, silent] }).count), { accuracy: 'NOT_AVAILABLE', value: null })
})

test('per-detector accounting separates a healthy silent detector from a dead one', () => {
  // The position the previous engine left us in: three rules, 1,054 runs, zero
  // findings, and no way to tell "ran and matched nothing" from "never ran".
  const dead: Detector<Event> = { id: 'dead', run: () => ({ status: 'RAN', considered: 0, findings: [] }) }
  const result = run([event('1'), event('2')], { detectors: [silent, dead] })

  assert.deepEqual(result.detectors, [
    { detectorId: 'silent', status: 'RAN', considered: 2, matched: 0 },
    { detectorId: 'dead', status: 'RAN', considered: 0, matched: 0 },
  ])
  assert.equal(result.findings.length, 0)
  // Diagnostic, not coverage: a dead detector does not make the evidence less
  // interpretable, so it must not move the claim.
  assert.deepEqual(result.claim, { permitted: true })
})

test('a detector the evidence cannot support narrows the scope without blocking the claim', () => {
  // Three audit-only tenants must not sit permanently unable to report clean
  // because of a licence they do not hold. So an inapplicable detector is not a
  // failed one: nothing was lost, the question simply cannot be asked here.
  const unsupported: Detector<Event> = {
    id: 'conditional-access',
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
    id: 'needs-risk-fields', run: () => ({ status: 'INAPPLICABLE', because: 'This source carries no risk fields.' }),
  }
  const crashed = run([event('1')], { detectors: [silent, broken] })
  const skipped = run([event('1')], { detectors: [silent, unsupported] })

  assert.deepEqual(crashed.claim, { permitted: false, because: 'DETECTOR_FAILED' })
  assert.deepEqual(skipped.claim, { permitted: true })
  // A crash never silently narrows scope: it is in neither list, because what it
  // would have covered is exactly what we do not know.
  assert.deepEqual(crashed.count.scope, { covered: ['silent'], notCovered: [] })
  assert.equal(skipped.count.scope.notCovered.length, 1)
})

test('a fully covered run says so, so full and partial coverage are distinguishable', () => {
  const result = run([event('1')], { detectors: [matching, silent] })
  assert.deepEqual(result.count.scope, { covered: ['matches-flagged', 'silent'], notCovered: [] })
})

test('distinct subjects are counted once however many findings they carry', () => {
  const twice: Detector<Event> = {
    id: 'twice',
    run: applicable => ({
      status: 'RAN', considered: applicable.length,
      findings: applicable.flatMap((item): Finding[] => [0, 1].map(() =>
        ({ detectorId: 'twice', subject: user(item.subject), observedAt: '2026-09-10T00:00:00.000Z' }))),
    }),
  }
  const result = run([event('1'), event('1')], { coverage: coverage({ applies: 2 }), detectors: [twice] })
  assert.equal(result.findings.length, 4)
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
        state: result.state,
        coverage: result.coverage,
        withinBudget: true,
        allDetectorsRan: true,
        allSubjectsResolved: true,
      }),
      result.claim,
      'recomputing from the reported state and coverage gives the same answer')
  }
})
