import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveCollectionReadiness, M365_ACTIVITY_CONTENT_TYPES } from './collection-readiness.js'

const now = new Date('2026-08-18T12:00:00.000Z')
const current = new Date('2026-08-18T11:55:00.000Z')

function sync(resourceType: string, overrides: Record<string, unknown> = {}) {
  return {
    resourceType,
    status: 'SUCCEEDED',
    lastAttemptAt: current,
    lastSuccessfulAt: current,
    lastErrorCode: null,
    lastErrorMessage: null,
    ...overrides,
  }
}

const allResources = [
  'AUDIT_LOGS', 'SIGN_INS', 'USERS', 'GROUPS', 'DEVICES', 'DIRECTORY_ROLES', 'AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES', 'CONDITIONAL_ACCESS', 'AUTHENTICATION_STRENGTHS', 'NAMED_LOCATIONS', 'RISKY_USERS', 'APPLICATIONS', 'SERVICE_PRINCIPALS', 'SECURITY_DEFAULTS', 'SECURE_SCORES', 'ORGANIZATION_CONFIGURATION', 'DOMAINS', 'LICENSES', 'DOMAIN_DNS_HEALTH', 'SHAREPOINT_SITES', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE', 'EXCHANGE_MAILBOXES', 'EXCHANGE_MAILBOX_SETTINGS', 'EXCHANGE_MAILBOX_USAGE', 'EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOX_RULES', 'M365_AUDIT',
]

const permissions = ['Organization.Read.All', 'User.Read.All', 'GroupMember.Read.All', 'Member.Read.Hidden', 'Device.Read.All', 'RoleManagement.Read.Directory', 'UserAuthenticationMethod.Read.All', 'Policy.Read.AuthenticationMethod', 'Policy.Read.All', 'IdentityRiskyUser.Read.All', 'Application.Read.All', 'AuditLog.Read.All', 'Directory.Read.All', 'Sites.Read.All', 'SharePointTenantSettings.Read.All', 'Reports.Read.All', 'MailboxSettings.Read', 'ActivityFeed.Read', 'SecurityEvents.Read.All']

function input(overrides: Record<string, unknown> = {}) {
  return {
    connectionStatus: 'CONNECTED',
    connectionVerifiedAt: current,
    consentedPermissions: permissions,
    syncStates: allResources.map((resource) => sync(resource)),
    licenseServicePlans: [
      { servicePlanName: 'SHAREPOINTENTERPRISE', provisioningStatus: 'Success' },
      { servicePlanName: 'EXCHANGE_S_ENTERPRISE', provisioningStatus: 'Success' },
      { servicePlanName: 'AAD_PREMIUM', servicePlanId: '41781fb2-bc02-4b7c-bd55-b576c07bb09d', provisioningStatus: 'Success' },
    ],
    subscriptions: M365_ACTIVITY_CONTENT_TYPES.map((contentType) => ({ contentType, status: 'ENABLED', lastStartRequestedAt: current, lastVerifiedAt: current, lastSuccessfulPollAt: current, lastError: null })),
    now,
    ...overrides,
  }
}

function row(result: ReturnType<typeof deriveCollectionReadiness>, key: string) {
  const value = result.workloads.find((workload) => workload.key === key)
  assert.ok(value, `missing ${key}`)
  return value
}

test('does not report a connected tenant as ready when collection has never succeeded', () => {
  const result = deriveCollectionReadiness(input({ syncStates: [] }))
  assert.equal(result.permissionVerifiedAt, current.toISOString())
  assert.equal(result.evaluatedAt, now.toISOString())
  assert.equal(result.overallState, 'UNVERIFIED')
  assert.equal(row(result, 'entra_directory_audit').state, 'NEVER_SUCCEEDED')
  assert.equal(row(result, 'm365_unified_audit').state, 'NEVER_SUCCEEDED')
})

