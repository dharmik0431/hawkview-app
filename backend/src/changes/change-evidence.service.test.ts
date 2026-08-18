import assert from 'node:assert/strict'
import test from 'node:test'
import { ChangeEvidenceService, redactSensitiveValues } from './change-evidence.service.js'
import { classifyEvidence, isPrimaryChange } from './change-classification.js'
import { ChangesService } from './changes.service.js'
import {
  MICROSOFT_ADMIN_CHANGE_CATALOG,
  SNAPSHOT_DIFFERENCE_SPECS,
  UNIFIED_AUDIT_LOG_GAP_REPORT,
  DOMAIN_DETAIL_COVERAGE_GAP,
  describeExchangeOrganizationCustomization,
  describeUnifiedAuditIngestion,
} from './microsoft-admin-change-catalog.js'
import {
  assertGroupRelationshipRefreshComplete,
  authoritativeSnapshot,
  collectMailboxDirectoryPages,
  collectMailboxRuleUsers,
  collectMailboxRules,
  partialSnapshot,
  sharePointSitesSnapshotResult,
  shouldRunFastMailboxRuleRefresh,
  TenantSyncService,
} from '../tenants/tenant-sync.service.js'

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
    m365AuditRecord: { findMany: async () => [] },
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
  assert.equal(classifyEvidence({ source: 'SNAPSHOT_DIFFERENCE', activity: 'Microsoft 365 organization identity changed', category: 'Organization' }), 'configuration_change')
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

test('exposes M365 workload evidence with a source-specific stable identifier', async () => {
  const event = {
    id: 'm365-evidence-1', source: 'M365_UNIFIED_AUDIT', sourceEventId: 'exchange-record-1', eventDateTime: new Date('2026-08-01T13:00:00.000Z'), customerTenantId: 'tenant-1', category: 'Exchange', severity: 'High', operationName: 'Set-Mailbox', summary: 'Exchange reported Set-Mailbox.', actorPrincipalName: 'admin@example.test', actorDisplayName: null, targetDisplayName: 'mailbox@example.test', ipAddress: null, location: null, beforeState: null, afterState: { ForwardingAddress: 'review@example.test' }, correlationId: 'corr-m365', changedFields: ['ForwardingAddress'], workload: 'Exchange', result: 'Succeeded',
  }
  const service = new ChangesService(changesPrisma({
    changeEvidenceEvent: { findMany: async () => [event] },
  }) as never)
  const result = await service.list(identity, range)
  assert.equal(result.changes.length, 1)
  assert.equal(result.changes[0]?.id, 'evidence:M365_UNIFIED_AUDIT:exchange-record-1')
  assert.equal(result.changes[0]?.source, 'Exchange')
  assert.equal(result.changes[0]?.classification, 'configuration_change')
  assert.equal((result.changes[0]?.evidence as { provenance?: string }).provenance, 'Microsoft 365 Unified Audit')
})

test('presents Exchange mailbox-rule snapshot evidence consistently in list and detail', async () => {
  const event = {
    id: 'snapshot-rule-1', source: 'SNAPSHOT_DIFFERENCE', sourceEventId: 'exchange-rule:mailbox@example.test:rule-1',
    eventDateTime: new Date('2026-08-01T13:00:00.000Z'), customerTenantId: 'tenant-1', organizationId: 'org-1',
    category: 'Exchange', severity: 'High', operationName: 'Exchange inbox rule changed', summary: 'A mailbox rule changed.',
    actorId: null, actorPrincipalName: null, actorDisplayName: null, targetId: 'mailbox@example.test', targetDisplayName: 'mailbox@example.test',
    ipAddress: null, location: null, beforeState: { forwardTo: [] }, afterState: { forwardTo: ['external@example.test'] },
    correlationId: null, changedFields: ['forwardTo'], workload: 'Exchange Online', result: 'Detected',
    targetType: 'EXCHANGE_MAILBOX_RULES',
    raw: { evidenceOrigin: 'hawkview_snapshot_difference', microsoftSource: 'Microsoft Graph /users/{id}/mailFolders/inbox/messageRules', impact: { guidance: 'attacker-supplied impact' } },
  }
  const service = new ChangesService(changesPrisma({
    changeEvidenceEvent: { findMany: async () => [event], findFirst: async () => event },
  }) as never)
  const list = await service.list(identity, range)
  const row = list.changes[0] as { source?: string; evidence?: { provenance?: string; microsoftSource?: string; potentialImpact?: { kind?: string; guidance?: string } } }
  assert.equal(row.source, 'Exchange Online')
  assert.deepEqual(row.evidence, {
    normalized: true, changedFields: ['forwardTo'], workload: 'Exchange Online', result: 'Detected',
    source: 'Exchange Online', provenance: 'HawkView snapshot comparison', microsoftSource: 'Microsoft Graph mailbox rules',
  })
  const detail = await service.detail(identity, 'evidence:SNAPSHOT_DIFFERENCE:exchange-rule:mailbox@example.test:rule-1')
  assert.equal(detail.event.source, 'Exchange Online')
  assert.deepEqual((detail.event.evidence as { provenance?: string; microsoftSource?: string }), {
    source: 'Exchange Online', provenance: 'HawkView snapshot comparison', microsoftSource: 'Microsoft Graph mailbox rules',
  })
  assert.equal(detail.event.actorPrincipalName, null)
})

