import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const microsoftTenantId = '11111111-2222-3333-4444-555555555555'
const tenant = { id: 'tenant-domains', organizationId: 'organization-domains', microsoftTenantId }
const owner = {
  customerTenantId: tenant.id, organizationId: tenant.organizationId,
  token: 'visit-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

test('DOMAINS cannot replace inventory or mark success after visit takeover', async () => {
  const events: string[] = []
  let ownerChecks = 0
  const transaction = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
      if (sql.includes('FROM tenant_sync_visit_leases')) {
        events.push('owner-check')
        return ++ownerChecks === 1 ? [{ generation: '4' }] : []
      }
      assert.fail(`Unexpected SQL: ${sql}`)
    },
    syncState: {
      upsert: async () => { events.push('running'); return { lastSuccessfulAt: null } },
      update: async () => { events.push('terminal') },
    },
    tenantDomain: {
      upsert: async () => { events.push('domain-upsert') },
      deleteMany: async () => { events.push('domain-delete') },
    },
    customerTenant: { update: async () => { events.push('tenant-update') } },
    tenantEntraSnapshot: { upsert: async () => { events.push('snapshot-upsert') } },
    changeEvidenceEvent: { createMany: async () => { events.push('evidence-write') } },
  }
  const prisma = { $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction) }
  const service = new TenantSyncService(prisma as any, {} as any, {} as any,
    { resolveIncident: async () => { events.push('resolve') },
      publishIncident: async () => { events.push('publish') } } as any,
    {} as any, {} as any)
  ;(service as any).fetchGraphPage = async () => {
    events.push('provider-page')
    return new Response(JSON.stringify({ value: [{
      id: microsoftTenantId, displayName: 'Example organization',
      verifiedDomains: [{ name: 'example.test', isDefault: true, isInitial: false }],
    }] }), { status: 200 })
  }

  await assert.rejects(() => (service as any).syncDomains(tenant, 'synthetic-token', owner),
    TenantVisitLeaseLostError)
  assert.deepEqual(events, ['owner-check', 'running', 'provider-page', 'owner-check'])
})

test('between-inventory DOMAINS forwards the visit owner', async () => {
  const service = new TenantSyncService({} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  const calls: unknown[][] = []
  ;(service as any).syncDomains = async (...args: unknown[]) => { calls.push(args) }
  const module = (service as any).incrementalInventoryModule(
    tenant, 'synthetic-token', 'DOMAINS', owner,
  )
  assert.equal(module.resource, 'DOMAINS')
  await module.synchronize()
  assert.deepEqual(calls, [[tenant, 'synthetic-token', owner]])
})

test('audit-triggered DOMAINS reentry forwards the visit owner', async () => {
  const service = new TenantSyncService({} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  const calls: unknown[][] = []
  ;(service as any).syncDomains = async (...args: unknown[]) => { calls.push(args) }
  ;(service as any).pendingAuditReconciliationWork = async () => []
  await (service as any).reconcileDirectoryAuditResources(
    tenant, 'synthetic-token', ['DOMAINS'], owner,
  )
  assert.deepEqual(calls, [[tenant, 'synthetic-token', owner]])
})

function domainReceiptHarness(responseStatus = 200, returnedTenant = microsoftTenantId) {
  const events: Array<{ kind: string; transaction: number }> = []
  let sequence = 0
  let active = 0
  const record = (kind: string) => { events.push({ kind, transaction: active }) }
  const transaction = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
      if (sql.includes('FROM tenant_sync_visit_leases')) return [{ generation: '4' }]
      assert.fail(`Unexpected SQL: ${sql}`)
    },
    $executeRawUnsafe: async () => {},
    syncState: {
      upsert: async () => { record('running'); return { lastSuccessfulAt: null } },
      update: async ({ data }: { data: { status: string } }) => {
        record(data.status)
        return { consecutiveFailures: 1 }
      },
    },
    tenantDomain: {
      upsert: async () => { record('domain-upsert') },
      deleteMany: async () => { record('domain-delete') },
    },
    customerTenant: { update: async () => { record('tenant-update') } },
    tenantEntraSnapshot: {
      findUnique: async () => null,
      upsert: async () => { record('snapshot') },
    },
    changeEvidenceEvent: { createMany: async () => { record('evidence') } },
    tenantAuditReconciliationWork: {
      updateMany: async ({ where, data }: {
        where: Record<string, unknown>; data: { completedRevision: bigint }
      }) => {
        assert.deepEqual(where, {
          organizationId: tenant.organizationId, customerTenantId: tenant.id,
          resourceType: 'DOMAINS', requestedRevision: 7n, completedRevision: { lt: 7n },
        })
        assert.equal(data.completedRevision, 7n)
        record('audit-receipt')
        return { count: 1 }
      },
    },
  }
  const database = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => {
      active = ++sequence
      try { return await work(transaction) } finally { active = 0 }
    },
  }
  const service = new TenantSyncService(database as any, {} as any, {} as any,
    { resolveIncident: async () => { record('resolve') },
      publishIncident: async () => { record('publish') } } as any,
    { buildSnapshotDifferenceEvidence: () => [{ sourceEventId: 'synthetic' }] } as any,
    {} as any) as any
  service.fetchGraphPage = async () => {
    record('provider')
    return new Response(JSON.stringify({ value: [{
      id: returnedTenant, displayName: 'Example organization',
      verifiedDomains: [{ name: 'example.test', isDefault: true, isInitial: false }],
    }] }), { status: responseStatus })
  }
  return { service, events }
}

