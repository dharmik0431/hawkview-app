import assert from 'node:assert/strict'
import test from 'node:test'
import { adaptIdentityRiskResponses } from './adapter.ts'
import { benignAlternativeLabel, hawkViewEmptyPresentation, microsoftHasConfirmedEmptySnapshot, missingEvidenceLabel } from './presentation.ts'
import { boundedCount, receiptTime, setHawkViewMeta, syntheticRiskResponses, unavailableMeta } from './test-fixtures.ts'

test('only actual evaluated outcomes and a complete current page justify evaluated-empty copy', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const view = adaptIdentityRiskResponses(syntheticRiskResponses())
  assert.equal(hawkViewEmptyPresentation(view.hawkView)?.label, 'No findings in evaluated evidence')
  assert.equal(microsoftHasConfirmedEmptySnapshot(view.microsoft), true)
  for (const key of ['identitiesNeedingReview', 'openFindings', 'matchedResults', 'suppressedResults', 'notEvaluatedResults']) {
    const responses = syntheticRiskResponses()
    responses.hawkViewSummary.counts[key] = boundedCount(1)
    assert.notEqual(hawkViewEmptyPresentation(adaptIdentityRiskResponses(responses).hawkView)?.label, 'No findings in evaluated evidence', key)
  }
  for (const key of ['evaluatedRules', 'notMatchedResults']) {
    const responses = syntheticRiskResponses()
    responses.hawkViewSummary.counts[key] = boundedCount(0)
    assert.notEqual(hawkViewEmptyPresentation(adaptIdentityRiskResponses(responses).hawkView)?.label, 'No findings in evaluated evidence', key)
  }
})

test('empty coverage records and only not-evaluated outcomes do not claim a check ran', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const responses = syntheticRiskResponses()
  responses.hawkViewSummary.counts.evaluatedRules = boundedCount(22)
  responses.hawkViewSummary.counts.notMatchedResults = boundedCount(0)
  responses.hawkViewSummary.counts.notEvaluatedResults = boundedCount(22)
  assert.equal(hawkViewEmptyPresentation(adaptIdentityRiskResponses(responses).hawkView)?.label, 'No evaluated outcomes reported')
})

test('stale, partial, missing, disabled, learning, and error evidence never becomes confirmed empty', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const states = [
    { capability: 'PARTIAL', limitation: 'Mailbox-rule evidence is incomplete.' },
    { status: 'STALE', freshness: 'STALE', limitation: 'Evidence is stale.' },
    { status: 'LEARNING', freshness: 'UNKNOWN', limitation: 'Learning state reported.' },
    unavailableMeta('HawkView identity signal evaluation is not enabled.'),
    unavailableMeta('No completed shadow evaluation is available.', 'NOT_EVALUATED'),
    unavailableMeta('Evidence could not be loaded.', 'ERROR'),
  ]
  for (const state of states) {
    const responses = syntheticRiskResponses()
    setHawkViewMeta(responses, state)
    if (state.capability === 'UNAVAILABLE') {
      for (const key of Object.keys(responses.hawkViewSummary.counts)) responses.hawkViewSummary.counts[key] = boundedCount(0, false)
    }
    const view = adaptIdentityRiskResponses(responses)
    assert.equal(view.hawkView.meta.status, state.status ?? 'AVAILABLE')
    assert.notEqual(hawkViewEmptyPresentation(view.hawkView)?.label, 'No findings in evaluated evidence')
  }
  const missing = adaptIdentityRiskResponses({ hawkViewSummary: null, hawkViewFindings: null, microsoftRiskyUsers: null })
  assert.equal(hawkViewEmptyPresentation(missing.hawkView), null)
  assert.equal(microsoftHasConfirmedEmptySnapshot(missing.microsoft), false)
})

test('bounded or missing pagination is never a complete empty result for either channel', (t) => {
  t.mock.method(Date, 'now', () => receiptTime)
  const responses = syntheticRiskResponses()
  for (const page of [responses.hawkViewFindings, responses.microsoftRiskyUsers]) page.pageInfo = { hasMore: true, nextCursor: 'opaque.cursor' }
  const view = adaptIdentityRiskResponses(responses)
  assert.equal(hawkViewEmptyPresentation(view.hawkView)?.label, 'No findings in this page')
  assert.equal(microsoftHasConfirmedEmptySnapshot(view.microsoft), false)
  view.hawkView.pageInfo = null
  view.microsoft.pageInfo = null
  assert.notEqual(hawkViewEmptyPresentation(view.hawkView)?.label, 'No findings in evaluated evidence')
  assert.equal(microsoftHasConfirmedEmptySnapshot(view.microsoft), false)
})

test('approved evidence and benign-alternative codes get plain language without exposing unknown codes', () => {
  assert.equal(missingEvidenceLabel('MAILBOX_RULE_PROJECTION_INCOMPLETE'), 'Mailbox-rule evidence is incomplete')
  assert.equal(benignAlternativeLabel('APPROVED_EXTERNAL_FORWARDING'), 'Authorized external forwarding')
  assert.doesNotMatch(missingEvidenceLabel('INTERNAL_SECRET_NAME'), /INTERNAL_SECRET_NAME/)
  assert.doesNotMatch(benignAlternativeLabel('INTERNAL_SECRET_NAME'), /INTERNAL_SECRET_NAME/)
  assert.equal(typeof missingEvidenceLabel('__proto__'), 'string')
  assert.equal(typeof benignAlternativeLabel('constructor'), 'string')
})
