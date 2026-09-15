import assert from 'node:assert/strict'
import test from 'node:test'
import { adaptRiskAssessmentResponse } from './adapter.ts'
import { assessmentFixture, assessmentNow } from './assessment-test-fixtures.ts'

/**
 * THE REASON HAS TO SURVIVE THE WIRE, OR IT TAKES THE SCREEN WITH IT.
 *
 * The evaluator now emits `NO_EVIDENCE_IN_WINDOW` to separate a window that
 * held nothing from a rule that ran and declined its evidence. The adapter
 * validates `reasonCode` against an allowlist, and an unrecognised value does
 * not degrade one rule — it nulls the WHOLE response, because a null entry in
 * `rules` fails the assembly check:
 *
 *     rules.some((item) => item === null) -> return null
 *
 * So shipping the backend half alone turns "this tenant produced no sign-in
 * evidence" into an unreadable page, for exactly the tenants the reason
 * describes. The two halves are one change.
 *
 * There are TWO allowlists, and only one of them was named in review. The
 * second guards why a tenant's user count is withheld.
 *
 * BE CLEAR ABOUT WHAT THE COUNT HALF IS: PREPARATION. No server sends a count
 * reason — the backend's RiskAssessmentSummaryDto has no `reasons` field, so
 * the fixtures below hand-craft one. They prove the adapter accepts and
 * preserves the shape, NOT that anything produces it. Today an empty-window
 * tenant withholds its count with no explanation at all.
 *
 * It is still the right value to add, because once a reason IS sent the only
 * alternative is `INCOMPLETE_WINDOW`, which claims part of the window was
 * seen — the same conflation this work removes, one level up.
 *
 * Found by Codex review (C1); the summary half found while testing it.
 */

/** The shape a real backend sends for a tenant whose window held nothing:
 *  collection succeeded, so the SOURCE is READY, and the rule is WAITING. */
const emptyWindowResponse = () => {
  const value = assessmentFixture()
  Object.assign(value.rules[0], {
    status: 'WAITING',
    reasonCode: 'NO_EVIDENCE_IN_WINDOW',
    explanation: 'Collection succeeded and the window held nothing to evaluate.',
    evaluatedAt: null,
    assessedIdentities: 0,
    matchedIdentities: 0,
  })
  // A rule that did not run cannot back an exact total, so the count is
  // withheld and carries its cause.
  value.summary.currentUsers = {
    value: null,
    accuracy: 'UNKNOWN',
    reasons: ['NO_EVIDENCE_IN_WINDOW'],
  }
  return value
}

test('C1: a rule reporting NO_EVIDENCE_IN_WINDOW reaches the screen', () => {
  const result = adaptRiskAssessmentResponse(emptyWindowResponse(), assessmentNow)

  assert.ok(
    result,
    'the whole assessment was rejected; every tenant with an empty window ' +
      'renders as unreadable rather than as quiet'
  )
  assert.equal(result.rules[0].reasonCode, 'NO_EVIDENCE_IN_WINDOW')
  assert.equal(result.rules[0].status, 'WAITING')
  assert.deepEqual(result.summary?.currentUsers.reasons, ['NO_EVIDENCE_IN_WINDOW'])
})

test('C1: the empty window is not laundered into an assessed result', () => {
  // The reason exists to stop the screen saying "assessed, nothing found", so
  // nothing on the way through may normalise it to READY or to a coverage code
  // that reads as completeness.
  const result = adaptRiskAssessmentResponse(emptyWindowResponse(), assessmentNow)
  assert.ok(result)
  assert.notEqual(result.rules[0].reasonCode, 'READY')
  assert.notEqual(result.rules[0].status, 'READY')
  assert.notEqual(result.summary?.currentUsers.accuracy, 'EXACT')
  assert.equal(result.meta.capability, 'PARTIAL')
})

test('C1: the summary can say WHY the count is withheld without misdescribing it', () => {
  // Before this change `INCOMPLETE_WINDOW` was the closest available reason,
  // and it says the opposite thing: that we saw part of the window. The
  // distinction has to exist at the summary level too or it is lost exactly
  // where the screen is most read.
  const result = adaptRiskAssessmentResponse(emptyWindowResponse(), assessmentNow)
  assert.ok(result)
  assert.ok(
    !result.summary?.currentUsers.reasons.includes('INCOMPLETE_WINDOW'),
    'an empty window is being reported as a partially-seen one'
  )
})

test('C1 CONTROL: a genuinely unknown reason is still refused, at both levels', () => {
  // The fix must be widening two allowlists by one value each, not removing the
  // checks. A reason no version of the backend emits has to keep failing.
  const inventedRule = emptyWindowResponse()
  inventedRule.rules[0].reasonCode = 'NO_EVIDENCE_IN_WINDOW_PLEASE'
  assert.equal(
    adaptRiskAssessmentResponse(inventedRule, assessmentNow),
    null,
    'the rule allowlist stopped discriminating; any string now passes'
  )

  const inventedCount = emptyWindowResponse()
  inventedCount.summary.currentUsers.reasons = ['NO_EVIDENCE_AT_ALL']
  assert.equal(
    adaptRiskAssessmentResponse(inventedCount, assessmentNow),
    null,
    'the count-reason allowlist stopped discriminating'
  )

  const empty = emptyWindowResponse()
  empty.rules[0].reasonCode = ''
  assert.equal(adaptRiskAssessmentResponse(empty, assessmentNow), null)
})

test('C1 CONTROL: an exact count still refuses to carry a reason', () => {
  // The pre-existing invariant — a reason explains a withheld or bounded total,
  // so attaching one to an exact count is a contradiction — must survive the
  // new value rather than be widened by it.
  const contradictory = assessmentFixture()
  contradictory.summary.currentUsers = {
    value: 0,
    accuracy: 'EXACT',
    reasons: ['NO_EVIDENCE_IN_WINDOW'],
  }
  assert.equal(adaptRiskAssessmentResponse(contradictory, assessmentNow), null)
})

test('C1 CONTROL: the untouched fixture still adapts', () => {
  // So none of the assertions above can pass because the fixture stopped
  // working. A healthy tenant is unaffected by any of this.
  const result = adaptRiskAssessmentResponse(assessmentFixture(), assessmentNow)
  assert.ok(result, 'the baseline fixture no longer adapts; the tests prove nothing')
  assert.equal(result.rules[0].reasonCode, 'READY')
  assert.equal(result.meta.capability, 'FULL')
  assert.equal(result.summary?.currentUsers.accuracy, 'EXACT')
})
