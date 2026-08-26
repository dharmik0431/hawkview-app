import assert from 'node:assert/strict'
import test from 'node:test'

import {
  effectiveMfaEnforcementPresentation,
  mfaRegistrationPresentation,
  perUserMfaPresentation,
  tenantUserMfaRegistration,
  tenantUserPerUserMfaState,
  tenantUserEffectiveMfaEnforcement,
} from './mfa-status.ts'

test('keeps MFA registration separate from the legacy per-user requirement', () => {
  const user = {
    mfaRegistration: 'Not registered',
    perUserMfaState: 'Enabled',
  }
  assert.equal(tenantUserMfaRegistration(user), 'Not registered')
  assert.equal(tenantUserPerUserMfaState(user), 'Enabled')
})

test('renders only the versioned backend-owned effective enforcement contract', () => {
  const user = {
    mfaRegistration: 'Not registered',
    perUserMfaState: 'Disabled',
    effectiveMfaEnforcement: {
      contractVersion: 1,
      status: 'COVERED_BY_CONDITIONAL_ACCESS',
      label: 'Covered by Conditional Access — Require MFA',
      policies: [{
        id: 'policy-1',
        name: 'Require MFA',
        state: 'ENABLED',
        outcome: 'UNIVERSAL',
        materialConditions: [],
      }],
      evidenceObservedAt: '2026-08-26T12:00:00.000Z',
      riskReductionAllowed: true,
    },
  }
  assert.equal(tenantUserEffectiveMfaEnforcement(user)?.policies[0]?.id, 'policy-1')
  assert.deepEqual(effectiveMfaEnforcementPresentation(user), {
    label: 'Covered by Conditional Access — Require MFA',
    tone: 'positive',
  })
})

test('never infers effective enforcement from registration or legacy per-user MFA', () => {
  for (const user of [
    { mfaRegistration: 'Registered', perUserMfaState: 'Enforced' },
    { effectiveMfaEnforcement: { contractVersion: 2, status: 'COVERED_BY_CONDITIONAL_ACCESS' } },
    { effectiveMfaEnforcement: { contractVersion: 1, status: 'future-value' } },
  ]) {
    assert.equal(tenantUserEffectiveMfaEnforcement(user), null)
    assert.deepEqual(effectiveMfaEnforcementPresentation(user), {
      label: 'Coverage unknown',
      tone: 'neutral',
    })
  }
})

test('keeps conditional and report-only enforcement visibly non-enforced', () => {
  const projection = (status: string, label: string) => ({
    effectiveMfaEnforcement: {
      contractVersion: 1,
      status,
      label,
      policies: [],
      evidenceObservedAt: null,
      riskReductionAllowed: false,
    },
  })
  assert.equal(
    effectiveMfaEnforcementPresentation(
      projection('CONDITIONALLY_COVERED', 'Conditionally covered — trusted location'),
    ).tone,
    'caution',
  )
  assert.deepEqual(
    effectiveMfaEnforcementPresentation(
      projection('REPORT_ONLY', 'Would be covered (report-only); not enforced'),
    ),
    { label: 'Would be covered (report-only); not enforced', tone: 'info' },
  )
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
