import assert from 'node:assert/strict'
import test from 'node:test'
import { adaptIdentityRiskResponses } from './adapter.ts'

const now = '2026-09-02T12:00:00.000Z'

function channelMeta(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    capability: 'FULL',
    status: 'AVAILABLE',
    sourceLabel: 'Current authoritative evidence',
    observedAt: now,
    freshness: 'CURRENT',
    limitation: null,
    ...overrides,
  }
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'opaque-finding-1',
    state: 'OPEN',
    severity: 'HIGH',
    confidence: 'HIGH',
    coverage: 'FULL',
    title: 'New identity received a privileged role',
    explanation: 'A new identity received privilege within the evaluated window.',
    affectedIdentity: {
      id: 'opaque-identity-1',
      label: 'Reported administrator',
      type: 'USER',
    },
    observedAt: now,
    ruleIds: ['HV-ID-CHG-001.v1'],
    sourceLabels: ['Microsoft Entra directory audit'],
    missingEvidenceLabels: [],
    benignAlternativeCodes: ['APPROVED_ACCOUNT_PROVISIONING'],
    investigationGuidanceCode: 'REVIEW_PRIVILEGE_ASSIGNMENT',
    investigationGuidance:
      'Confirm the identity and privilege assignment with an authorized administrator.',
    ...overrides,
  }
}

function microsoftUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'microsoft-risk-1',
    identityLabel: 'Microsoft-reported user',
    riskLevel: 'high',
    riskState: 'atRisk',
    riskDetail: 'adminConfirmedUserCompromised',
    observedAt: now,
    ...overrides,
  }
}

function validResponses(): {
  hawkViewSummary: Record<string, unknown>
  hawkViewFindings: Record<string, unknown>
  microsoftRiskyUsers: Record<string, unknown>
} {
  return {
    hawkViewSummary: {
      ...channelMeta(),
      channel: 'HAWKVIEW_IDENTITY_SIGNALS',
      findings: 1,
    },
    hawkViewFindings: {
      ...channelMeta(),
      channel: 'HAWKVIEW_IDENTITY_SIGNALS',
      findings: [finding()],
    },
    microsoftRiskyUsers: {
      ...channelMeta({ sourceLabel: 'Microsoft Entra Risky Users' }),
      channel: 'MICROSOFT_ENTRA_RISKY_USERS',
      users: [microsoftUser()],
    },
  }
}

test('adapts the two channels without merging their records', () => {
  const view = adaptIdentityRiskResponses(validResponses())

  assert.equal(view.hawkView.channel, 'HAWKVIEW_IDENTITY_SIGNALS')
  assert.equal(view.hawkView.findings?.[0]?.ruleIds[0], 'HV-ID-CHG-001.v1')
  assert.equal(
    view.hawkView.findings?.[0]?.investigationGuidanceCode,
    'REVIEW_PRIVILEGE_ASSIGNMENT'
  )
  assert.equal(view.microsoft.channel, 'MICROSOFT_ENTRA_RISKY_USERS')
  assert.equal(view.microsoft.users?.[0]?.riskState, 'atRisk')
})

test('preserves stale, learning, and not-evaluated capability states', () => {
  for (const status of ['STALE', 'LEARNING', 'NOT_EVALUATED'] as const) {
    const responses = validResponses()
    responses.hawkViewSummary = {
      ...responses.hawkViewSummary,
      status,
      capability: 'PARTIAL',
      freshness: status === 'STALE' ? 'STALE' : 'UNKNOWN',
      limitation: `${status} evidence state`,
    }
    responses.hawkViewFindings = {
      ...responses.hawkViewFindings,
      status,
      capability: 'PARTIAL',
      freshness: status === 'STALE' ? 'STALE' : 'UNKNOWN',
      limitation: `${status} evidence state`,
    }

    const view = adaptIdentityRiskResponses(responses)
    assert.equal(view.hawkView.meta.status, status)
    assert.equal(view.hawkView.meta.capability, 'PARTIAL')
  }
})

test('keeps license and permission limitations server-authored', () => {
  for (const limitation of [
    'Microsoft Entra ID P2 is required for this evidence.',
    'IdentityRiskyUser.Read.All permission is required for this evidence.',
  ]) {
    const responses = validResponses()
    responses.microsoftRiskyUsers = {
      ...responses.microsoftRiskyUsers,
      capability: 'UNAVAILABLE',
      status: 'UNAVAILABLE',
      freshness: 'UNKNOWN',
      observedAt: null,
      limitation,
      users: [],
    }
    const view = adaptIdentityRiskResponses(responses)
    assert.equal(view.microsoft.meta.status, 'UNAVAILABLE')
    assert.equal(view.microsoft.meta.limitation, limitation)
    assert.deepEqual(view.microsoft.users, [])
  }
})

test('rejects mixed channels and unknown contract versions', () => {
  const mixed = validResponses()
  mixed.hawkViewFindings = {
    ...mixed.hawkViewFindings,
    channel: 'MICROSOFT_ENTRA_RISKY_USERS',
  }
  assert.equal(
    adaptIdentityRiskResponses(mixed).hawkView.meta.status,
    'NOT_EVALUATED'
  )

  const unknown = validResponses()
  unknown.microsoftRiskyUsers = {
    ...unknown.microsoftRiskyUsers,
    version: 2,
  }
  assert.equal(
    adaptIdentityRiskResponses(unknown).microsoft.meta.status,
    'NOT_EVALUATED'
  )
})

test('fails closed when required finding fields or enums are malformed', () => {
  for (const malformedFinding of [
    finding({ title: undefined }),
    finding({ affectedIdentity: { id: 'opaque', label: 'User', type: 'DEVICE' } }),
    finding({ severity: 'PROBABLE' }),
    finding({ sourceLabels: [] }),
    finding({ investigationGuidance: '' }),
  ]) {
    const responses = validResponses()
    responses.hawkViewFindings = {
      ...responses.hawkViewFindings,
      findings: [malformedFinding],
    }
    const view = adaptIdentityRiskResponses(responses)
    assert.equal(view.hawkView.meta.status, 'ERROR')
    assert.equal(view.hawkView.findings, null)
  }
})

test('does not convert missing channel payloads into empty success', () => {
  const view = adaptIdentityRiskResponses({
    hawkViewSummary: null,
    hawkViewFindings: null,
    microsoftRiskyUsers: null,
  })

  assert.equal(view.hawkView.meta.status, 'NOT_EVALUATED')
  assert.equal(view.hawkView.findings, null)
  assert.equal(view.microsoft.meta.status, 'NOT_EVALUATED')
  assert.equal(view.microsoft.users, null)
})
