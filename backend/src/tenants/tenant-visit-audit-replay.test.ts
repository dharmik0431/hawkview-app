import assert from 'node:assert/strict'
import test from 'node:test'
import { AuditReconciliationIncompleteError, TenantSyncService } from './tenant-sync.service.js'
import { AUDIT_RECONCILIATION_RESOURCES, type AuditReconciliationResource } from './audit-change-reconciliation.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'
import { HOURLY_INVENTORY_REFRESH_MS, shouldCollectInventoryInTwentyMinuteFullPass,
  shouldRunHourlyInventoryRefresh } from './scheduled-sync-selection.js'

const tenant = { id: 'tenant', organizationId: 'organization' }
const owner = { customerTenantId: tenant.id, organizationId: tenant.organizationId,
  token: 'token', generation: 4n, expiresAt: new Date('2030-01-01') }

function fixture(rows: Array<{ resourceType: AuditReconciliationResource; requestedRevision: string }>, lost = false) {
  const operations: string[] = []
  const writes: unknown[] = []
  const transaction = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
      if (sql.includes('FROM tenant_sync_visit_leases')) return lost ? [] : [{ generation: '4' }]
      if (sql.includes('FROM tenant_audit_reconciliation_work')) {
        assert.deepEqual(args, [tenant.organizationId, tenant.id, 22])
        operations.push('read-pending')
        return rows
      }
      assert.fail(sql)
    },
    tenantAuditReconciliationWork: { updateMany: async (...args: unknown[]) => {
      writes.push(args); return { count: 1 }
    } },
  }
  const states: any[] = []
  const database = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
    syncState: { findMany: async () => states },
  }
  const service: any = new TenantSyncService(database as any, {} as any, {} as any, {} as any, {} as any, {} as any)
  service.logger = { warn: () => operations.push('source-failed') }
  return { service, operations, writes, states }
}

test('successor replays durable requests even when provider returns no new audit events', async () => {
  const { service, operations, writes } = fixture([{ resourceType: 'LICENSES', requestedRevision: '7' }])
  service.syncLicenses = async (target: unknown, token: string, visit: unknown, revision: bigint) => {
    assert.equal(target, tenant); assert.equal(token, 'access'); assert.equal(visit, owner); assert.equal(revision, 7n)
    operations.push('refresh')
  }
  await assert.rejects(service.reconcileDirectoryAuditResources(tenant, 'access', [], owner), AuditReconciliationIncompleteError)
  assert.deepEqual(operations, ['read-pending', 'refresh', 'read-pending'])
  assert.deepEqual(writes, [], 'a fulfilled collector promise is not completion evidence')
})

test('all durable resource kinds dispatch once with their exact owner and revision', async () => {
  const { service, operations } = fixture(AUDIT_RECONCILIATION_RESOURCES.map((resourceType, i) => ({
    resourceType, requestedRevision: String(i + 1),
  })))
  const calls = new Map<string, bigint>()
  const named: Record<string, string> = {
    ORGANIZATION_CONFIGURATION: 'syncOrganizationConfiguration', GROUPS: 'syncGroups', LICENSES: 'syncLicenses',
    DOMAINS: 'syncDomains', DOMAIN_DNS_HEALTH: 'syncDomainDnsHealth', AUTH_REGISTRATIONS: 'syncAuthenticationRegistrations',
    AUTH_METHOD_POLICIES: 'syncAuthenticationMethodPolicy', DIRECTORY_ROLES: 'syncDirectoryRoles',
    SECURITY_DEFAULTS: 'syncSecurityDefaults', EXCHANGE_MAILBOXES: 'syncExchangeMailboxDirectory',
    EXCHANGE_MAILBOX_SETTINGS: 'syncExchangeMailboxSettings', EXCHANGE_MAILBOX_USAGE: 'syncExchangeMailboxUsage',
    EXCHANGE_ACCEPTED_DOMAINS: 'syncExchangeAcceptedDomains', EXCHANGE_MAILBOX_RULES: 'syncExchangeMailboxRules',
    SHAREPOINT_SITES: 'syncSharePointSites', SHAREPOINT_SETTINGS: 'syncSharePointSettings', SHAREPOINT_USAGE: 'syncSharePointUsage',
  }
  for (const [resource, method] of Object.entries(named)) service[method] = async (...args: unknown[]) => {
    assert.ok(args.includes(owner)); calls.set(resource, args.at(-1) as bigint)
    if (resource === 'DOMAINS') service.pendingAuditReconciliationWork = async () => []
  }
  service.syncEntraCollection = async (...args: unknown[]) => {
    assert.equal(args[4], owner); calls.set(args[2] as string, args[5] as bigint)
  }
  await service.reconcileDirectoryAuditResources(tenant, 'access', ['LICENSES', 'LICENSES'], owner)
  assert.equal(calls.size, 22)
  AUDIT_RECONCILIATION_RESOURCES.forEach((resource, i) => assert.equal(calls.get(resource), BigInt(i + 1), resource))
  assert.equal(operations.filter(x => x === 'read-pending').length, 1)
})

