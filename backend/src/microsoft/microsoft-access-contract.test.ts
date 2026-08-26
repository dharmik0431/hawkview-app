import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CONNECTION_REQUIRED_PERMISSIONS,
  DEFAULT_REQUIRED_PERMISSIONS,
  MICROSOFT_ACCESS_CAPABILITIES,
  MICROSOFT_APPLICATION_PERMISSIONS,
  MICROSOFT_COLLECTOR_RESOURCE_TYPES,
} from './microsoft-access-contract.js'
import { MicrosoftConsentService } from './microsoft-consent.service.js'
import { effectiveMicrosoftConnectionStatus } from '../tenants/tenants.service.js'

test('registers every requested application permission against a real capability and exact resource', () => {
  assert.equal(DEFAULT_REQUIRED_PERMISSIONS.length, 20)
  assert.deepEqual(CONNECTION_REQUIRED_PERMISSIONS, ['Organization.Read.All'])
  assert.equal(new Set(DEFAULT_REQUIRED_PERMISSIONS).size, DEFAULT_REQUIRED_PERMISSIONS.length)
  for (const name of DEFAULT_REQUIRED_PERMISSIONS) {
    const permission = MICROSOFT_APPLICATION_PERMISSIONS.find((candidate) => candidate.name === name)
    assert.ok(permission, `missing permission definition for ${name}`)
    assert.equal(permission.consentMode, 'DEFAULT')
    const uses = MICROSOFT_ACCESS_CAPABILITIES.filter((capability) =>
      capability.applicationPermissions.some((candidate) => candidate.name === name && candidate.resource === permission.resource),
    )
    assert.ok(uses.length > 0, `${name} is requested but unused`)
  }
  assert.equal(DEFAULT_REQUIRED_PERMISSIONS.includes('Exchange.ManageAsAppV2'), false)
})

