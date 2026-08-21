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
  'AUDIT_LOGS', 'SIGN_INS', 'USERS', 'GROUPS', 'DEVICES', 'DIRECTORY_ROLES', 'AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES', 'CONDITIONAL_ACCESS', 'NAMED_LOCATIONS', 'APPLICATIONS', 'SERVICE_PRINCIPALS', 'SECURITY_DEFAULTS', 'SECURE_SCORES', 'ORGANIZATION_CONFIGURATION', 'DOMAINS', 'LICENSES', 'DOMAIN_DNS_HEALTH', 'SHAREPOINT_SITES', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE', 'EXCHANGE_MAILBOXES', 'EXCHANGE_MAILBOX_SETTINGS', 'EXCHANGE_MAILBOX_USAGE', 'EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOX_RULES', 'EXCHANGE_MAILBOX_CONFIGURATION', 'M365_AUDIT',
]

const permissions = ['Organization.Read.All', 'User.Read.All', 'GroupMember.Read.All', 'Member.Read.Hidden', 'Device.Read.All', 'RoleManagement.Read.Directory', 'UserAuthenticationMethod.Read.All', 'Policy.Read.AuthenticationMethod', 'Policy.Read.All', 'Application.Read.All', 'AuditLog.Read.All', 'Directory.Read.All', 'Sites.Read.All', 'SharePointTenantSettings.Read.All', 'Reports.Read.All', 'MailboxSettings.Read', 'ActivityFeed.Read', 'SecurityEvents.Read.All']

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

test('does not equate Exchange Graph consent with Exchange RBAC and keeps messages sanitized', () => {
  const states = allResources.map((resource) => sync(resource))
  states.splice(states.findIndex((state) => state.resourceType === 'EXCHANGE_MAILBOX_CONFIGURATION'), 1, sync('EXCHANGE_MAILBOX_CONFIGURATION', { status: 'FAILED', lastErrorMessage: 'Recipient Management Exchange RBAC role required; client_secret=do-not-show' }))
  const result = deriveCollectionReadiness(input({ syncStates: states }))
  const exchange = row(result, 'exchange')
  assert.equal(exchange.permissionStatus, 'CONFIRMED')
  assert.equal(exchange.exchangeRbac?.status, 'MISSING')
  assert.equal(exchange.exchangeRbac?.state, 'BLOCKED_PERMISSION')
  assert.doesNotMatch(JSON.stringify(result), /do-not-show/)
})