test('failed domain refresh keeps dependent DNS pending without reading a stale target list', async () => {
  const { service, writes } = fixture([
    { resourceType: 'DOMAINS', requestedRevision: '2' },
    { resourceType: 'DOMAIN_DNS_HEALTH', requestedRevision: '2' },
  ])
  service.syncDomains = async () => { throw new Error('provider failure') }
  service.syncDomainDnsHealth = async () => assert.fail('stale targets must not be collected')
  await assert.rejects(service.reconcileDirectoryAuditResources(tenant, 'access', [], owner), AuditReconciliationIncompleteError)
  assert.deepEqual(writes, [])
})

test('ordinary failed work remains pending and does not prevent another independent refresh', async () => {
  const { service, operations, writes } = fixture([
    { resourceType: 'GROUPS', requestedRevision: '2' }, { resourceType: 'LICENSES', requestedRevision: '3' },
  ])
  service.syncGroups = async () => { throw new Error('provider failure') }
  service.syncLicenses = async () => operations.push('licenses')
  await assert.rejects(service.reconcileDirectoryAuditResources(tenant, 'access', [], owner), (error: unknown) => {
    assert.ok(error instanceof AuditReconciliationIncompleteError)
    assert.deepEqual(error.failedResources, ['GROUPS'])
    return true
  })
  assert.ok(operations.includes('licenses'))
  assert.deepEqual(writes, [])
})

test('ownership loss at durable selection prevents any provider work', async () => {
  const { service } = fixture([{ resourceType: 'LICENSES', requestedRevision: '1' }], true)
  service.syncLicenses = async () => assert.fail('must not run')
  await assert.rejects(service.reconcileDirectoryAuditResources(tenant, 'access', [], owner), TenantVisitLeaseLostError)
})

test('ownership loss in a replay stops admission of later resources', async () => {
  const { service, writes } = fixture([
    { resourceType: 'GROUPS', requestedRevision: '1' }, { resourceType: 'LICENSES', requestedRevision: '1' },
  ])
  service.syncGroups = async () => { throw new TenantVisitLeaseLostError() }
  service.syncLicenses = async () => assert.fail('must not start after loss')
  await assert.rejects(service.reconcileDirectoryAuditResources(tenant, 'access', [], owner), TenantVisitLeaseLostError)
  assert.deepEqual(writes, [])
})

test('legacy ownerless dispatch never reads the inactive ledger', async () => {
  const { service } = fixture([])
  service.pendingAuditReconciliationWork = async () => assert.fail('legacy path must not read new table')
  let refreshed = 0
  service.syncLicenses = async () => { refreshed++ }
  await service.reconcileDirectoryAuditResources(tenant, 'access', ['LICENSES'])
  assert.equal(refreshed, 1)
})


test('an empty owned M365 poll still dispatches durable reconciliation work', async () => {
  const { service, operations } = fixture([{ resourceType: 'LICENSES', requestedRevision: '9' }])
  service.m365ManagementActivity = { syncTenant: async (target: unknown, visit: unknown) => {
    assert.equal(target, tenant); assert.equal(visit, owner); return []
  } }
  service.syncLicenses = async (...args: unknown[]) => {
    assert.equal(args.at(-1), 9n); operations.push('licenses')
    service.pendingAuditReconciliationWork = async () => []
  }
  assert.deepEqual(await service.syncM365AuditActivity(tenant, 'access', owner), { collectedChanges: 0 })
  assert.deepEqual(operations, ['read-pending', 'licenses'])
})

test('an empty ownerless M365 poll preserves the legacy no-replay behavior', async () => {
  const { service, operations } = fixture([])
  service.m365ManagementActivity = { syncTenant: async () => [] }
  service.pendingAuditReconciliationWork = async () => assert.fail('legacy must not select durable work')
  assert.deepEqual(await service.syncM365AuditActivity(tenant, 'access'), { collectedChanges: 0 })
  assert.deepEqual(operations, [])
})


