import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_HAWKVIEW_FEATURE_FLAGS,
  resolveServerFeatureFlags,
} from './feature-flags.ts'

test('identity-risk UI is globally visible when the server setting is absent', () => {
  assert.equal(resolveServerFeatureFlags({}).identityRiskUi, true)
  for (const identityRiskUi of [undefined, null]) {
    assert.equal(resolveServerFeatureFlags({ identityRiskUi }).identityRiskUi, true)
  }
})

test('explicit server true enables the UI', () => {
  for (const identityRiskUi of ['true', 'TRUE', ' True ', '\ttrue\n']) {
    assert.equal(resolveServerFeatureFlags({ identityRiskUi }).identityRiskUi, true)
  }
})

test('explicit server false remains an emergency hide', () => {
  for (const identityRiskUi of ['false', 'FALSE', ' False ', '\tfalse\n']) {
    assert.equal(resolveServerFeatureFlags({ identityRiskUi }).identityRiskUi, false)
  }
})

test('blank and unknown server settings fail closed', () => {
  for (const identityRiskUi of ['', ' ', '\t\n', '1', '0', 'yes', 'on', 'off', 'null', 'undefined', 'tru', 'false,true']) {
    assert.equal(resolveServerFeatureFlags({ identityRiskUi }).identityRiskUi, false, JSON.stringify(identityRiskUi))
  }
})

test('missing provider fallback stays off and resolution returns independent frozen values', () => {
  assert.equal(DEFAULT_HAWKVIEW_FEATURE_FLAGS.identityRiskUi, false)
  assert.equal(Object.isFrozen(DEFAULT_HAWKVIEW_FEATURE_FLAGS), true)
  const enabled = resolveServerFeatureFlags({})
  const disabled = resolveServerFeatureFlags({ identityRiskUi: 'false' })
  assert.equal(Object.isFrozen(enabled), true)
  assert.equal(Object.isFrozen(disabled), true)
  assert.notEqual(enabled, disabled)
  assert.equal(enabled.identityRiskUi, true)
  assert.equal(disabled.identityRiskUi, false)
  assert.equal(DEFAULT_HAWKVIEW_FEATURE_FLAGS.identityRiskUi, false)
})
