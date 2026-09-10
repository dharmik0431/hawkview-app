import assert from 'node:assert/strict'
import test from 'node:test'
import { decideFeed } from './decide-feed.js'

/** The audit envelope as the collector actually writes it, checked against real
 * rows rather than invented: the marker is on the OUTER object, beside a
 * Graph-shaped `createdDateTime`, which is why reading the payload's shape
 * instead of its marker concluded "Graph" for all five tenants. */
const auditRaw = { hawkviewSource: 'MICROSOFT_365_MANAGEMENT_ACTIVITY', createdDateTime: '2026-09-10T17:34:50', managementActivityRecord: {} }
const graphRaw = { id: 'evt-1', createdDateTime: '2026-09-10T17:34:50Z' }

test('the feed comes off the rows', () => {
  assert.deepEqual(decideFeed([auditRaw, auditRaw], 'GRAPH_SIGN_INS'), {
    feed: 'M365_AUDIT_STS', from: 'ROWS', rowsWithUnrecognizedSource: 0,
  })
  assert.deepEqual(decideFeed([graphRaw], 'M365_AUDIT_STS'), {
    feed: 'GRAPH_SIGN_INS', from: 'ROWS', rowsWithUnrecognizedSource: 0,
  })
})

test('the caller cannot override what the rows say', () => {
  // The whole defect in one assertion. The caller asserted GRAPH_SIGN_INS on
  // three tenants whose rows were audit-sourced, and was believed.
  assert.equal(decideFeed([auditRaw], 'GRAPH_SIGN_INS').feed, 'M365_AUDIT_STS')
})

test('with no rows the fallback is used and says that it was', () => {
  // A quiet tenant still needs a feed, because detectors are bound to one and
  // an unbindable check reports INAPPLICABLE. So the fallback is legitimate —
  // what is not legitimate is it being indistinguishable from a derived answer.
  const decision = decideFeed([], 'GRAPH_SIGN_INS')
  assert.equal(decision.feed, 'GRAPH_SIGN_INS')
  assert.equal(decision.from, 'NO_ROWS_TO_DERIVE_FROM')
})

test('an unknown source name is counted, not guessed at', () => {
  // Passed through to the classifier, which files it under SOURCE_UNRECOGNIZED.
  // Guessing a feed for it would put rows we cannot identify into a feed's
  // coverage, and coverage is the denominator a zero rests on.
  const decision = decideFeed([{ hawkviewSource: 'SOMETHING_NEW' }, auditRaw], 'GRAPH_SIGN_INS')
  assert.equal(decision.feed, 'M365_AUDIT_STS')
  assert.equal(decision.rowsWithUnrecognizedSource, 1)

  // And rows we cannot identify do not become a feed on their own.
  assert.equal(decideFeed([{ hawkviewSource: 'SOMETHING_NEW' }], 'GRAPH_SIGN_INS').from, 'NO_ROWS_TO_DERIVE_FROM')
})

test('two feeds in one tenant is refused rather than resolved', () => {
  // Picking either one silently discards the other's rows, which is the
  // disappearance this function exists to end — arriving through its own fix.
  assert.throws(() => decideFeed([graphRaw, auditRaw], 'GRAPH_SIGN_INS'), /more than one feed/)
})
