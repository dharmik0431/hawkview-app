import assert from 'node:assert/strict'
import test from 'node:test'
import { ChangeEvidenceService, redactSensitiveValues } from './change-evidence.service.js'
import { classifyEvidence, isPrimaryChange } from './change-classification.js'
import { classifyEvidenceTrust, EVIDENCE_TRUST_CATALOG_VERSION } from './evidence-trust-catalog.js'
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
  readBoundedSharePointJson,
  SHAREPOINT_COLLECTION_LIMITS,
  shouldRunFastMailboxRuleRefresh,
  claimTenantUsersLease,
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
  assert.equal(classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Update conditional access policy', operationType: 'Update', targetResourceTypes: ['conditionalAccessPolicy'] }), 'security_control_change')
  assert.equal(classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Add app role assignment', operationType: 'Add', targetResourceTypes: ['appRoleAssignment'] }), 'permission_change')
  assert.equal(classifyEvidence({ source: 'SNAPSHOT_DIFFERENCE', activity: 'Microsoft 365 organization identity changed', category: 'Organization' }), 'configuration_change')
  assert.equal(classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Add member to group', operationType: 'Add', targetResourceTypes: ['group'] }), 'identity_change')
  assert.equal(classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Update license assignment', operationType: 'Update', targetResourceTypes: ['assignedLicense'] }), 'configuration_change')
  assert.equal(classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Reset user password', operationType: 'Update', targetResourceTypes: ['user'] }), 'administrative_action')
  assert.equal(classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Reset user password', operationType: 'Update', targetResourceTypes: ['user'], result: 'failed' }), 'system_or_collection_event')
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

test('suppresses read suffixes and routine synchronization telemetry before noun classification', () => {
  for (const activity of ['Policy_Get', 'Groups_List', 'Applications_Read', 'Report_Export', 'InventorySyncCompleted', 'CollectionRefreshStarted']) {
    assert.equal(classifyEvidence({ source: 'DIRECTORY_AUDIT', activity, category: 'Groups', operationType: 'Update' }), 'system_or_collection_event', activity)
  }
  assert.equal(
    classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Update directory synchronization configuration', category: 'DirectoryManagement', operationType: 'Update', targetResourceTypes: ['synchronizationJob'] }),
    'configuration_change',
  )
})

test('uses an immutable versioned catalog for Microsoft 365 audit trust decisions', () => {
  const cases = [
    [{ source: 'Office 365 Management Activity API', operation: 'Policy_Get', workload: 'AzureActiveDirectory' }, 'SYSTEM_OR_COLLECTION_EVENT'],
    [{ source: 'Office 365 Management Activity API', operation: 'MessageCreated', workload: 'MicrosoftTeams' }, 'INFORMATIONAL_ACTIVITY'],
    [{ source: 'Office 365 Management Activity API', operation: 'TaskCreated', workload: 'Microsoft To Do' }, 'INFORMATIONAL_ACTIVITY'],
    [{ source: 'Office 365 Management Activity API', operation: 'Set-InboxRule', workload: 'Exchange' }, 'PRIMARY_CHANGE'],
    [{ source: 'Office 365 Management Activity API', operation: 'Set-SPOTenant', workload: 'SharePoint' }, 'PRIMARY_CHANGE'],
  ] as const
  for (const [input, expected] of cases) {
    const result = classifyEvidenceTrust(input)
    assert.equal(result.version, EVIDENCE_TRUST_CATALOG_VERSION)
    assert.equal(result.evidenceClass, expected)
    assert.ok(Object.isFrozen(result))
  }
  assert.equal(classifyEvidenceTrust({
    source: 'DIRECTORY_AUDIT', operation: 'Update application', category: 'Apps', operationType: 'Update',
    targetResourceTypes: ['application'], result: 'UnknownFutureValue',
  }).evidenceClass, 'SYSTEM_OR_COLLECTION_EVENT')
})

test('keeps narrow Microsoft portal and service maintenance noise out of change investigations', () => {
  assert.equal(classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: 'Features_GetFeaturesAsync', category: 'Groups', operationType: 'Update' }), 'system_or_collection_event')
  assert.equal(classifyEvidence({
    source: 'DIRECTORY_AUDIT', activity: 'Set Company Information', category: 'Users', operationType: 'Update',
    actor: 'Microsoft Office 365 Portal', targetResourceTypes: ['organization'], beforeState: { 'Included Updated Properties': null }, afterState: { 'Included Updated Properties': '' },
  }), 'system_or_collection_event')
  assert.equal(classifyEvidence({
    source: 'DIRECTORY_AUDIT', activity: 'Set Company Information', category: 'Users', operationType: 'Update',
    actor: 'Microsoft Office 365 Portal', targetResourceTypes: ['organization'], beforeState: { displayName: 'Old Co' }, afterState: { displayName: 'New Co' },
  }), 'identity_change')
  assert.equal(classifyEvidence({
    source: 'DIRECTORY_AUDIT', activity: 'Update service principal', category: 'Applications', operationType: 'Update',
    actor: 'Microsoft Azure AD Internal - Jit Provisioning',
  }), 'system_or_collection_event')
  assert.equal(classifyEvidence({
    source: 'M365_UNIFIED_AUDIT', workload: 'Exchange', activity: 'Set-Mailbox', category: 'Exchange',
    actor: 'NT SERVICE\\MSExchangeAdminApiNetCore (Microsoft.Exchange.AdminApi.NetCore)', afterState: { Arbitration: 'True' },
  }), 'system_or_collection_event')
  assert.equal(classifyEvidence({
    source: 'M365_UNIFIED_AUDIT', workload: 'Exchange', activity: 'Set-Mailbox', category: 'Exchange',
    actor: 'admin@example.test', afterState: { ForwardingAddress: 'review@example.test' },
  }), 'configuration_change')
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

test('never queries another organization tenant selected through the investigation filter', async () => {
  const queriedTenantScopes: unknown[] = []
  const service = new ChangesService(changesPrisma({
    directoryAuditLog: {
      findMany: async (args: { where: { customerTenantId: unknown } }) => {
        queriedTenantScopes.push(args.where.customerTenantId)
        return []
      },
      findFirst: async () => null,
    },
    changeEvidenceEvent: {
      findMany: async (args: { where: { customerTenantId: unknown } }) => {
        queriedTenantScopes.push(args.where.customerTenantId)
        return []
      },
    },
  }) as never)

  const result = await service.list(identity, { ...range, tenantId: 'tenant-from-another-org' })
  assert.deepEqual(result.changes, [])
  assert.equal(queriedTenantScopes.length, 2)
  for (const scope of queriedTenantScopes) assert.deepEqual(scope, { in: [] })
})

test('keeps identical Microsoft source IDs isolated by tenant across totals, filters, and pages', async () => {
  const events = ['tenant-1', 'tenant-2'].map((customerTenantId, index) => ({
    id: `row-${index + 1}`, source: 'DIRECTORY_AUDIT', sourceEventId: 'shared-microsoft-id',
    eventDateTime: new Date(`2026-08-01T1${index + 1}:00:00.000Z`), customerTenantId,
    category: 'Apps', severity: 'High', operationName: 'Update application', summary: 'Updated',
    actorPrincipalName: 'owner@example.test', actorDisplayName: null, targetDisplayName: `App ${index + 1}`,
    targetType: 'application', ipAddress: null, location: null, beforeState: null, afterState: null,
    correlationId: null, changedFields: [], workload: 'Microsoft Entra ID', result: 'success', raw: { operationType: 'Update' },
  }))
  const service = new ChangesService(changesPrisma({
    customerTenant: {
      findMany: async () => [
        { id: 'tenant-1', displayName: 'Tenant One', primaryDomain: 'one.example' },
        { id: 'tenant-2', displayName: 'Tenant Two', primaryDomain: 'two.example' },
      ],
    },
    changeEvidenceEvent: {
      findMany: async (args: { where: { customerTenantId: { in: string[] } } }) =>
        events.filter((event) => args.where.customerTenantId.in.includes(event.customerTenantId)),
    },
  }) as never)

  const firstPage = await service.list(identity, { ...range, page: '1', pageSize: '1' })
  const secondPage = await service.list(identity, { ...range, page: '2', pageSize: '1' })
  assert.equal(firstPage.summary.total, 2)
  assert.deepEqual(firstPage.pagination, { page: 1, pageSize: 1, total: 2, totalPages: 2 })
  assert.deepEqual(secondPage.pagination, { page: 2, pageSize: 1, total: 2, totalPages: 2 })
  assert.deepEqual(
    new Set([firstPage.changes[0]?.tenantId, secondPage.changes[0]?.tenantId]),
    new Set(['tenant-1', 'tenant-2']),
  )

  const tenantFiltered = await service.list(identity, { ...range, tenantId: 'tenant-2', page: '1', pageSize: '1' })
  assert.equal(tenantFiltered.summary.total, 1)
  assert.equal(tenantFiltered.changes[0]?.tenantId, 'tenant-2')
  assert.deepEqual(tenantFiltered.pagination, { page: 1, pageSize: 1, total: 1, totalPages: 1 })
})

test('requires tenant identity and resolves a shared Microsoft event ID only inside that tenant', async () => {
  const events = ['tenant-1', 'tenant-2'].map((customerTenantId, index) => ({
    id: `shared-row-${index + 1}`, source: 'DIRECTORY_AUDIT', sourceEventId: 'shared:detail:id',
    eventDateTime: new Date(`2026-08-01T1${index + 1}:00:00.000Z`), customerTenantId, organizationId: 'org-1',
    category: 'Apps', severity: 'High', operationName: 'Update application', summary: 'Updated',
    actorId: null, actorPrincipalName: 'owner@example.test', actorDisplayName: null, targetId: `app-${index + 1}`,
    targetDisplayName: `App ${index + 1}`, targetType: 'application', ipAddress: null, location: null,
    beforeState: null, afterState: null, correlationId: null, changedFields: [], workload: 'Microsoft Entra ID',
    result: 'success', raw: { operationType: 'Update' },
  }))
  events.push({
    ...events[0]!,
    id: 'tenant-1-only-row',
    sourceEventId: 'tenant-1:only:id',
    targetId: 'tenant-1-only-app',
    targetDisplayName: 'Tenant 1 only app',
  })
  const detailQueries: any[] = []
  const service = new ChangesService(changesPrisma({
    customerTenant: {
      findMany: async () => [
        { id: 'tenant-1', displayName: 'Tenant One', primaryDomain: 'one.example' },
        { id: 'tenant-2', displayName: 'Tenant Two', primaryDomain: 'two.example' },
      ],
    },
    changeEvidenceEvent: {
      findFirst: async (args: any) => {
        detailQueries.push(args)
        return events.find((event) =>
          event.customerTenantId === args.where.customerTenantId &&
          event.source === args.where.source &&
          event.sourceEventId === args.where.sourceEventId
        ) ?? null
      },
      findMany: async () => [],
    },
  }) as never)

  await assert.rejects(
    () => service.detail(identity, 'audit:shared:detail:id', undefined),
    /Select a tenant for this investigation event/,
  )
  const tenantOneDetail = await service.detail(identity, 'audit:shared:detail:id', 'tenant-1')
  const tenantTwoDetail = await service.detail(identity, 'audit:shared:detail:id', 'tenant-2')
  assert.equal(tenantOneDetail.event.customerTenantId, 'tenant-1')
  assert.equal(tenantOneDetail.event.targetDisplayName, 'App 1')
  assert.equal(tenantTwoDetail.event.customerTenantId, 'tenant-2')
  assert.equal(tenantTwoDetail.event.targetDisplayName, 'App 2')
  assert.deepEqual(detailQueries.map((query) => query.where), ['tenant-1', 'tenant-2'].map((customerTenantId) => ({
    source: 'DIRECTORY_AUDIT',
    sourceEventId: 'shared:detail:id',
    customerTenantId,
    organizationId: { in: ['org-1'] },
  })))

  await assert.rejects(
    () => service.detail(identity, 'audit:tenant-1:only:id', 'tenant-2'),
    /unavailable or outside retention/,
  )
})

test('fails closed before evidence lookup when a detail tenant is outside the organization', async () => {
  let evidenceLookups = 0
  let fallbackLookups = 0
  const service = new ChangesService(changesPrisma({
    customerTenant: { findMany: async () => [{ id: 'tenant-1' }] },
    changeEvidenceEvent: {
      findFirst: async () => { evidenceLookups += 1; return null },
      findMany: async () => [],
    },
    directoryAuditLog: {
      findMany: async () => [],
      findFirst: async () => { fallbackLookups += 1; return null },
    },
  }) as never)

  await assert.rejects(
    () => service.detail(identity, 'audit:shared-detail-id', 'tenant-outside-org'),
    /unavailable or outside retention/,
  )
  assert.equal(evidenceLookups, 0)
  assert.equal(fallbackLookups, 0)
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

test('suppresses Microsoft system-mailbox maintenance while retaining ordinary mailbox changes', async () => {
  const base = {
    eventDateTime: new Date('2026-08-01T13:00:00.000Z'), customerTenantId: 'tenant-1', category: 'Exchange', severity: 'High',
    actorDisplayName: null, targetDisplayName: 'mailbox', ipAddress: null, location: null, beforeState: null,
    correlationId: null, changedFields: [], workload: 'Exchange', result: 'Succeeded', raw: {},
  }
  const events = [
    {
      ...base, id: 'system-mailbox', source: 'M365_UNIFIED_AUDIT', sourceEventId: 'system-mailbox', operationName: 'Set-Mailbox',
      summary: 'Exchange reported Set-Mailbox.', actorPrincipalName: 'NT SERVICE\\MSExchangeAdminApiNetCore (Microsoft.Exchange.AdminApi.NetCore)',
      afterState: { Identity: 'Microsoft Exchange Hosted Organizations\\example.test\\Migration.8f3e7716', Arbitration: 'True' },
    },
    {
      ...base, id: 'user-mailbox', source: 'M365_UNIFIED_AUDIT', sourceEventId: 'user-mailbox', operationName: 'Set-Mailbox',
      summary: 'Exchange reported Set-Mailbox.', actorPrincipalName: 'admin@example.test', afterState: { ForwardingAddress: 'review@example.test' },
    },
  ]
  const service = new ChangesService(changesPrisma({ changeEvidenceEvent: { findMany: async () => events } }) as never)
  const result = await service.list(identity, range)
  assert.deepEqual(result.changes.map((event) => event.id), ['evidence:M365_UNIFIED_AUDIT:user-mailbox'])
  assert.equal(result.changes[0]?.guidanceKind, 'recovery')
})

test('labels missing-state advice as review guidance rather than rollback guidance', async () => {
  const event = {
    id: 'missing-state', source: 'DIRECTORY_AUDIT', sourceEventId: 'missing-state', eventDateTime: new Date('2026-08-01T13:00:00.000Z'),
    customerTenantId: 'tenant-1', category: 'Groups', severity: 'Medium', operationName: 'Update group', summary: 'Microsoft reported an update.',
    actorPrincipalName: 'admin@example.test', actorDisplayName: null, targetDisplayName: 'Support', ipAddress: null, location: null,
    beforeState: null, afterState: null, correlationId: 'corr-1', changedFields: [], workload: 'Microsoft Entra ID', result: 'Succeeded', raw: {},
  }
  const service = new ChangesService(changesPrisma({ changeEvidenceEvent: { findMany: async () => [event] } }) as never)
  const result = await service.list(identity, range)
  assert.equal(result.changes[0]?.guidanceKind, 'review')
  assert.match(String((result.changes[0]?.recoveryGuidance as string[] | undefined)?.at(-1)), /did not provide enough state evidence/i)
  assert.doesNotMatch((result.changes[0]?.recoveryGuidance as string[] | undefined)?.join(' ') ?? '', /restore the last approved configuration/i)
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
  const detail = await service.detail(identity, 'evidence:SNAPSHOT_DIFFERENCE:exchange-rule:mailbox@example.test:rule-1', 'tenant-1')
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
  const detail = await service.detail(identity, 'audit:directory-1', 'tenant-1')
  assert.equal(detail.event.source, 'Entra')
  assert.equal((detail.event.evidence as { provenance?: string }).provenance, 'Microsoft Graph directoryAudit')
})

test('reclassifies retained historical fields identically in list and detail', async () => {
  const event = {
    id: 'historical-directory-1', source: 'DIRECTORY_AUDIT', sourceEventId: 'historical-directory-1',
    eventDateTime: new Date('2026-08-01T13:00:00.000Z'), customerTenantId: 'tenant-1', organizationId: 'org-1',
    category: 'Licenses', severity: 'Low', operationName: 'Update application', summary: 'Updated',
    actorId: null, actorPrincipalName: 'admin@example.test', actorDisplayName: null, targetId: 'app-1',
    targetDisplayName: 'Application', targetType: 'application', ipAddress: null, location: null,
    beforeState: null, afterState: null, correlationId: null, changedFields: [], workload: 'Microsoft Entra ID',
    result: 'Succeeded', raw: { operationType: 'Update' },
  }
  const service = new ChangesService(changesPrisma({
    changeEvidenceEvent: { findMany: async () => [event], findFirst: async () => event },
  }) as never)

  const list = await service.list(identity, range)
  const detail = await service.detail(identity, 'audit:historical-directory-1', 'tenant-1')
  const listTruth = {
    category: list.changes[0]?.category,
    severity: list.changes[0]?.severity,
    source: list.changes[0]?.source,
    classification: list.changes[0]?.classification,
  }
  const detailTruth = {
    category: detail.event.category,
    severity: detail.event.severity,
    source: detail.event.source,
    classification: detail.event.classification,
  }
  assert.deepEqual(listTruth, {
    category: 'Apps', severity: 'High', source: 'Entra', classification: 'permission_change',
  })
  assert.deepEqual(detailTruth, listTruth)
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
    id: 'raw-1', microsoftAuditId: 'audit-raw-1', activityDisplayName: 'Reset user password', category: 'UserManagement', eventDateTime: new Date('2026-08-01T12:00:00.000Z'), customerTenantId: 'tenant-1', operationType: 'Update', result: 'success', resultReason: null, initiatedBy: null, targetResources: [{ type: 'User', displayName: 'user@example.test' }], additionalDetails: null, raw: {}, correlationId: null,
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
    id: 'raw-1', microsoftAuditId: 'audit-raw-1', activityDisplayName: 'Reset user password', category: 'UserManagement', eventDateTime: new Date('2026-08-01T12:00:00.000Z'), customerTenantId: 'tenant-1', operationType: 'Update', result: 'success', resultReason: null, initiatedBy: null, targetResources: [{ type: 'User', displayName: 'user@example.test' }], additionalDetails: null, raw: {}, correlationId: null,
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
  const result = await service.detail(identity, 'audit:audit-correlation', 'tenant-1')
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
  const result = await service.detail(identity, 'audit:audit-no-correlation', 'tenant-1')
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
  const result = await service.detail(identity, 'audit:app-registration', 'tenant-1')
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
    () => service.detail(identity, 'signin:sign-in-1', 'tenant-1'),
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
  const result = await service.detail(identity, 'audit:audit-raw-detail-1', 'tenant-1')
  assert.equal(result.event.sourceEventId, 'audit-raw-detail-1')
  assert.equal(result.event.actorPrincipalName, 'owner@example.test')
  assert.equal((result.event.raw as Record<string, unknown>).clientSecret, '[REDACTED]')
  assert.deepEqual(fallbackQuery.where.organizationId, { in: ['org-1'] })
  assert.equal(fallbackQuery.where.customerTenantId, 'tenant-1')
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
    [{ microsoftAuditId: 'audit-1', eventDateTime: new Date('2026-08-01T12:00:00.000Z'), activityDisplayName: 'Update application credential', category: 'ApplicationManagement', operationType: 'Update', targetResources: [{ id: 'app-1', type: 'Application', displayName: 'Example app', modifiedProperties: [{ displayName: 'clientSecret', oldValue: 'old-secret', newValue: 'new-secret' }] }], initiatedBy: {}, raw: { clientSecret: 'new-secret' }, ingestedAt: new Date('2026-08-01T12:00:01.000Z'), expiresAt: new Date('2027-02-01T12:00:00.000Z') }]
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
  const detail = await service.detail(identity, 'evidence:SNAPSHOT_DIFFERENCE:organization:displayName', 'tenant-1')
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
  assert.deepEqual(list.changes, [])
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

test('enforces the SharePoint response byte ceiling from the actual stream, not Content-Length', async () => {
  const encoder = new TextEncoder()
  const streamResponse = (chunks: string[], contentLength?: string, keepOpen = false) => {
    let index = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[index++]
        if (next === undefined) return keepOpen ? undefined : controller.close()
        controller.enqueue(encoder.encode(next))
      },
      cancel() { cancelled = true },
    })
    return {
      response: new Response(stream, { headers: contentLength ? { 'content-length': contentLength } : undefined }),
      cancelled: () => cancelled,
    }
  }
  const exact = streamResponse(['{"x":', '"1234"}'])
  assert.deepEqual(await readBoundedSharePointJson(exact.response, 12), { x: '1234' })
  // Keep oversized streams open so cancellation is observable independently
  // of the stream implementation's read-ahead/auto-close scheduling.
  const missingHeader = streamResponse(['{"x":', '"12345"}'], undefined, true)
  await assert.rejects(() => readBoundedSharePointJson(missingHeader.response, 12), /response-size limit/)
  assert.equal(missingHeader.cancelled(), true)
  const understatedHeader = streamResponse(['{"x":', '"12345"}'], '1', true)
  await assert.rejects(() => readBoundedSharePointJson(understatedHeader.response, 12), /response-size limit/)
  const declaredTooLarge = streamResponse(['{}'], '99')
  await assert.rejects(() => readBoundedSharePointJson(declaredTooLarge.response, 12), /response-size limit/)
})

test('runs the real bounded SharePoint orchestration without SharePoint-resource tokens or site-user REST calls', async () => {
  const tokenHosts: string[] = []
  const saved: any[] = []
  const calls: string[] = []
  const service = new TenantSyncService({
    tenantDomain: { findFirst: async () => ({ name: 'contoso.onmicrosoft.com' }) },
  } as never, {
    getTenantSharePointAccessToken: async (input: any) => { tokenHosts.push(input.sharePointHost); return `token-${input.sharePointHost}` },
  } as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
  ;(service as any).runSnapshotSync = async (_tenant: any, _resource: string, work: () => Promise<void>) => work()
  ;(service as any).saveSnapshot = async (...args: any[]) => { saved.push(args) }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/sites/root')) return new Response(JSON.stringify({ id: 'root', webUrl: 'https://contoso.sharepoint.com' }))
    if (url.includes('/v1.0/sites?')) return new Response(JSON.stringify({ value: [
      { id: 'root', webUrl: 'https://contoso.sharepoint.com' },
      { id: 'my', webUrl: 'https://contoso-my.sharepoint.com/personal/a' },
    ] }))
    if (url.includes('/_api/web/siteusers')) return new Response(JSON.stringify({ value: [] }))
    throw new Error(`unexpected request ${url}`)
  }) as typeof fetch
  try {
    await (service as any).syncSharePointSites({
      id: 'tenant-1', organizationId: 'org-1', microsoftTenantId: 'microsoft-1',
      connection: { connectionMode: 'CUSTOMER_MANAGED', clientId: 'client', credentialReference: 'reference' },
    }, 'graph-token', { ...SHAREPOINT_COLLECTION_LIMITS, sitePages: 1, sites: 5, siteUserPages: 1, siteUserRecords: 5, responseBytes: 1024 })
  } finally { globalThis.fetch = originalFetch }
  assert.deepEqual(tokenHosts, [])
  assert.equal(saved.length, 1)
  assert.equal(saved[0]?.[1], 'SHAREPOINT_SITES')
  assert.equal(calls.some((url) => /\/sites\/[^?]+\/drive(?:\?|$)/i.test(url)), false)
  assert.equal(saved[0]?.[2]?.rows?.every((site: any) => site.driveQuota === null), true)
})

test('real SharePoint pagination aborts before a snapshot baseline can advance', async () => {
  let saved = false
  const service = new TenantSyncService({
    tenantDomain: { findFirst: async () => ({ name: 'contoso.onmicrosoft.com' }) },
  } as never, { getTenantSharePointAccessToken: async () => 'site-token' } as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
  ;(service as any).runSnapshotSync = async (_tenant: any, _resource: string, work: () => Promise<void>) => work()
  ;(service as any).saveSnapshot = async () => { saved = true }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/sites/root')) return new Response(JSON.stringify({ id: 'root', webUrl: 'https://contoso.sharepoint.com' }))
    if (url.includes('/v1.0/sites?')) return new Response(JSON.stringify({ value: [], '@odata.nextLink': url }))
    throw new Error(`unexpected request ${url}`)
  }) as typeof fetch
  try {
    await assert.rejects(() => (service as any).syncSharePointSites({
      id: 'tenant-1', organizationId: 'org-1', microsoftTenantId: 'microsoft-1',
      connection: { connectionMode: 'CUSTOMER_MANAGED', clientId: 'client', credentialReference: 'reference' },
    }, 'graph-token', { ...SHAREPOINT_COLLECTION_LIMITS, sitePages: 2, sites: 5, siteUserPages: 1, siteUserRecords: 5, responseBytes: 1024 }), /repeated pagination link/)
  } finally { globalThis.fetch = originalFetch }
  assert.equal(saved, false)
})

test.skip('legacy REST site-user limit coverage is superseded by standard least-privilege mode', async () => {
  assert.deepEqual(SHAREPOINT_COLLECTION_LIMITS, {
    sitePages: 50, sites: 10_000, siteUserPages: 20, siteUserRecords: 50_000,
    responseBytes: 5 * 1024 * 1024, requestTimeoutMs: 20_000, collectorDeadlineMs: 10 * 60_000,
  })
  const tenant: any = { id: 'tenant-1', organizationId: 'org-1', microsoftTenantId: 'microsoft-1', connection: { connectionMode: 'CUSTOMER_MANAGED', clientId: 'client', credentialReference: 'reference' } }
  async function run(input: { limits: any; graphPages?: any[]; restPages?: any[] }) {
    let saved = 0; let graphPage = 0; let restPage = 0
    const service = new TenantSyncService({ tenantDomain: { findFirst: async () => ({ name: 'contoso.onmicrosoft.com' }) } } as never, { getTenantSharePointAccessToken: async () => 'site-token' } as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
    ;(service as any).runSnapshotSync = async (_t: any, _r: string, work: any) => work()
    ;(service as any).saveSnapshot = async () => { saved += 1 }
    const original = globalThis.fetch
    globalThis.fetch = (async (request: any) => {
      const url = String(request)
      if (url.includes('/sites/root')) return new Response(JSON.stringify({ id: 'root', webUrl: 'https://contoso.sharepoint.com/sites/root' }))
      if (url.includes('/v1.0/sites?')) return new Response(JSON.stringify(input.graphPages?.[graphPage++] ?? { value: [] }))
      if (url.includes('/drive?')) return new Response(JSON.stringify({ quota: {} }))
      if (url.includes('/_api/web/siteusers')) {
        const page = input.restPages?.[restPage++] ?? { value: [] }
        return new Response(JSON.stringify(page?.__repeat ? { value: page.value ?? [], '@odata.nextLink': url } : page))
      }
      throw new Error(`unexpected ${url}`)
    }) as typeof fetch
    try { await (service as any).syncSharePointSites(tenant, 'graph-token', input.limits) } finally { globalThis.fetch = original }
    return saved
  }
  const limits = { ...SHAREPOINT_COLLECTION_LIMITS, sitePages: 1, sites: 2, siteUserPages: 1, siteUserRecords: 1, responseBytes: 1024 }
  assert.equal(await run({ limits, graphPages: [{ value: [{ id: 'other', webUrl: 'https://contoso.sharepoint.com/sites/other' }] }], restPages: [{ value: [{ Id: 1 }] }] }), 1, 'exactly two raw sites and one site-user record at the configured limits save once')
  await assert.rejects(() => run({ limits, graphPages: [{ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/sites?next=2' }, { value: [] }] }), /bounded collection limit/)
  await assert.rejects(() => run({ limits: { ...limits, sites: 1 }, graphPages: [{ value: [{ id: 'other', webUrl: 'https://contoso.sharepoint.com/sites/other' }] }] }), /bounded record limit/)
  await assert.rejects(() => run({ limits: { ...limits, collectorDeadlineMs: 0 }, graphPages: [{ value: [] }] }), /bounded wall-clock deadline/)
  await assert.rejects(() => run({ limits, graphPages: [{ value: [{ id: 'other', webUrl: 'https://contoso.sharepoint.com/sites/other' }] }], restPages: [{ value: [], '@odata.nextLink': 'https://contoso.sharepoint.com/sites/other/_api/web/siteusers?next=2' }] }), /could not be collected completely/)
  await assert.rejects(() => run({ limits, graphPages: [{ value: [{ id: 'other', webUrl: 'https://contoso.sharepoint.com/sites/other' }] }], restPages: [{ value: [{ Id: 1 }, { Id: 2 }] }] }), /could not be collected completely/)
  await assert.rejects(() => run({ limits: { ...limits, siteUserPages: 2 }, graphPages: [{ value: [{ id: 'other', webUrl: 'https://contoso.sharepoint.com/sites/other' }] }], restPages: [{ value: [], __repeat: true }] }), /could not be collected completely/)
})

test('real syncSharePointSites streams root responses with byte limits and never advances a snapshot on overflow', async () => {
  const encoder = new TextEncoder()
  const tenant: any = { id: 'tenant-1', organizationId: 'org-1', microsoftTenantId: 'microsoft-1', connection: { connectionMode: 'CUSTOMER_MANAGED', clientId: 'client', credentialReference: 'reference' } }
  async function runRoot(chunks: string[], contentLength?: string, observed: { cancelled?: boolean; saves?: number } = {}) {
    let cancelled = false; let saves = 0
    const service = new TenantSyncService({ tenantDomain: { findFirst: async () => ({ name: 'contoso.onmicrosoft.com' }) } } as never, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
    ;(service as any).runSnapshotSync = async (_t: any, _r: string, work: any) => work()
    ;(service as any).saveSnapshot = async () => { saves += 1 }
    const original = globalThis.fetch
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes('/sites/root')) {
        let index = 0
        // A minimal response body records the reader cancellation invoked by
        // the production collector.  This avoids relying on Undici's stream
        // wrapper to forward its internal cancel callback in the test runner.
        return {
          ok: true,
          status: 200,
          headers: new Headers(contentLength ? { 'content-length': contentLength } : undefined),
          body: { getReader: () => ({
            read: async () => { const chunk = chunks[index++]; return chunk === undefined ? { done: true, value: undefined } : { done: false, value: encoder.encode(chunk) } },
            cancel: async () => { cancelled = true; observed.cancelled = true },
            releaseLock: () => undefined,
          }) },
        } as Response
      }
      return new Response('{"value":[]}')
    }) as typeof fetch
    try {
      await (service as any).syncSharePointSites(tenant, 'graph', { ...SHAREPOINT_COLLECTION_LIMITS, responseBytes: 12, sitePages: 1, sites: 1, siteUserPages: 1, siteUserRecords: 1 })
    } finally {
      observed.saves = saves
      observed.cancelled = cancelled || observed.cancelled
      globalThis.fetch = original
    }
    return { cancelled, saves }
  }
  assert.deepEqual(await runRoot(['{"id":"r"}  ']), { cancelled: false, saves: 1 }, 'exact byte limit succeeds')
  const chunkedOverflow: { cancelled?: boolean; saves?: number } = {}
  await assert.rejects(() => runRoot(['{"id":"r"}', '  ', 'x'], undefined, chunkedOverflow), /bounded page-size limit/)
  assert.deepEqual(chunkedOverflow, { cancelled: true, saves: 0 }, 'the actual collector cancels an overflowing chunked response before saving')
  await assert.rejects(() => runRoot(['{"id":"r"}  '], '999'), /bounded page-size limit/)
  const understatedOverflow: { cancelled?: boolean; saves?: number } = {}
  await assert.rejects(() => runRoot(['{"id":"r"}', '  ', 'x'], '1', understatedOverflow), /bounded page-size limit/)
  assert.deepEqual(understatedOverflow, { cancelled: true, saves: 0 })
})

test.skip('legacy SharePoint-resource token failure coverage is superseded by standard least-privilege mode', async () => {
  const tenant: any = { id: 'tenant-1', organizationId: 'org-1', microsoftTenantId: 'microsoft-1', connection: { connectionMode: 'CUSTOMER_MANAGED', clientId: 'client', credentialReference: 'reference' } }
  async function make(mode: 'timeout' | 'token' | 'rest') {
    let transactions = 0; const logs: string[] = []; const tokenHosts: string[] = []; let sawAbort = false
    // This journal is deliberately wired through the real saveSnapshot
    // transaction contract.  Collection failures must happen before the
    // transaction and leave the seeded baseline/evidence untouched.
    const persisted = {
      snapshot: { organizationId: 'org-1', payload: [{ id: 'old-site' }], observedAt: new Date('2026-08-01T00:00:00.000Z') },
      evidence: [{ id: 'old-evidence' }],
      siteRelationships: [{ siteId: 'old-site', userId: 'old-user' }],
    }
    const prisma = {
      tenantDomain: { findFirst: async () => ({ name: 'contoso.onmicrosoft.com' }) },
      $transaction: async (work: (transaction: any) => Promise<unknown>) => {
        transactions += 1
        const before = structuredClone(persisted)
        try {
          return await work({
            $executeRawUnsafe: async () => undefined,
            tenantEntraSnapshot: {
              findUnique: async () => persisted.snapshot,
              upsert: async (input: any) => { persisted.snapshot = { organizationId: 'org-1', payload: input.update.payload, observedAt: input.update.observedAt } },
            },
            changeEvidenceEvent: { createMany: async (input: any) => { persisted.evidence.push(...input.data) } },
          })
        } catch (error) {
          persisted.snapshot = before.snapshot
          persisted.evidence = before.evidence
          persisted.siteRelationships = before.siteRelationships
          throw error
        }
      },
    }
    const service = new TenantSyncService(prisma as never, {
      getTenantSharePointAccessToken: async (input: any) => { tokenHosts.push(input.sharePointHost); if (mode === 'token' && input.sharePointHost === 'contoso-my.sharepoint.com') throw new Error('HTTP 403 RequestDenied correlationId=corr-1 access_token=never password=never Bearer jwt.secret client_secret=never https://user:pass@host/path?sig=never'); return `token-${input.sharePointHost}` },
    } as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
    ;(service as any).runSnapshotSync = async (_t: any, _r: string, work: any) => work()
    ;(service as any).logger = { warn: (message: unknown) => logs.push(String(message)), log: () => undefined, error: () => undefined }
    const original = globalThis.fetch
    globalThis.fetch = (async (url: any, init: any) => {
      const value = String(url)
      if (mode === 'timeout' && value.includes('/sites/root')) return await new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => { sawAbort = true; reject(new Error('request timeout')) }, { once: true }))
      if (value.includes('/sites/root')) return new Response(JSON.stringify({ id: 'root', webUrl: 'https://contoso.sharepoint.com/sites/root' }))
      if (value.includes('/v1.0/sites?')) return new Response(JSON.stringify({ value: [{ id: 'root', webUrl: 'https://contoso.sharepoint.com/sites/root' }, { id: 'my', webUrl: 'https://contoso-my.sharepoint.com/personal/a' }] }))
      if (value.includes('/drive?')) return new Response(JSON.stringify({ quota: {} }))
      if (value.includes('/_api/web/siteusers')) return mode === 'rest' ? new Response('denied access_token=never&sig=never', { status: 401, headers: { 'x-correlation-id': 'corr-1' } }) : new Response(JSON.stringify({ value: [] }))
      throw new Error(`unexpected ${value}`)
    }) as typeof fetch
    let failure = ''
    try {
      await assert.rejects(() => (service as any).syncSharePointSites(tenant, 'graph', { ...SHAREPOINT_COLLECTION_LIMITS, requestTimeoutMs: mode === 'timeout' ? 1 : 20, sitePages: 1, sites: 5, siteUserPages: 1, siteUserRecords: 5, responseBytes: 1024 }), (error: Error) => { failure = error.message; return true })
    } finally { globalThis.fetch = original }
    return { transactions, logs, tokenHosts, sawAbort, failure, persisted }
  }
  const timeout = await make('timeout')
  assert.equal(timeout.sawAbort, true); assert.equal(timeout.transactions, 0)
  const token = await make('token')
  assert.equal(token.transactions, 0); assert.deepEqual(token.tokenHosts.sort(), ['contoso-my.sharepoint.com', 'contoso.sharepoint.com'])
  assert.equal(token.logs.length, 1)
  assert.match(token.logs[0] ?? '', /403|RequestDenied|correlationId/i)
  for (const output of [token.logs.join(' '), token.failure]) assert.doesNotMatch(output, /never|jwt\.secret|user:pass|sig=|Bearer\s+jwt/i)
  assert.deepEqual(token.persisted.snapshot.payload, [{ id: 'old-site' }])
  assert.deepEqual(token.persisted.evidence, [{ id: 'old-evidence' }])
  assert.deepEqual(token.persisted.siteRelationships, [{ siteId: 'old-site', userId: 'old-user' }])
  const rest = await make('rest')
  assert.equal(rest.transactions, 0)
  assert.deepEqual(rest.persisted.snapshot.payload, [{ id: 'old-site' }])
  assert.deepEqual(rest.persisted.evidence, [{ id: 'old-evidence' }])
  assert.deepEqual(rest.persisted.siteRelationships, [{ siteId: 'old-site', userId: 'old-user' }])
  for (const output of [rest.logs.join(' '), rest.failure]) assert.doesNotMatch(output, /never|sig=|Bearer\s+jwt/i)
})

test('a complete Graph SharePoint inventory advances after a historic REST-access 401 without any REST or SharePoint-token call', async () => {
  const saves: any[] = []
  const calls: string[] = []
  const service = new TenantSyncService({} as never, {
    getTenantSharePointAccessToken: async () => { throw new Error('must not request a SharePoint resource token') },
  } as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
  ;(service as any).runSnapshotSync = async (_tenant: any, _resource: string, work: () => Promise<void>) => work()
  ;(service as any).saveSnapshot = async (...args: any[]) => { saves.push(args) }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url)
    if (url.includes('/sites/root')) return new Response(JSON.stringify({ id: 'root', displayName: 'Root', webUrl: 'https://contoso.sharepoint.com' }))
    if (url.includes('/v1.0/sites?')) return new Response(JSON.stringify({ value: [] }))
    throw new Error(`unexpected request ${url}`)
  }) as typeof fetch
  try {
    await (service as any).syncSharePointSites({ id: 'tenant-1', organizationId: 'org-1', microsoftTenantId: 'microsoft-1' }, 'graph-token', { ...SHAREPOINT_COLLECTION_LIMITS, sitePages: 1, sites: 2, responseBytes: 1024 })
  } finally { globalThis.fetch = originalFetch }
  assert.equal(saves.length, 1)
  assert.equal(saves[0]?.[2]?.completeness, 'authoritative_complete')
  assert.equal(saves[0]?.[2]?.rows?.[0]?.siteAccessMetadataState, 'NOT_COLLECTED_LEAST_PRIVILEGE')
  assert.equal(saves[0]?.[2]?.rows?.[0]?.externalSharing, null)
  assert.equal(saves[0]?.[2]?.rows?.[0]?.driveQuota, null)
  assert.equal(calls.some((url) => /_api\/web\/siteusers|\.sharepoint\.com\/\.default|\/sites\/[^?]+\/drive(?:\?|$)/i.test(url)), false)
})

test('retires historic privileged SharePoint access fields without fabricating evidence, while preserving real site changes', async () => {
  let snapshot: any = {
    organizationId: 'org-1',
    observedAt: new Date('2026-08-18T08:00:00.000Z'),
    payload: [{
      id: 'site-1', webUrl: 'https://contoso.sharepoint.com/sites/one', displayName: 'One',
      externalSharing: true, guestsCount: 4, sharingCapability: 'ExternalUserSharingOnly',
      owners: [{ id: 'old-owner' }], siteCollectionAdministrator: 'old-admin', accessMetadata: { privileged: true },
    }],
  }
  const evidenceStore: any[] = [{
    id: 'historic-evidence', source: 'SNAPSHOT_DIFFERENCE', customerTenantId: 'tenant-1',
    beforeState: { externalSharing: true }, afterState: { externalSharing: false },
  }]
  const historicEvidence = structuredClone(evidenceStore)
  const prisma: any = {
    $transaction: async (work: any) => work({
      $executeRawUnsafe: async () => undefined,
      tenantEntraSnapshot: {
        findUnique: async () => snapshot,
        upsert: async (input: any) => {
          snapshot = {
            organizationId: 'org-1',
            observedAt: input.update.observedAt,
            payload: input.update.payload,
          }
        },
      },
      changeEvidenceEvent: {
        createMany: async (input: any) => evidenceStore.push(...input.data),
        findMany: async () => structuredClone(evidenceStore),
      },
    }),
  }
  const service = new TenantSyncService(prisma, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
  const tenant = { id: 'tenant-1', organizationId: 'org-1' }
  const graphOnlyRow = {
    id: 'site-1', webUrl: 'https://contoso.sharepoint.com/sites/one', displayName: 'One',
    externalSharing: null, guestsCount: null, sharingCapability: null,
    owners: null, siteCollectionAdministrator: null, accessMetadata: null,
    siteAccessMetadataState: 'NOT_COLLECTED_LEAST_PRIVILEGE',
  }

  await (service as any).saveSnapshot(tenant, 'SHAREPOINT_SITES', authoritativeSnapshot([graphOnlyRow]))
  assert.deepEqual(await (prisma.$transaction as any)(async (tx: any) => tx.changeEvidenceEvent.findMany()), historicEvidence, 'existing evidence remains byte/record-identical')
  assert.equal(snapshot.payload[0].externalSharing, null)
  assert.equal(snapshot.payload[0].guestsCount, null)
  assert.equal(snapshot.payload[0].owners, null)
  assert.equal(snapshot.payload[0].accessMetadata, null)

  await (service as any).saveSnapshot(tenant, 'SHAREPOINT_SITES', authoritativeSnapshot([{ ...graphOnlyRow, displayName: 'Renamed site' }]))
  assert.equal(evidenceStore.length, 2, 'supported Graph site changes remain evidence')
  assert.deepEqual(evidenceStore[1]?.changedFields, ['displayName'])
})

function scheduledTenant(id: number) {
  return {
    id: `tenant-${String(id).padStart(4, '0')}`,
    organizationId: 'org-1',
    microsoftTenantId: `microsoft-${id}`,
    displayName: `Tenant ${id}`,
    primaryDomain: `tenant-${id}.example.test`,
    status: 'ACTIVE',
    connection: { status: 'CONNECTED' },
    syncStates: [{
      resourceType: 'USERS', status: 'SUCCEEDED',
      lastAttemptAt: new Date('2026-08-15T00:00:00.000Z'),
      lastSuccessfulAt: new Date('2026-08-15T00:00:00.000Z'),
      lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0,
    }],
  }
}

test('actual scheduled service excludes active leases before its 1,000-candidate window and rotates productive work after lock losses', async () => {
  const candidates = Array.from({ length: 1_000 }, (_, index) => scheduledTenant(index + 1))
  const queries: any[] = []
  const prisma = {
    customerTenant: { findMany: async (query: any) => { queries.push(query); return candidates } },
  }
  const service = new TenantSyncService(prisma as never, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
  const attempted: string[] = []
  ;(service as any).syncConnectedTenant = async (tenant: any) => {
    attempted.push(tenant.id)
    return { status: tenant.id === 'tenant-0001' ? 'SKIPPED' : 'SUCCEEDED', failedResources: [] }
  }
  const oldBatch = process.env.SCHEDULED_SYNC_BATCH_SIZE
  const oldScan = process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT
  process.env.SCHEDULED_SYNC_BATCH_SIZE = '25'
  process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT = '1000'
  try {
    const summary = await service.syncDueTenants()
    assert.equal(summary.succeeded, 25)
    assert.equal(summary.skipped, 1)
    assert.equal(attempted.length, 26, 'a lock loser must not consume a productive slot')
    assert.equal(attempted.at(-1), 'tenant-0026')
    const leaseClause = queries[0]?.where?.AND?.[0]?.syncStates?.none
    assert.equal(leaseClause?.resourceType, 'USERS')
    assert.equal(leaseClause?.status, 'RUNNING')
    assert.ok(leaseClause?.lastAttemptAt?.gt instanceof Date, 'active USERS leases are filtered by the database query before take:1000')
    assert.equal(queries[0]?.take, 1000)
  } finally {
    if (oldBatch === undefined) delete process.env.SCHEDULED_SYNC_BATCH_SIZE
    else process.env.SCHEDULED_SYNC_BATCH_SIZE = oldBatch
    if (oldScan === undefined) delete process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT
    else process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT = oldScan
  }
})

test('production scheduled sync invokes the approved identity-risk scheduler contract', async () => {
  const tenant = scheduledTenant(1)
  const requests: any[] = []
  const identityRiskScheduler = {
    runTenant: async (request: any) => {
      requests.push(request)
      return { status: 'OFF', runKey: null, alertDeliveryDisabled: true }
    },
  }
  const service = new TenantSyncService(
    { customerTenant: { findMany: async () => [tenant] } } as never,
    {} as never,
    {} as never,
    {} as never,
    new ChangeEvidenceService({} as never),
    {} as never,
    identityRiskScheduler as never,
    { load: async () => ({ capability: 'UNAVAILABLE', sourceEnvelopes: [] }) } as never,
  )
  ;(service as any).syncConnectedTenant = async () => ({
    status: 'SUCCEEDED',
    failedResources: [],
  })
  const oldBatch = process.env.SCHEDULED_SYNC_BATCH_SIZE
  process.env.SCHEDULED_SYNC_BATCH_SIZE = '1'
  try {
    const summary = await service.syncDueTenants()
    assert.equal(summary.succeeded, 1)
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.organizationId, tenant.organizationId)
    assert.equal(requests[0]?.customerTenantId, tenant.id)
    assert.equal(requests[0]?.engineVersion, 'hawkview-identity-engine/1')
    assert.equal(requests[0]?.catalogVersion, 'hawkview-identity-signals/v1')
    assert.equal(requests[0]?.approvedEvaluator.readiness, 'READY')
    assert.equal(requests[0]?.approvedEvaluator.featureFlags['HV-ID-MBX-001.v1'], true)
    assert.equal(Object.values(requests[0]?.approvedEvaluator.featureFlags).filter(Boolean).length, 1)
    const batch = await requests[0]?.loadSources()
    assert.equal(batch.capability, 'UNAVAILABLE')
    assert.deepEqual(batch.sourceEnvelopes, [])
  } finally {
    if (oldBatch === undefined) delete process.env.SCHEDULED_SYNC_BATCH_SIZE
    else process.env.SCHEDULED_SYNC_BATCH_SIZE = oldBatch
  }
})

test('targeted retry maps Named Locations to its exact tenant-level Graph collector only', async () => {
  const service = new TenantSyncService({} as never, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
  const calls: Array<{ resource: string; endpoint: string; token: string }> = []
  ;(service as any).syncEntraCollection = async (
    _tenant: unknown,
    token: string,
    resource: string,
    endpoint: string,
  ) => { calls.push({ resource, endpoint, token }) }
  ;(service as any).syncSharePointSites = async () => {
    throw new Error('SharePoint must not run for a Named Locations retry.')
  }
  const tenant = {
    id: 'tenant-1', organizationId: 'org-1', microsoftTenantId: 'microsoft-1',
    status: 'ACTIVE', connection: { status: 'CONNECTED' },
  }

  const module = (service as any).targetedTransientRetryModule(
    tenant,
    'graph-token',
    'NAMED_LOCATIONS',
  )
  assert.equal(module?.resource, 'NAMED_LOCATIONS')
  await module?.synchronize()
  assert.deepEqual(calls, [{
    resource: 'NAMED_LOCATIONS',
    endpoint: 'https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations',
    token: 'graph-token',
  }])
  assert.equal(
    (service as any).targetedTransientRetryModule(tenant, 'graph-token', 'USERS'),
    null,
  )
})

test('two actual scheduled service runs share leases without duplicate productive tenants and advance beyond the first batch', async () => {
  const candidates = Array.from({ length: 1_000 }, (_, index) => scheduledTenant(index + 1))
  const prisma = { customerTenant: { findMany: async () => candidates } }
  const active = new Set<string>()
  const completed = new Set<string>()
  const executed: string[] = []
  const makeService = () => {
    const service = new TenantSyncService(prisma as never, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
    ;(service as any).syncConnectedTenant = async (tenant: any) => {
      if (active.has(tenant.id) || completed.has(tenant.id)) return { status: 'SKIPPED', failedResources: [] }
      active.add(tenant.id)
      await new Promise<void>((resolve) => setImmediate(resolve))
      active.delete(tenant.id)
      completed.add(tenant.id)
      executed.push(tenant.id)
      return { status: 'SUCCEEDED', failedResources: [] }
    }
    return service
  }
  const oldBatch = process.env.SCHEDULED_SYNC_BATCH_SIZE
  process.env.SCHEDULED_SYNC_BATCH_SIZE = '25'
  try {
    const [left, right] = await Promise.all([makeService().syncDueTenants(), makeService().syncDueTenants()])
    assert.equal(new Set(executed).size, executed.length, 'a tenant executes productively at most once across concurrent workers')
    assert.equal(executed.length, 50)
    assert.equal(left.succeeded + right.succeeded, 50)
    assert.ok(executed.some((id) => id === 'tenant-0050'), 'later eligible tenants are reached after races')
  } finally {
    if (oldBatch === undefined) delete process.env.SCHEDULED_SYNC_BATCH_SIZE
    else process.env.SCHEDULED_SYNC_BATCH_SIZE = oldBatch
  }
})

test('production USERS lease compare-and-set permits one concurrent claimant, rejects active state, and takes over stale state', async () => {
  const now = new Date('2026-08-18T12:00:00.000Z')
  let row: any = { id: 'users-state', status: 'SUCCEEDED', lastAttemptAt: new Date('2026-08-18T11:00:00.000Z') }
  const prisma: any = {
    syncState: {
      findUnique: async () => row,
      updateMany: async (args: any) => {
        const allowed = row && (row.status !== 'RUNNING' || !row.lastAttemptAt || row.lastAttemptAt < args.where.OR[2].lastAttemptAt.lt)
        if (!allowed) return { count: 0 }
        row = { ...row, ...args.data }
        return { count: 1 }
      },
      create: async (args: any) => { if (row) throw new Error('unique'); row = { id: 'new-users-state', ...args.data } },
    },
  }
  const tenant = { id: 'tenant-1', organizationId: 'org-1' }
  const [left, right] = await Promise.all([claimTenantUsersLease(prisma, tenant, now), claimTenantUsersLease(prisma, tenant, now)])
  assert.deepEqual([left.claimed, right.claimed].sort(), [false, true])
  assert.equal(row.status, 'RUNNING')
  const active = await claimTenantUsersLease(prisma, tenant, new Date(now.getTime() + 1_000))
  assert.equal(active.claimed, false)
  row.lastAttemptAt = new Date(now.getTime() - 16 * 60_000)
  const stale = await claimTenantUsersLease(prisma, tenant, now)
  assert.equal(stale.claimed, true)
  row = null
  const [created, createRace] = await Promise.all([claimTenantUsersLease(prisma, tenant, now), claimTenantUsersLease(prisma, tenant, now)])
  assert.deepEqual([created.claimed, createRace.claimed].sort(), [false, true], 'unique create race produces one durable lease')
})

test('actual license snapshot transaction rolls back inventory, evidence, and baseline together before a retry commits once', async () => {
  const committed: { licenses: any[]; evidence: any[]; snapshot: any } = { licenses: [], evidence: [], snapshot: null }
  let failPoint: 'baseline' | 'evidence' | null = 'baseline'
  const prisma: any = {
    $transaction: async (callback: any) => {
      const draft = { licenses: structuredClone(committed.licenses), evidence: structuredClone(committed.evidence), snapshot: structuredClone(committed.snapshot) }
      const transaction = {
        $executeRawUnsafe: async () => 1,
        tenantLicense: {
          upsert: async (args: any) => {
            const key = args.where.customerTenantId_microsoftSkuId
            const index = draft.licenses.findIndex((row) => row.customerTenantId === key.customerTenantId && row.microsoftSkuId === key.microsoftSkuId)
            const row = { ...(index < 0 ? args.create : draft.licenses[index]), ...(index < 0 ? {} : args.update) }
            if (index < 0) draft.licenses.push(row); else draft.licenses[index] = row
          },
          deleteMany: async () => undefined,
        },
        tenantEntraSnapshot: {
          findUnique: async () => draft.snapshot,
          upsert: async (args: any) => {
            if (failPoint === 'baseline') throw new Error('forced baseline write failure')
            draft.snapshot = { organizationId: 'org-1', payload: args.create.payload, observedAt: args.create.observedAt }
          },
        },
        changeEvidenceEvent: {
          createMany: async (args: any) => {
            if (failPoint === 'evidence') throw new Error('forced evidence write failure')
            draft.evidence.push(...args.data)
          },
        },
      }
      const value = await callback(transaction)
      committed.licenses = draft.licenses
      committed.evidence = draft.evidence
      committed.snapshot = draft.snapshot
      return value
    },
  }
  const service = new TenantSyncService(prisma, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never), {} as never)
  ;(service as any).runSnapshotSync = async (_tenant: any, _resource: string, work: () => Promise<void>) => work()
  const originalFetch = globalThis.fetch
  let capabilityStatus = 'Enabled'
  globalThis.fetch = (async () => new Response(JSON.stringify({ value: [{
    skuId: 'sku-1', skuPartNumber: 'EXAMPLE', consumedUnits: 0,
    prepaidUnits: { enabled: 5 }, capabilityStatus,
    servicePlans: [{ servicePlanId: 'plan-1', servicePlanName: 'EXCHANGE_S_STANDARD', provisioningStatus: 'Success', appliesTo: 'User' }],
  }] }))) as typeof fetch
  try {
    await assert.rejects(() => (service as any).syncLicenses({ id: 'tenant-1', organizationId: 'org-1' }, 'token'), /forced baseline/)
    assert.deepEqual(committed, { licenses: [], evidence: [], snapshot: null })
    failPoint = null
    await (service as any).syncLicenses({ id: 'tenant-1', organizationId: 'org-1' }, 'token')
    assert.equal(committed.licenses.length, 1)
    assert.equal((committed as any).snapshot?.payload?.length, 1)
    const committedSnapshot = structuredClone(committed.snapshot)
    capabilityStatus = 'Suspended'
    failPoint = 'evidence'
    await assert.rejects(() => (service as any).syncLicenses({ id: 'tenant-1', organizationId: 'org-1' }, 'token'), /forced evidence/)
    assert.equal((committed as any).licenses[0]?.capabilityStatus, 'Enabled', 'evidence failure rolls back the pending license update')
    assert.deepEqual(committed.snapshot, committedSnapshot, 'evidence failure rolls back the pending baseline update')
    failPoint = null
    await (service as any).syncLicenses({ id: 'tenant-1', organizationId: 'org-1' }, 'token')
    assert.equal(committed.licenses.length, 1, 'retry is idempotent for the same SKU')
    assert.equal(committed.evidence.length, 1, 'the successful changed-state retry creates one evidence record')
  } finally { globalThis.fetch = originalFetch }
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
