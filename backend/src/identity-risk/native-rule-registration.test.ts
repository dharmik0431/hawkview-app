import assert from 'node:assert/strict'
import test from 'node:test'
import { IDENTITY_RISK_RULE_CATALOG } from './identity-risk.catalog.js'
import { IDENTITY_SIGNAL_RULE_IDS } from './identity-signal-contract.js'
import { isApprovedRuleCatalogCompatible, PLATFORM_ONLY_IDENTITY_RISK_RULE_IDS } from './identity-risk-approved-evaluator.adapter.js'

test('native 011 is platform-only without a fictional legacy implementation', () => {
  assert.ok(PLATFORM_ONLY_IDENTITY_RISK_RULE_IDS.includes('HV-ID-AUTH-011.v1'))
  assert.equal((IDENTITY_SIGNAL_RULE_IDS as readonly string[]).includes('HV-ID-AUTH-011.v1'), false)
  assert.equal(isApprovedRuleCatalogCompatible(Object.keys(IDENTITY_RISK_RULE_CATALOG)), true)
})

test('approval guard rejects unknown additions, missing approved rules and duplicates', () => {
  const catalog = Object.keys(IDENTITY_RISK_RULE_CATALOG)
  assert.equal(isApprovedRuleCatalogCompatible([...catalog, 'HV-ID-AUTH-999.v1']), false)
  assert.equal(isApprovedRuleCatalogCompatible(catalog.filter(id => id !== IDENTITY_SIGNAL_RULE_IDS[0])), false)
  assert.equal(isApprovedRuleCatalogCompatible([...catalog, catalog[0]!]), false)
})
