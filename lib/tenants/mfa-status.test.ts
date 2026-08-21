import assert from 'node:assert/strict'
import test from 'node:test'

import {
  tenantUserMfaRegistration,
  tenantUserPerUserMfaState,
} from './mfa-status.ts'

test('keeps MFA registration separate from the legacy per-user requirement', () => {
  const user = {
    mfaRegistration: 'Not registered',
    perUserMfaState: 'Enabled',
  }
  assert.equal(tenantUserMfaRegistration(user), 'Not registered')
  assert.equal(tenantUserPerUserMfaState(user), 'Enabled')
})
test('labels older Enabled and Disabled bundle values as registration facts', () => {
  assert.equal(tenantUserMfaRegistration({ mfa: 'Enabled' }), 'Registered')
  assert.equal(
    tenantUserMfaRegistration({ mfa: 'Disabled' }),
    'Not registered',
  )
  assert.equal(tenantUserPerUserMfaState({ mfa: 'Enabled' }), 'Unknown')
})

test('fails closed for inherited, malformed, and future values', () => {
  const inherited = Object.create({
    mfaRegistration: 'Registered',
    perUserMfaState: 'Enforced',
  })
  for (const value of [
    inherited,
    null,
    [],
    { mfaRegistration: true, perUserMfaState: 'unknownFutureValue' },
  ]) {
    assert.equal(tenantUserMfaRegistration(value), 'Unknown')
    assert.equal(tenantUserPerUserMfaState(value), 'Unknown')
  }
})