test('surfaces permission, tenant configuration, stale, and transient failures distinctly', () => {
  const states = allResources.map((resource) => sync(resource))
  states.splice(states.findIndex((state) => state.resourceType === 'AUDIT_LOGS'), 1, sync('AUDIT_LOGS', { status: 'FAILED', lastErrorCode: '403', lastErrorMessage: 'Forbidden' }))
  states.splice(states.findIndex((state) => state.resourceType === 'SIGN_INS'), 1, sync('SIGN_INS', { status: 'FAILED', lastErrorCode: 'sign-in-license', lastErrorMessage: 'Tenant does not have a premium license' }))
  states.splice(states.findIndex((state) => state.resourceType === 'SHAREPOINT_SITES'), 1, sync('SHAREPOINT_SITES', { lastSuccessfulAt: new Date('2026-08-16T00:00:00.000Z') }))
  states.splice(states.findIndex((state) => state.resourceType === 'EXCHANGE_MAILBOXES'), 1, sync('EXCHANGE_MAILBOXES', { status: 'FAILED', lastErrorCode: '500', lastErrorMessage: 'Gateway temporarily unavailable' }))
  const result = deriveCollectionReadiness(input({ syncStates: states }))
  assert.equal(row(result, 'entra_directory_audit').state, 'BLOCKED_PERMISSION')
  const signIns = row(result, 'sign_ins')
  assert.equal(signIns.state, 'FAILED_TRANSIENT')
  assert.equal(signIns.reasonCode, 'SIGN_IN_LICENSE_RESPONSE_CONTRADICTED')
  assert.match(signIns.reason ?? '', /current service-plan evidence confirms/i)
  assert.doesNotMatch(signIns.reason ?? '', /does not have a premium license/i)
  assert.equal(row(result, 'sharepoint_onedrive').state, 'STALE')
  assert.equal(row(result, 'exchange').state, 'FAILED_TRANSIENT')
})

test('reports all four Management Activity subscriptions independently and distinguishes provisioning from a failed subscription', () => {
  const subscriptions: Array<{
    contentType: string
    status: string
    lastStartRequestedAt: Date
    lastVerifiedAt: Date
    lastSuccessfulPollAt: Date | null
    lastError: string | null
  }> = M365_ACTIVITY_CONTENT_TYPES.map((contentType) => ({ contentType, status: 'ENABLED', lastStartRequestedAt: current, lastVerifiedAt: current, lastSuccessfulPollAt: current, lastError: null }))
  subscriptions[0] = { ...subscriptions[0], status: 'PENDING', lastSuccessfulPollAt: null }
  subscriptions[1] = { ...subscriptions[1], status: 'FAILED', lastError: 'Unified Audit is not enabled for this tenant' }
  const result = deriveCollectionReadiness(input({ subscriptions }))
  const audit = row(result, 'm365_unified_audit')
  assert.equal(audit.state, 'BLOCKED_TENANT_CONFIGURATION')
  assert.equal(audit.components?.length, 4)
  assert.equal(audit.components?.find((component) => component.key === 'Audit.Exchange')?.state, 'INITIALIZING')
  assert.equal(audit.components?.find((component) => component.key === 'Audit.AzureActiveDirectory')?.state, 'BLOCKED_TENANT_CONFIGURATION')
})

test('reports unsupported Exchange administrative facts as non-degrading capability boundaries', () => {
  const exchange = row(deriveCollectionReadiness(input()), 'exchange')
  assert.equal(exchange.state, 'READY')
  assert.deepEqual(exchange.capabilities?.map((capability) => capability.key), [
    'exchange_mailbox_delegation',
    'exchange_mailbox_retention_assignment',
    'exchange_accepted_domain_type',
  ])
  assert.equal(exchange.capabilities?.every((capability) => capability.state === 'NOT_COLLECTED_LEAST_PRIVILEGE'), true)
})

test('uses authoritative service-plan semantics without treating pending plans as unlicensed', () => {
  const disabled = deriveCollectionReadiness(input({
    licenseServicePlans: [{ servicePlanName: 'EXCHANGE_S_ENTERPRISE', provisioningStatus: 'Disabled' }],
  }))
  assert.equal(row(disabled, 'exchange').state, 'NOT_LICENSED')

  const pending = deriveCollectionReadiness(input({
    licenseServicePlans: [{ servicePlanName: 'EXCHANGE_S_ENTERPRISE', provisioningStatus: 'PendingActivation' }],
  }))
  assert.equal(row(pending, 'exchange').state, 'UNVERIFIED')

  const staleLicenses = deriveCollectionReadiness(input({
    syncStates: allResources.map((resource) => sync(resource, resource === 'LICENSES' ? { lastSuccessfulAt: new Date('2026-08-16T00:00:00.000Z') } : {})),
  }))
  assert.equal(row(staleLicenses, 'exchange').state, 'UNVERIFIED')
})

test('keeps Microsoft Identity Protection risk explicitly P2-only', () => {
  const p1Only = deriveCollectionReadiness(input())
  const p1Dataset = row(p1Only, 'entra_identity_protection').datasets?.find(
    (dataset) => dataset.key === 'entra_identity_protection_risky_users',
  )
  assert.equal(p1Dataset?.licensePrerequisite.kind, 'ENTRA_ID_P2')
  assert.equal(p1Dataset?.licensePrerequisite.state, 'NOT_LICENSED')
  assert.equal(p1Dataset?.state, 'NOT_LICENSED')

  const p2 = deriveCollectionReadiness(input({
    licenseServicePlans: [
      ...(input().licenseServicePlans ?? []),
      { servicePlanName: 'AAD_PREMIUM_P2', provisioningStatus: 'Success' },
    ],
  }))
  const p2Dataset = row(p2, 'entra_identity_protection').datasets?.find(
    (dataset) => dataset.key === 'entra_identity_protection_risky_users',
  )
  assert.equal(p2Dataset?.licensePrerequisite.state, 'SATISFIED')
  assert.equal(p2Dataset?.state, 'READY')
})

