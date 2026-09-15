import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  AUTH_WINDOW_SCHEMA_V1, prepareAuthenticationEvaluation,
  type AuthenticationDirectoryUser, type AuthenticationProof,
  type AuthenticationReference, type AuthenticationWindow,
} from './authentication-source-readiness.js'
import { AUTH_COLLECTION_MAX_AGE_MS } from './risk-assessment-projection.js'
import { SYNTHETIC_SCOPE as scope, SYNTHETIC_NOW } from '../risky-users-auth/fixtures.js'

/**
 * `freshness: 'CURRENT'` IS A LITERAL, AND THE RULE THAT MAKES IT TRUE HAD NO TEST.
 *
 * The source DTO sets `freshness: 'CURRENT'` unconditionally, which reads like
 * an unchecked assertion sitting beside the `lastSuccessfulCollectionAt` that
 * would contradict it. It is not: a collection older than
 * `AUTH_COLLECTION_MAX_AGE_MS` — ONE HOUR — never reaches that line, because
 * the guard above returns COLLECTION_STALE first.
 *
 * So the literal is true by construction. The defect is that NOTHING SAID SO.
 * Removing the age guard entirely left 122 tests passing, measured, so the rule
 * the literal depends on was resting on nobody having touched it.
 *
 * WHAT THIS PINS, EXACTLY. The rule is enforced TWICE -- once on the age of
 * `lastSuccessfulAt` and once on the age of `window.end` -- and because a
 * window ending after the last successful collection is refused separately, the
 * second subsumes the first. Removing either one alone leaves these tests
 * green; removing both fails three of them. Measured, not assumed.
 *
 * That is the honest limit of a behavioural test over a redundant pair: it
 * cannot tell which of two guards did the work, because by construction neither
 * has to. What it does catch is the rule DISAPPEARING, which is the failure
 * that matters, and it is worth knowing that the guard which looks removable
 * today becomes load-bearing the moment the window-end check changes.
 *
 * That is a live trap rather than a tidiness problem. Reading the literal as an
 * unchecked assertion and "fixing" it against a freshness threshold from a
 * neighbouring surface — `CURRENT_RUN_MAX_AGE_MS` in identity-risk.service.ts
 * is 36 HOURS — would loosen this rule by a factor of 36 and ship a regression
 * as a repair, with a green suite. I was one step from doing exactly that; this
 * test is what would have stopped me.
 *
 * The threshold is imported rather than restated, so this pins the RELATIONSHIP
 * and a deliberate change to the constant does not have to be made twice.
 */

const now = new Date(SYNTHETIC_NOW)
const user: AuthenticationDirectoryUser = {
  organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
  microsoftUserId: '11111111-1111-4111-8111-111111111111',
  userPrincipalName: 'synthetic.human@example.invalid', userType: 'Member',
}
const reference: AuthenticationReference = async (kind, identifiers) =>
  `hvr1_${kind}_${createHash('sha256').update(JSON.stringify(identifiers)).digest('hex')}`

/** A collection that finished `ageMs` ago, with a window ending when it did —
 *  the only shape that reaches the DTO, since a window extending past the last
 *  successful collection is refused separately as INCOMPLETE_WINDOW. */
const windowEndingAt = (end: Date): AuthenticationWindow => ({
  schemaVersion: AUTH_WINDOW_SCHEMA_V1, source: 'GRAPH_SIGN_INS',
  start: new Date(end.getTime() - 60 * 60_000).toISOString(),
  end: end.toISOString(), paginationComplete: true,
})
const preparedAgo = async (ageMs: number) => {
  const last = new Date(now.getTime() - ageMs)
  return prepareAuthenticationEvaluation(
    scope, [], [user],
    { status: 'SUCCEEDED', lastSuccessfulAt: last, lastAttemptAt: null, lastErrorCode: null },
    windowEndingAt(last), true, now, reference)
}
const collectedAgo = async (ageMs: number) => {
  const last = new Date(now.getTime() - ageMs)
  const proof: AuthenticationProof = {
    status: 'SUCCEEDED', lastSuccessfulAt: last, lastAttemptAt: null, lastErrorCode: null,
  }
  const window: AuthenticationWindow = {
    schemaVersion: AUTH_WINDOW_SCHEMA_V1, source: 'GRAPH_SIGN_INS',
    start: new Date(last.getTime() - 60 * 60_000).toISOString(),
    end: last.toISOString(), paginationComplete: true,
  }
  const prepared = await prepareAuthenticationEvaluation(
    scope, [], [user], proof, window, true, now, reference)
  const source = prepared.sources.find((item) => item.source === 'GRAPH_SIGN_INS')
  assert.ok(source, 'the fixture produced no GRAPH_SIGN_INS source')
  return source
}

test('a collection inside the freshness window reports CURRENT', async () => {
  const source = await collectedAgo(AUTH_COLLECTION_MAX_AGE_MS - 60_000)
  assert.equal(source.freshness, 'CURRENT')
  assert.equal(source.status, 'READY')
  assert.ok(source.lastSuccessfulCollectionAt, 'CURRENT was reported with no collection time behind it')
})

test('a collection past the freshness window never reaches CURRENT', async () => {
  // The guard the literal depends on. Deleting it leaves this the only failure.
  const source = await collectedAgo(AUTH_COLLECTION_MAX_AGE_MS + 60_000)
  assert.notEqual(
    source.freshness, 'CURRENT',
    'a collection older than the freshness window reported itself current')
  assert.equal(source.status, 'STALE')
  assert.equal(source.reasonCode, 'COLLECTION_STALE')
})