test('keeps directory audit display source as Entra in list and detail', async () => {
  const event = {
    id: 'directory-1', source: 'DIRECTORY_AUDIT', sourceEventId: 'directory-1', eventDateTime: new Date('2026-08-01T13:00:00.000Z'),
    customerTenantId: 'tenant-1', organizationId: 'org-1', category: 'Apps', severity: 'High', operationName: 'Update application', summary: 'Updated',
    actorId: null, actorPrincipalName: null, actorDisplayName: null, targetId: null, targetDisplayName: 'App', ipAddress: null, location: null,
    beforeState: null, afterState: null, correlationId: null, changedFields: [], workload: 'Microsoft Entra ID', result: 'Succeeded', raw: {},
  }
  const service = new ChangesService(changesPrisma({ changeEvidenceEvent: { findMany: async () => [event], findFirst: async () => event } }) as never)
  const list = await service.list(identity, range)
  assert.equal(list.changes[0]?.source, 'Entra')
  const detail = await service.detail(identity, 'audit:directory-1')
  assert.equal(detail.event.source, 'Entra')
  assert.equal((detail.event.evidence as { provenance?: string }).provenance, 'Microsoft Graph directoryAudit')
})

test('keeps routine Exchange mailbox actions out of What Changed while retaining real inbox-rule changes', async () => {
  const base = {
    eventDateTime: new Date('2026-08-01T13:00:00.000Z'), customerTenantId: 'tenant-1', category: 'Exchange', severity: 'High',
    actorPrincipalName: 'compromised@example.test', actorDisplayName: null, targetDisplayName: 'compromised@example.test',
    ipAddress: null, location: null, beforeState: null, afterState: null, correlationId: null, changedFields: [], workload: 'Exchange', result: 'Succeeded',
  }
  const events = [
    { ...base, id: 'noise-1', source: 'M365_UNIFIED_AUDIT', sourceEventId: 'noise-1', operationName: 'MoveToDeletedItems', summary: 'Mailbox item moved.', raw: { Operation: 'MoveToDeletedItems', Workload: 'Exchange' } },
    { ...base, id: 'noise-2', source: 'M365_UNIFIED_AUDIT', sourceEventId: 'noise-2', operationName: 'Create', summary: 'Mailbox item created.', raw: { Operation: 'Create', Workload: 'Exchange' } },
    { ...base, id: 'rule-1', source: 'M365_UNIFIED_AUDIT', sourceEventId: 'rule-1', operationName: 'Set-InboxRule', summary: 'Inbox rule changed.', raw: { Operation: 'Set-InboxRule', Workload: 'Exchange' } },
  ]
  const service = new ChangesService(changesPrisma({
    changeEvidenceEvent: { findMany: async () => events },
  }) as never)
  const result = await service.list(identity, range)
  assert.deepEqual(result.changes.map((event) => event.title), ['Set-InboxRule'])
})

