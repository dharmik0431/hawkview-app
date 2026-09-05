import assert from 'node:assert/strict'
import test from 'node:test'
import { isGlobalRiskConfig, riskRuntimeConfig, riskScopeAllowed } from './risk-runtime-config.js'

const globalEnv = { HAWKVIEW_IDENTITY_RISK_ROLLOUT: 'global', HAWKVIEW_IDENTITY_RISK_MODE: 'shadow',
  HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'wrapped-v1', HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: 'test' }
const scope = { environment: 'test', organizationId: '00000000-0000-0000-0000-000000000001', customerTenantId: '00000000-0000-0000-0000-000000000002' }

test('explicit global config has no tenant enrollment, subscription or expiry restriction', () => {
  const config = riskRuntimeConfig(globalEnv)
  assert.ok(isGlobalRiskConfig(config))
  for (let id = 1; id <= 100; id++) {
    assert.equal(riskScopeAllowed({ ...scope, organizationId: `00000000-0000-0000-0000-${String(id).padStart(12, '0')}` }, config), true)
  }
  assert.equal(riskScopeAllowed({ ...scope, environment: 'foreign' }, config), false)
  assert.equal(riskScopeAllowed({ ...scope, organizationId: '*' }, config), false)
  assert.equal(riskScopeAllowed({ ...scope, customerTenantId: 'invalid' }, config), false)
})

test('global config fails closed on contradictory/unknown/provider/mode/environment values', () => {
  for (const [name, value] of [
    ['HAWKVIEW_IDENTITY_RISK_ROLLOUT', 'GLOBAL'], ['HAWKVIEW_IDENTITY_RISK_ROLLOUT', ''],
    ['HAWKVIEW_IDENTITY_RISK_MODE', 'off'], ['HAWKVIEW_IDENTITY_RISK_MODE', 'enabled'],
    ['HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER', 'wrapped-pilot-v1'], ['HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER', 'managed-kms'],
    ['HAWKVIEW_IDENTITY_RISK_ENVIRONMENT', '*'], ['HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE', ''],
    ['HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE', '{}'],
  ]) assert.equal(riskRuntimeConfig({ ...globalEnv, [name!]: value }), null)
  assert.equal(riskRuntimeConfig({}), null)
})

test('legacy pilot compatibility stays strict and never becomes a global fallback', () => {
  const env = { ...globalEnv, HAWKVIEW_IDENTITY_RISK_ROLLOUT: undefined, HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'wrapped-pilot-v1',
    HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: JSON.stringify({ organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
      expiresAt: new Date(Date.now() + 3600000).toISOString() }) }
  const config = riskRuntimeConfig(env)
  assert.ok(config)
  assert.equal(isGlobalRiskConfig(config), false)
  assert.equal(riskScopeAllowed(scope, config), true)
  assert.equal(riskScopeAllowed({ ...scope, customerTenantId: '00000000-0000-0000-0000-000000000003' }, config), false)
  assert.equal(riskRuntimeConfig({ ...env, HAWKVIEW_IDENTITY_RISK_ROLLOUT: 'global' }), null)
})
