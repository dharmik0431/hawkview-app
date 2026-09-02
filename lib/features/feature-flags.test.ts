import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_HAWKVIEW_FEATURE_FLAGS,
  resolveServerFeatureFlags,
} from './feature-flags.ts'

test('identity-risk UI defaults off', () => {
  assert.equal(DEFAULT_HAWKVIEW_FEATURE_FLAGS.identityRiskUi, false)
  assert.equal(resolveServerFeatureFlags({}).identityRiskUi, false)
  assert.equal(
    resolveServerFeatureFlags({ identityRiskUi: 'false' }).identityRiskUi,
    false
  )
})

test('identity-risk UI enables only through an explicit server value', () => {
  assert.equal(
    resolveServerFeatureFlags({ identityRiskUi: 'true' }).identityRiskUi,
    true
  )
  assert.equal(
    resolveServerFeatureFlags({ identityRiskUi: ' TRUE ' }).identityRiskUi,
    true
  )
  assert.equal(
    resolveServerFeatureFlags({ identityRiskUi: '1' }).identityRiskUi,
    false
  )
})
