import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CORE_AUTHENTICATION_PARTIAL,
  isCoreAuthenticationPartial,
  isRecognizedLimitedSignInCode,
} from './authentication-collection-outcome.js'

test('only exact, scoped limited SIGN_INS reasons qualify', () => {
  const sources = ['premium-graph', 'non-premium', 'entitlement-unverified']
  for (const source of sources) {
    for (const suffix of ['', '-geolocation-partial']) {
      const code = `sign-ins-${source}-fallback-active${suffix}`
      assert.equal(isRecognizedLimitedSignInCode('SIGN_INS', code), true, code)
      assert.equal(isRecognizedLimitedSignInCode('AUDIT_LOGS', code), false, code)
    }
  }
})

test('core loss, unknown and lookalike partial reasons cannot imply limited success', () => {
  assert.equal(isCoreAuthenticationPartial('SIGN_INS', CORE_AUTHENTICATION_PARTIAL), true)
  for (const code of [
    CORE_AUTHENTICATION_PARTIAL,
    'sign-ins-audit-subscription-initializing',
    'sign-ins-non-premium-fallback-active-extra',
    'sign-ins-non-premium-fallback-active-geolocation-partial-extra',
    'SIGN-INS-NON-PREMIUM-FALLBACK-ACTIVE',
    '', null, undefined,
  ]) {
    assert.equal(isRecognizedLimitedSignInCode('SIGN_INS', code), false, String(code))
  }
})