test('projects Identity Protection counts only from fresh P2 snapshot evidence', () => {
  const p1Only = deriveCollectionReadiness(input({
    evidenceSnapshots: [{ resourceType: 'RISKY_USERS', payload: [{ id: 'must-not-count' }], observedAt: current }],
  }))
  assert.equal(p1Only.evidence.riskyIdentities.availability, 'NOT_LICENSED')
  assert.equal(p1Only.evidence.riskyIdentities.count, null)

  const p2Plans = [
    ...(input().licenseServicePlans ?? []),
    { servicePlanName: 'AAD_PREMIUM_P2', provisioningStatus: 'Success' },
  ]
  const freshEmpty = deriveCollectionReadiness(input({
    licenseServicePlans: p2Plans,
    evidenceSnapshots: [
      { resourceType: 'RISKY_USERS', payload: [], observedAt: current },
      { resourceType: 'RISKY_USERS', payload: [{ id: 'older-risk-must-not-win' }], observedAt: new Date('2026-08-18T10:00:00.000Z') },
    ],
  }))
  assert.equal(freshEmpty.evidence.riskyIdentities.availability, 'READY')
  assert.equal(freshEmpty.evidence.riskyIdentities.count, 0)

  const freshRisk = deriveCollectionReadiness(input({
    licenseServicePlans: p2Plans,
    evidenceSnapshots: [{ resourceType: 'RISKY_USERS', payload: [{ id: 'risk-1' }, { id: 'risk-2' }], observedAt: current }],
  }))
  assert.equal(freshRisk.evidence.riskyIdentities.count, 2)

  const missingSnapshot = deriveCollectionReadiness(input({
    licenseServicePlans: p2Plans,
  }))
  assert.equal(missingSnapshot.evidence.riskyIdentities.availability, 'UNVERIFIED')
  assert.equal(missingSnapshot.evidence.riskyIdentities.count, null)
  assert.equal(missingSnapshot.evidence.riskyIdentities.reasonCode, 'EVIDENCE_SNAPSHOT_UNAVAILABLE')

  const missingPermission = deriveCollectionReadiness(input({
    licenseServicePlans: p2Plans,
    consentedPermissions: permissions.filter((permission) => permission !== 'IdentityRiskyUser.Read.All'),
    evidenceSnapshots: [{ resourceType: 'RISKY_USERS', payload: [{ id: 'must-not-count' }], observedAt: current }],
  }))
  assert.equal(missingPermission.evidence.riskyIdentities.availability, 'BLOCKED_PERMISSION')
  assert.equal(missingPermission.evidence.riskyIdentities.count, null)
})

test('separates unlicensed Conditional Access from current Security Defaults evidence', () => {
  const basic = deriveCollectionReadiness(input({
    licenseServicePlans: [
      { servicePlanName: 'EXCHANGE_S_STANDARD', provisioningStatus: 'Success' },
      { servicePlanName: 'SHAREPOINTSTANDARD', provisioningStatus: 'Success' },
    ],
    evidenceSnapshots: [
      { resourceType: 'CONDITIONAL_ACCESS', payload: [], observedAt: current },
      { resourceType: 'SECURITY_DEFAULTS', payload: [{ isEnabled: true }], observedAt: current },
    ],
  }))
  assert.equal(basic.evidence.conditionalAccess.availability, 'NOT_LICENSED')
  assert.equal(basic.evidence.conditionalAccess.count, null)
  assert.equal(basic.evidence.securityDefaults.availability, 'READY')
  assert.equal(basic.evidence.securityDefaults.enabled, true)

  const premiumEmpty = deriveCollectionReadiness(input({
    evidenceSnapshots: [{ resourceType: 'CONDITIONAL_ACCESS', payload: [], observedAt: current }],
  }))
  assert.equal(premiumEmpty.evidence.conditionalAccess.availability, 'READY')
  assert.equal(premiumEmpty.evidence.conditionalAccess.count, 0)

  const missingSnapshots = deriveCollectionReadiness(input())
  assert.equal(missingSnapshots.evidence.conditionalAccess.availability, 'UNVERIFIED')
  assert.equal(missingSnapshots.evidence.conditionalAccess.count, null)
  assert.equal(missingSnapshots.evidence.securityDefaults.availability, 'UNVERIFIED')
  assert.equal(missingSnapshots.evidence.securityDefaults.enabled, null)
})