test('DOMAINS carries its exact audit revision into the inventory and snapshot transaction', async () => {
  const { service, events } = domainReceiptHarness()
  await service.syncDomains(tenant, 'synthetic-token', owner, 7n)
  const writes = events.filter(event => [
    'evidence', 'domain-upsert', 'domain-delete', 'tenant-update', 'snapshot', 'audit-receipt',
  ].includes(event.kind))
  assert.deepEqual(writes.map(event => event.kind), [
    'evidence', 'domain-upsert', 'domain-delete', 'tenant-update', 'snapshot', 'audit-receipt',
  ])
  assert.ok(writes.every(event => event.transaction === writes[0].transaction && event.transaction > 0),
    'domain projection, complete snapshot and request receipt must share one transaction')
  assert.ok(events.findIndex(event => event.kind === 'audit-receipt') <
    events.findIndex(event => event.kind === 'SUCCEEDED'))
})

test('ordinary DOMAINS collection has no audit receipt without an explicit revision', async () => {
  const { service, events } = domainReceiptHarness()
  await service.syncDomains(tenant, 'synthetic-token', owner)
  assert.ok(events.some(event => event.kind === 'snapshot'))
  assert.equal(events.some(event => event.kind === 'audit-receipt'), false)
})

test('partial or foreign DOMAINS response cannot acknowledge an audit request', async () => {
  for (const [status, returnedTenant] of [[206, microsoftTenantId], [200, 'other-tenant']] as const) {
    const { service, events } = domainReceiptHarness(status, returnedTenant)
    await assert.rejects(() => service.syncDomains(tenant, 'synthetic-token', owner, 7n))
    assert.equal(events.some(event => ['domain-upsert', 'domain-delete', 'tenant-update',
      'snapshot', 'evidence', 'audit-receipt', 'SUCCEEDED'].includes(event.kind)), false)
  }
})

test('invalid DOMAINS audit receipt refuses before status, provider or inventory work', async () => {
  for (const [suppliedOwner, revision] of [
    [undefined, 7n], [owner, 0n], [owner, -1n], [owner, 9223372036854775808n], [owner, '7'],
  ]) {
    const service = new TenantSyncService({} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any) as any
    service.runSnapshotSync = async () => assert.fail('invalid receipt entered collection')
    await assert.rejects(() => service.syncDomains(tenant, 'synthetic-token', suppliedOwner, revision),
      /TENANT_AUDIT_RECONCILIATION_SNAPSHOT_RECEIPT_INVALID/)
  }
})
