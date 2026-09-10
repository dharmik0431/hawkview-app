import assert from 'node:assert/strict'
import test from 'node:test'
import { countOf, declined, evaluate, uninterpreted, withheldExplanation, zeroClaim } from './evaluate.js'
import type { Coverage, Detector, Finding } from './contract.js'

type Event = Readonly<{ id: string; subject: string; match?: boolean }>

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
    considered: applicable.length,
    findings: applicable.filter(item => item.match)
      .map(item => ({ detectorId: 'matches-flagged', subject: user(item.subject), observedAt: '2026-09-10T00:00:00.000Z' })),
  }),
}
const silent: Detector<Event> = { id: 'silent', run: applicable => ({ considered: applicable.length, findings: [] }) }
const broken: Detector<Event> = { id: 'broken', run: () => { throw new Error('detector fault') } }

const run = (applies: readonly Event[], options: Partial<{
  coverage: Coverage; detectors: readonly Detector<Event>[]; maxEvents: number; collected: boolean; readable: boolean
}> = {}) => evaluate({
  applies,
  coverage: options.coverage ?? coverage({ applies: applies.length }),
  detectors: options.detectors ?? [matching, silent],
  budget: { maxEvents: options.maxEvents ?? 1000 },
  collected: options.collected ?? true,
  readable: options.readable ?? true,
})

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
  assert.deepEqual(result.count, { accuracy: 'AT_LEAST', value: 1 })
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
  assert.deepEqual(nothingFound.count, { accuracy: 'NOT_AVAILABLE', value: null })

  const clean = run([event('1')])
  assert.deepEqual(clean.count, { accuracy: 'EXACT', value: 0 })
  assert.deepEqual(clean.claim, { permitted: true })

  // Exhaustive: no combination of inputs yields a zero-valued lower bound.
  for (const permitted of [true, false] as const) {
    const claim = permitted ? { permitted } as const : { permitted, because: 'UNREADABLE_NOW' } as const
    for (const subjects of [0, 1, 5]) {
      const count = countOf(subjects, claim)
      assert.ok(!(count.accuracy === 'AT_LEAST' && count.value === 0))
      if (count.accuracy === 'EXACT') assert.equal(claim.permitted, true, 'exact requires the claim to be permitted')
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
  assert.deepEqual(result.count, { accuracy: 'EXACT', value: 1 })
  // Broken out by reason, so background traffic cannot bury the exclusion an
  // investigator would care about beneath a large token-refresh number.
  assert.deepEqual(result.coverage.doesNotApply, { NON_INTERACTIVE: 40, APPLICATION_ACTOR: 2 })
})

test('a window where nothing applied cannot report a confident zero', () => {
  // The live production defect: everything set aside, nothing assessed, and a
  // headline zero captioned as though the evidence had been examined.
  const result = run([], { coverage: coverage({ applies: 0, doesNotApply: { NOT_A_CREDENTIAL_EVENT: 12 } }) })
  assert.deepEqual(result.claim, { permitted: false, because: 'NOTHING_APPLICABLE' })
  assert.deepEqual(result.count, { accuracy: 'NOT_AVAILABLE', value: null })
})

test('a partly declined window is judged by what applied, not by the ratio', () => {
  // Eight declined and four assessed still permits a clean claim: the four were
  // genuinely assessed and the eight genuinely did not apply. There is no
  // exclusion-rate threshold, which is what made the old defect fire at any rate.
  const result = run([event('1'), event('2'), event('3'), event('4')],
    { coverage: coverage({ applies: 4, doesNotApply: { NOT_A_CREDENTIAL_EVENT: 8 } }) })
  assert.deepEqual(result.claim, { permitted: true })
  assert.deepEqual(result.count, { accuracy: 'EXACT', value: 0 })
  assert.ok(declined(result.coverage) > 0, 'the qualification travels beside the count')
})

