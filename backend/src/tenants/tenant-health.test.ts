import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveTenantHealth,
  TENANT_HEALTH_RESOURCE_REGISTRY,
  type TenantAuditEvent,
} from './tenant-health'
import { sanitizeHealthMessage } from './sanitize-health-message'

function baseInput() {
  return {
    tenantId: 'tenant-1',
    effectiveStatus: 'active',
    connectionStatus: 'ACTIVE',
    missingPermissions: [] as string[],
    syncStates: [],
    authSnapshot: null,
    riskyIdentityCount: 0,
    auditEvents: [] as TenantAuditEvent[],
  }
}

test('disconnected tenants link directly to connection settings', () => {
  const result = deriveTenantHealth({
    ...baseInput(),
    effectiveStatus: 'disconnected',
    connectionStatus: 'REVOKED',
  })

  assert.equal(result.attention[0]?.label, 'Tenant is no longer connected to HawkView')
  assert.equal(result.attention[0]?.actionLabel, 'Reconnect tenant')
  assert.equal(result.attention[0]?.actionUrl, '/tenants/tenant-1/settings')
})

test('missing permissions link directly to permission settings', () => {
  const result = deriveTenantHealth({
    ...baseInput(),
    missingPermissions: ['AuditLog.Read.All'],
  })

  assert.equal(result.attention[0]?.label, 'Required Microsoft permissions are missing')
  assert.equal(result.attention[0]?.actionLabel, 'Review permissions')
  assert.equal(result.attention[0]?.actionUrl, '/tenants/tenant-1/settings')
})

test('M365 audit collection findings open the audit synchronization health panel', () => {
  const result = deriveTenantHealth({
    ...baseInput(),
    syncStates: [{ resourceType: 'M365_AUDIT', status: 'FAILED', lastAttemptAt: new Date('2026-08-07T12:00:00.000Z'), lastSuccessfulAt: null, lastErrorCode: '403', lastErrorMessage: 'Microsoft rejected the request.', consecutiveFailures: 1 }],
  })
  const finding = result.attention.find((item) => item.key === 'sync-m365_audit')
  assert.equal(finding?.actionLabel, 'Review audit synchronization')
  assert.equal(finding?.actionUrl, '/tenants/tenant-1/settings?section=sync&resource=M365_AUDIT')
  assert.equal(finding?.actionUrl.includes('what-changed'), false)
})

test('reports current limited sign-in fallback without a synchronization-failure action', () => {
  const result = deriveTenantHealth({
    ...baseInput(),
    now: new Date('2026-08-07T12:05:00.000Z'),
    riskyIdentityCount: null,
    syncStates: [{
      resourceType: 'SIGN_INS', status: 'RUNNING', lastAttemptAt: new Date('2026-08-07T12:00:00.000Z'),
      lastSuccessfulAt: new Date('2026-08-07T12:00:00.000Z'), lastErrorCode: 'sign-ins-non-premium-fallback-active',
      lastErrorMessage: 'Current limited audit-feed login evidence is available.', consecutiveFailures: 0,
    }],
  })
  assert.equal(result.resourceHealth.find((item) => item.resourceType === 'SIGN_INS')?.classification, 'PARTIAL')
  assert.equal(result.attention.some((item) => item.key === 'sync-sign_ins'), false)
  assert.equal(result.attention.find((item) => item.key === 'sign-ins-limited-evidence')?.label, 'Limited sign-in evidence is active')
  assert.equal(result.operations.failedJobs, 0)
  assert.equal(result.operations.partialJobs, 1)
  assert.equal(result.riskyIdentityCount, null)
})