test('the boundary is the declared threshold, not a number this test invented', async () => {
  // Imported, so changing AUTH_COLLECTION_MAX_AGE_MS deliberately moves both
  // sides together — but SHRINKING it silently is still caught, because the
  // pair either side of the boundary must always differ.
  const inside = await collectedAgo(AUTH_COLLECTION_MAX_AGE_MS - 1_000)
  const outside = await collectedAgo(AUTH_COLLECTION_MAX_AGE_MS + 1_000)
  assert.equal(inside.freshness, 'CURRENT')
  assert.notEqual(outside.freshness, 'CURRENT')
  assert.notEqual(
    inside.status, outside.status,
    'the guard no longer discriminates anywhere near its own threshold')
})

test('a collection dated in the future is not current either', async () => {
  // The same guard's other half. A clock ahead of ours is not freshness.
  const source = await collectedAgo(-60 * 60_000)
  assert.notEqual(source.freshness, 'CURRENT')
  assert.equal(source.reasonCode, 'COLLECTION_STALE')
})

/**
 * A DETERMINED STALE IS NOT AN UNKNOWN.
 *
 * The stale path measured the age to decide it was stale, then reported
 * `freshness: 'UNKNOWN'` and dropped `lastSuccessfulCollectionAt` to null. We
 * looked, we know the answer, and we recorded the value that means WE COULD NOT
 * LOOK. The screen could say a source was stale but never how stale, which is
 * the difference between "check this" and "this stopped three weeks ago".
 *
 * THE CONSTRAINT ON FIXING IT, and it is the reason these tests exist rather
 * than one assertion: UNKNOWN must keep meaning "we could not look". A genuine
 * inability to determine freshness has to stay distinct from a determined
 * stale, or the change trades one conflation for another.
 *
 * So the three states are separated here by what we KNEW, not by how bad the
 * outcome was:
 *
 *   CURRENT  measured, inside the window
 *   STALE    measured, outside the window -- and it says WHEN
 *   UNKNOWN  not measurable: never collected, a clock ahead of ours, or a
 *            failure that happened before any collection time was established
 */

test('a determined stale says so, and says when it last collected', async () => {
  const last = new Date(now.getTime() - 5 * 24 * 60 * 60_000)
  const source = await collectedAgo(now.getTime() - last.getTime())
  assert.equal(source.status, 'STALE')
  assert.equal(source.reasonCode, 'COLLECTION_STALE')
  assert.equal(source.freshness, 'STALE', 'a measured staleness still reports as unmeasurable')
  assert.equal(
    source.lastSuccessfulCollectionAt, last.toISOString(),
    'the timestamp used to decide staleness was discarded on the way out')
})

test('the timestamp is not attributed to a source that did not collect it', async () => {
  // The proof belongs to the SELECTED source. Stamping its collection time onto
  // the other lane would invent a fact about a source we did not read.
  const prepared = await preparedAgo(5 * 24 * 60 * 60_000)
  const other = prepared.sources.find((item) => item.source === 'M365_AUDIT_STS')
  assert.ok(other)
  assert.equal(other.freshness, 'UNKNOWN')
  assert.equal(other.lastSuccessfulCollectionAt, null)
})

test('UNKNOWN still means we could not look, and is still reachable', async () => {
  // The constraint, as cases. None of these established a collection time, so
  // none of them may claim one or claim to know the freshness.
  const cases: [string, AuthenticationProof][] = [
    ['never collected', { status: 'RUNNING', lastSuccessfulAt: null, lastAttemptAt: now, lastErrorCode: null }],
    ['a clock ahead of ours', { status: 'SUCCEEDED', lastSuccessfulAt: new Date(now.getTime() + 60 * 60_000), lastAttemptAt: null, lastErrorCode: null }],
    ['permission refused', { status: 'FAILED', lastSuccessfulAt: null, lastAttemptAt: now, lastErrorCode: 'MICROSOFT_PERMISSION_REQUIRED' }],
  ]
  for (const [label, proof] of cases) {
    const prepared = await prepareAuthenticationEvaluation(
      scope, [], [user], proof, windowEndingAt(now), true, now, reference)
    for (const source of prepared.sources) {
      assert.equal(source.freshness, 'UNKNOWN', `${label}: freshness was claimed without being measurable`)
      assert.equal(source.lastSuccessfulCollectionAt, null, `${label}: a collection time was invented`)
    }
  }
})

test('a future-dated collection is UNKNOWN, not STALE', async () => {
  // Both fail through COLLECTION_STALE, and they are not the same fact. A clock
  // ahead of ours means we cannot place the collection in time at all, so it
  // must not borrow the vocabulary of a measured staleness.
  const source = await collectedAgo(-60 * 60_000)
  assert.equal(source.reasonCode, 'COLLECTION_STALE')
  assert.equal(
    source.freshness, 'UNKNOWN',
    'an unplaceable collection time was reported as a measured staleness')
  assert.equal(source.lastSuccessfulCollectionAt, null)
})

test('the three freshness states never collapse into two', async () => {
  // Read as one property rather than three assertions: each state must be
  // produced by some input, or the distinction exists only in the type.
  const produced = new Set([
    (await collectedAgo(AUTH_COLLECTION_MAX_AGE_MS - 60_000)).freshness,
    (await collectedAgo(AUTH_COLLECTION_MAX_AGE_MS + 60_000)).freshness,
    (await collectedAgo(-60 * 60_000)).freshness,
  ])
  assert.deepEqual([...produced].sort(), ['CURRENT', 'STALE', 'UNKNOWN'])
})
