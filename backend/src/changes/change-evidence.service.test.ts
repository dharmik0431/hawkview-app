import assert from 'node:assert/strict'
import test from 'node:test'
import { redactSensitiveValues } from './change-evidence.service.js'
import { ChangesService } from './changes.service.js'

test('redacts secrets recursively while preserving investigation evidence', () => {
  const source = {
    displayName: 'Changed authentication method',
    clientSecret: 'do-not-store',
    nested: { password: 'never-store', harmless: 'keep-me' },
    values: [{ authorization: 'Bearer token' }, { id: 'resource-id' }],
  }
  assert.deepEqual(redactSensitiveValues(source), {
    displayName: 'Changed authentication method',
    clientSecret: '[REDACTED]',
    nested: { password: '[REDACTED]', harmless: 'keep-me' },
    values: [{ authorization: '[REDACTED]' }, { id: 'resource-id' }],
  })
})

test('handles null and non-object source values without throwing', () => {
  assert.equal(redactSensitiveValues(null), null)
  assert.equal(redactSensitiveValues('audit value'), 'audit value')
  assert.deepEqual(redactSensitiveValues(['visible', { token: 'hidden' }]), [
    'visible',
    { token: '[REDACTED]' },
  ])
})

function changesPrisma(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      findUnique: async () => ({
        disabledAt: null,
        memberships: [{ organizationId: 'org-1' }],
      }),
    },
    customerTenant: {
      findMany: async () => [
        { id: 'tenant-1', displayName: 'Example MSP tenant', primaryDomain: 'example.test' },
      ],
    },
    directoryAuditLog: { findMany: async () => [] },
    signInLog: { findMany: async () => [] },
    changeEvidenceEvent: { findMany: async () => [] },
    ...overrides,
  }
}

const identity = { subject: 'user-1', email: 'owner@example.test' }
const range = {
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-08-02T00:00:00.000Z',
}

test('returns a stable paginated timeline from normalized evidence', async () => {
  const events = [
    {
      id: '2', source: 'DIRECTORY_AUDIT', sourceEventId: 'audit-2', eventDateTime: new Date('2026-08-01T12:00:00.000Z'), customerTenantId: 'tenant-1', category: 'Apps', severity: 'High', operationName: 'Update application', summary: 'Updated', actorPrincipalName: 'owner@example.test', actorDisplayName: null, targetDisplayName: 'App', ipAddress: null, location: null, beforeState: null, afterState: null, correlationId: null, changedFields: [], workload: 'Microsoft Entra ID', result: 'success',
    },
    {
      id: '1', source: 'SIGN_IN', sourceEventId: 'sign-in-1', eventDateTime: new Date('2026-08-01T11:00:00.000Z'), customerTenantId: 'tenant-1', category: 'Sign-ins', severity: 'Low', operationName: 'Successful sign-in', summary: 'Success', actorPrincipalName: 'owner@example.test', actorDisplayName: null, targetDisplayName: 'Microsoft 365', ipAddress: '203.0.113.9', location: null, beforeState: null, afterState: null, correlationId: null, changedFields: [], workload: 'Microsoft Entra ID', result: 'Success',
    },
  ]
  const service = new ChangesService(changesPrisma({
    changeEvidenceEvent: { findMany: async () => events },
  }) as never)
  const result = await service.list(identity, { ...range, page: '1', pageSize: '1' })
  assert.equal(result.changes.length, 1)
  assert.equal(result.changes[0]?.id, 'audit:audit-2')
  assert.deepEqual(result.pagination, { page: 1, pageSize: 1, total: 2, totalPages: 2 })
  assert.equal(result.summary.total, 2)
  assert.equal(result.summary.changes, 1)
  assert.equal(result.summary.signIns, 1)
})

test('keeps source timeline available when normalized evidence is malformed or unavailable', async () => {
  const sourceAudit = {
    id: 'raw-1', microsoftAuditId: 'audit-raw-1', activityDisplayName: 'Reset user password', category: 'UserManagement', eventDateTime: new Date('2026-08-01T12:00:00.000Z'), customerTenantId: 'tenant-1', operationType: null, result: 'success', resultReason: null, initiatedBy: null, targetResources: null, additionalDetails: null, raw: {}, correlationId: null,
  }
  const service = new ChangesService(changesPrisma({
    directoryAuditLog: { findMany: async () => [sourceAudit] },
    changeEvidenceEvent: { findMany: async () => { throw new Error('projection table unavailable') } },
  }) as never)
  const result = await service.list(identity, range)
  assert.equal(result.changes.length, 1)
  assert.equal(result.changes[0]?.title, 'Reset user password')
  assert.equal(result.summary.changes, 1)
})

test('uses one normalized event when source and evidence represent the same Microsoft event', async () => {
  const sourceAudit = {
    id: 'raw-1', microsoftAuditId: 'audit-raw-1', activityDisplayName: 'Reset user password', category: 'UserManagement', eventDateTime: new Date('2026-08-01T12:00:00.000Z'), customerTenantId: 'tenant-1', operationType: null, result: 'success', resultReason: null, initiatedBy: null, targetResources: null, additionalDetails: null, raw: {}, correlationId: null,
  }
  const evidence = {
    id: 'evidence-1', source: 'DIRECTORY_AUDIT', sourceEventId: 'audit-raw-1', eventDateTime: sourceAudit.eventDateTime, customerTenantId: 'tenant-1', category: 'Passwords', severity: 'High', operationName: 'Reset user password', summary: 'A password was reset', actorPrincipalName: 'owner@example.test', actorDisplayName: null, targetDisplayName: 'user@example.test', ipAddress: null, location: null, beforeState: null, afterState: null, correlationId: null, changedFields: ['passwordProfile'], workload: 'Microsoft Entra ID', result: 'success',
  }
  const service = new ChangesService(changesPrisma({
    directoryAuditLog: { findMany: async () => [sourceAudit] },
    changeEvidenceEvent: { findMany: async () => [evidence] },
  }) as never)
  const result = await service.list(identity, range)
  assert.equal(result.changes.length, 1)
  assert.equal(result.changes[0]?.id, 'audit:audit-raw-1')
  assert.equal(result.changes[0]?.category, 'Passwords')
})