test('uses selected current limited evidence instead of a failed non-selected Graph state', () => {
  const now = new Date('2026-08-07T12:05:00.000Z')
  const result = deriveTenantHealth({
    ...baseInput(),
    now,
    signInEvidence: {
      availability: 'CURRENT_LIMITED', coverage: 'LIMITED', selectedSource: 'OFFICE_365_ACTIVITY_FEED',
      observedAt: '2026-08-07T12:00:00.000Z', reasonCode: 'SIGN_IN_FALLBACK_ACTIVE',
      reason: 'Current limited audit-feed login evidence is available.',
    },
    syncStates: [{
      resourceType: 'SIGN_INS', status: 'FAILED', lastAttemptAt: now,
      lastSuccessfulAt: null, lastErrorCode: '403', lastErrorMessage: 'Graph sign-ins denied.', consecutiveFailures: 9,
    }],
  })
  assert.equal(result.resourceHealth.find((item) => item.resourceType === 'SIGN_INS')?.classification, 'PARTIAL')
  assert.equal(result.attention.some((item) => item.key === 'sync-sign_ins'), false)
  assert.equal(result.attention.filter((item) => item.key === 'sign-ins-limited-evidence').length, 1)
  assert.equal(result.operations.failedJobs, 0)
  assert.equal(result.operations.activeIssues, 0)
})

test('creates one truthful action for each actionable selected sign-in evidence state', () => {
  const now = new Date('2026-08-07T12:05:00.000Z')
  for (const availability of ['STALE', 'FAILED_TRANSIENT', 'BLOCKED_PERMISSION'] as const) {
    const result = deriveTenantHealth({
      ...baseInput(), now,
      signInEvidence: {
        availability, coverage: 'LIMITED', selectedSource: 'OFFICE_365_ACTIVITY_FEED',
        observedAt: '2026-08-07T11:00:00.000Z', reasonCode: `SIGN_INS_${availability}`,
        reason: 'The selected evidence source needs attention.',
      },
      syncStates: [{ resourceType: 'SIGN_INS', status: 'SUCCEEDED', lastAttemptAt: now, lastSuccessfulAt: now, lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0 }],
    })
    assert.equal(result.attention.filter((item) => item.key === 'sync-sign_ins').length, 1, availability)
    assert.equal(result.attention.some((item) => item.key === 'sign-ins-limited-evidence'), false, availability)
    assert.equal(result.operations.activeIssues, 1, availability)
  }
})

test('creates exactly one selected sign-in action when audit-feed fallback evidence is stale or failed', () => {
  const now = new Date('2026-08-07T15:00:00.000Z')
  const stale = deriveTenantHealth({
    ...baseInput(),
    now,
    syncStates: [{
      resourceType: 'SIGN_INS', status: 'RUNNING', lastAttemptAt: now,
      lastSuccessfulAt: new Date('2026-08-07T12:00:00.000Z'), lastErrorCode: 'sign-ins-non-premium-fallback-active',
      lastErrorMessage: 'Audit-feed login evidence has not refreshed.', consecutiveFailures: 0,
    }],
  })
  assert.equal(stale.resourceHealth.find((item) => item.resourceType === 'SIGN_INS')?.classification, 'STALE')
  assert.deepEqual(stale.attention.filter((item) => item.key === 'sync-sign_ins').map((item) => item.label), ['Sign-ins data could not be synchronized'])
  assert.equal(stale.attention.some((item) => item.key === 'sign-ins-limited-evidence'), false)
  assert.equal(stale.operations.activeIssues, 1)
  assert.equal(stale.operations.pendingJobs, 0)

  const failed = deriveTenantHealth({
    ...baseInput(),
    now,
    syncStates: [{
      resourceType: 'SIGN_INS', status: 'FAILED', lastAttemptAt: now,
      lastSuccessfulAt: new Date('2026-08-07T14:55:00.000Z'), lastErrorCode: 'sign-ins-non-premium-fallback-active',
      lastErrorMessage: 'Audit-feed login evidence failed.', consecutiveFailures: 1,
    }],
  })
  assert.equal(failed.resourceHealth.find((item) => item.resourceType === 'SIGN_INS')?.classification, 'FAILED')
  assert.deepEqual(failed.attention.filter((item) => item.key === 'sync-sign_ins').map((item) => item.label), ['Sign-ins data could not be synchronized'])
  assert.equal(failed.attention.some((item) => item.key === 'sign-ins-limited-evidence'), false)
  assert.equal(failed.operations.activeIssues, 1)
})

