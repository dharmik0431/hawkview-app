import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  computeTenantAttention,
  tenantActionableHealthProjection,
} from './computeTenantAttention.ts'

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

test('uses backend tenant-list attention instead of recomputing health from connection state', () => {
  const findings = computeTenantAttention({
    connectionStatus: 'connected',
    status: 'active',
    attention: [{
      key: 'sync-sign_ins',
      label: 'Sign-ins data could not be synchronized',
      severity: 'high',
      why: 'The most recent collection failed.',
      detectedAt: '2026-08-21T16:05:00.000Z',
    }],
  })
  assert.deepEqual(findings, [{
    key: 'sync-sign_ins',
    label: 'Sign-ins data could not be synchronized',
    severity: 'high',
    why: 'The most recent collection failed.',
    detectedAt: '2026-08-21T16:05:00.000Z',
  }])
})

test('an authoritative empty attention list stays empty', () => {
  const findings = computeTenantAttention({
    attention: [],
    users: [{ role: 'Global Administrator', mfaRegistration: 'Not registered' }],
  })
  assert.deepEqual(findings, [])
})

test('does not treat the complete optional permission catalog as core tenant attention', () => {
  const projection = tenantActionableHealthProjection({
    connectionStatus: 'connected',
    missingPermissions: ['IdentityRiskyUser.Read.All'],
    attention: [],
  })
  assert.deepEqual(projection, { status: 'VERIFIED', items: [] })
})

test('fails closed when an authoritative attention result contains malformed rows', () => {
  const projection = tenantActionableHealthProjection({
    attention: [
      { key: 'safe', label: 'Safe issue', severity: 'medium', why: 'Review this issue.' },
      { key: 'unsafe', label: 'Unsafe issue', severity: 'critical', why: 'token=abc\nBearer secret' },
      { key: 'unknown', label: 'Unknown severity', severity: 'low', why: 'Not in the public contract.' },
    ],
  })
  assert.deepEqual(projection, { status: 'UNAVAILABLE', items: [] })
})

test('accepts low-severity coverage as verified informational evidence without inflating action count', () => {
  const projection = tenantActionableHealthProjection({
    attention: [{
      key: 'sign-ins-limited-evidence',
      label: 'Limited sign-in evidence is active',
      severity: 'low',
      why: 'Current limited evidence is available.',
    }],
  })
  assert.deepEqual(projection, { status: 'VERIFIED', items: [] })
})

test('tenant directory and dashboard consumers keep the backend attention contract intact', () => {
  const sources = [
    'app/(protected)/tenants/page.tsx',
    'components/tenants/tenant-status-badge.tsx',
    'components/tenants/tenant-issue-drawer.tsx',
    'components/tenants/affected-services.tsx',
    'components/dashboard/tenant-risk-matrix-helpers.ts',
    'components/dashboard/tenant-risk-matrix-drawer.tsx',
  ].map((path) => readFileSync(path, 'utf8'))

  for (const source of sources) {
    assert.doesNotMatch(source, /computeTenantAttention\(\{[\s\S]{0,240}connectionStatus/)
  }
  assert.match(sources[0], /tenantActionableHealthProjection\(tenant\)/)
  assert.match(sources[1], /tenantActionableHealthProjection\(tenant\)/)
  assert.doesNotMatch(sources[1], /tenant\.missingPermissions/)
  assert.match(sources[2], /computeTenantAttention\(tenant\)/)
})
