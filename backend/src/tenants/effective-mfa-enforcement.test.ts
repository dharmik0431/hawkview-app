import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deriveUserPostureRisk,
  evaluateEffectiveMfaEnforcement,
  type EffectiveMfaEvaluationInput,
  type MfaEvidenceState,
  type MicrosoftRiskFact,
} from './effective-mfa-enforcement.js'

const fresh: MfaEvidenceState = {
  status: 'FRESH',
  observedAt: '2026-08-26T12:00:00.000Z',
  reason: null,
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'policy-1',
    displayName: 'Require MFA for everyone',
    state: 'enabled',
    conditions: {
      users: {
        includeUsers: ['All'],
        excludeUsers: [],
        includeGroups: [],
        excludeGroups: [],
        includeRoles: [],
        excludeRoles: [],
      },
      applications: { includeApplications: ['All'], excludeApplications: [] },
    },
    grantControls: { operator: 'OR', builtInControls: ['mfa'] },
    ...overrides,
  }
}

function input(overrides: Partial<EffectiveMfaEvaluationInput> = {}): EffectiveMfaEvaluationInput {
  return {
    subject: {
      id: 'user-1',
      userType: 'Member',
      transitiveGroupIds: [],
      activeRoleTemplateIds: [],
    },
    policies: [policy()],
    authenticationStrengths: [],
    evidence: {
      policies: fresh,
      membership: fresh,
      roles: fresh,
      authenticationStrengths: fresh,
    },
    now: new Date('2026-08-26T12:05:00.000Z'),
    ...overrides,
  }
}

test('proves universal enabled MFA and names every independently qualifying policy', () => {
  const result = evaluateEffectiveMfaEnforcement(input({
    policies: [
      policy(),
      policy({ id: 'policy-2', displayName: 'Global MFA baseline' }),
    ],
  }))
  assert.equal(result.status, 'COVERED_BY_CONDITIONAL_ACCESS')
  assert.equal(result.riskReductionAllowed, true)
  assert.match(result.label, /Global MFA baseline/)
  assert.match(result.label, /Require MFA for everyone/)
  assert.deepEqual(result.policies.map((entry) => entry.id), ['policy-2', 'policy-1'])
})

test('resolves nested transitive group and active role targeting', () => {
  const grouped = evaluateEffectiveMfaEnforcement(input({
    subject: {
      id: 'user-1',
      userType: 'Member',
      transitiveGroupIds: ['nested-parent-group'],
      activeRoleTemplateIds: [],
    },
    policies: [policy({
      conditions: {
        users: { includeUsers: [], includeGroups: ['nested-parent-group'] },
        applications: { includeApplications: ['All'] },
      },
    })],
  }))
  assert.equal(grouped.status, 'COVERED_BY_CONDITIONAL_ACCESS')

  const role = evaluateEffectiveMfaEnforcement(input({
    subject: {
      id: 'user-1',
      userType: 'Member',
      transitiveGroupIds: [],
      activeRoleTemplateIds: ['global-admin-template'],
    },
    policies: [policy({
      conditions: {
        users: { includeUsers: [], includeRoles: ['global-admin-template'] },
        applications: { includeApplications: ['All'] },
      },
    })],
  }))
  assert.equal(role.status, 'COVERED_BY_CONDITIONAL_ACCESS')
})

test('effective direct, group, and role exclusions win over inclusion', () => {
  for (const users of [
    { includeUsers: ['All'], excludeUsers: ['user-1'] },
    { includeUsers: ['All'], excludeGroups: ['excluded-group'] },
    { includeUsers: ['All'], excludeRoles: ['excluded-role'] },
  ]) {
    const result = evaluateEffectiveMfaEnforcement(input({
      subject: {
        id: 'user-1',
        userType: 'Member',
        transitiveGroupIds: ['excluded-group'],
        activeRoleTemplateIds: ['excluded-role'],
      },
      policies: [policy({
        conditions: {
          users,
          applications: { includeApplications: ['All'] },
        },
      })],
    }))
    assert.equal(result.status, 'NOT_COVERED')
    assert.equal(result.riskReductionAllowed, false)
    assert.ok(result.reasonCodes.includes('EFFECTIVE_EXCLUSION'))
    assert.deepEqual(result.policies.map(({ id, name, outcome, materialConditions }) => ({
      id,
      name,
      outcome,
      materialConditions,
    })), [{
      id: 'policy-1',
      name: 'Require MFA for everyone',
      outcome: 'NOT_ENFORCED',
      materialConditions: ['effective exclusion'],
    }])
  }
})

