import assert from 'node:assert/strict'
import test from 'node:test'
import { signalsOf, withSignals } from './finding-signals-dto.js'
import type { Finding } from '../evaluation-core/contract.js'

const finding = (signals: Finding['signals']): Finding => ({
  detectorId: 'repeated-credential-failure',
  subject: {
    kind: 'DIRECTORY_USER',
    userRef: 'subject-1',
    correlation: { available: true, matchedBy: 'DIRECTORY_OBJECT_ID', ref: 'guid-1' },
  },
  signals,
})

test('a signal crosses the wire whole — count, recency, kind and ceiling together', () => {
  const wire = signalsOf(finding([
    { signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES', count: 467, latest: { at: '2026-09-03T10:40:00.000Z', kind: 'EVENT_OCCURRED' }, capped: false },
    { signal: 'PASSWORD_REJECTED', count: 12, latest: { at: '2026-09-09T03:58:00.000Z', kind: 'EVENT_OCCURRED' }, capped: false },
  ]))

  // The Raymonds account. The count and the date that belongs to it arrive in
  // one object, so a renderer cannot pair 467 with the 9 September rejection.
  assert.deepEqual(wire[0], {
    signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES',
    count: 467,
    latest: { at: '2026-09-03T10:40:00.000Z', kind: 'EVENT_OCCURRED' },
    capped: false,
  })
  assert.equal(wire[1]?.latest?.at, '2026-09-09T03:58:00.000Z')
})

test('the two things a null recency and an absent signal mean survive the crossing', () => {
  // Biolink's fourth account: no lockouts, seven rejections. The zero-count
  // signal must arrive, carrying null — "we looked and found none". A signal
  // simply absent from the array was never evaluated at all.
  const wire = signalsOf(finding([
    { signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES', count: 0, latest: null, capped: false },
    { signal: 'PASSWORD_REJECTED', count: 7, latest: { at: '2026-09-08T13:20:00.000Z', kind: 'EVENT_OCCURRED' }, capped: false },
  ]))

  assert.equal(wire.length, 2)
  assert.equal(wire[0]?.count, 0)
  assert.equal(wire[0]?.latest, null)
  assert.equal(wire.some(signal => signal.signal === 'EXTERNAL_FORWARDING_CONFIGURED'), false)
})

test('a read time crosses as a read time', () => {
  // Forwarding has no event time — Exchange reports no moment at which a rule
  // was configured, only when we last looked. Dropping the kind here would
  // restore the inversion the core just removed: a six-month-old rule reading
  // as the most urgent thing on the page, and getting worse as collection
  // improves.
  const wire = signalsOf(finding([
    { signal: 'EXTERNAL_FORWARDING_CONFIGURED', count: 3, latest: { at: '2026-09-10T17:59:00.000Z', kind: 'STATE_OBSERVED' }, capped: false },
  ]))
  assert.equal(wire[0]?.latest?.kind, 'STATE_OBSERVED')
})

test('absence is the missing key — never null, never an empty array', () => {
  const base = { id: 'finding-1', evidenceCount: 467, lastSeen: '2026-09-09T03:58:00.000Z' }

  // An old server, or a path that has no signals: the key is simply not there.
  // A presence-based adapter reads that as "this server does not speak this
  // field" and falls back, with no new code on either side of a split deploy.
  const without = withSignals(base, undefined)
  assert.equal('signals' in without, false)
  assert.equal(JSON.stringify(without).includes('signals'), false)

  // And the legacy fields survive alongside, because additive has to hold in
  // BOTH deploy directions — an old frontend against a new backend is the
  // window where the consumer has no fallback to reach for.
  const withThem = withSignals(base, [
    { signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES', count: 467, latest: { at: '2026-09-03T10:40:00.000Z', kind: 'EVENT_OCCURRED' }, capped: false },
  ])
  assert.equal(withThem.evidenceCount, 467)
  assert.equal(withThem.lastSeen, '2026-09-09T03:58:00.000Z')
  assert.equal('signals' in withThem, true)
})

test('an empty signals array is unrepresentable rather than discouraged', () => {
  // `[]` would assert "every signal was never evaluated" — a finding resting on
  // nothing. The consumer rejects it deliberately, so if it were ever also used
  // as an old-server sentinel they would reject every finding in the tenant for
  // the length of the deploy window: silent, total, and looking exactly like a
  // clean tenant.
  //
  // The non-empty tuple is what stops it being constructible at all, and the
  // suppression below IS the assertion: `tsc` fails this file if the type ever
  // starts permitting an empty array, because the suppression would then be
  // unused. A compile-time check living in a test rather than a runtime one.
  //
  // (Do not name that directive in prose. Any comment containing the token is
  // a live directive, so describing it here created a second, unused one and
  // broke the build — which is how this comment came to be worded around it.)
  const empty = (): unknown =>
    // @ts-expect-error a finding must rest on at least one signal
    signalsOf(finding([]))

  // And if it is reached anyway — via `any`, or JSON parsed from elsewhere — it
  // throws rather than quietly emitting a malformed array. Loud beats silent
  // for a shape whose whole purpose is to be unambiguous downstream.
  assert.throws(empty)
})