test('suppresses an actorless snapshot when authoritative Microsoft audit evidence covers the same target', async () => {
  const base = {
    customerTenantId: 'tenant-1', category: 'Groups', severity: 'Medium', actorDisplayName: null, ipAddress: null,
    location: null, beforeState: null, afterState: null, correlationId: null, changedFields: [], workload: 'Microsoft Entra ID', result: 'Succeeded', raw: {},
  }
  const events = [
    {
      ...base, id: 'audit-row', source: 'DIRECTORY_AUDIT', sourceEventId: 'audit-group', eventDateTime: new Date('2026-08-01T12:00:00.000Z'),
      operationName: 'Add group', summary: 'Microsoft recorded the group.', actorId: 'actor-1', actorPrincipalName: 'admin@example.test',
      targetId: 'group-1', targetDisplayName: 'Incident Group',
    },
    {
      ...base, id: 'snapshot-row', source: 'SNAPSHOT_DIFFERENCE', sourceEventId: 'GROUPS:group-1:diff', eventDateTime: new Date('2026-08-01T12:10:00.000Z'),
      operationName: 'Group configuration changed', summary: 'HawkView observed a difference.', actorId: null, actorPrincipalName: null,
      targetId: 'group-1', targetDisplayName: 'Incident Group', raw: { evidenceOrigin: 'hawkview_snapshot_difference' },
    },
  ]
  const service = new ChangesService(changesPrisma({
    changeEvidenceEvent: { findMany: async () => events },
  }) as never)
  const result = await service.list(identity, range)
  assert.equal(result.changes.length, 1)
  assert.equal(result.changes[0]?.id, 'audit:audit-group')
  assert.equal(result.changes[0]?.actor, 'admin@example.test')
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

test('groups destructive mailbox activity as non-causal evidence around a compromised actor', async () => {
  const event = {
    id: 'app-event', source: 'DIRECTORY_AUDIT', sourceEventId: 'app-registration', eventDateTime: new Date('2026-08-01T12:00:00.000Z'),
    customerTenantId: 'tenant-1', organizationId: 'org-1', category: 'Apps', severity: 'High', operationName: 'Add application',
    summary: 'Application registered', actorId: 'actor-1', actorPrincipalName: 'compromised@example.test', actorDisplayName: null,
    targetId: 'app-1', targetDisplayName: 'Data theft app', correlationId: null, changedFields: [], workload: 'Microsoft Entra ID',
    result: 'success', location: null, beforeState: null, afterState: null, raw: {},
  }
  const inboxRule = {
    ...event,
    id: 'rule-event', source: 'M365_UNIFIED_AUDIT', sourceEventId: 'rule-record', eventDateTime: new Date('2026-08-01T12:05:00.000Z'),
    category: 'Exchange', operationName: 'Set-InboxRule', summary: 'Inbox rule changed', targetId: 'victim@example.test',
    targetDisplayName: 'victim@example.test', workload: 'Exchange', raw: { Operation: 'Set-InboxRule', Workload: 'Exchange' },
  }
  const supporting = (id: string, operation: string, actorId = 'compromised@example.test') => ({
    id, microsoftRecordId: id, eventDateTime: new Date(`2026-08-01T12:${id === 'mail-1' ? '10' : '11'}:00.000Z`),
    operation, workload: 'Exchange', actorId, objectId: `message-${id}`, correlationId: null,
    raw: { Operation: operation, Workload: 'Exchange', UserId: actorId, MailboxOwnerUPN: 'victim@example.test', hawkviewEvidenceRole: 'security_supporting_activity' },
  })
  const summarizedSupporting = supporting('mail-1', 'MoveToDeletedItems')
  summarizedSupporting.raw = {
    ...summarizedSupporting.raw,
    hawkviewSupportingActivityCount: 3,
    hawkviewSupportingFirstSeenAt: '2026-08-01T12:08:00.000Z',
    hawkviewSupportingLastSeenAt: '2026-08-01T12:10:00.000Z',
    hawkviewSupportingSampleRecordIds: ['source-mail-1', 'source-mail-2', 'source-mail-3'],
  } as typeof summarizedSupporting.raw
  const service = new ChangesService(changesPrisma({
    changeEvidenceEvent: { findFirst: async () => event, findMany: async () => [event, inboxRule] },
    m365AuditRecord: { findMany: async () => [
      summarizedSupporting,
      supporting('mail-2', 'MoveToDeletedItems'),
      supporting('mail-unrelated', 'SoftDelete', 'other@example.test'),
    ] },
  }) as never)
  const result = await service.detail(identity, 'audit:app-registration')
  assert.equal(result.relatedMailboxActivity.length, 1)
  assert.equal(result.relatedMailboxActivity[0]?.operation, 'MoveToDeletedItems')
  assert.equal(result.relatedMailboxActivity[0]?.count, 4)
  assert.equal(result.relatedMailboxActivity[0]?.mailboxOrObject, 'victim@example.test')
  assert.match(String(result.relatedMailboxActivity[0]?.relationship), /does not establish causation/)
  assert.deepEqual(result.associatedChanges.map((change) => change.operationName), ['Set-InboxRule'])
  assert.equal(result.relatedMailboxActivityTruncated, false)
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
  assert.equal(createManyArgs.data[0].raw.evidenceOrigin, 'microsoft_audit_event')
  assert.equal(createManyArgs.data[0].raw.microsoftSource, 'Microsoft Graph /auditLogs/directoryAudits')
})

test('does not create snapshot evidence for a first successful baseline', () => {
  const service = new ChangeEvidenceService({} as never)
  const evidence = service.buildSnapshotDifferenceEvidence({
    tenant: { id: 'tenant-1', organizationId: 'org-1' },
    resourceType: 'LICENSES',
    previousPayload: null,
    currentPayload: [{ skuId: 'sku-1', skuPartNumber: 'M365_BUSINESS', consumedUnits: 4 }],
    observedAt: new Date('2026-08-17T12:00:00.000Z'),
    expiresAt: new Date('2027-02-17T12:00:00.000Z'),
  })
  assert.deepEqual(evidence, [])
})

test('records an actorless organization rename with identity impact guidance', () => {
  const service = new ChangeEvidenceService({} as never)
  const evidence = service.buildSnapshotDifferenceEvidence({
    tenant: { id: 'tenant-1', organizationId: 'org-1' },
    resourceType: 'ORGANIZATION_CONFIGURATION',
    previousPayload: [{ id: 'microsoft-tenant-1', tenantId: 'microsoft-tenant-1', displayName: 'Contoso MSP' }],
    currentPayload: [{ id: 'microsoft-tenant-1', tenantId: 'microsoft-tenant-1', displayName: 'Contoso Security' }],
    observedAt: new Date('2026-08-18T12:00:00.000Z'), baselineObservedAt: new Date('2026-08-18T11:00:00.000Z'), expiresAt: new Date('2027-02-18T12:00:00.000Z'),
  })
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0]?.operationName, 'Microsoft 365 organization identity changed')
  assert.deepEqual(evidence[0]?.changedFields, ['displayName'])
  assert.equal(evidence[0]?.actorDisplayName, null)
  assert.equal((evidence[0]?.raw as any)?.impact, undefined)
})

test('derives product guidance only from the trusted snapshot catalog, never stored raw impact', async () => {
  const event = {
    id: 'organization-guidance-1', source: 'SNAPSHOT_DIFFERENCE', sourceEventId: 'organization:displayName',
    eventDateTime: new Date('2026-08-18T13:00:00.000Z'), customerTenantId: 'tenant-1', organizationId: 'org-1',
    targetType: 'ORGANIZATION_CONFIGURATION', category: 'Organization', severity: 'Medium',
    operationName: 'Microsoft 365 organization identity changed', summary: 'The organization identity changed.',
    actorPrincipalName: null, actorDisplayName: null, targetDisplayName: 'Contoso Security',
    ipAddress: null, location: null, beforeState: { displayName: 'Contoso MSP' }, afterState: { displayName: 'Contoso Security' },
    correlationId: null, changedFields: ['displayName'], workload: 'Microsoft 365 organization', result: 'Detected',
    raw: { impact: { guidance: 'ATTACKER-CONTROLLED-GUIDANCE', isProductGuidance: true } },
  }
  const service = new ChangesService(changesPrisma({
    changeEvidenceEvent: { findMany: async () => [event], findFirst: async () => event },
  }) as never)
  const list = await service.list(identity, range)
  const listImpact = (list.changes[0]?.evidence as { potentialImpact?: unknown }).potentialImpact
  const detail = await service.detail(identity, 'evidence:SNAPSHOT_DIFFERENCE:organization:displayName')
  const detailImpact = (detail.event.evidence as { potentialImpact?: unknown }).potentialImpact
  assert.deepEqual(listImpact, {
    kind: 'product_guidance', impactId: 'organization.identity_changed',
  })
  assert.deepEqual(detailImpact, listImpact)
  assert.doesNotMatch(JSON.stringify({ listImpact, detailImpact }), /ATTACKER-CONTROLLED-GUIDANCE/)
})