test('does not turn an explicitly unlicensed Conditional Access collector into an action item', () => {
  const result = deriveTenantHealth({
    ...baseInput(),
    notApplicableResourceTypes: ['CONDITIONAL_ACCESS'],
  })
  const conditionalAccess = result.resourceHealth.find((item) => item.resourceType === 'CONDITIONAL_ACCESS')
  assert.equal(conditionalAccess?.classification, 'NOT_LICENSED')
  assert.equal(result.attention.some((item) => item.key === 'sync-conditional_access'), false)
  assert.equal(result.data.notLicensedResources, 1)
})

test('keeps unsupported capability evidence separate from licensing evidence', () => {
  const result = deriveTenantHealth({
    ...baseInput(),
    unsupportedResourceTypes: ['CONDITIONAL_ACCESS'],
  })
  const conditionalAccess = result.resourceHealth.find((item) => item.resourceType === 'CONDITIONAL_ACCESS')
  assert.equal(conditionalAccess?.classification, 'UNSUPPORTED')
  assert.equal(result.data.notLicensedResources, 0)
  assert.equal(result.data.unsupportedResources, 1)
  assert.equal(result.attention.some((item) => item.key === 'sync-conditional_access'), false)
})

test('redacts credential-shaped collector failures before tenant health is returned', () => {
  const result = deriveTenantHealth({
    ...baseInput(),
    syncStates: [{ resourceType: 'M365_AUDIT', status: 'FAILED', lastAttemptAt: new Date(), lastSuccessfulAt: null, lastErrorCode: '403', lastErrorMessage: 'HTTP 403 Bearer secret-token refresh_token=hidden https://graph.microsoft.com/v1.0/auditLogs?sig=signed', consecutiveFailures: 1 }],
  })
  const resource = result.resourceHealth.find((item) => item.resourceType === 'M365_AUDIT')
  assert.match(resource?.message ?? '', /HTTP 403/)
  assert.doesNotMatch(resource?.message ?? '', /secret-token|hidden|signed/)
  assert.match(result.operations.issues[0]?.message ?? '', /\[REDACTED\]/)
})

test('does not render arbitrary fields from structured collector failures', () => {
  const result = sanitizeHealthMessage({
    status: 429,
    message: 'Too many requests; access_token=hidden https://graph.microsoft.com/v1.0/auditLogs?sig=signed',
    rawPayload: 'must never be rendered',
  })
  assert.match(result, /HTTP 429/)
  assert.doesNotMatch(result, /hidden|signed|must never be rendered/)
})

test('redacts quoted and encoded secrets in structured failure messages', () => {
  const result = sanitizeHealthMessage('HTTP 429 Correlation ID corr-1 {"client_secret":"JSONSECRET","refresh_token":"REFRESH"} api_key: "two word secret" Refresh_Token%253DENCODEDSECRET Bearer%2520ENCODEDTOKEN')
  assert.match(result, /HTTP 429 Correlation ID corr-1/)
  assert.doesNotMatch(result, /JSONSECRET|\bREFRESH\b|two word secret|ENCODEDSECRET|ENCODEDTOKEN/i)
  assert.match(result, /\[REDACTED\]/)
})

test('fails closed on malformed percent encoding while retaining HTTP status', () => {
  const result = sanitizeHealthMessage('HTTP 400 malformed %ZZ refresh_token=must-not-render')
  assert.equal(result, 'HTTP 400: [REDACTED ENCODED ERROR]')
  assert.doesNotMatch(result, /must-not-render/)
})

test('sanitizes compound free-text and recursive structured credentials while retaining safe error codes', () => {
  const structured = sanitizeHealthMessage(JSON.stringify({
    error: { code: 'RequestDenied', message: 'Microsoft denied this operation.' },
    client_secret: 'alpha beta gamma',
    access_token: ['ARRAYSECRET1', 'ARRAYSECRET2'],
    password: { primary: 'NESTEDSECRET' },
    nested: [{ refresh_token: 'REFRESH VALUE' }],
  }))
  assert.match(structured, /RequestDenied/)
  assert.match(structured, /Microsoft denied this operation/)
  assert.doesNotMatch(structured, /alpha beta gamma|ARRAYSECRET1|ARRAYSECRET2|NESTEDSECRET|REFRESH VALUE/i)

  for (const value of [
    'password=top secret phrase',
    'client_secret: alpha beta gamma',
    'password={"primary":"NESTEDSECRET"}',
    'refresh_token%3DENCODEDSECRET',
    'Bearer%20ENCODEDTOKEN',
    'Bearer%2520DOUBLEENCODEDTOKEN',
    'CLIENT_SECRET: "escaped \\"secret\\" value"',
  ]) {
    const result = sanitizeHealthMessage(value)
    assert.match(result, /\[REDACTED\]/)
    assert.doesNotMatch(result, /top secret phrase|alpha beta gamma|NESTEDSECRET|ENCODEDSECRET|ENCODEDTOKEN|DOUBLEENCODEDTOKEN|escaped|secret value/i)
  }
})