test('selects current limited audit-feed sign-in evidence without claiming full Graph coverage', () => {
  const result = deriveCollectionReadiness(input({
    licenseServicePlans: [{ servicePlanName: 'EXCHANGE_S_STANDARD', provisioningStatus: 'Success' }],
    consentedPermissions: ['ActivityFeed.Read'],
    syncStates: allResources.map((resource) => sync(resource, resource === 'SIGN_INS' ? {
      status: 'RUNNING',
      lastErrorCode: 'sign-ins-non-premium-fallback-active',
      lastErrorMessage: 'Current limited audit-feed login evidence is available.',
    } : {})),
  }))
  assert.equal(result.evidence.signIns.availability, 'CURRENT_LIMITED')
  assert.equal(result.evidence.signIns.coverage, 'LIMITED')
  assert.equal(result.evidence.signIns.selectedSource, 'OFFICE_365_ACTIVITY_FEED')
  assert.equal(row(result, 'sign_ins').state, 'PARTIAL')

  const stale = deriveCollectionReadiness(input({
    licenseServicePlans: [{ servicePlanName: 'EXCHANGE_S_STANDARD', provisioningStatus: 'Success' }],
    consentedPermissions: ['ActivityFeed.Read'],
    syncStates: allResources.map((resource) => sync(resource, resource === 'SIGN_INS' ? {
      status: 'RUNNING',
      lastSuccessfulAt: new Date('2026-08-18T08:00:00.000Z'),
      lastErrorCode: 'sign-ins-non-premium-fallback-active',
      lastErrorMessage: 'Audit-feed login evidence has not refreshed.',
    } : {})),
  }))
  assert.equal(stale.evidence.signIns.availability, 'STALE')
  assert.equal(stale.evidence.signIns.selectedSource, 'OFFICE_365_ACTIVITY_FEED')
  assert.equal(stale.evidence.signIns.reasonCode, 'SIGN_IN_FALLBACK_STALE')

  const failed = deriveCollectionReadiness(input({
    licenseServicePlans: [{ servicePlanName: 'EXCHANGE_S_STANDARD', provisioningStatus: 'Success' }],
    consentedPermissions: ['ActivityFeed.Read'],
    syncStates: allResources.map((resource) => sync(resource, resource === 'SIGN_INS' ? {
      status: 'FAILED',
      lastErrorCode: 'sign-ins-non-premium-fallback-active',
      lastErrorMessage: 'Audit-feed login evidence failed.',
    } : {})),
  }))
  assert.notEqual(failed.evidence.signIns.availability, 'CURRENT_LIMITED')
  assert.equal(failed.evidence.signIns.selectedSource, 'OFFICE_365_ACTIVITY_FEED')
})

test('selects sign-in permissions from current authoritative Entra entitlement evidence', () => {
  const premium = row(deriveCollectionReadiness(input()), 'sign_ins')
  assert.deepEqual(premium.requiredPermissions, [
    'AuditLog.Read.All',
    'Directory.Read.All',
  ])
  assert.equal(premium.permissionStatus, 'CONFIRMED')

  const premiumMissingDirectory = row(
    deriveCollectionReadiness(
      input({
        consentedPermissions: permissions.filter(
          (permission) => permission !== 'Directory.Read.All',
        ),
      }),
    ),
    'sign_ins',
  )
  assert.equal(premiumMissingDirectory.state, 'BLOCKED_PERMISSION')
  assert.match(premiumMissingDirectory.reason ?? '', /Directory\.Read\.All/)

  const nonPremium = row(
    deriveCollectionReadiness(
      input({
        licenseServicePlans: [
          {
            servicePlanName: 'EXCHANGE_S_STANDARD',
            servicePlanId: 'plan-1',
            provisioningStatus: 'Success',
          },
        ],
        consentedPermissions: ['ActivityFeed.Read'],
      }),
    ),
    'sign_ins',
  )
  assert.deepEqual(nonPremium.requiredPermissions, ['ActivityFeed.Read'])
  assert.equal(nonPremium.permissionStatus, 'CONFIRMED')

  const historicalLicenseFailure = allResources.map((resource) =>
    sync(
      resource,
      resource === 'SIGN_INS'
        ? {
            status: 'FAILED',
            lastErrorCode: 'sign-in-license',
            lastErrorMessage: 'Tenant does not have a premium license',
          }
        : {},
    ),
  )
  const nonPremiumFailure = row(
    deriveCollectionReadiness(
      input({
        syncStates: historicalLicenseFailure,
        licenseServicePlans: [
          {
            servicePlanName: 'EXCHANGE_S_STANDARD',
            servicePlanId: 'plan-1',
            provisioningStatus: 'Success',
          },
        ],
      }),
    ),
    'sign_ins',
  )
  assert.equal(nonPremiumFailure.state, 'NOT_LICENSED')
  assert.equal(
    nonPremiumFailure.reasonCode,
    'SIGN_IN_ENTITLEMENT_NOT_LICENSED',
  )
  assert.match(nonPremiumFailure.reason ?? '', /service-plan evidence does not include/i)

  const unknown = row(
    deriveCollectionReadiness(
      input({
        syncStates: allResources.map((resource) =>
          sync(
            resource,
            resource === 'LICENSES'
              ? { lastSuccessfulAt: new Date('2026-08-16T00:00:00.000Z') }
              : {},
          ),
        ),
      }),
    ),
    'sign_ins',
  )
  assert.deepEqual(unknown.requiredPermissions, [
    'AuditLog.Read.All',
    'Directory.Read.All',
    'ActivityFeed.Read',
  ])

  const unknownFailure = row(
    deriveCollectionReadiness(
      input({
        syncStates: historicalLicenseFailure.map((state) =>
          state.resourceType === 'LICENSES'
            ? { ...state, lastSuccessfulAt: new Date('2026-08-16T00:00:00.000Z') }
            : state,
        ),
      }),
    ),
    'sign_ins',
  )
  assert.equal(unknownFailure.state, 'UNVERIFIED')
  assert.equal(
    unknownFailure.reasonCode,
    'SIGN_IN_ENTITLEMENT_UNVERIFIED',
  )
})