test('keeps the registry bounded, unique, documented, and collector-complete', () => {
  assert.equal(new Set(MICROSOFT_ACCESS_CAPABILITIES.map((capability) => capability.key)).size, MICROSOFT_ACCESS_CAPABILITIES.length)
  for (const capability of MICROSOFT_ACCESS_CAPABILITIES) {
    assert.ok(capability.endpointPatterns.length > 0, `${capability.key} has no endpoint`)
    assert.match(capability.documentationUrl, /^https:\/\/learn\.microsoft\.com\//)
    for (const permission of capability.applicationPermissions) {
      assert.ok(MICROSOFT_APPLICATION_PERMISSIONS.some((candidate) => candidate.name === permission.name && candidate.resource === permission.resource), `${capability.key} has unregistered ${permission.resource}/${permission.name}`)
    }
  }
  assert.deepEqual(MICROSOFT_COLLECTOR_RESOURCE_TYPES, [
    'APPLICATIONS', 'AUDIT_LOGS', 'AUTHENTICATION_STRENGTHS', 'AUTH_METHOD_POLICIES', 'AUTH_REGISTRATIONS',
    'CONDITIONAL_ACCESS', 'DEVICES', 'DIRECTORY_ROLES', 'DOMAINS',
    'EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOXES', 'EXCHANGE_MAILBOX_CONFIGURATION',
    'EXCHANGE_MAILBOX_RULES', 'EXCHANGE_MAILBOX_SETTINGS', 'EXCHANGE_MAILBOX_USAGE',
    'GROUPS', 'LICENSES', 'M365_AUDIT', 'NAMED_LOCATIONS',
    'ORGANIZATION_CONFIGURATION', 'RISKY_USERS', 'SECURE_SCORES', 'SECURITY_DEFAULTS',
    'SERVICE_PRINCIPALS', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_SITES',
    'SHAREPOINT_USAGE', 'SIGN_INS', 'USERS',
  ])
})

test('matches current high-risk collector endpoints without retired SharePoint drive calls', () => {
  const endpoints = MICROSOFT_ACCESS_CAPABILITIES.flatMap((capability) => [...capability.endpointPatterns])
  assert.equal(endpoints.some((endpoint) => endpoint.includes('/sites/{siteId}/drive')), false)
  assert.ok(endpoints.includes('POST /beta/$batch (users/{id}/authentication/requirements)'))
  assert.ok(endpoints.includes('POST /v1.0/$batch (users/{id}/authentication/methods)'))
  assert.ok(endpoints.some((endpoint) => endpoint.includes('Graph report Location URL')))
  assert.ok(endpoints.includes('GET /api/v1.0/{tenantId}/activity/feed/subscriptions/list'))
})

test('keeps current Microsoft call-site families represented in the registry', () => {
  const tenantSync = readFileSync(fileURLToPath(new URL('../tenants/tenant-sync.service.ts', import.meta.url)), 'utf8')
  const consentService = readFileSync(fileURLToPath(new URL('./microsoft-consent.service.ts', import.meta.url)), 'utf8')
  const activity = readFileSync(fileURLToPath(new URL('../tenants/m365-management-activity.service.ts', import.meta.url)), 'utf8')
  const registered = MICROSOFT_ACCESS_CAPABILITIES.flatMap((capability) => capability.endpointPatterns).join('\n')
  const pairs = [
    ['/auditLogs/directoryAudits', '/auditLogs/directoryAudits'],
    ['/auditLogs/signIns', '/auditLogs/signIns'],
    ['/users/delta', '/users/delta'],
    ['/groups?', '/groups'],
    ['/devices?', '/devices'],
    ['/roleManagement/directory/roleAssignments', '/roleManagement/directory/roleAssignments'],
    ['/reports/authenticationMethods/userRegistrationDetails', '/reports/authenticationMethods/userRegistrationDetails'],
    ['/authentication/requirements', '/authentication/requirements'],
    ['/authentication/methods', '/authentication/methods'],
    ['/policies/authenticationMethodsPolicy', '/policies/authenticationMethodsPolicy'],
    ['/identity/conditionalAccess/policies', '/identity/conditionalAccess/policies'],
    ['/policies/authenticationStrengthPolicies', '/policies/authenticationStrengthPolicies'],
    ['/identity/conditionalAccess/namedLocations', '/identity/conditionalAccess/namedLocations'],
    ['/policies/identitySecurityDefaultsEnforcementPolicy', '/policies/identitySecurityDefaultsEnforcementPolicy'],
    ['/applications?', '/applications'],
    ['/servicePrincipals?', '/servicePrincipals'],
    ['/security/secureScores', '/security/secureScores'],
    ['/identityProtection/riskyUsers', '/identityProtection/riskyUsers'],
    ['/subscribedSkus', '/subscribedSkus'],
    ['/admin/sharepoint/settings', '/admin/sharepoint/settings'],
    ['/sites?search=', '/sites?search=*'],
    ['/reports/getSharePointSiteUsageDetail', '/reports/getSharePointSiteUsageDetail'],
    ['/reports/getOneDriveUsageAccountDetail', '/reports/getOneDriveUsageAccountDetail'],
    ['/users/${encodeURIComponent(user.microsoftUserId)}/mailboxSettings', '/users/{id}/mailboxSettings'],
    ['/mailFolders/inbox/messageRules', '/mailFolders/inbox/messageRules'],
    ['/reports/getMailboxUsageDetail', '/reports/getMailboxUsageDetail'],
    ['/adminapi/v2.0/', '/adminapi/v2.0/'],
  ] as const
  for (const [sourceNeedle, registryNeedle] of pairs) {
    assert.ok(tenantSync.includes(sourceNeedle), `collector call disappeared: ${sourceNeedle}`)
    assert.ok(registered.includes(registryNeedle), `collector call is not registered: ${registryNeedle}`)
  }
  for (const needle of ['/subscriptions/list', '/subscriptions/start', '/subscriptions/content']) {
    assert.ok(activity.includes(needle), `activity call disappeared: ${needle}`)
    assert.ok(registered.includes(needle), `activity call is not registered: ${needle}`)
  }
  assert.ok(consentService.includes('/v1.0/admin/reportSettings?$select=displayConcealedNames'))
  assert.ok(registered.includes('/v1.0/admin/reportSettings?$select=displayConcealedNames'))
  assert.equal(consentService.includes('PATCH') && consentService.includes('/admin/reportSettings'), false)
})

test('publishes canonical permission metadata without turning optional coverage into a connection gate', () => {
  const contract = new MicrosoftConsentService({} as never, {} as never).getAccessContract()
  assert.equal(contract.version, 1)
  assert.deepEqual(contract.connectionRequiredPermissions, ['Organization.Read.All'])
  assert.equal(contract.requestedPermissions.length, 20)
  const activity = contract.requestedPermissions.find((permission) => permission.name === 'ActivityFeed.Read')
  assert.equal(activity?.resource, 'OFFICE_365_MANAGEMENT_API')
  assert.equal(activity?.type, 'APPLICATION')
  assert.equal(activity?.connectionRequired, false)
  assert.ok(activity?.purpose.includes('Microsoft 365 Unified Audit'))
})

test('directory audit contract requires both documented Graph application roles', () => {
  const audit = MICROSOFT_ACCESS_CAPABILITIES.find((capability) => capability.key === 'entra_directory_audit')
  assert.deepEqual(audit?.applicationPermissions, [
    { resource: 'MICROSOFT_GRAPH', name: 'AuditLog.Read.All' },
    { resource: 'MICROSOFT_GRAPH', name: 'Directory.Read.All' },
  ])
})

test('authentication registration declares truthful premium and unlicensed source alternatives', () => {
  const capability = MICROSOFT_ACCESS_CAPABILITIES.find(
    (candidate) => candidate.key === 'entra_authentication_registration_coverage',
  )
  assert.ok(capability)
  assert.equal(capability.permissionMatch, 'ANY')
  assert.equal(capability.evidenceMode, 'COMPOSITE_RESOURCE_STATE')
  assert.deepEqual(capability.sourceAlternatives, [
    {
      key: 'user_registration_details_report',
      applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'AuditLog.Read.All' }],
      licensePrerequisite: 'ENTRA_ID_P1_OR_P2',
      endpointPatterns: ['GET /v1.0/reports/authenticationMethods/userRegistrationDetails'],
      documentationUrl: 'https://learn.microsoft.com/graph/api/authenticationmethodsroot-list-userregistrationdetails',
    },
    {
      key: 'per_user_authentication_methods',
      applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'UserAuthenticationMethod.Read.All' }],
      licensePrerequisite: 'NONE',
      endpointPatterns: ['POST /v1.0/$batch (users/{id}/authentication/methods)'],
      documentationUrl: 'https://learn.microsoft.com/graph/api/authentication-list-methods',
    },
  ])
})

test('only heals a legacy global permission error when the connection baseline is present', () => {
  assert.equal(effectiveMicrosoftConnectionStatus('ERROR', 'missing-permissions', []), 'ACTIVE')
  assert.equal(effectiveMicrosoftConnectionStatus('ERROR', 'missing-permissions', ['Organization.Read.All']), 'ERROR')
  assert.equal(effectiveMicrosoftConnectionStatus('ERROR', 'invalid-client', []), 'ERROR')
  assert.equal(effectiveMicrosoftConnectionStatus('REVOKED', 'missing-permissions', []), 'REVOKED')
})