test('projects structured diagnostics through a strict allowlist', () => {
  const probe = JSON.stringify({
    error: { code: 'RequestDenied', message: 'Microsoft rejected the request.' }, correlationId: 'corr-1', tenantId: 'tenant-1',
    arbitrary: 'ARBITRARYSECRET', nested: { debug: 'DEBUGSECRET' }, access_token: ['ARRAYSECRET1', 'ARRAYSECRET2'],
    password: { primary: 'NESTEDSECRET' }, __proto__: { debug: 'PROTOTYPESECRET' }, constructor: 'CONSTRUCTORSECRET',
  })
  for (const value of [probe, `prefix ${probe}`]) {
    const result = sanitizeHealthMessage(value)
    assert.match(result, /RequestDenied|REDACTED STRUCTURED ERROR/)
    assert.match(result, /corr-1|REDACTED STRUCTURED ERROR/)
    assert.doesNotMatch(result, /ARBITRARYSECRET|DEBUGSECRET|ARRAYSECRET1|ARRAYSECRET2|NESTEDSECRET|PROTOTYPESECRET|CONSTRUCTORSECRET/i)
    assert.doesNotMatch(result, /"arbitrary"|"nested"|"access_token"|"password"/i)
  }
  assert.equal(sanitizeHealthMessage('{"untrusted":["NOPE"],"other":{"debug":"NOPE2"}}'), '{"diagnostic":"[REDACTED STRUCTURED ERROR]"}')
})

test('uses case-insensitive strict projection for direct collector error objects', () => {
  const result = sanitizeHealthMessage({
    STATUS: 403, Error: { CODE: 'RequestDenied', MESSAGE: 'Safe Microsoft message' }, CLIENTREQUESTID: 'req-1', Organization_ID: 'org-1',
    URL: 'https://user:pass@graph.microsoft.com/v1.0/auditLogs?sig=SECRET#fragment', PASSWORD: 'NESTEDSECRET',
    arbitrary: ['ARBITRARYSECRET'], nested: { debug: 'DEBUGSECRET' }, constructor: 'CONSTRUCTORSECRET',
  })
  assert.match(result, /HTTP 403.*RequestDenied.*Safe Microsoft message.*req-1.*org-1.*https:\/\/graph\.microsoft\.com\/v1\.0\/auditLogs/i)
  assert.doesNotMatch(result, /user:pass|sig=|fragment|NESTEDSECRET|ARBITRARYSECRET|DEBUGSECRET|CONSTRUCTORSECRET/i)
  assert.equal(sanitizeHealthMessage({ status: ['not primitive'], message: { no: 'object' }, __proto__: { secret: 'NOPE' } }), 'The latest collection failed.')
})

test('normalizes approved direct-object aliases without preserving collisions or unknown values', () => {
  const result = sanitizeHealthMessage({
    STATUS_CODE: 401,
    'REQUEST-ID': 'request-first',
    request_id: 'request-second',
    'ORGANIZATION-ID': 'org-hyphen',
    URI: 'https://graph.microsoft.com/v1.0/users?api_key=SECRET',
    MESSAGE: { unsafe: 'OBJECTSECRET' },
    unknown: { nested: 'UNKNOWNSECRET' },
    __proto__: { poison: 'PROTOTYPESECRET' },
  })
  assert.match(result, /HTTP 401.*request-first.*org-hyphen.*https:\/\/graph\.microsoft\.com\/v1\.0\/users/i)
  assert.doesNotMatch(result, /request-second|SECRET|OBJECTSECRET|UNKNOWNSECRET|PROTOTYPESECRET/i)
})

