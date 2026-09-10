import assert from 'node:assert/strict'
import test from 'node:test'
import { countOf, declinedCount, evaluate, uninterpretedCount, withheldExplanation, zeroClaim } from './evaluate.js'
import { DOES_NOT_APPLY_REASONS, UNKNOWN_REASONS, type Detector, type Disposition, type Finding } from './contract.js'

type Event = Readonly<{ id: string; subject: string; kind: 'applies' | 'declined' | 'unreadable'; match?: boolean }>

const classify = (event: Event): Disposition =>
  event.kind === 'applies' ? { kind: 'APPLIES' }
    : event.kind === 'declined' ? { kind: 'DOES_NOT_APPLY', reason: 'NON_INTERACTIVE' }
      : { kind: 'UNKNOWN', reason: 'UNRECOGNIZED_OUTCOME' }

const matching: Detector<Event> = {
  id: 'matches-flagged',
  findings: applicable => applicable.filter(event => event.match)
    .map(event => ({ detectorId: 'matches-flagged', subject: event.subject, observedAt: '2026-09-10T00:00:00.000Z' })),
}
const silent: Detector<Event> = { id: 'silent', findings: () => [] }

const event = (id: string, kind: Event['kind'], extra: Partial<Event> = {}): Event =>
  ({ id, subject: `user-${id}`, kind, ...extra })

const run = (events: readonly Event[], options: Partial<{ detectors: readonly Detector<Event>[]; maxEvents: number; collected: boolean; readable: boolean }> = {}) =>
  evaluate({
    events, classify,
    detectors: options.detectors ?? [matching, silent],
    budget: { maxEvents: options.maxEvents ?? 1000 },
    collected: options.collected ?? true,
    readable: options.readable ?? true,
  })

test('an event we cannot interpret never blocks a finding another event supports', () => {
  const result = run([event('1', 'applies', { match: true }), event('2', 'unreadable')])
  // The whole point. Under the previous design one unrecognized row took the
  // entire rule to not-evaluated, so this finding would have been suppressed.
  assert.equal(result.findings.length, 1)
  assert.equal(result.coverage.applies, 1)
  assert.equal(uninterpretedCount(result.coverage), 1)
  // It reduces what we claim, and only that.
  assert.equal(result.state, 'PARTIALLY_UNINTERPRETABLE')
  assert.deepEqual(result.claim, { permitted: false, because: 'UNINTERPRETED_EVENTS' })
  assert.deepEqual(result.count, { accuracy: 'AT_LEAST', value: 1 })
})

