import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveTenantHealth, type TenantAuditEvent } from './tenant-health'

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