test('MFA registration coverage produces an actionable organization finding', () => {
  const result = deriveTenantHealth({
    ...baseInput(),
    authSnapshot: {
      payload: [
        { isMfaRegistered: true },
        { isMfaRegistered: false },
        { isMfaRegistered: false },
        { isMfaRegistered: false },
        { isMfaRegistered: false },
      ],
      observedAt: new Date('2026-08-07T12:00:00.000Z'),
    },
  })

  assert.equal(result.mfaCoverage, 20)
  assert.equal(
    result.attention[0]?.label,
    'This organization has 20% MFA registration coverage',
  )
  assert.match(
    result.attention[0]?.why ?? '',
    /does not establish whether MFA is required/,
  )
  assert.equal(result.attention[0]?.actionUrl, '/tenants/tenant-1?entraTab=security&securityView=auth')
})

test('disabled Conditional Access policies create deep-linked audit findings', () => {
  const result = deriveTenantHealth({
    ...baseInput(),
    auditEvents: [{
      microsoftAuditId: 'audit-1',
      eventDateTime: new Date('2026-08-07T12:00:00.000Z'),
      activityDisplayName: 'Disable conditional access policy',
      category: 'Policy',
      operationType: 'Update',
      result: 'success',
      initiatedBy: { user: { userPrincipalName: 'admin@example.com' } },
      targetResources: [{ displayName: 'Require MFA', type: 'conditionalAccessPolicy' }],
    }],
  })

  assert.equal(result.attention[0]?.label, 'Conditional Access policy was disabled or removed')
  assert.match(result.attention[0]?.why ?? '', /admin@example\.com/)
  assert.match(result.attention[0]?.actionUrl ?? '', /^\/what-changed\?tenantId=tenant-1&from=/)
})

test('detects a disabled Conditional Access state inside Microsoft modified properties', () => {
  const result = deriveTenantHealth({
    ...baseInput(),
    auditEvents: [{
      microsoftAuditId: 'audit-ca-state',
      eventDateTime: new Date('2026-08-07T12:00:00.000Z'),
      activityDisplayName: 'Update conditional access policy',
      category: 'Policy',
      operationType: 'Update',
      result: 'success',
      initiatedBy: null,
      targetResources: [{
        displayName: 'Require MFA',
        type: 'conditionalAccessPolicy',
        modifiedProperties: [{ displayName: 'State', newValue: 'disabled' }],
      }],
    }],
  })

  assert.equal(result.attention[0]?.label, 'Conditional Access policy was disabled or removed')
  assert.equal(result.attention[0]?.severity, 'critical')
})

test('removed authentication methods identify the affected user', () => {
  const result = deriveTenantHealth({
    ...baseInput(),
    auditEvents: [{
      microsoftAuditId: 'audit-2',
      eventDateTime: new Date('2026-08-07T12:00:00.000Z'),
      activityDisplayName: 'Delete authentication method',
      category: 'UserManagement',
      operationType: 'Delete',
      result: 'success',
      initiatedBy: { user: { userPrincipalName: 'admin@example.com' } },
      targetResources: [{ displayName: 'Alex User', type: 'authenticationMethod' }],
    }],
  })

  assert.equal(result.attention[0]?.label, 'MFA or authentication method was removed for Alex User')
  assert.equal(result.attention[0]?.severity, 'critical')
})

test('does not turn Microsoft JIT service-principal provisioning into a customer security alert', () => {
  const result = deriveTenantHealth({
    ...baseInput(),
    auditEvents: [{
      microsoftAuditId: 'audit-jit', eventDateTime: new Date('2026-08-07T12:00:00.000Z'),
      activityDisplayName: 'Update service principal', category: 'ApplicationManagement', operationType: 'Update', result: 'success',
      initiatedBy: { app: { displayName: 'Microsoft Azure AD Internal - Jit Provisioning' } },
      targetResources: [{ displayName: 'Workload Identity Control Plane' }],
    }],
  })
  assert.deepEqual(result.attention, [])
})

