import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mfaRegistrationPresentation,
  perUserMfaPresentation,
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

test('assigns distinct, non-deceptive badge tones to every MFA state', () => {
  assert.deepEqual(
    mfaRegistrationPresentation({ mfaRegistration: 'Registered' }),
    { label: 'Registered', tone: 'positive' },
  )
  assert.deepEqual(
    mfaRegistrationPresentation({ mfaRegistration: 'Not registered' }),
    { label: 'Not registered', tone: 'caution' },
  )
  assert.deepEqual(mfaRegistrationPresentation({}), {
    label: 'Not reported',
    tone: 'neutral',
  })

  assert.deepEqual(perUserMfaPresentation({ perUserMfaState: 'Enforced' }), {
    label: 'Enforced',
    tone: 'positive',
  })
  assert.deepEqual(perUserMfaPresentation({ perUserMfaState: 'Enabled' }), {
    label: 'Enabled',
    tone: 'info',
  })
  assert.deepEqual(perUserMfaPresentation({ perUserMfaState: 'Disabled' }), {
    label: 'Disabled',
    tone: 'neutral',
  })
  assert.deepEqual(perUserMfaPresentation({}), {
    label: 'Not reported',
    tone: 'neutral',
  })
})