test('the four states stay distinct, and each withholds as its own sentence', () => {
  const applied = coverage({ applies: 1 })
  assert.equal(run([event('1')], { coverage: applied, collected: false }).state, 'NEVER_COLLECTED')
  assert.equal(run([event('1')], { coverage: applied, readable: false }).state, 'UNREADABLE_NOW')
  assert.equal(run([event('1')], { coverage: applied }).state, 'FULLY_INTERPRETED')
  assert.equal(run([event('1')], { coverage: coverage({ applies: 1, unknown: { X: 1 } }) }).state, 'PARTIALLY_UNINTERPRETABLE')

  const reasons = [
    run([event('1')], { coverage: applied, collected: false }).claim,
    run([event('1')], { coverage: applied, readable: false }).claim,
    run([event('1')], { coverage: coverage({ applies: 1, unknown: { X: 1 } }) }).claim,
    run([], { coverage: coverage({ applies: 0 }) }).claim,
    run([event('1')], { coverage: applied, detectors: [broken] }).claim,
  ].map(claim => (claim.permitted ? 'permitted' : claim.because))
  // Five distinct reasons, five distinct sentences. Collapsing them is how a
  // label meaning "we could not read it" came to mean "never collected".
  assert.equal(new Set(reasons).size, 5)
  assert.equal(new Set(reasons.map(reason => reason === 'permitted' ? reason : withheldExplanation(reason))).size, 5)
})

test('the budget belongs to the caller and exceeding it withholds rather than truncating silently', () => {
  const events = Array.from({ length: 5 }, (_, index) => event(`${index}`, { match: index === 0 }))
  const result = run(events, { coverage: coverage({ applies: 5 }), maxEvents: 3 })
  assert.deepEqual(result.claim, { permitted: false, because: 'CAPACITY_EXCEEDED' })
  // What it did assess is still reported, as a bound rather than a total.
  assert.deepEqual(result.count, { accuracy: 'AT_LEAST', value: 1 })
  assert.equal(result.detectors[0]?.status === 'RAN' && result.detectors[0].considered, 3)

  assert.deepEqual(run(events, { coverage: coverage({ applies: 5 }), maxEvents: 5 }).claim, { permitted: true })
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
  assert.deepEqual(result.count, { accuracy: 'AT_LEAST', value: 1 })

  // A failure with nothing else found cannot produce a lower bound of zero.
  assert.deepEqual(run([event('1')], { detectors: [broken, silent] }).count, { accuracy: 'NOT_AVAILABLE', value: null })
})

test('per-detector accounting separates a healthy silent detector from a dead one', () => {
  // The position the previous engine left us in: three rules, 1,054 runs, zero
  // findings, and no way to tell "ran and matched nothing" from "never ran".
  const dead: Detector<Event> = { id: 'dead', run: () => ({ considered: 0, findings: [] }) }
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

test('distinct subjects are counted once however many findings they carry', () => {
  const twice: Detector<Event> = {
    id: 'twice',
    run: applicable => ({
      considered: applicable.length,
      findings: applicable.flatMap((item): Finding[] => [0, 1].map(() =>
        ({ detectorId: 'twice', subject: user(item.subject), observedAt: '2026-09-10T00:00:00.000Z' }))),
    }),
  }
  const result = run([event('1'), event('1')], { coverage: coverage({ applies: 2 }), detectors: [twice] })
  assert.equal(result.findings.length, 4)
  assert.deepEqual(result.count, { accuracy: 'EXACT', value: 1 })
})

test('the claim is computed once and the count cannot disagree with it', () => {
  // Two surfaces asking the same question against different bars is what let a
  // headline and its caption contradict each other. There is one answer here.
  for (const supplied of [coverage({ applies: 1 }), coverage({ applies: 1, unknown: { X: 1 } }), coverage({ applies: 0 })]) {
    const result = run([event('1')], { coverage: supplied })
    assert.equal(result.count.accuracy === 'EXACT', result.claim.permitted,
      'an exact count is available exactly when the claim is permitted')
    assert.deepEqual(zeroClaim(result.state, result.coverage, true, true), result.claim,
      'recomputing from the reported state and coverage gives the same answer')
  }
})