test('converges Exchange readiness after the daily Exchange Admin configuration collector succeeds', () => {
  const before = deriveCollectionReadiness(input({
    syncStates: allResources
      .filter((resource) => resource !== 'EXCHANGE_MAILBOX_CONFIGURATION')
      .map((resource) => sync(resource)),
  }))
  assert.equal(row(before, 'exchange').state, 'UNVERIFIED')

  const after = deriveCollectionReadiness(input())
  assert.equal(row(after, 'exchange').state, 'READY')
  assert.equal(row(after, 'exchange').exchangeRbac?.status, 'CONFIRMED')
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

test('fails closed when an included collector is missing or Exchange RBAC is unverified', () => {
  const omitted = deriveCollectionReadiness(input({ syncStates: allResources.filter((resource) => resource !== 'DEVICES').map((resource) => sync(resource)) }))
  assert.notEqual(row(omitted, 'entra_directory').state, 'READY')

  const noExchangeAdmin = deriveCollectionReadiness(input({ syncStates: allResources.filter((resource) => resource !== 'EXCHANGE_MAILBOX_CONFIGURATION').map((resource) => sync(resource)) }))
  const exchange = row(noExchangeAdmin, 'exchange')
  assert.equal(exchange.state, 'UNVERIFIED')
  assert.equal(exchange.exchangeRbac?.status, 'UNVERIFIED')
  assert.notEqual(noExchangeAdmin.overallState, 'READY')
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

test('preserves prior Exchange Admin success while accurately reporting stale and later failures', () => {
  const old = new Date('2026-08-14T12:00:00.000Z')
  const states = allResources.map((resource) => sync(resource))
  const replace = (value: Record<string, unknown>) => states.splice(states.findIndex((item) => item.resourceType === 'EXCHANGE_MAILBOX_CONFIGURATION'), 1, sync('EXCHANGE_MAILBOX_CONFIGURATION', value))
  replace({ lastAttemptAt: old, lastSuccessfulAt: old })
  let result = deriveCollectionReadiness(input({ syncStates: states }))
  let exchange = row(result, 'exchange')
  assert.equal(exchange.state, 'STALE')
  assert.equal(exchange.lastSuccessfulAt, old.toISOString())

  replace({ status: 'FAILED', lastAttemptAt: current, lastSuccessfulAt: old, lastErrorCode: '403', lastErrorMessage: 'Recipient Management role required' })
  result = deriveCollectionReadiness(input({ syncStates: states }))
  exchange = row(result, 'exchange')
  assert.equal(exchange.state, 'BLOCKED_PERMISSION')
  assert.equal(exchange.lastSuccessfulAt, old.toISOString())

  replace({ status: 'FAILED', lastAttemptAt: current, lastSuccessfulAt: old, lastErrorCode: '500', lastErrorMessage: 'Temporary failure' })
  result = deriveCollectionReadiness(input({ syncStates: states }))
  exchange = row(result, 'exchange')
  assert.equal(exchange.state, 'FAILED_TRANSIENT')
  assert.equal(exchange.lastSuccessfulAt, old.toISOString())

  replace({ lastAttemptAt: current, lastSuccessfulAt: new Date('invalid') })
  result = deriveCollectionReadiness(input({ syncStates: states }))
  assert.equal(row(result, 'exchange').state, 'UNVERIFIED')

  replace({ lastAttemptAt: current, lastSuccessfulAt: new Date('2026-08-19T12:00:00.000Z') })
  result = deriveCollectionReadiness(input({ syncStates: states }))
  exchange = row(result, 'exchange')
  assert.equal(exchange.state, 'UNVERIFIED')
  assert.equal(exchange.exchangeRbac?.status, 'UNVERIFIED')
  assert.equal(exchange.components?.find((component) => component.key === 'EXCHANGE_MAILBOX_CONFIGURATION')?.lastSuccessfulAt, null)
})

test('keeps missing Graph mailbox permission authoritative across confirmed, unverified, and failed Exchange RBAC', () => {
  const withoutMailboxSettings = permissions.filter((permission) => permission !== 'MailboxSettings.Read')
  const variants: Array<Record<string, unknown>> = [
    {},
    { lastSuccessfulAt: current },
    { status: 'FAILED', lastErrorCode: '403', lastErrorMessage: 'Recipient Management role required' },
  ]
  for (const exchangeAdmin of variants) {
    const states = allResources.map((resource) => sync(resource))
    states.splice(states.findIndex((state) => state.resourceType === 'EXCHANGE_MAILBOX_CONFIGURATION'), 1, sync('EXCHANGE_MAILBOX_CONFIGURATION', exchangeAdmin))
    const result = deriveCollectionReadiness(input({ consentedPermissions: withoutMailboxSettings, syncStates: states }))
    const exchange = row(result, 'exchange')
    assert.equal(exchange.permissionStatus, 'MISSING')
    assert.equal(exchange.state, 'BLOCKED_PERMISSION')
    assert.equal(exchange.reasonCode, 'MICROSOFT_PERMISSION_NOT_CONFIRMED')
    assert.match(exchange.reason ?? '', /MailboxSettings\.Read/)
    assert.equal(result.overallState, 'BLOCKED_PERMISSION')
  }
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
  assert.equal(row(secureScoreFailure, 'entra_security_configuration').state, 'BLOCKED_PERMISSION')

  states.splice(states.findIndex((state) => state.resourceType === 'SECURE_SCORES'), 1, sync('SECURE_SCORES', { lastSuccessfulAt: new Date('2026-08-15T00:00:00.000Z') }))
  assert.equal(row(deriveCollectionReadiness(input({ syncStates: states })), 'entra_security_configuration').state, 'STALE')
})

test('treats every active collector grant as a verified requirement instead of silently declaring its workload ready', () => {
  const expectations: Array<[string, string]> = [
    ['Member.Read.Hidden', 'entra_directory'],
    ['Device.Read.All', 'entra_directory'],
    ['RoleManagement.Read.Directory', 'entra_directory'],
    ['Policy.Read.AuthenticationMethod', 'entra_security_configuration'],
    ['SecurityEvents.Read.All', 'entra_security_configuration'],
  ]
  for (const [permission, workload] of expectations) {
    const result = deriveCollectionReadiness(input({ consentedPermissions: permissions.filter((value) => value !== permission) }))
    const value = row(result, workload)
    assert.equal(value.permissionStatus, 'MISSING', permission)
    assert.equal(value.state, 'BLOCKED_PERMISSION', permission)
    assert.match(value.remediation, /permission/i)
  }
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

test('keeps a workload partial when one persisted collector is still running after other data succeeded', () => {
  const states = allResources.map((resource) => sync(resource))
  states.splice(states.findIndex((state) => state.resourceType === 'SHAREPOINT_USAGE'), 1, sync('SHAREPOINT_USAGE', {
    status: 'RUNNING',
    lastErrorMessage: 'Usage report collection is in progress.',
  }))
  const result = deriveCollectionReadiness(input({ syncStates: states }))
  assert.equal(row(result, 'sharepoint_onedrive').state, 'PARTIAL')
  assert.equal(row(result, 'sharepoint_onedrive').lastSuccessfulAt, current.toISOString())
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