test('empty Graph then M365 polls do not retry a failed daily-only resource twice in one visit', async () => {
  const { service, operations, states } = fixture([
    { resourceType: 'EXCHANGE_MAILBOX_RULES', requestedRevision: '5' },
  ])
  service.runSnapshotSync = async (_tenant: unknown, _resource: unknown, collect: () => Promise<void>) => collect()
  service.logSyncStart = async () => new Date('2026-01-01T00:00:00Z')
  service.fetchGraphCollection = async () => []
  service.changeEvidence = {
    projectRetainedDirectoryAuditsMissingEvidence: async () => ({ hasMore: false }),
    pruneExpired: async () => {},
  }
  service.repairRetainedDirectoryAuditNotices = async () => ({ hasMore: false })
  service.pruneExpiredDirectoryAuditLogs = async () => {}
  service.m365ManagementActivity = { syncTenant: async () => [] }
  service.syncExchangeMailboxRules = async () => {
    operations.push('rules-attempt')
    states.push({ resourceType: 'EXCHANGE_MAILBOX_RULES', status: 'FAILED',
      lastAttemptAt: new Date(), lastSuccessfulAt: null,
      lastErrorCode: 'MICROSOFT_TRANSIENT', consecutiveFailures: 1 })
    throw new Error('provider failed')
  }
  await assert.rejects(service.syncDirectoryAuditLogs(tenant, 'access', true, owner), AuditReconciliationIncompleteError)
  await assert.rejects(service.syncM365AuditActivity(tenant, 'access', owner), (error: unknown) => {
    assert.ok(error instanceof AuditReconciliationIncompleteError)
    assert.deepEqual(error.failedResources, [])
    assert.deepEqual(error.pendingResources, ['EXCHANGE_MAILBOX_RULES'])
    return true
  })
  assert.equal(operations.filter(item => item === 'read-pending').length, 3)
  assert.equal(operations.filter(item => item === 'rules-attempt').length, 1)
})

test('durable retries retain targeted, anchor and daily failure intervals', async () => {
  const now = new Date('2026-11-14T20:00:00Z')
  const { service } = fixture([])
  const failed = (resourceType: string, minutes: number, code = 'MICROSOFT_TRANSIENT') => ({
    resourceType, status: 'FAILED', lastAttemptAt: new Date(now.getTime() - minutes * 60_000),
    lastSuccessfulAt: null, lastErrorCode: code, consecutiveFailures: 1,
  })
  assert.equal(service.auditReconciliationRetryDue(failed('AUTH_METHOD_POLICIES', 14), now), false)
  assert.equal(service.auditReconciliationRetryDue(failed('AUTH_METHOD_POLICIES', 15), now), true)
  assert.equal(service.auditReconciliationRetryDue(failed('GROUPS', 29), now), false)
  assert.equal(service.auditReconciliationRetryDue(failed('GROUPS', 30), now), true)
  assert.equal(service.auditReconciliationRetryDue(failed('DOMAINS', 59, 'MICROSOFT_PERMISSION_REQUIRED'), now), false)
  assert.equal(service.auditReconciliationRetryDue(failed('DOMAINS', 60, 'MICROSOFT_PERMISSION_REQUIRED'), now), true)
  assert.equal(service.auditReconciliationRetryDue(failed('EXCHANGE_MAILBOX_RULES', 1439), now), false)
  assert.equal(service.auditReconciliationRetryDue(failed('EXCHANGE_MAILBOX_RULES', 1440), now), true)
  assert.equal(service.auditReconciliationRetryDue(failed('SHAREPOINT_SITES', 60, 'MICROSOFT_PERMISSION_REQUIRED'), now), false)
  assert.equal(service.auditReconciliationRetryDue({ ...failed('GROUPS', 60), status: 'RUNNING' }, now), false)
})

test('durable pending replay recovers only clean abandoned attempts after the existing one-hour delay', () => {
  const now = new Date('2026-11-19T20:00:00Z')
  const { service } = fixture([])
  for (const resourceType of AUDIT_RECONCILIATION_RESOURCES) {
    const state = { resourceType, status: 'RUNNING' as const,
      lastAttemptAt: new Date(now.getTime() - HOURLY_INVENTORY_REFRESH_MS),
      lastSuccessfulAt: null, lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0 }
    assert.equal(service.auditReconciliationRetryDue(state, now), true, resourceType)
    assert.equal(service.auditReconciliationRetryDue({ ...state,
      lastAttemptAt: new Date(state.lastAttemptAt.getTime() + 1) }, now), false, resourceType)
    for (const badClock of [null, new Date(NaN), new Date(now.getTime() + 1)]) {
      assert.equal(service.auditReconciliationRetryDue({ ...state, lastAttemptAt: badClock }, now), false)
    }
    for (const badClock of [new Date(NaN), new Date(now.getTime() + 1)]) {
      assert.equal(service.auditReconciliationRetryDue({ ...state, lastSuccessfulAt: badClock }, now), false)
    }
    for (const marker of [{ lastErrorCode: 'PARTIAL_MICROSOFT_RESPONSE' },
      { lastErrorCode: 'MICROSOFT_TRANSIENT' }, { lastErrorMessage: 'partial collection' }]) {
      assert.equal(service.auditReconciliationRetryDue({ ...state, ...marker }, now), false)
    }
    if (resourceType === 'GROUPS') {
      assert.equal(shouldRunHourlyInventoryRefresh(state, now), false,
        'durable replay must not add GROUPS to ordinary hourly selection')
      assert.equal(shouldCollectInventoryInTwentyMinuteFullPass(state, now), false,
        'the correction does not alter the general full-pass RUNNING policy')
    }
  }
})

