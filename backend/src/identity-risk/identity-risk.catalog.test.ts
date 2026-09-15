import assert from 'node:assert/strict'
import test from 'node:test'
import { IDENTITY_RISK_RULE_CATALOG } from './identity-risk.catalog.js'

test('v1 catalog owns all bounded user-facing finding text', () => {
  const entries = Object.entries(IDENTITY_RISK_RULE_CATALOG)
  assert.equal(entries.length, 25)
  assert.match(IDENTITY_RISK_RULE_CATALOG['HV-ID-AUTH-009.v1'].title, /Break-glass/)
  assert.ok(IDENTITY_RISK_RULE_CATALOG['HV-ID-AUTH-010.v1'])
  assert.ok(IDENTITY_RISK_RULE_CATALOG['HV-ID-AUTH-005.v2'])
  assert.equal(IDENTITY_RISK_RULE_CATALOG['HV-ID-AUTH-011.v1'].investigationGuidanceCode, 'REVIEW_ACTIVITY')
  assert.match(IDENTITY_RISK_RULE_CATALOG['HV-ID-AUTH-011.v1'].explanation, /does not assert/)
  for (const [ruleId, presentation] of entries) {
    assert.match(ruleId, /^(?:HV-ID-(EXP|CHG|APP|MBX|AUTH)-\d{3}\.v1|HV-ID-AUTH-005\.v2)$/)
    assert.ok(ruleId.length <= 150)
    assert.ok(presentation.title.length > 0 && presentation.title.length <= 160)
    assert.ok(
      presentation.explanation.length > 0 &&
        presentation.explanation.length <= 300,
    )
    assert.ok(
      presentation.investigationGuidance.length > 0 &&
        presentation.investigationGuidance.length <= 300,
    )
    assert.ok(presentation.benignAlternativeCodes.length <= 10)
    assert.ok(presentation.sourceLabels.length <= 10)
    for (const value of [
      ...presentation.benignAlternativeCodes,
      ...presentation.sourceLabels,
    ]) {
      assert.ok(value.length > 0 && value.length <= 120)
      assert.doesNotMatch(value, /[\u0000-\u001f\u007f]/)
    }
  }
})