test('a lower bound is never zero, and zero arrives only through the exact branch', () => {
  // Uninterpreted events with nothing found: a bound of "at least none" would
  // state nothing while looking like a measurement.
  const unreadable = run([event('1', 'unreadable')])
  assert.deepEqual(unreadable.count, { accuracy: 'NOT_AVAILABLE', value: null })

  const clean = run([event('1', 'applies')])
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

test('declined events do not reduce coverage, and are never summed with uninterpreted ones', () => {
  const result = run([event('1', 'applies', { match: true }), event('2', 'declined'), event('3', 'declined')])
  assert.equal(declinedCount(result.coverage), 2)
  assert.equal(uninterpretedCount(result.coverage), 0)
  // Declining an event is the rules working, so a clean claim survives it.
  assert.equal(result.state, 'FULLY_INTERPRETED')
  assert.deepEqual(result.claim, { permitted: true })
  assert.deepEqual(result.count, { accuracy: 'EXACT', value: 1 })
  // The two groups are separate objects; there is no total that merges them.
  assert.deepEqual(Object.keys(result.coverage.doesNotApply).sort(), [...DOES_NOT_APPLY_REASONS].sort())
  assert.deepEqual(Object.keys(result.coverage.unknown).sort(), [...UNKNOWN_REASONS].sort())
})

test('a window of only declined events cannot report a confident zero', () => {
  // The live production defect: everything set aside, nothing assessed, and a
  // headline zero captioned as though the evidence had been examined.
  const result = run([event('1', 'declined'), event('2', 'declined')])
  assert.equal(result.coverage.applies, 0)
  assert.equal(result.state, 'FULLY_INTERPRETED')
  assert.deepEqual(result.claim, { permitted: false, because: 'NOTHING_APPLICABLE' })
  assert.deepEqual(result.count, { accuracy: 'NOT_AVAILABLE', value: null })
})

test('a partly declined window is judged by what was interpreted, not by the ratio', () => {
  // Eight declined and four assessed still permits a clean claim, because the
  // four were genuinely assessed and the eight were genuinely not applicable.
  const events = [...Array.from({ length: 8 }, (_, index) => event(`d${index}`, 'declined')),
    ...Array.from({ length: 4 }, (_, index) => event(`a${index}`, 'applies'))]
  const result = run(events)
  assert.equal(declinedCount(result.coverage), 8)
  assert.equal(result.coverage.applies, 4)
  assert.deepEqual(result.claim, { permitted: true })
  // But the disclosure is present and countable, so the zero is never bare.
  assert.deepEqual(result.count, { accuracy: 'EXACT', value: 0 })
  assert.ok(declinedCount(result.coverage) > 0, 'the qualification travels with the count')
})

test('the four states stay distinct, and each withholds for its own reason', () => {
  assert.equal(run([event('1', 'applies')], { collected: false }).state, 'NEVER_COLLECTED')
  assert.equal(run([event('1', 'applies')], { readable: false }).state, 'UNREADABLE_NOW')
  assert.equal(run([event('1', 'applies')]).state, 'FULLY_INTERPRETED')
  assert.equal(run([event('1', 'unreadable')]).state, 'PARTIALLY_UNINTERPRETABLE')

  const reasons = [
    run([event('1', 'applies')], { collected: false }).claim,
    run([event('1', 'applies')], { readable: false }).claim,
    run([event('1', 'unreadable')]).claim,
    run([event('1', 'declined')]).claim,
  ].map(claim => (claim.permitted ? 'permitted' : claim.because))
  // Distinguishable, not four spellings of "not available". Collapsing these is
  // how a label meaning "we could not read it" came to mean "never collected".
  assert.equal(new Set(reasons).size, 4)
  const explanations = new Set(reasons.map(reason => reason === 'permitted' ? reason : withheldExplanation(reason)))
  assert.equal(explanations.size, 4, 'each reason reaches the reader as its own sentence')
})

test('the budget belongs to the caller and exceeding it withholds rather than truncating silently', () => {
  const events = Array.from({ length: 5 }, (_, index) => event(`${index}`, 'applies', { match: index === 0 }))
  const result = run(events, { maxEvents: 3 })
  assert.deepEqual(result.claim, { permitted: false, because: 'CAPACITY_EXCEEDED' })
  // What it did assess is still reported, as a bound rather than a total.
  assert.deepEqual(result.count, { accuracy: 'AT_LEAST', value: 1 })
  assert.equal(result.coverage.applies, 3)

  // At the boundary the budget is not exceeded, so the claim stands.
  assert.deepEqual(run(events, { maxEvents: 5 }).claim, { permitted: true })
})

test('one failing detector cannot erase what another already found', () => {
  const broken: Detector<Event> = { id: 'broken', findings: () => { throw new Error('detector fault') } }
  // Today this propagates, which is honest but total. Pinning it so the
  // behaviour is a decision rather than an accident when detectors are added.
  assert.throws(() => run([event('1', 'applies', { match: true })], { detectors: [matching, broken] }), /detector fault/)
  const survived = run([event('1', 'applies', { match: true })], { detectors: [matching, silent] })
  assert.equal(survived.findings.length, 1)
})

test('distinct subjects are counted once however many findings they carry', () => {
  const twice: Detector<Event> = {
    id: 'twice',
    findings: applicable => applicable.flatMap(item => [0, 1].map((): Finding =>
      ({ detectorId: 'twice', subject: item.subject, observedAt: '2026-09-10T00:00:00.000Z' }))),
  }
  const result = run([event('1', 'applies'), event('1', 'applies')], { detectors: [twice] })
  assert.equal(result.findings.length, 4)
  assert.deepEqual(result.count, { accuracy: 'EXACT', value: 1 })
})

test('the claim is computed once and the count cannot disagree with it', () => {
  // Two surfaces asking the same question against different bars is what let a
  // headline and its caption contradict each other. There is one answer here.
  for (const events of [[event('1', 'applies')], [event('1', 'unreadable')], [event('1', 'declined')], []]) {
    const result = run(events)
    assert.equal(result.count.accuracy === 'EXACT', result.claim.permitted,
      'an exact count is available exactly when the claim is permitted')
    assert.deepEqual(zeroClaim(result.state, result.coverage, true), result.claim,
      'recomputing the claim from the reported state and coverage gives the same answer')
  }
})