test('owned empty-page replay leaves recent GROUPS pending and later dispatches the same revision', async () => {
  const { service, states, writes } = fixture([{ resourceType: 'GROUPS', requestedRevision: '6' }])
  states.push({ resourceType: 'GROUPS', status: 'RUNNING', lastAttemptAt: new Date(),
    lastSuccessfulAt: null, lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0 })
  let calls = 0
  service.syncGroups = async (target: unknown, token: string, visit: unknown, revision: bigint) => {
    assert.equal(target, tenant); assert.equal(token, 'access'); assert.equal(visit, owner); assert.equal(revision, 6n)
    calls++
    service.pendingAuditReconciliationWork = async () => []
  }
  await assert.rejects(service.reconcileDirectoryAuditChanges(tenant, 'access', [], owner), AuditReconciliationIncompleteError)
  assert.equal(calls, 0)
  assert.deepEqual(writes, [])
  states[0].lastAttemptAt = new Date(Date.now() - 2 * HOURLY_INVENTORY_REFRESH_MS)
  await service.reconcileDirectoryAuditChanges(tenant, 'access', [], owner)
  assert.equal(calls, 1)
})

test('new provider events preserve immediate collection while old failed work waits', async () => {
  const { service, states } = fixture([{ resourceType: 'GROUPS', requestedRevision: '6' }])
  states.push({ resourceType: 'GROUPS', status: 'FAILED', lastAttemptAt: new Date(),
    lastSuccessfulAt: null, lastErrorCode: 'MICROSOFT_PERMISSION_REQUIRED', consecutiveFailures: 1 })
  const revisions: bigint[] = []
  service.syncGroups = async (...args: unknown[]) => {
    revisions.push(args.at(-1) as bigint)
    service.pendingAuditReconciliationWork = async () => []
  }
  await assert.rejects(service.reconcileDirectoryAuditResources(tenant, 'access', [], owner), AuditReconciliationIncompleteError)
  assert.deepEqual(revisions, [])
  await service.reconcileDirectoryAuditResources(tenant, 'access', ['GROUPS'], owner)
  assert.deepEqual(revisions, [6n])
})


test('owned full Graph collection enqueues new resources before an interrupted replay', async () => {
  const { service } = fixture([])
  const records = [{ id: 'audit-full', activityDateTime: '2026-11-14T20:00:00Z',
    activityDisplayName: 'Change user license' }]
  service.runSnapshotSync = async (_tenant: unknown, _resource: unknown, collect: () => Promise<void>) => collect()
  service.logSyncStart = async () => new Date('2026-01-01T00:00:00Z')
  service.fetchGraphCollection = async () => records
  service.prisma.directoryAuditLog = { findMany: async () => [] }
  let queued = false
  service.persistDirectoryAuditRows = async (_tenant: unknown, _records: unknown, visit: unknown, enqueue: boolean) => {
    assert.equal(visit, owner)
    assert.equal(enqueue, true)
    queued = true
    return { count: 1, requestedResources: ['LICENSES'] }
  }
  service.changeEvidence = {
    projectRetainedDirectoryAuditsMissingEvidence: async () => ({ hasMore: false }),
    pruneExpired: async () => {},
  }
  service.repairRetainedDirectoryAuditNotices = async () => ({ hasMore: false })
  service.pruneExpiredDirectoryAuditLogs = async () => {}
  service.reconcileDirectoryAuditResources = async () => {
    assert.equal(queued, true)
    throw new Error('interrupted after durable enqueue')
  }
  await assert.rejects(service.syncDirectoryAuditLogs(tenant, 'access', false, owner), /interrupted after durable enqueue/)
  assert.equal(queued, true)
})

test('a superseding revision stays visible even when the selected collector resolves', async () => {
  const { service } = fixture([{ resourceType: 'LICENSES', requestedRevision: '9' }])
  service.syncLicenses = async () => {
    service.pendingAuditReconciliationWork = async () => [{ resourceType: 'LICENSES', requestedRevision: 10n }]
  }
  await assert.rejects(service.reconcileDirectoryAuditResources(tenant, 'access', [], owner), (error: unknown) => {
    assert.ok(error instanceof AuditReconciliationIncompleteError)
    assert.deepEqual(error.failedResources, [])
    assert.deepEqual(error.pendingResources, ['LICENSES'])
    return true
  })
})