test('does not derive product guidance for unrecognized or Microsoft-audit evidence', async () => {
  const event = {
    id: 'audit-no-guidance-1', source: 'M365_UNIFIED_AUDIT', sourceEventId: 'audit-no-guidance-1',
    eventDateTime: new Date('2026-08-18T13:00:00.000Z'), customerTenantId: 'tenant-1', organizationId: 'org-1',
    targetType: 'ORGANIZATION_CONFIGURATION', category: 'Organization', severity: 'Medium', operationName: 'Update organization',
    summary: 'Microsoft reported an organization update.', actorPrincipalName: 'admin@example.test', actorDisplayName: null,
    targetDisplayName: 'Contoso Security', ipAddress: null, location: null, beforeState: null, afterState: null,
    correlationId: null, changedFields: [], workload: 'Microsoft 365 organization', result: 'Succeeded',
    raw: { impact: { guidance: 'ATTACKER-CONTROLLED-GUIDANCE' } },
  }
  const service = new ChangesService(changesPrisma({ changeEvidenceEvent: { findMany: async () => [event] } }) as never)
  const list = await service.list(identity, range)
  assert.equal((list.changes[0]?.evidence as { potentialImpact?: unknown }).potentialImpact, undefined)
})

test('records domain additions, removals, and default transitions with domain guidance', () => {
  const service = new ChangeEvidenceService({} as never)
  const common = { tenant: { id: 'tenant-1', organizationId: 'org-1' }, resourceType: 'DOMAINS', observedAt: new Date('2026-08-18T12:00:00.000Z'), baselineObservedAt: new Date('2026-08-18T11:00:00.000Z'), expiresAt: new Date('2027-02-18T12:00:00.000Z') }
  const added = service.buildSnapshotDifferenceEvidence({ ...common, previousPayload: [{ name: 'old.example', isDefault: true, isInitial: true }], currentPayload: [{ name: 'old.example', isDefault: false, isInitial: true }, { name: 'new.example', isDefault: true, isInitial: false }] })
  assert.equal(added.length, 2)
  assert.equal((added[0]?.raw as any)?.impact, undefined)
  const removed = service.buildSnapshotDifferenceEvidence({ ...common, previousPayload: [{ name: 'old.example', isDefault: true, isInitial: true }], currentPayload: [] })
  assert.equal(removed.length, 1)
  assert.deepEqual(removed[0]?.afterState, null)
})

test('records SKU capacity and capability differences as guidance, not a billing or per-user assignment claim', () => {
  const service = new ChangeEvidenceService({} as never)
  const evidence = service.buildSnapshotDifferenceEvidence({
    tenant: { id: 'tenant-1', organizationId: 'org-1' }, resourceType: 'LICENSES',
    previousPayload: [{ skuId: 'sku-1', skuPartNumber: 'M365_BASIC', consumedUnits: 2, prepaidUnits: { enabled: 10 }, capabilityStatus: 'Enabled' }],
    currentPayload: [{ skuId: 'sku-1', skuPartNumber: 'M365_BASIC', consumedUnits: 3, prepaidUnits: { enabled: 12 }, capabilityStatus: 'Suspended' }],
    observedAt: new Date('2026-08-18T12:00:00.000Z'), baselineObservedAt: new Date('2026-08-18T11:00:00.000Z'), expiresAt: new Date('2027-02-18T12:00:00.000Z'),
  })
  assert.equal(evidence.length, 1)
  assert.deepEqual(evidence[0]?.changedFields, ['prepaidUnits', 'capabilityStatus'])
  assert.equal((evidence[0]?.raw as any)?.impact, undefined)
})

test('does not emit subscription evidence for consumed-license utilization alone', () => {
  const service = new ChangeEvidenceService({} as never)
  const evidence = service.buildSnapshotDifferenceEvidence({
    tenant: { id: 'tenant-1', organizationId: 'org-1' }, resourceType: 'LICENSES',
    previousPayload: [{ skuId: 'sku-1', skuPartNumber: 'M365_BASIC', consumedUnits: 2, prepaidUnits: { enabled: 10 }, capabilityStatus: 'Enabled' }],
    currentPayload: [{ skuId: 'sku-1', skuPartNumber: 'M365_BASIC', consumedUnits: 3, prepaidUnits: { enabled: 10 }, capabilityStatus: 'Enabled' }],
    observedAt: new Date('2026-08-18T12:00:00.000Z'), baselineObservedAt: new Date('2026-08-18T11:00:00.000Z'), expiresAt: new Date('2027-02-18T12:00:00.000Z'),
  })
  assert.deepEqual(evidence, [])
})

test('keeps Exchange customization and Unified Audit semantic inversions explicit for a verified future collector', () => {
  assert.equal(describeExchangeOrganizationCustomization(true).operationName, 'Exchange organization customization disabled')
  assert.equal(describeExchangeOrganizationCustomization(false).operationName, 'Exchange organization customization enabled')
  assert.match(describeUnifiedAuditIngestion(true).impactGuidance, /does not establish that historic audit data was recovered/i)
  assert.match(describeUnifiedAuditIngestion(false).impactGuidance, /may be unavailable or delayed/i)
})