test('does not promote directory reads or collector telemetry into tenant health findings', () => {
  const now = new Date('2026-08-07T12:00:00.000Z')
  const result = deriveTenantHealth({
    ...baseInput(), now,
    auditEvents: [
      { microsoftAuditId: 'read', eventDateTime: now, activityDisplayName: 'Applications_Get', category: 'Applications', operationType: 'Update', result: 'success', initiatedBy: null, targetResources: [] },
      { microsoftAuditId: 'sync', eventDateTime: now, activityDisplayName: 'InventorySyncCompleted', category: 'Groups', operationType: 'Update', result: 'success', initiatedBy: null, targetResources: [] },
    ],
  })
  assert.equal(result.attention.some((item) => item.key.startsWith('audit-')), false)
})

test('retains a named-administrator application change as an actionable alert', () => {
  const result = deriveTenantHealth({
    ...baseInput(),
    auditEvents: [{
      microsoftAuditId: 'audit-app', eventDateTime: new Date('2026-08-07T12:00:00.000Z'),
      activityDisplayName: 'Update application', category: 'ApplicationManagement', operationType: 'Update', result: 'success',
      initiatedBy: { user: { userPrincipalName: 'admin@example.test' } }, targetResources: [{ displayName: 'Customer Integration', type: 'application' }],
    }],
  })
  assert.equal(result.attention[0]?.label, 'Application access changed')
  assert.match(result.attention[0]?.why ?? '', /admin@example\.test/)
})

test('healthy current state has no action queue findings', () => {
  assert.deepEqual(deriveTenantHealth(baseInput()).attention, [])
})

function completeCurrentStates(now = new Date('2026-08-13T12:00:00.000Z')) {
  return TENANT_HEALTH_RESOURCE_REGISTRY.map((resource) => ({
    resourceType: resource.resourceType,
    status: 'SUCCEEDED',
    lastAttemptAt: now,
    lastSuccessfulAt: now,
    lastErrorCode: null,
    lastErrorMessage: null,
    consecutiveFailures: 0,
  }))
}

test('healthy connection, complete current data, and no findings is healthy', () => {
  const now = new Date('2026-08-13T12:00:00.000Z')
  const result = deriveTenantHealth({ ...baseInput(), syncStates: completeCurrentStates(now), now })
  assert.equal(result.connection.status, 'HEALTHY')
  assert.equal(result.data.status, 'COMPLETE')
  assert.equal(result.overallStatus, 'HEALTHY')
})

test('security recommendations produce attention without changing the connection state', () => {
  const now = new Date('2026-08-13T12:00:00.000Z')
  const result = deriveTenantHealth({
    ...baseInput(), now, syncStates: completeCurrentStates(now),
    authSnapshot: { payload: [{ isMfaRegistered: false }, { isMfaRegistered: true }], observedAt: now },
  })
  assert.equal(result.connection.status, 'HEALTHY')
  assert.equal(result.security.status, 'NEEDS_REVIEW')
  assert.equal(result.overallStatus, 'ATTENTION')
})

test('optional incomplete collection is attention rather than a connection failure', () => {
  const now = new Date('2026-08-13T12:00:00.000Z')
  const states = completeCurrentStates(now).filter((state) => state.resourceType !== 'SIGN_INS')
  const result = deriveTenantHealth({ ...baseInput(), now, syncStates: states })
  assert.equal(result.connection.status, 'HEALTHY')
  assert.equal(result.data.status, 'PARTIAL')
  assert.equal(result.overallStatus, 'ATTENTION')
})

test('an optional failed collector is exposed as an operational attention item', () => {
  const now = new Date('2026-08-13T12:00:00.000Z')
  const states = completeCurrentStates(now).map((state) => state.resourceType === 'SIGN_INS'
    ? {
        ...state,
        status: 'FAILED',
        lastErrorCode: '500',
        lastErrorMessage: 'Microsoft sign-in collection returned 500.',
        consecutiveFailures: 1,
      }
    : state)
  const result = deriveTenantHealth({ ...baseInput(), now, syncStates: states })
  assert.equal(result.overallStatus, 'DEGRADED')
  assert.equal(result.operations.activeIssues, 1)
  assert.equal(result.attention.some((item) => item.key === 'sync-sign_ins'), true)
  assert.match(result.attention.find((item) => item.key === 'sync-sign_ins')?.label ?? '', /Sign-ins data/)
})