test('keeps standard SharePoint Graph inventory ready while explicitly declaring access metadata uncollected', () => {
  const result = deriveCollectionReadiness(input({
    licenseServicePlans: [{ servicePlanName: 'SHAREPOINTENTERPRISE', provisioningStatus: 'Success' }],
  }))
  const sharePoint = row(result, 'sharepoint_onedrive')
  assert.equal(sharePoint.state, 'READY')
  assert.equal(sharePoint.capabilities?.[0]?.state, 'NOT_COLLECTED_LEAST_PRIVILEGE')
  assert.equal(sharePoint.capabilities?.[0]?.reasonCode, 'NOT_COLLECTED_LEAST_PRIVILEGE')
})

test('missing consent and an unavailable Microsoft connection remain explicit without inventing next retry', () => {
  const result = deriveCollectionReadiness(input({ connectionStatus: 'PENDING_CONSENT', connectionVerifiedAt: current, consentedPermissions: [] }))
  const audit = row(result, 'm365_unified_audit')
  assert.equal(audit.state, 'BLOCKED_PERMISSION')
  assert.equal(audit.permissionStatus, 'UNVERIFIED')
  assert.match(audit.reason ?? '', /Microsoft connection consent/i)
})

test('fails closed when an included collector is missing', () => {
  const omitted = deriveCollectionReadiness(input({ syncStates: allResources.filter((resource) => resource !== 'DEVICES').map((resource) => sync(resource)) }))
  assert.notEqual(row(omitted, 'entra_directory').state, 'READY')
})

test('keeps subscription verification separate from successful polling and selects matching diagnostics', () => {
  const subscriptions = M365_ACTIVITY_CONTENT_TYPES.map((contentType) => ({ contentType, status: 'ENABLED', lastStartRequestedAt: current, lastVerifiedAt: current, lastSuccessfulPollAt: null, lastError: null }))
  const result = deriveCollectionReadiness(input({ subscriptions }))
  const audit = row(result, 'm365_unified_audit')
  assert.equal(audit.state, 'INITIALIZING')
  assert.equal(audit.lastSuccessfulAt, null)
  assert.equal(audit.components?.[0]?.lastVerifiedAt, current.toISOString())
  assert.equal(result.reason, row(result, result.workloads.find((item) => item.state === result.overallState)?.key ?? '').reason)
})

test('keeps a missing optional Graph mailbox permission dataset-scoped', () => {
  const withoutMailboxSettings = permissions.filter((permission) => permission !== 'MailboxSettings.Read')
  const result = deriveCollectionReadiness(input({ consentedPermissions: withoutMailboxSettings }))
  const exchange = row(result, 'exchange')
  assert.equal(exchange.permissionStatus, 'CONFIRMED')
  assert.equal(exchange.state, 'READY')
  const mailboxSettings = exchange.datasets?.find((dataset) => dataset.key === 'exchange_mailbox_settings_rules')
  assert.equal(mailboxSettings?.permissionStatus, 'MISSING')
  assert.equal(mailboxSettings?.state, 'BLOCKED_PERMISSION')
  assert.match(mailboxSettings?.reason ?? '', /MailboxSettings\.Read/)
  assert.notEqual(result.overallState, 'BLOCKED_PERMISSION')
})