test('records a redacted, actorless snapshot difference only for tracked admin state', () => {
  const service = new ChangeEvidenceService({} as never)
  const observedAt = new Date('2026-08-17T12:00:00.000Z')
  const input = {
    tenant: { id: 'tenant-1', organizationId: 'org-1' },
    resourceType: 'APPLICATIONS',
    previousPayload: [{ id: 'app-object-1', displayName: 'Example app', passwordCredentials: [{ secretText: 'old-secret' }], createdDateTime: '2026-01-01T00:00:00Z' }],
    currentPayload: [{ id: 'app-object-1', displayName: 'Example app', passwordCredentials: [{ secretText: 'new-secret' }], createdDateTime: '2026-08-17T12:00:00Z' }],
    observedAt,
    expiresAt: new Date('2027-02-17T12:00:00.000Z'),
  }
  const evidence = service.buildSnapshotDifferenceEvidence(input)
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0]?.actorPrincipalName, null)
  assert.equal(evidence[0]?.organizationId, 'org-1')
  assert.equal(evidence[0]?.customerTenantId, 'tenant-1')
  assert.match(evidence[0]?.summary ?? '', /did not provide a confirmed actor/)
  assert.equal(evidence[0]?.raw.evidenceOrigin, 'hawkview_snapshot_difference')
  assert.equal(evidence[0]?.raw.microsoftSource, 'Microsoft Graph /applications')
  assert.deepEqual(evidence[0]?.changedFields, ['passwordCredentials'])
  assert.equal(JSON.stringify(evidence[0]?.afterState).includes('new-secret'), false)
  assert.equal(evidence[0]?.sourceEventId.includes('new-secret'), false)
  // Identical comparisons produce the same id so retried collection is deduplicable.
  assert.equal(service.buildSnapshotDifferenceEvidence(input)[0]?.sourceEventId, evidence[0]?.sourceEventId)
})

test('does not treat SharePoint content activity or an unidentifiable row as an admin change', () => {
  const service = new ChangeEvidenceService({} as never)
  const common = {
    tenant: { id: 'tenant-1', organizationId: 'org-1' },
    resourceType: 'SHAREPOINT_SITES',
    observedAt: new Date('2026-08-17T12:00:00.000Z'),
    expiresAt: new Date('2027-02-17T12:00:00.000Z'),
  }
  const contentOnly = service.buildSnapshotDifferenceEvidence({
    ...common,
    previousPayload: [{ id: 'site-1', displayName: 'Site', lastModifiedDateTime: '2026-08-16T00:00:00Z' }],
    currentPayload: [{ id: 'site-1', displayName: 'Site', lastModifiedDateTime: '2026-08-17T00:00:00Z' }],
  })
  assert.deepEqual(contentOnly, [])
  const noIdentifier = service.buildSnapshotDifferenceEvidence({
    ...common,
    previousPayload: [{}],
    currentPayload: [{ displayName: 'Cannot prove target' }],
  })
  assert.deepEqual(noIdentifier, [])
  const unsupportedResource = service.buildSnapshotDifferenceEvidence({
    ...common,
    resourceType: 'SHAREPOINT_USAGE',
    previousPayload: [{ id: 'report-1', usage: 1 }],
    currentPayload: [{ id: 'report-1', usage: 2 }],
  })
  assert.deepEqual(unsupportedResource, [])
})

test('emits actorless, provenance-labelled differences for every supported snapshot slice', () => {
  const service = new ChangeEvidenceService({} as never)
  const observedAt = new Date('2026-08-17T12:00:00.000Z')

  for (const [resourceType, spec] of Object.entries(SNAPSHOT_DIFFERENCE_SPECS)) {
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    for (const identifierField of [...spec.identifierFields, ...(spec.compoundIdentifierFields ?? [])]) {
      before[identifierField] = `${resourceType}-${identifierField}`
      after[identifierField] = `${resourceType}-${identifierField}`
    }
    const changedField = spec.trackedFields.find(
      (field) => !spec.identifierFields.includes(field)
    )
    assert.ok(changedField, `${resourceType} needs a non-identifier state field`)
    before[changedField] = 'before'
    after[changedField] = 'after'

    const evidence = service.buildSnapshotDifferenceEvidence({
      tenant: { id: 'tenant-1', organizationId: 'org-1' },
      resourceType,
      previousPayload: [before],
      currentPayload: [after],
      observedAt,
      expiresAt: new Date('2027-02-17T12:00:00.000Z'),
    })

    assert.equal(evidence.length, 1, resourceType)
    assert.equal(evidence[0]?.actorPrincipalName, null, resourceType)
    assert.equal(evidence[0]?.raw.evidenceOrigin, 'hawkview_snapshot_difference', resourceType)
    assert.equal(evidence[0]?.raw.microsoftSource, spec.microsoftSource, resourceType)
  }
})

test('canonicalizes only documented unordered admin-state arrays', () => {
  const service = new ChangeEvidenceService({} as never)
  const input = {
    tenant: { id: 'tenant-1', organizationId: 'org-1' }, resourceType: 'APPLICATIONS',
    previousPayload: [{ id: 'app-1', appRoles: [{ id: 'b' }, { id: 'a' }], requiredResourceAccess: [{ resourceAppId: 'b' }, { resourceAppId: 'a' }] }],
    currentPayload: [{ id: 'app-1', appRoles: [{ id: 'a' }, { id: 'b' }], requiredResourceAccess: [{ resourceAppId: 'a' }, { resourceAppId: 'b' }] }],
    observedAt: new Date('2026-08-17T12:00:00.000Z'), baselineObservedAt: new Date('2026-08-17T11:00:00.000Z'), expiresAt: new Date('2027-02-17T12:00:00.000Z'),
  }
  assert.deepEqual(service.buildSnapshotDifferenceEvidence(input), [])
  const ordered = service.buildSnapshotDifferenceEvidence({
    ...input, resourceType: 'EXCHANGE_MAILBOX_RULES',
    previousPayload: [{ id: 'rule', mailboxUserId: 'user', sequence: 1, actions: [{ kind: 'a' }, { kind: 'b' }] }],
    currentPayload: [{ id: 'rule', mailboxUserId: 'user', sequence: 1, actions: [{ kind: 'b' }, { kind: 'a' }] }],
  })
  assert.equal(ordered.length, 1)
})