test('temporary Microsoft failures stay in automatic-retry state before becoming actionable', () => {
  const now = new Date('2026-08-13T12:00:00.000Z')
  const transient = (failures: number) => completeCurrentStates(now).map((state) =>
    state.resourceType === 'CONDITIONAL_ACCESS'
      ? {
          ...state,
          status: 'FAILED',
          lastErrorCode: 'MICROSOFT_TRANSIENT',
          lastErrorMessage: 'Microsoft temporarily could not provide conditional access data. HawkView retained the last successful data. HawkView will retry automatically.',
          consecutiveFailures: failures,
        }
      : state,
  )

  const first = deriveTenantHealth({ ...baseInput(), now, syncStates: transient(1) })
  assert.equal(first.resourceHealth.find((item) => item.resourceType === 'CONDITIONAL_ACCESS')?.classification, 'PENDING')
  assert.equal(first.attention.some((item) => item.key === 'sync-conditional_access'), false)
  assert.equal(first.operations.failedJobs, 0)

  const persistent = deriveTenantHealth({ ...baseInput(), now, syncStates: transient(3) })
  const issue = persistent.attention.find((item) => item.key === 'sync-conditional_access')
  assert.equal(issue?.severity, 'medium')
  assert.equal(issue?.actionLabel, 'View synchronization')
  assert.match(issue?.label ?? '', /refresh is delayed/i)
  assert.doesNotMatch(issue?.label ?? '', /review policies|permission/i)
})

test('a retired historical Exchange Admin API failure no longer degrades tenant health', () => {
  const now = new Date('2026-08-13T12:00:00.000Z')
  const states = [
    ...completeCurrentStates(now),
    {
      resourceType: 'EXCHANGE_MAILBOX_CONFIGURATION',
      status: 'FAILED',
      lastAttemptAt: now,
      lastSuccessfulAt: null,
      lastErrorCode: '403',
      lastErrorMessage: 'Exchange RBAC assignment is unavailable.',
      consecutiveFailures: 4,
    },
  ]
  const result = deriveTenantHealth({ ...baseInput(), now, syncStates: states })
  assert.equal(result.operations.issues.some((issue) => issue.resourceType === 'EXCHANGE_MAILBOX_CONFIGURATION'), false)
})

test('a failed required SharePoint inventory cannot leave tenant health healthy', () => {
  const now = new Date('2026-08-13T12:00:00.000Z')
  const states = completeCurrentStates(now).map((state) => state.resourceType === 'SHAREPOINT_SITES'
    ? { ...state, status: 'FAILED', lastErrorCode: '401', lastErrorMessage: 'SharePoint site users returned 401.' }
    : state)
  const result = deriveTenantHealth({ ...baseInput(), now, syncStates: states })
  assert.equal(result.overallStatus, 'DEGRADED')
  assert.equal(result.legacyHealthStatus, 'attention')
  assert.equal(result.healthScore < 100, true)
})

test('required stale and failed collectors degrade tenant health', () => {
  const now = new Date('2026-08-13T12:00:00.000Z')
  const stale = completeCurrentStates(now).map((state) => state.resourceType === 'USERS' ? { ...state, lastSuccessfulAt: new Date('2026-08-13T08:00:00.000Z') } : state)
  assert.equal(deriveTenantHealth({ ...baseInput(), now, syncStates: stale }).overallStatus, 'DEGRADED')
  const failed = completeCurrentStates(now).map((state) => state.resourceType === 'USERS' ? { ...state, status: 'FAILED', lastErrorCode: '500', lastErrorMessage: 'upstream unavailable' } : state)
  assert.equal(deriveTenantHealth({ ...baseInput(), now, syncStates: failed }).overallStatus, 'DEGRADED')
})

test('daily inventory collectors remain healthy between daily full collections', () => {
  const collectedAt = new Date('2026-08-13T00:00:00.000Z')
  const now = new Date('2026-08-13T23:00:00.000Z')
  const states = completeCurrentStates(collectedAt).map((state) =>
    ['USERS', 'SIGN_INS', 'AUDIT_LOGS', 'M365_AUDIT'].includes(state.resourceType)
      ? { ...state, lastAttemptAt: now, lastSuccessfulAt: now }
      : state,
  )
  const result = deriveTenantHealth({ ...baseInput(), now, syncStates: states })

  assert.equal(result.resourceHealth.find((item) => item.resourceType === 'LICENSES')?.classification, 'SUCCESS')
  assert.equal(result.resourceHealth.find((item) => item.resourceType === 'DOMAINS')?.classification, 'SUCCESS')
  assert.notEqual(result.data.freshnessStatus, 'STALE')
})

