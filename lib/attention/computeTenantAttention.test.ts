import assert from 'node:assert/strict'
import test from 'node:test'
import { computeTenantAttention } from './computeTenantAttention.ts'

test('does not turn unavailable MFA registration into a disabled or enforcement finding', () => {
  const findings = computeTenantAttention({
    users: [{
      role: 'Global Administrator',
      mfaRegistration: 'Unknown',
      // A contradictory compatibility field must not override the explicit
      // new contract state.
      mfa: 'Disabled',
    }],
  })
  assert.equal(findings.some((item) => item.key === 'admin_without_mfa'), false)
  assert.equal(findings.some((item) => item.key === 'user_mfa_gap'), false)
})

test('creates registration findings only from an explicit missing registration fact', () => {
  const findings = computeTenantAttention({
    users: [
      { role: 'Global Administrator', mfaRegistration: 'Not registered' },
      { role: 'User', mfaRegistration: 'Registered' },
    ],
  })
  assert.equal(findings.some((item) => item.key === 'admin_without_mfa'), true)
  const gap = findings.find((item) => item.key === 'user_mfa_gap')
  assert.match(gap?.label ?? '', /MFA registration gap/)
  assert.match(gap?.why ?? '', /does not prove MFA enforcement/i)
})