test('does not create changes when documented unordered fields are merely reordered', () => {
  const service = new ChangeEvidenceService({} as never)
  const common = { tenant: { id: 'tenant-1', organizationId: 'org-1' }, observedAt: new Date('2026-08-17T12:00:00.000Z'), baselineObservedAt: new Date('2026-08-17T11:00:00.000Z'), expiresAt: new Date('2027-02-17T12:00:00.000Z') }
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['GROUPS', { id: 'group', groupTypes: ['Unified', 'DynamicMembership'] }, { id: 'group', groupTypes: ['DynamicMembership', 'Unified'] }],
    ['CONDITIONAL_ACCESS', { id: 'policy', conditions: { users: { includeUsers: ['a', 'b'] }, applications: { includeApplications: ['x', 'y'] } }, grantControls: { builtInControls: ['mfa', 'compliantDevice'] } }, { id: 'policy', conditions: { applications: { includeApplications: ['y', 'x'] }, users: { includeUsers: ['b', 'a'] } }, grantControls: { builtInControls: ['compliantDevice', 'mfa'] } }],
    ['NAMED_LOCATIONS', { id: 'location', ipRanges: ['10.0.0.0/8', '192.168.0.0/16'], countriesAndRegions: ['CA', 'US'] }, { id: 'location', ipRanges: ['192.168.0.0/16', '10.0.0.0/8'], countriesAndRegions: ['US', 'CA'] }],
    ['SERVICE_PRINCIPALS', { id: 'sp', tags: ['tag-a', 'tag-b'] }, { id: 'sp', tags: ['tag-b', 'tag-a'] }],
    ['APPLICATIONS', { id: 'app', appRoles: [{ id: 'a' }, { id: 'b' }], requiredResourceAccess: [{ resourceAppId: 'a' }, { resourceAppId: 'b' }] }, { id: 'app', appRoles: [{ id: 'b' }, { id: 'a' }], requiredResourceAccess: [{ resourceAppId: 'b' }, { resourceAppId: 'a' }] }],
    ['SHAREPOINT_SETTINGS', { id: 'settings', oneDriveForBusinessRestrictions: { allowedDomainGuids: ['a', 'b'] } }, { id: 'settings', oneDriveForBusinessRestrictions: { allowedDomainGuids: ['b', 'a'] } }],
  ]
  for (const [resourceType, before, after] of cases) {
    assert.deepEqual(service.buildSnapshotDifferenceEvidence({ ...common, resourceType, previousPayload: [before], currentPayload: [after] }), [], resourceType)
  }
})

test('uses baseline version for retry-safe but transition-distinct snapshot IDs', () => {
  const service = new ChangeEvidenceService({} as never)
  const make = (baseline: string) => service.buildSnapshotDifferenceEvidence({
    tenant: { id: 'tenant-1', organizationId: 'org-1' }, resourceType: 'GROUPS',
    previousPayload: [{ id: 'group-1', displayName: 'A' }], currentPayload: [{ id: 'group-1', displayName: 'B' }],
    observedAt: new Date('2026-08-17T12:00:00.000Z'), baselineObservedAt: new Date(baseline), expiresAt: new Date('2027-02-17T12:00:00.000Z'),
  })[0]?.sourceEventId
  assert.equal(make('2026-08-17T10:00:00.000Z'), make('2026-08-17T10:00:00.000Z'))
  assert.notEqual(make('2026-08-17T10:00:00.000Z'), make('2026-08-17T11:00:00.000Z'))
})

test('collects all mailbox users and every Graph inbox-rules page with mailbox-scoped identity', async () => {
  const users = Array.from({ length: 501 }, (_, index) => ({ microsoftUserId: `user-${index}`, userPrincipalName: `user-${index}@example.test` }))
  const loadedUsers = await collectMailboxRuleUsers(async (skip, take) => users.slice(skip, skip + take))
  assert.equal(loadedUsers.length, 501)
  const rows = await collectMailboxRules(loadedUsers.slice(0, 2), async (user, next) => next
    ? { value: [{ id: 'same-rule' }] }
    : { value: [{ id: 'same-rule' }], '@odata.nextLink': `https://graph.microsoft.com/next/${user.microsoftUserId}` })
  assert.equal(rows.length, 4)
  assert.equal((rows[0] as any).mailboxUserId, 'user-0')
  assert.equal((rows[2] as any).mailboxUserId, 'user-1')
})

test('runs the independent mailbox-rule safety scan only when due and within its cost cap', () => {
  const now = new Date('2026-08-17T12:30:00.000Z')
  const recent = {
    status: 'SUCCEEDED',
    lastAttemptAt: new Date('2026-08-17T12:20:00.000Z'),
    lastSuccessfulAt: new Date('2026-08-17T12:20:00.000Z'),
  }
  const stale = {
    ...recent,
    lastAttemptAt: new Date('2026-08-17T12:00:00.000Z'),
    lastSuccessfulAt: new Date('2026-08-17T12:00:00.000Z'),
  }
  assert.equal(shouldRunFastMailboxRuleRefresh({
    state: null,
    activeMailboxUsers: 20,
    now,
  }), true)
  assert.equal(shouldRunFastMailboxRuleRefresh({
    state: recent,
    activeMailboxUsers: 20,
    now,
    intervalMinutes: 15,
  }), false)
  assert.equal(shouldRunFastMailboxRuleRefresh({
    state: stale,
    activeMailboxUsers: 20,
    now,
    intervalMinutes: 15,
  }), true)
  assert.equal(shouldRunFastMailboxRuleRefresh({
    state: stale,
    activeMailboxUsers: 251,
    now,
    maximumUsers: 250,
  }), false)
})

