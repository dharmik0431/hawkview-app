import assert from 'node:assert/strict'
import test from 'node:test'
import { ChangeEvidenceService, redactSensitiveValues } from './change-evidence.service.js'
import { classifyEvidence, isPrimaryChange } from './change-classification.js'
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
    directoryAuditLog: { findMany: async () => [], findFirst: async () => null },
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

test('classifies evidence and keeps authentication telemetry out of the primary timeline', () => {
  assert.equal(classifyEvidence({ source: 'SIGN_IN', activity: 'Successful sign-in' }), 'authentication_evidence')
  assert.equal(classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Update conditional access policy' }), 'security_control_change')
  assert.equal(classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Add app role assignment' }), 'permission_change')
  assert.equal(classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Add member to group' }), 'identity_change')
  assert.equal(classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Update license assignment' }), 'configuration_change')
  assert.equal(classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Reset user password' }), 'administrative_action')
  assert.equal(isPrimaryChange({ source: 'SIGN_IN', activity: 'Successful sign-in' }), false)
})

test('uses structured audit metadata without hiding real policy or synchronization changes', () => {
  assert.equal(
    classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Update sign-in frequency policy', category: 'Policy', operationType: 'Update', targetResourceTypes: ['conditionalAccessPolicy'] }),
    'security_control_change',
  )
  assert.equal(
    classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Update directory synchronization configuration', category: 'DirectoryManagement', operationType: 'Update', targetResourceTypes: ['synchronizationJob'] }),
    'configuration_change',
  )
  assert.equal(
    classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Get directory synchronization configuration', category: 'DirectoryManagement', operationType: 'Read', targetResourceTypes: ['synchronizationJob'] }),
    'system_or_collection_event',
  )
  assert.equal(
    isPrimaryChange({ source: 'DIRECTORY_AUDIT', activity: 'Report sign-in policy status', category: 'Reports', operationType: 'Report' }),
    false,
  )
  assert.equal(isPrimaryChange({ source: 'DIRECTORY_AUDIT', activity: 'Unmapped Microsoft operation', category: 'Unknown' }), false)
})

test('returns a stable paginated change-only timeline from normalized evidence', async () => {
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
  assert.deepEqual(result.pagination, { page: 1, pageSize: 1, total: 1, totalPages: 1 })
  assert.equal(result.summary.total, 1)
  assert.equal(result.summary.changes, 1)
  assert.equal(result.summary.signIns, 0)
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

test('uses an exact Microsoft correlation ID for supporting sign-ins and never infers causation from timing alone', async () => {
  const event = {
    id: 'audit-row', source: 'DIRECTORY_AUDIT', sourceEventId: 'audit-correlation', eventDateTime: new Date('2026-08-01T12:00:00.000Z'), customerTenantId: 'tenant-1', organizationId: 'org-1', category: 'Groups', severity: 'Medium', operationName: 'Add member to group', summary: 'Success', actorId: 'actor-1', actorPrincipalName: 'owner@example.test', actorDisplayName: null, targetDisplayName: 'Example group', correlationId: 'corr-1', changedFields: [], workload: 'Microsoft Entra ID', result: 'success', location: null, beforeState: null, afterState: null,
  }
  const matchingSignIn = {
    microsoftSignInId: 'sign-in-matching', eventDateTime: new Date('2026-08-01T12:01:00.000Z'), raw: { correlationId: 'corr-1' }, userPrincipalName: 'owner@example.test', userDisplayName: null, resourceDisplayName: 'Microsoft 365', appDisplayName: null, statusErrorCode: '0', ipAddress: '203.0.113.10',
  }
  const moreThanOneHundredNearbyButUnrelated = Array.from({ length: 101 }, (_, index) => ({
    ...matchingSignIn,
    microsoftSignInId: `sign-in-other-${index}`,
    raw: { correlationId: `corr-${index + 2}` },
  }))
  let signInQuery: any
  let relatedQuery: any
  const service = new ChangesService(changesPrisma({
    changeEvidenceEvent: { findFirst: async () => event, findMany: async (args: unknown) => { relatedQuery = args; return [event] } },
    // The database-side exact JSON predicate excludes the 101 nearby rows;
    // returning only the matching row simulates that query result.
    signInLog: { findMany: async (args: unknown) => { signInQuery = args; void moreThanOneHundredNearbyButUnrelated; return [matchingSignIn] } },
  }) as never)
  const result = await service.detail(identity, 'audit:audit-correlation')
  assert.equal(result.relatedSignIns.length, 1)
  assert.equal(result.relatedSignIns[0]?.id, 'sign-in-matching')
  assert.match(String(result.relatedSignIns[0]?.relationship), /does not establish causation/)
  assert.equal(result.relatedSignIns[0]?.provenance, 'Microsoft Graph auditLogs/signIns')
  assert.deepEqual(signInQuery.where.organizationId, { in: ['org-1'] })
  assert.deepEqual(signInQuery.where.OR, [
    { raw: { path: ['correlationId'], equals: 'corr-1' } },
    { raw: { path: ['correlation_id'], equals: 'corr-1' } },
  ])
  assert.equal('take' in signInQuery, false)
  assert.deepEqual(relatedQuery.where.organizationId, { in: ['org-1'] })
})

test('does not attach nearby sign-ins when Microsoft did not provide a correlation ID', async () => {
  const event = {
    id: 'audit-row', source: 'DIRECTORY_AUDIT', sourceEventId: 'audit-no-correlation', eventDateTime: new Date('2026-08-01T12:00:00.000Z'), customerTenantId: 'tenant-1', organizationId: 'org-1', category: 'Groups', severity: 'Medium', operationName: 'Add member to group', summary: 'Success', actorId: 'actor-1', actorPrincipalName: 'owner@example.test', actorDisplayName: null, targetDisplayName: 'Example group', correlationId: null, changedFields: [], workload: 'Microsoft Entra ID', result: 'success', location: null, beforeState: null, afterState: null,
  }
  let signInQueryCount = 0
  const service = new ChangesService(changesPrisma({
    changeEvidenceEvent: { findFirst: async () => event, findMany: async () => [] },
    signInLog: { findMany: async () => { signInQueryCount += 1; return [] } },
  }) as never)
  const result = await service.detail(identity, 'audit:audit-no-correlation')
  assert.deepEqual(result.relatedSignIns, [])
  assert.equal(signInQueryCount, 0)
})

test('does not expose a standalone sign-in through the change detail endpoint', async () => {
  const service = new ChangesService(changesPrisma() as never)
  await assert.rejects(
    () => service.detail(identity, 'signin:sign-in-1'),
    /Sign-ins are available only as correlated supporting evidence/
  )
})

test('returns a redacted raw directory-audit detail when its projection is unavailable', async () => {
  const sourceAudit = {
    id: 'raw-detail-1', microsoftAuditId: 'audit-raw-detail-1', organizationId: 'org-1', customerTenantId: 'tenant-1',
    activityDisplayName: 'Reset user password', category: 'UserManagement', operationType: 'Update', result: 'success', resultReason: null,
    eventDateTime: new Date('2026-08-01T12:00:00.000Z'), initiatedBy: { user: { userPrincipalName: 'owner@example.test' } },
    targetResources: [{ id: 'target-1', userPrincipalName: 'user@example.test', type: 'User', modifiedProperties: [{ displayName: 'passwordProfile', oldValue: 'old', newValue: 'new' }] }],
    additionalDetails: [], raw: { clientSecret: 'must-not-leak' }, correlationId: null,
  }
  let fallbackQuery: any
  const service = new ChangesService(changesPrisma({
    changeEvidenceEvent: { findFirst: async () => null, findMany: async () => [] },
    directoryAuditLog: { findMany: async () => [], findFirst: async (args: unknown) => { fallbackQuery = args; return sourceAudit } },
  }) as never)
  const result = await service.detail(identity, 'audit:audit-raw-detail-1')
  assert.equal(result.event.sourceEventId, 'audit-raw-detail-1')
  assert.equal(result.event.actorPrincipalName, 'owner@example.test')
  assert.equal((result.event.raw as Record<string, unknown>).clientSecret, '[REDACTED]')
  assert.deepEqual(fallbackQuery.where.organizationId, { in: ['org-1'] })
})

test('does not silently truncate a timeline with more than 5,000 records', async () => {
  const records = Array.from({ length: 5001 }, (_, index) => ({
    id: `evidence-${index}`,
    source: 'DIRECTORY_AUDIT', sourceEventId: `audit-${index}`,
    eventDateTime: new Date(1_754_000_000_000 - index), customerTenantId: 'tenant-1', category: 'Users', severity: 'Low',
    operationName: 'Update user', summary: 'Updated user', actorPrincipalName: null, actorDisplayName: null, targetDisplayName: null,
    ipAddress: null, location: null, beforeState: null, afterState: null, correlationId: null, changedFields: [], workload: 'Microsoft Entra ID', result: 'success',
  }))
  const queries: any[] = []
  const service = new ChangesService(changesPrisma({
    changeEvidenceEvent: {
      findMany: async (args: any) => {
        queries.push(args)
        const start = args.cursor ? records.findIndex((record) => record.id === args.cursor.id) + 1 : 0
        return records.slice(start, start + args.take)
      },
    },
  }) as never)
  const result = await service.list(identity, { ...range, page: '3', pageSize: '250' })
  assert.equal(result.pagination?.total, 5001)
  assert.equal(result.changes.length, 250)
  assert.equal(queries.length, 6)
  assert.equal(queries.every((query) => query.take === 1000), true)
})

test('projects directory evidence with deduplication and redacted configuration values', async () => {
  let createManyArgs: any
  const service = new ChangeEvidenceService({
    changeEvidenceEvent: { createMany: async (args: unknown) => { createManyArgs = args } },
  } as never)
  await service.projectDirectoryAudits(
    { id: 'tenant-1', organizationId: 'org-1' },
    [{ microsoftAuditId: 'audit-1', eventDateTime: new Date('2026-08-01T12:00:00.000Z'), activityDisplayName: 'Update application credential', category: 'ApplicationManagement', targetResources: [{ id: 'app-1', displayName: 'Example app', modifiedProperties: [{ displayName: 'clientSecret', oldValue: 'old-secret', newValue: 'new-secret' }] }], initiatedBy: {}, raw: { clientSecret: 'new-secret' }, ingestedAt: new Date('2026-08-01T12:00:01.000Z'), expiresAt: new Date('2027-02-01T12:00:00.000Z') }]
  )
  assert.equal(createManyArgs.skipDuplicates, true)
  assert.equal(createManyArgs.data[0].raw.clientSecret, '[REDACTED]')
  assert.equal(createManyArgs.data[0].afterState.clientSecret, '[REDACTED]')
})