test('daily inventory collectors become stale only after the daily grace window', () => {
  const collectedAt = new Date('2026-08-13T00:00:00.000Z')
  const now = new Date('2026-08-14T03:00:00.000Z')
  const states = completeCurrentStates(collectedAt).map((state) =>
    ['USERS', 'SIGN_INS', 'AUDIT_LOGS', 'M365_AUDIT'].includes(state.resourceType)
      ? { ...state, lastAttemptAt: now, lastSuccessfulAt: now }
      : state,
  )
  const result = deriveTenantHealth({ ...baseInput(), now, syncStates: states })

  assert.equal(result.resourceHealth.find((item) => item.resourceType === 'LICENSES')?.classification, 'STALE')
  assert.equal(result.resourceHealth.find((item) => item.resourceType === 'DOMAINS')?.classification, 'STALE')
})

test('revoked access and critical security findings take precedence', () => {
  const now = new Date('2026-08-13T12:00:00.000Z')
  assert.equal(deriveTenantHealth({ ...baseInput(), connectionStatus: 'REVOKED', now }).overallStatus, 'DISCONNECTED')
  const critical = deriveTenantHealth({ ...baseInput(), now, syncStates: completeCurrentStates(now), auditEvents: [{ microsoftAuditId: 'critical', eventDateTime: now, activityDisplayName: 'Disable conditional access policy', category: 'Policy', operationType: 'Update', result: 'success', initiatedBy: null, targetResources: [{ type: 'conditionalAccessPolicy', displayName: 'Require MFA' }] }] })
  assert.equal(critical.security.status, 'CRITICAL')
  assert.equal(critical.overallStatus, 'CRITICAL')
})

test('initial collection is pending and failed newer state overrides older success', () => {
  const now = new Date('2026-08-13T12:00:00.000Z')
  assert.equal(deriveTenantHealth({ ...baseInput(), effectiveStatus: 'pending', connectionStatus: 'PENDING_CONSENT', now }).overallStatus, 'PENDING')
  const pendingWithCriticalFinding = deriveTenantHealth({ ...baseInput(), effectiveStatus: 'pending', connectionStatus: 'PENDING_CONSENT', now, auditEvents: [{ microsoftAuditId: 'pending-critical', eventDateTime: now, activityDisplayName: 'Disable conditional access policy', category: 'Policy', operationType: 'Update', result: 'success', initiatedBy: null, targetResources: [{ type: 'conditionalAccessPolicy', displayName: 'Require MFA' }] }] })
  assert.equal(pendingWithCriticalFinding.overallStatus, 'CRITICAL')
  const states = completeCurrentStates(now).map((state) => state.resourceType === 'USERS' ? { ...state, status: 'FAILED', lastAttemptAt: now, lastSuccessfulAt: new Date('2026-08-13T11:59:00.000Z'), lastErrorMessage: 'latest attempt failed' } : state)
  const result = deriveTenantHealth({ ...baseInput(), now, syncStates: states })
  assert.equal(result.resourceHealth.find((item) => item.resourceType === 'USERS')?.classification, 'FAILED')
  assert.equal(result.overallStatus, 'DEGRADED')
})

test('missing security collectors are unknown and empty is not failed', () => {
  const now = new Date('2026-08-13T12:00:00.000Z')
  const incomplete = completeCurrentStates(now).filter((state) => state.resourceType !== 'AUDIT_LOGS')
  const result = deriveTenantHealth({ ...baseInput(), now, syncStates: incomplete })
  assert.equal(result.security.status, 'UNKNOWN')
  assert.notEqual(result.overallStatus, 'HEALTHY')
  const empty = deriveTenantHealth({ ...baseInput(), now, syncStates: completeCurrentStates(now) })
  assert.equal(empty.resourceHealth.find((item) => item.resourceType === 'USERS')?.classification, 'SUCCESS')
})