test('backs off a failed mailbox-rule safety scan from its last attempt', () => {
  const now = new Date('2026-08-17T12:30:00.000Z')
  assert.equal(shouldRunFastMailboxRuleRefresh({
    state: {
      status: 'FAILED',
      lastAttemptAt: new Date('2026-08-17T12:25:00.000Z'),
      lastSuccessfulAt: new Date('2026-08-16T12:00:00.000Z'),
    },
    activeMailboxUsers: 20,
    now,
    intervalMinutes: 15,
  }), false)
})

test('serializes concurrent snapshot transitions so the second comparison uses the first new baseline', async () => {
  let snapshot: any = { payload: [{ id: 'group-1', displayName: 'A' }], observedAt: new Date('2026-08-17T10:00:00.000Z'), organizationId: 'org-1' }
  const evidenceWrites: any[] = []
  let queue = Promise.resolve()
  const prisma: any = {
    $transaction: async (callback: any) => {
      const previous = queue
      let release!: () => void
      queue = new Promise<void>((resolve) => { release = resolve })
      await previous
      try {
        return await callback({
          $executeRawUnsafe: async () => 1,
          tenantEntraSnapshot: {
            findUnique: async () => snapshot,
            upsert: async (args: any) => { snapshot = { ...snapshot, payload: args.update.payload, observedAt: args.update.observedAt } },
          },
          changeEvidenceEvent: { createMany: async (args: any) => { evidenceWrites.push(...args.data) } },
        })
      } finally { release() }
    },
  }
  const service = new TenantSyncService(prisma, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
  await Promise.all([
    (service as any).saveSnapshot({ id: 'tenant-1', organizationId: 'org-1' }, 'GROUPS', authoritativeSnapshot([{ id: 'group-1', displayName: 'B' }])),
    (service as any).saveSnapshot({ id: 'tenant-1', organizationId: 'org-1' }, 'GROUPS', authoritativeSnapshot([{ id: 'group-1', displayName: 'C' }])),
  ])
  assert.equal(evidenceWrites.length, 2)
  assert.equal(evidenceWrites[0].beforeState.displayName, 'A')
  assert.equal(evidenceWrites[1].beforeState.displayName, 'B')
  assert.equal(snapshot.payload[0].displayName, 'C')
})

test('refuses a cross-organization snapshot baseline instead of emitting tenant evidence', async () => {
  const service = new TenantSyncService({
    $transaction: async (callback: any) => callback({
      $executeRawUnsafe: async () => 1,
      tenantEntraSnapshot: { findUnique: async () => ({ payload: [], observedAt: new Date(), organizationId: 'other-org' }) },
      changeEvidenceEvent: { createMany: async () => undefined },
    }),
  } as never, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
  await assert.rejects(
    () => (service as any).saveSnapshot({ id: 'tenant-1', organizationId: 'org-1' }, 'GROUPS', authoritativeSnapshot([])),
    /organization mismatch/
  )
})

test('only complete snapshot results advance baselines, including legitimate empty inventories', async () => {
  let snapshot: any = { payload: [{ id: 'group-1', displayName: 'Old' }], observedAt: new Date('2026-08-17T10:00:00.000Z'), organizationId: 'org-1' }
  const writes: any[] = []
  const prisma: any = {
    $transaction: async (callback: any) => callback({
      $executeRawUnsafe: async () => 1,
      tenantEntraSnapshot: {
        findUnique: async () => snapshot,
        upsert: async (args: any) => { snapshot = { ...snapshot, payload: args.update.payload, observedAt: args.update.observedAt } },
      },
      changeEvidenceEvent: { createMany: async (args: any) => { writes.push(...args.data) } },
    }),
  }
  const service = new TenantSyncService(prisma, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
  await assert.rejects(
    () => (service as any).saveSnapshot({ id: 'tenant-1', organizationId: 'org-1' }, 'GROUPS', partialSnapshot([])),
    /partial or unverified/
  )
  assert.equal(snapshot.payload.length, 1)
  await (service as any).saveSnapshot({ id: 'tenant-1', organizationId: 'org-1' }, 'GROUPS', authoritativeSnapshot([]))
  assert.deepEqual(snapshot.payload, [])
  assert.equal(writes.length, 1)
})

test('does not create snapshot change evidence for a first authoritative empty baseline', async () => {
  let snapshot: any = null
  const writes: any[] = []
  const prisma: any = {
    $transaction: async (callback: any) => callback({
      $executeRawUnsafe: async () => 1,
      tenantEntraSnapshot: {
        findUnique: async () => snapshot,
        upsert: async (args: any) => { snapshot = { organizationId: 'org-1', payload: args.create.payload, observedAt: args.create.observedAt } },
      },
      changeEvidenceEvent: { createMany: async (args: any) => { writes.push(...args.data) } },
    }),
  }
  const service = new TenantSyncService(prisma, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
  await (service as any).saveSnapshot({ id: 'tenant-1', organizationId: 'org-1' }, 'GROUPS', authoritativeSnapshot([]))
  assert.deepEqual(snapshot.payload, [])
  assert.equal(writes.length, 0)
})

test('bounds mailbox inventory and rule pagination without advancing a partial baseline', async () => {
  await assert.rejects(
    () => collectMailboxRuleUsers(async () => [{ microsoftUserId: 'user', userPrincipalName: 'user@example.test' }], { pageSize: 1, maxPages: 2 }),
    /2-page safety limit/
  )
  await assert.rejects(
    () => collectMailboxRuleUsers(async () => [
      { microsoftUserId: 'user-1', userPrincipalName: 'one@example.test' },
      { microsoftUserId: 'user-2', userPrincipalName: 'two@example.test' },
    ], { pageSize: 2, maxRecords: 1 }),
    /1-record safety limit/
  )
  let page = 0
  await assert.rejects(
    () => collectMailboxRules(
      [{ microsoftUserId: 'user', userPrincipalName: 'user@example.test' }],
      async () => ({ value: [{ id: `rule-${page++}` }], '@odata.nextLink': `https://graph.microsoft.com/next/${page}` }),
      1,
      { maxPages: 2 }
    ),
    /2-page safety limit/
  )
  await assert.rejects(
    () => collectMailboxRules(
      [{ microsoftUserId: 'user', userPrincipalName: 'user@example.test' }],
      async () => ({ value: [{ id: 'rule-1' }, { id: 'rule-2' }] }),
      1,
      { maxRecords: 1 }
    ),
    /1-record safety limit/
  )
})

test('bounds Graph mailbox directory pagination before a baseline can advance', async () => {
  await assert.rejects(
    () => collectMailboxDirectoryPages(
      'https://graph.microsoft.com/users?page=1',
      async () => ({ value: [{ id: 'one' }], '@odata.nextLink': 'https://graph.microsoft.com/users?page=1' })
    ),
    /repeated mailbox directory pagination link/
  )
  let uniquePage = 0
  await assert.rejects(
    () => collectMailboxDirectoryPages(
      'https://graph.microsoft.com/users?page=0',
      async () => ({ value: [{ id: uniquePage }], '@odata.nextLink': `https://graph.microsoft.com/users?page=${++uniquePage}` }),
      { maxPages: 2 }
    ),
    /2-page safety limit/
  )
  await assert.rejects(
    () => collectMailboxDirectoryPages(
      'https://graph.microsoft.com/users?page=0',
      async () => ({ value: [{ id: 'one' }, { id: 'two' }] }),
      { maxRecords: 1 }
    ),
    /1-record safety limit/
  )
})

test('does not attest to a complete SharePoint baseline when administrative enrichment fails', async () => {
  const tokenFailure = sharePointSitesSnapshotResult([{ id: 'site-1' }], false)
  const perSiteFailure = sharePointSitesSnapshotResult([{ id: 'site-1' }], false)
  assert.equal(tokenFailure.completeness, 'partial_or_unknown')
  assert.equal(perSiteFailure.completeness, 'partial_or_unknown')

  let writes = 0
  const service = new TenantSyncService({
    $transaction: async (callback: any) => callback({
      $executeRawUnsafe: async () => 1,
      tenantEntraSnapshot: {
        findUnique: async () => ({ payload: [{ id: 'old-site' }], observedAt: new Date(), organizationId: 'org-1' }),
        upsert: async () => { writes += 1 },
      },
      changeEvidenceEvent: { createMany: async () => { writes += 1 } },
    }),
  } as never, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
  await assert.rejects(
    () => (service as any).saveSnapshot(
      { id: 'tenant-1', organizationId: 'org-1' },
      'SHAREPOINT_SITES',
      tokenFailure
    ),
    /partial or unverified/
  )
  assert.equal(writes, 0)
})

test('marks owner or membership failures as incomplete group relationship synchronization', () => {
  assert.doesNotThrow(() => assertGroupRelationshipRefreshComplete(0, 0))
  assert.throws(
    () => assertGroupRelationshipRefreshComplete(1, 0),
    /relationship refresh was incomplete/
  )
  assert.throws(
    () => assertGroupRelationshipRefreshComplete(0, 1),
    /Existing relationships were retained/
  )
})

test('documents supported Microsoft administrative evidence and the implemented Unified Audit boundary', () => {
  assert.equal(MICROSOFT_ADMIN_CHANGE_CATALOG.some((entry) => entry.normalizedEventType.includes('conditional_access')), true)
  assert.equal(MICROSOFT_ADMIN_CHANGE_CATALOG.some((entry) => entry.workload === 'Teams and tenant-wide Microsoft 365 settings' && entry.collectorStatus === 'not_collected'), true)
  assert.equal(UNIFIED_AUDIT_LOG_GAP_REPORT.leastPrivilegeApplicationPermission, 'ActivityFeed.Read (Office 365 Management APIs, not Microsoft Graph)')
  assert.equal(UNIFIED_AUDIT_LOG_GAP_REPORT.adminConsentRequired, true)
  assert.equal(UNIFIED_AUDIT_LOG_GAP_REPORT.status, 'implemented_polling')
  assert.match(UNIFIED_AUDIT_LOG_GAP_REPORT.subscriptions, /poll/i)
  assert.match(UNIFIED_AUDIT_LOG_GAP_REPORT.subscriptions, /optional/i)
  assert.match(UNIFIED_AUDIT_LOG_GAP_REPORT.currentActivityFeedUse, /already consented/i)
  assert.match(UNIFIED_AUDIT_LOG_GAP_REPORT.currentActivityFeedUse, /durable at-least-once ledger/i)
  assert.equal(DOMAIN_DETAIL_COVERAGE_GAP.requiredApplicationPermission, 'Domain.Read.All')
  assert.equal(DOMAIN_DETAIL_COVERAGE_GAP.decision, 'permission_blocked_not_implemented')
  assert.equal(MICROSOFT_ADMIN_CHANGE_CATALOG.some((entry) => entry.microsoftSource.includes('/domains')), false)
})