test('marks absent verification as unverified, revoked connection as blocked, and secure score failure as visible', () => {
  const noVerification = deriveCollectionReadiness(input({ connectionVerifiedAt: null }))
  assert.equal(row(noVerification, 'entra_directory').permissionStatus, 'UNVERIFIED')
  assert.notEqual(noVerification.overallState, 'READY')

  const revoked = deriveCollectionReadiness(input({ connectionStatus: 'REVOKED' }))
  assert.equal(row(revoked, 'sharepoint_onedrive').state, 'BLOCKED_PERMISSION')
  assert.equal(row(revoked, 'sharepoint_onedrive').lastSuccessfulAt, current.toISOString())

  const states = allResources.map((resource) => sync(resource))
  states.splice(states.findIndex((state) => state.resourceType === 'SECURE_SCORES'), 1, sync('SECURE_SCORES', { status: 'FAILED', lastErrorCode: '403', lastErrorMessage: 'Forbidden' }))
  const secureScoreFailure = deriveCollectionReadiness(input({ syncStates: states }))
  assert.equal(row(secureScoreFailure, 'entra_security_configuration').state, 'READY')
  assert.equal(row(secureScoreFailure, 'entra_security_configuration').datasets?.find((dataset) => dataset.key === 'entra_secure_scores')?.state, 'BLOCKED_PERMISSION')

  states.splice(states.findIndex((state) => state.resourceType === 'SECURE_SCORES'), 1, sync('SECURE_SCORES', { lastSuccessfulAt: new Date('2026-08-15T00:00:00.000Z') }))
  const staleSecureScore = row(deriveCollectionReadiness(input({ syncStates: states })), 'entra_security_configuration')
  assert.equal(staleSecureScore.state, 'READY')
  assert.equal(staleSecureScore.datasets?.find((dataset) => dataset.key === 'entra_secure_scores')?.state, 'STALE')
})

test('keeps required and optional collector grants independently visible', () => {
  const expectations: Array<[string, string, string, 'READY' | 'PARTIAL']> = [
    ['Member.Read.Hidden', 'entra_directory', 'entra_hidden_group_members', 'PARTIAL'],
    ['Device.Read.All', 'entra_directory', 'entra_devices', 'PARTIAL'],
    ['RoleManagement.Read.Directory', 'entra_directory', 'entra_directory_roles', 'PARTIAL'],
    ['Policy.Read.AuthenticationMethod', 'entra_security_configuration', 'entra_authentication_policy', 'PARTIAL'],
    ['SecurityEvents.Read.All', 'entra_security_configuration', 'entra_secure_scores', 'READY'],
  ]
  for (const [permission, workload, datasetKey, parentState] of expectations) {
    const result = deriveCollectionReadiness(input({ consentedPermissions: permissions.filter((value) => value !== permission) }))
    const value = row(result, workload)
    assert.equal(value.state, parentState, permission)
    const dataset = value.datasets?.find((candidate) => candidate.key === datasetKey)
    assert.equal(dataset?.permissionStatus, 'MISSING', permission)
    assert.equal(dataset?.state, 'BLOCKED_PERMISSION', permission)
    assert.match(dataset?.remediation ?? '', /Grant/i)
  }
})

test('keeps exact per-scope grant truth for an ALL-permission dataset', () => {
  const result = deriveCollectionReadiness(input({
    consentedPermissions: permissions.filter((permission) => permission !== 'Directory.Read.All'),
  }))
  const audit = row(result, 'entra_directory_audit').datasets?.find(
    (dataset) => dataset.key === 'entra_directory_audit',
  )
  assert.equal(audit?.permissionStatus, 'MISSING')
  assert.deepEqual(
    audit?.permissions.map((permission) => [permission.name, permission.grantStatus]),
    [['AuditLog.Read.All', 'CONFIRMED'], ['Directory.Read.All', 'MISSING']],
  )
})

