import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveTenantHealth,
  TENANT_HEALTH_RESOURCE_REGISTRY,
  type TenantAuditEvent,
} from './tenant-health'

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

test('MFA coverage produces an actionable organization finding', () => {
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
  assert.equal(result.attention[0]?.label, 'This organization has 20% MFA coverage')
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
      targetResources: [{ displayName: 'Require MFA' }],
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
      targetResources: [{ displayName: 'Alex User' }],
    }],
  })

  assert.equal(result.attention[0]?.label, 'MFA or authentication method was removed for Alex User')
  assert.equal(result.attention[0]?.severity, 'critical')
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

test('a legacy optional Exchange Admin API failure does not degrade Graph-based Exchange health', () => {
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
  assert.equal(result.operations.status, 'HEALTHY')
  assert.equal(result.operations.failedJobs, 0)
  assert.equal(result.operations.issues.some((issue) => issue.resourceType === 'EXCHANGE_MAILBOX_CONFIGURATION'), false)
})

test('required stale and failed collectors degrade tenant health', () => {
  const now = new Date('2026-08-13T12:00:00.000Z')
  const stale = completeCurrentStates(now).map((state) => state.resourceType === 'USERS' ? { ...state, lastSuccessfulAt: new Date('2026-08-13T08:00:00.000Z') } : state)
  assert.equal(deriveTenantHealth({ ...baseInput(), now, syncStates: stale }).overallStatus, 'DEGRADED')
  const failed = completeCurrentStates(now).map((state) => state.resourceType === 'USERS' ? { ...state, status: 'FAILED', lastErrorCode: '500', lastErrorMessage: 'upstream unavailable' } : state)
  assert.equal(deriveTenantHealth({ ...baseInput(), now, syncStates: failed }).overallStatus, 'DEGRADED')
})

test('revoked access and critical security findings take precedence', () => {
  const now = new Date('2026-08-13T12:00:00.000Z')
  assert.equal(deriveTenantHealth({ ...baseInput(), connectionStatus: 'REVOKED', now }).overallStatus, 'DISCONNECTED')
  const critical = deriveTenantHealth({ ...baseInput(), now, syncStates: completeCurrentStates(now), auditEvents: [{ microsoftAuditId: 'critical', eventDateTime: now, activityDisplayName: 'Disable conditional access policy', category: 'Policy', operationType: 'Update', result: 'success', initiatedBy: null, targetResources: [] }] })
  assert.equal(critical.security.status, 'CRITICAL')
  assert.equal(critical.overallStatus, 'CRITICAL')
})

test('initial collection is pending and failed newer state overrides older success', () => {
  const now = new Date('2026-08-13T12:00:00.000Z')
  assert.equal(deriveTenantHealth({ ...baseInput(), effectiveStatus: 'pending', connectionStatus: 'PENDING_CONSENT', now }).overallStatus, 'PENDING')
  const pendingWithCriticalFinding = deriveTenantHealth({ ...baseInput(), effectiveStatus: 'pending', connectionStatus: 'PENDING_CONSENT', now, auditEvents: [{ microsoftAuditId: 'pending-critical', eventDateTime: now, activityDisplayName: 'Disable conditional access policy', category: 'Policy', operationType: 'Update', result: 'success', initiatedBy: null, targetResources: [] }] })
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