test('matches guest selectors only when their external scope is authoritative', () => {
  const covered = evaluateEffectiveMfaEnforcement(input({
    subject: {
      id: 'guest-1',
      userType: 'Guest',
      externalTenantId: 'external-tenant',
      transitiveGroupIds: [],
      activeRoleTemplateIds: [],
    },
    policies: [policy({
      conditions: {
        users: {
          includeUsers: [],
          includeGuestsOrExternalUsers: {
            guestOrExternalUserTypes: 'b2bCollaborationGuest',
            externalTenants: { membershipKind: 'enumerated', members: ['external-tenant'] },
          },
        },
        applications: { includeApplications: ['All'] },
      },
    })],
  }))
  assert.equal(covered.status, 'COVERED_BY_CONDITIONAL_ACCESS')

  const unknown = evaluateEffectiveMfaEnforcement(input({
    subject: {
      id: 'guest-1',
      userType: 'Guest',
      transitiveGroupIds: [],
      activeRoleTemplateIds: [],
    },
    policies: covered.policies.length ? [policy({
      conditions: {
        users: {
          includeUsers: [],
          includeGuestsOrExternalUsers: {
            guestOrExternalUserTypes: 'b2bCollaborationGuest',
            externalTenants: { membershipKind: 'enumerated', members: ['external-tenant'] },
          },
        },
        applications: { includeApplications: ['All'] },
      },
    })] : [],
  }))
  assert.equal(unknown.status, 'UNKNOWN')
  assert.ok(unknown.reasonCodes.includes('EXTERNAL_TENANT_UNKNOWN'))
})

test('keeps resource, platform, location, device, client-app, and risk conditions conditional', () => {
  const result = evaluateEffectiveMfaEnforcement(input({
    policies: [policy({
      conditions: {
        users: { includeUsers: ['All'] },
        applications: { includeApplications: ['app-1'] },
        platforms: { includePlatforms: ['windows'] },
        locations: { includeLocations: ['trusted-location'] },
        devices: { deviceFilter: { mode: 'include', rule: 'device.isCompliant -eq True' } },
        clientAppTypes: ['browser'],
        signInRiskLevels: ['high'],
        userRiskLevels: ['medium'],
      },
    })],
  }))
  assert.equal(result.status, 'CONDITIONALLY_COVERED')
  assert.equal(result.riskReductionAllowed, false)
  assert.deepEqual(result.policies[0]?.materialConditions, [
    'application subset',
    'platform',
    'location',
    'client app',
    'device state',
    'sign-in risk',
    'user risk',
  ])
})

test('distinguishes report-only and disabled policies', () => {
  const report = evaluateEffectiveMfaEnforcement(input({
    policies: [policy({ state: 'enabledForReportingButNotEnforced' })],
  }))
  assert.equal(report.status, 'REPORT_ONLY')
  assert.equal(
    report.label,
    'Would be covered (report-only) — Require MFA for everyone; not enforced',
  )
  assert.equal(report.riskReductionAllowed, false)

  const disabled = evaluateEffectiveMfaEnforcement(input({
    policies: [policy({ state: 'disabled' })],
  }))
  assert.equal(disabled.status, 'NOT_COVERED')
  assert.equal(disabled.riskReductionAllowed, false)
})

test('respects grant OR versus AND semantics', () => {
  const orResult = evaluateEffectiveMfaEnforcement(input({
    policies: [policy({
      grantControls: { operator: 'OR', builtInControls: ['mfa', 'compliantDevice'] },
    })],
  }))
  assert.equal(orResult.status, 'NOT_COVERED')

  const andResult = evaluateEffectiveMfaEnforcement(input({
    policies: [policy({
      grantControls: { operator: 'AND', builtInControls: ['mfa', 'compliantDevice'] },
    })],
  }))
  assert.equal(andResult.status, 'COVERED_BY_CONDITIONAL_ACCESS')
})