test('reports one composite authentication-registration dataset for the premium report or per-user fallback', () => {
  const withoutAudit = deriveCollectionReadiness(input({
    consentedPermissions: permissions.filter((permission) => permission !== 'AuditLog.Read.All'),
  }))
  const fallbackReady = row(withoutAudit, 'entra_security_configuration')
  assert.equal(fallbackReady.state, 'READY')
  const fallbackCoverage = fallbackReady.datasets?.find((dataset) => dataset.key === 'entra_authentication_registration_coverage')
  assert.equal(fallbackCoverage?.state, 'READY')
  assert.equal(fallbackCoverage?.permissionMatch, 'ANY')
  assert.equal(fallbackCoverage?.evidenceMode, 'COMPOSITE_RESOURCE_STATE')
  assert.deepEqual(
    fallbackCoverage?.permissions.map((permission) => [permission.name, permission.grantStatus]),
    [['AuditLog.Read.All', 'MISSING'], ['UserAuthenticationMethod.Read.All', 'CONFIRMED']],
  )

  const withoutFallback = row(deriveCollectionReadiness(input({
    consentedPermissions: permissions.filter((permission) => permission !== 'UserAuthenticationMethod.Read.All'),
  })), 'entra_security_configuration')
  assert.equal(withoutFallback.state, 'READY')
  const reportCoverage = withoutFallback.datasets?.find((dataset) => dataset.key === 'entra_authentication_registration_coverage')
  assert.equal(reportCoverage?.state, 'READY')
  assert.deepEqual(
    reportCoverage?.permissions.map((permission) => [permission.name, permission.grantStatus]),
    [['AuditLog.Read.All', 'CONFIRMED'], ['UserAuthenticationMethod.Read.All', 'MISSING']],
  )

  const withoutEither = row(deriveCollectionReadiness(input({
    consentedPermissions: permissions.filter((permission) => !['AuditLog.Read.All', 'UserAuthenticationMethod.Read.All'].includes(permission)),
  })), 'entra_security_configuration')
  assert.equal(withoutEither.state, 'PARTIAL')
  assert.equal(withoutEither.datasets?.find((dataset) => dataset.key === 'entra_authentication_registration_coverage')?.state, 'BLOCKED_PERMISSION')
})

test('does not claim source-specific authentication readiness from the shared successful snapshot state', () => {
  const result = row(deriveCollectionReadiness(input()), 'entra_security_configuration')
  const coverage = result.datasets?.find((dataset) => dataset.key === 'entra_authentication_registration_coverage')
  const requirements = result.datasets?.find((dataset) => dataset.key === 'entra_per_user_mfa_requirements')

  // AUTH_REGISTRATIONS is SUCCEEDED both for the premium report and when the
  // collector catches non-premium and completes its per-user methods fallback.
  assert.equal(coverage?.state, 'READY')
  assert.equal(coverage?.evidenceMode, 'COMPOSITE_RESOURCE_STATE')
  assert.equal(result.datasets?.some((dataset) => dataset.key === 'entra_authentication_methods_fallback'), false)

  // The beta requirements enrichment catches failures while the same shared
  // snapshot still succeeds, so no source-specific READY claim is defensible.
  assert.equal(requirements?.state, 'UNVERIFIED')
  assert.equal(requirements?.lastSuccessfulAt, null)
  assert.equal(requirements?.reasonCode, 'SOURCE_AVAILABILITY_NOT_DURABLY_OBSERVED')
  assert.equal(requirements?.evidenceMode, 'NOT_DURABLY_OBSERVED')
})

test('connection verification failures override historical collection success without erasing that evidence', () => {
  const result = deriveCollectionReadiness(input({ connectionStatus: 'ERROR', connectionVerifiedAt: null }))
  const directory = row(result, 'entra_directory')
  assert.equal(directory.state, 'BLOCKED_PERMISSION')
  assert.equal(directory.lastSuccessfulAt, current.toISOString())
  assert.match(directory.remediation, /Reconnect/i)
})

test('distinguishes a bounded audit backlog from a completed scheduler run', () => {
  const states = allResources.map((resource) => sync(resource))
  states.splice(states.findIndex((state) => state.resourceType === 'M365_AUDIT'), 1, sync('M365_AUDIT', {
    status: 'RUNNING',
    lastErrorCode: 'M365_AUDIT_BACKLOG',
    lastErrorMessage: 'Content continuation backlog remains within the daily budget.',
  }))
  const result = deriveCollectionReadiness(input({ syncStates: states }))
  assert.equal(row(result, 'm365_unified_audit').state, 'BACKLOGGED')
})

test('keeps an optional dataset visible while it is running without degrading its healthy parent', () => {
  const states = allResources.map((resource) => sync(resource))
  states.splice(states.findIndex((state) => state.resourceType === 'SHAREPOINT_USAGE'), 1, sync('SHAREPOINT_USAGE', {
    status: 'RUNNING',
    lastErrorMessage: 'Usage report collection is in progress.',
  }))
  const result = deriveCollectionReadiness(input({ syncStates: states }))
  assert.equal(row(result, 'sharepoint_onedrive').state, 'READY')
  assert.equal(row(result, 'sharepoint_onedrive').datasets?.find((dataset) => dataset.key === 'sharepoint_usage_reports')?.state, 'PARTIAL')
  assert.equal(row(result, 'sharepoint_onedrive').lastSuccessfulAt, current.toISOString())
})

