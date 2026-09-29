import assert from 'node:assert/strict'
import test from 'node:test'
import { mapRuleToPresentation, primaryReasonFor } from './risk-presentation-mapper.ts'
const reason = (signal: string | null, evidenceCount?: number | null, ruleId = 'repeated-credential-failure') => ({ ruleId, signal, evidenceCount, evidenceCountCapped: false })

test('a positive rejection titles the finding while evaluated zero lockout remains available', () => {
  const reasons = [reason('LOCKED_OUT_AFTER_REPEATED_FAILURES', 0), reason('PASSWORD_REJECTED', 7)]
  assert.equal(primaryReasonFor(reasons), reasons[1])
  assert.equal(reasons.length, 2)
  assert.equal(mapRuleToPresentation(primaryReasonFor(reasons)!).plainTitle, 'Rejected password attempts observed')
  const zero = mapRuleToPresentation(reasons[0])
  assert.match(zero.plainTitle, /No lockout records observed/)
  assert.match(zero.plainExplanation, /zero/)
  assert.notEqual(zero.plainTitle, mapRuleToPresentation(reason('LOCKED_OUT_AFTER_REPEATED_FAILURES')).plainTitle)
  assert.equal(primaryReasonFor([]), undefined)
})

test('known signals need positive evidence; zero, absent, invalid and capped-zero do not assert occurrence', () => {
  for (const signal of ['LOCKED_OUT_AFTER_REPEATED_FAILURES', 'PASSWORD_REJECTED', 'EXTERNAL_FORWARDING_CONFIGURED']) {
    assert.match(mapRuleToPresentation(reason(signal, 0)).plainTitle, /^No /)
    for (const evidenceCount of [undefined, null, -1, NaN, Infinity, 1.5]) {
      assert.equal(mapRuleToPresentation(reason(signal, evidenceCount)).plainTitle, 'Finding explanation unavailable')
    }
    assert.equal(mapRuleToPresentation({ ...reason(signal, 0), evidenceCountCapped: true }).plainTitle, 'Finding explanation unavailable')
    assert.notEqual(mapRuleToPresentation(reason(signal, 2)).plainTitle, 'Finding explanation unavailable')
  }
})

test('positive lockout is provider-attributed and neither varied-password proof nor current compromise', () => {
  const mapped = mapRuleToPresentation(reason('LOCKED_OUT_AFTER_REPEATED_FAILURES', 1))
  assert.equal(mapped.plainTitle, 'Account lockout reported')
  assert.match(mapped.plainExplanation, /Microsoft reported/)
  assert.match(mapped.evidenceContext, /not distinct lockout episodes/)
  assert.match(mapped.evidenceContext, /does not prove varied passwords/)
  assert.doesNotMatch(mapped.plainExplanation, /consecutive|triggered|compromis|varied/)
})

test('rejection-only guidance investigates saved credentials before conditional containment', () => {
  for (const count of [1, 5, 1000]) {
    const mapped = mapRuleToPresentation(reason('PASSWORD_REJECTED', count))
    assert.match(mapped.evidenceContext, /do not by themselves prove a concentrated attack/)
    assert.match(mapped.recommendedActions[1], /outdated saved password/)
    assert.match(mapped.recommendedActions[3], /^If unauthorized successful access or credential exposure is corroborated/)
    assert.doesNotMatch(mapped.recommendedActions.join(' '), /if.*unexplained|if suspicious attempts continue/i)
  }
})

test('unknown signal never borrows a known detector explanation, but preserves the existing finding', () => {
  for (const ruleId of ['repeated-credential-failure', 'HV-ID-AUTH-005.v2', 'future-rule']) {
    const mapped = mapRuleToPresentation(reason('NEW_SIGNAL', 7, ruleId))
    assert.equal(mapped.plainTitle, 'Finding explanation unavailable')
    assert.match(mapped.plainExplanation, /returned a finding/)
    assert.doesNotMatch(mapped.plainExplanation, /locked|password was rejected|successful authentication/)
  }
  assert.equal(mapRuleToPresentation(reason(null, 7, 'future-rule')).plainTitle, 'Finding explanation unavailable')
})

test('legacy failure-then-success preserves success without inferring an unauthorized actor', () => {
  const mapped = mapRuleToPresentation(reason(null, 7, 'HV-ID-AUTH-005.v2'))
  assert.equal(mapped.plainTitle, 'Authentication failures followed by success')
  assert.match(mapped.evidenceContext, /does not establish.*unauthorized/)
  assert.match(mapped.recommendedActions[0], /successful authentication/)
})