test('accepts qualifying built-in and resolved custom authentication strengths', () => {
  const builtIn = evaluateEffectiveMfaEnforcement(input({
    policies: [policy({
      grantControls: {
        operator: 'OR',
        builtInControls: [],
        authenticationStrength: { id: '00000000-0000-0000-0000-000000000004' },
      },
    })],
    authenticationStrengths: [{
      id: '00000000-0000-0000-0000-000000000004',
      displayName: 'Phishing-resistant MFA',
    }],
  }))
  assert.equal(builtIn.status, 'COVERED_BY_CONDITIONAL_ACCESS')

  const custom = evaluateEffectiveMfaEnforcement(input({
    policies: [policy({
      grantControls: {
        operator: 'OR',
        builtInControls: [],
        authenticationStrength: { id: 'custom-strength' },
      },
    })],
    authenticationStrengths: [{
      id: 'custom-strength',
      allowedCombinations: ['password,microsoftAuthenticatorPush'],
    }],
  }))
  assert.equal(custom.status, 'COVERED_BY_CONDITIONAL_ACCESS')
})

test('fails closed for stale, partial, failed, permission-limited, or ambiguous evidence', () => {
  for (const status of ['STALE', 'MISSING', 'FAILED', 'PERMISSION_LIMITED'] as const) {
    const result = evaluateEffectiveMfaEnforcement(input({
      evidence: {
        policies: { status, observedAt: fresh.observedAt, reason: 'collection unavailable' },
        membership: fresh,
        roles: fresh,
        authenticationStrengths: fresh,
      },
    }))
    assert.equal(result.status, 'UNKNOWN')
    assert.equal(result.riskReductionAllowed, false)
  }

  const groupUnknown = evaluateEffectiveMfaEnforcement(input({
    subject: {
      id: 'user-1',
      userType: 'Member',
      transitiveGroupIds: null,
      activeRoleTemplateIds: [],
    },
    policies: [policy({
      conditions: {
        users: { includeUsers: [], includeGroups: ['group-1'] },
        applications: { includeApplications: ['All'] },
      },
    })],
    evidence: {
      policies: fresh,
      membership: { status: 'FAILED', observedAt: null, reason: 'bounded collection failed' },
      roles: fresh,
      authenticationStrengths: fresh,
    },
  }))
  assert.equal(groupUnknown.status, 'UNKNOWN')
})

function risk(value: MicrosoftRiskFact['value'], state: MicrosoftRiskFact['state'] = 'REPORTED'): MicrosoftRiskFact {
  return {
    value,
    state,
    source: 'Microsoft Identity Protection',
    observedAt: state === 'REPORTED' ? fresh.observedAt : null,
  }
}

test('lowers only MFA enforcement exposure and preserves medium/high Microsoft risk', () => {
  const effectiveMfa = evaluateEffectiveMfaEnforcement(input())
  for (const microsoftRisk of ['medium', 'high'] as const) {
    const posture = deriveUserPostureRisk({
      mfaRegistration: 'Not registered',
      legacyPerUserMfa: 'Disabled',
      effectiveMfa,
      microsoftUserRisk: risk(microsoftRisk),
      microsoftSignInRisk: risk('low'),
    })
    assert.equal(posture.mfaEnforcementExposure, 'low')
    assert.equal(posture.microsoftUserRisk.value, microsoftRisk)
    assert.equal(posture.overall, microsoftRisk)
  }
})

test('never fabricates low when Microsoft risk evidence is unknown', () => {
  const posture = deriveUserPostureRisk({
    mfaRegistration: 'Not registered',
    legacyPerUserMfa: 'Disabled',
    effectiveMfa: evaluateEffectiveMfaEnforcement(input()),
    microsoftUserRisk: risk('unknown', 'PERMISSION_LIMITED'),
    microsoftSignInRisk: risk('unknown', 'NOT_REPORTED'),
  })
  assert.equal(posture.mfaEnforcementExposure, 'low')
  assert.equal(posture.overall, 'unknown')
})