test('does not call a SharePoint usage projection ready without durable valid evidence', () => {
  const authoritative = deriveCollectionReadiness(input({
    sharePointUsageProjectionEvidence: {
      state: 'AUTHORITATIVE_COMPLETE',
      reasonCode: null,
    },
    oneDriveUsageProjectionEvidence: {
      state: 'AUTHORITATIVE_COMPLETE',
      reasonCode: null,
    },
  }))
  assert.equal(
    row(authoritative, 'sharepoint_onedrive').datasets?.find(
      (dataset) => dataset.key === 'sharepoint_usage_reports',
    )?.state,
    'READY',
  )
  assert.equal(
    row(authoritative, 'sharepoint_onedrive').datasets?.find(
      (dataset) => dataset.key === 'onedrive_usage_reports',
    )?.state,
    'READY',
  )

  const legacy = deriveCollectionReadiness(input({
    sharePointUsageProjectionEvidence: {
      state: 'UNVERIFIED_LEGACY',
      reasonCode: 'USAGE_PROJECTION_NOT_DURABLY_VERIFIED',
    },
  }))
  const legacyDataset = row(legacy, 'sharepoint_onedrive').datasets?.find(
    (dataset) => dataset.key === 'sharepoint_usage_reports',
  )
  assert.equal(legacyDataset?.state, 'UNVERIFIED')
  assert.equal(legacyDataset?.reasonCode, 'USAGE_PROJECTION_NOT_DURABLY_VERIFIED')
  assert.equal(row(legacy, 'sharepoint_onedrive').state, 'READY')

  const incomplete = deriveCollectionReadiness(input({
    sharePointUsageProjectionEvidence: {
      state: 'PARTIAL',
      reasonCode: 'USAGE_PROJECTION_EVIDENCE_INCOMPLETE',
    },
  }))
  const incompleteDataset = row(incomplete, 'sharepoint_onedrive').datasets?.find(
    (dataset) => dataset.key === 'sharepoint_usage_reports',
  )
  assert.equal(incompleteDataset?.state, 'PARTIAL')
  assert.equal(incompleteDataset?.reasonCode, 'USAGE_PROJECTION_EVIDENCE_INCOMPLETE')
  assert.equal(row(incomplete, 'sharepoint_onedrive').state, 'READY')

  const oneDriveIncomplete = deriveCollectionReadiness(input({
    sharePointUsageProjectionEvidence: {
      state: 'AUTHORITATIVE_COMPLETE',
      reasonCode: null,
    },
    oneDriveUsageProjectionEvidence: {
      state: 'PARTIAL',
      reasonCode: 'USAGE_PROJECTION_EVIDENCE_INCOMPLETE',
    },
  }))
  assert.equal(
    row(oneDriveIncomplete, 'sharepoint_onedrive').datasets?.find(
      (dataset) => dataset.key === 'sharepoint_usage_reports',
    )?.state,
    'READY',
  )
  assert.equal(
    row(oneDriveIncomplete, 'sharepoint_onedrive').datasets?.find(
      (dataset) => dataset.key === 'onedrive_usage_reports',
    )?.state,
    'PARTIAL',
  )
  assert.equal(row(oneDriveIncomplete, 'sharepoint_onedrive').state, 'READY')

  const rejected = deriveCollectionReadiness(input({
    sharePointUsageProjectionEvidence: {
      state: 'REJECTED',
      reasonCode: 'USAGE_PROJECTION_EVIDENCE_INVALID',
    },
  }))
  const rejectedDataset = row(rejected, 'sharepoint_onedrive').datasets?.find(
    (dataset) => dataset.key === 'sharepoint_usage_reports',
  )
  assert.equal(rejectedDataset?.state, 'PARTIAL')
  assert.equal(rejectedDataset?.reasonCode, 'USAGE_PROJECTION_EVIDENCE_INVALID')
  assert.equal(row(rejected, 'sharepoint_onedrive').state, 'READY')
})

test('automatically reflects an M365 subscription recovering after provisioning without reconnecting', () => {
  const pending: Array<{
    contentType: string
    status: string
    lastStartRequestedAt: Date
    lastVerifiedAt: Date
    lastSuccessfulPollAt: Date | null
    lastError: string | null
  }> = M365_ACTIVITY_CONTENT_TYPES.map((contentType) => ({ contentType, status: 'ENABLED', lastStartRequestedAt: current, lastVerifiedAt: current, lastSuccessfulPollAt: current, lastError: null }))
  pending[2] = { ...pending[2], status: 'PENDING', lastSuccessfulPollAt: null }
  const before = deriveCollectionReadiness(input({ subscriptions: pending }))
  assert.equal(row(before, 'm365_unified_audit').components?.find((component) => component.key === 'Audit.SharePoint')?.state, 'INITIALIZING')

  const recovered = deriveCollectionReadiness(input())
  assert.equal(row(recovered, 'm365_unified_audit').state, 'READY')
  assert.equal(row(recovered, 'm365_unified_audit').components?.every((component) => component.state === 'READY'), true)
})
