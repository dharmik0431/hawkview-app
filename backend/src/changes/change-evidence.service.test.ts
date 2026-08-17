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
} from './microsoft-admin-change-catalog.js'
import {
  assertGroupRelationshipRefreshComplete,
  authoritativeSnapshot,
  collectMailboxDirectoryPages,
  collectMailboxRuleUsers,
  collectMailboxRules,
  partialSnapshot,
  sharePointSitesSnapshotResult,
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
  const service = new TenantSyncService(prisma, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never))
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
  } as never, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never))
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
  const service = new TenantSyncService(prisma, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never))
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
  const service = new TenantSyncService(prisma, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never))
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
  } as never, {} as never, {} as never, {} as never, new ChangeEvidenceService({} as never))
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

test('documents supported Microsoft administrative evidence and the Unified Audit gap without enabling it', () => {
  assert.equal(MICROSOFT_ADMIN_CHANGE_CATALOG.some((entry) => entry.normalizedEventType.includes('conditional_access')), true)
  assert.equal(MICROSOFT_ADMIN_CHANGE_CATALOG.some((entry) => entry.workload === 'Teams and tenant-wide Microsoft 365 settings' && entry.collectorStatus === 'not_collected'), true)
  assert.equal(UNIFIED_AUDIT_LOG_GAP_REPORT.leastPrivilegeApplicationPermission, 'ActivityFeed.Read (Office 365 Management APIs, not Microsoft Graph)')
  assert.equal(UNIFIED_AUDIT_LOG_GAP_REPORT.adminConsentRequired, true)
  assert.equal(UNIFIED_AUDIT_LOG_GAP_REPORT.status, 'documented_not_enabled')
  assert.match(UNIFIED_AUDIT_LOG_GAP_REPORT.subscriptions, /poll/i)
  assert.match(UNIFIED_AUDIT_LOG_GAP_REPORT.subscriptions, /optional/i)
  assert.match(UNIFIED_AUDIT_LOG_GAP_REPORT.currentActivityFeedUse, /already consented/i)
  assert.equal(DOMAIN_DETAIL_COVERAGE_GAP.requiredApplicationPermission, 'Domain.Read.All')
  assert.equal(DOMAIN_DETAIL_COVERAGE_GAP.decision, 'permission_blocked_not_implemented')
  assert.equal(MICROSOFT_ADMIN_CHANGE_CATALOG.some((entry) => entry.microsoftSource.includes('/domains')), false)
})
