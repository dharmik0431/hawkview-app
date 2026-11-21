import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant-groups', organizationId: 'organization-groups' }
const owner = {
  customerTenantId: tenant.id, organizationId: tenant.organizationId,
  token: 'visit-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

for (const lostAt of [2, 3] as const) {
  test(`GROUPS takeover before ${lostAt === 2 ? 'definition/snapshot' : 'membership'} transaction blocks stale writes`, async () => {
    const events: string[] = []
    let checks = 0
    const transaction = {
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
        if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
        if (sql.includes('FROM tenant_sync_visit_leases')) {
          events.push('owner-check')
          return ++checks < lostAt ? [{ generation: '4' }] : []
        }
        assert.fail(`Unexpected SQL: ${sql}`)
      },
      $executeRawUnsafe: async () => { events.push('snapshot-lock') },
      syncState: {
        upsert: async () => { events.push('running'); return { lastSuccessfulAt: null } },
        update: async () => { events.push('terminal') },
      },
      tenantEntraSnapshot: {
        findUnique: async () => { events.push('snapshot-read'); return null },
        upsert: async () => { events.push('snapshot-write') },
      },
      changeEvidenceEvent: { createMany: async () => { events.push('evidence-write') } },
      directoryGroup: {
        upsert: async () => { events.push('definition-write') },
        deleteMany: async () => { events.push('definition-prune') },
      },
      directoryGroupMembership: {
        deleteMany: async () => { events.push('membership-delete') },
        createMany: async () => { events.push('membership-create') },
      },
    }
    const prisma = {
      $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
      directoryUser: { findMany: async () => [{ id: 'user-row', microsoftUserId: 'user-1' }] },
      directoryGroup: { findMany: async () => [{ id: 'group-row', microsoftGroupId: 'group-1' }] },
    }
    const service = new TenantSyncService(prisma as any, {} as any, {} as any,
      { resolveIncident: async () => { events.push('resolve') },
        publishIncident: async () => { events.push('publish') } } as any,
      { buildSnapshotDifferenceEvidence: () => [] } as any, {} as any)
    ;(service as any).collectEntraCollection = async (
      _token: string, _resource: string, url: string,
    ) => {
      events.push('provider-page')
      if (url.includes('/owners?')) return []
      if (url.includes('/members?')) return [{ id: 'user-1' }]
      return [{ id: 'group-1', displayName: 'Group One' }]
    }

    await assert.rejects(
      () => (service as any).syncGroups(tenant, 'synthetic-token', owner),
      TenantVisitLeaseLostError,
    )
    assert.equal(checks, lostAt)
    assert.equal(events.includes('membership-delete'), false)
    assert.equal(events.includes('membership-create'), false)
    assert.equal(events.includes('terminal'), false)
    assert.equal(events.includes('publish'), false)
    assert.equal(events.includes('resolve'), false)
    if (lostAt === 2) {
      assert.equal(events.includes('definition-write'), false)
      assert.equal(events.includes('snapshot-write'), false)
      assert.equal(events.includes('snapshot-lock'), false)
    } else {
      assert.equal(events.includes('definition-write'), true)
      assert.equal(events.includes('snapshot-write'), true)
      assert.deepEqual(events.filter((event) => event === 'owner-check'), ['owner-check', 'owner-check', 'owner-check'])
    }
  })
}

test('between-inventory and audit GROUPS dispatch forward the visit owner', async () => {
  const service = new TenantSyncService({} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  const calls: unknown[][] = []
  ;(service as any).syncGroups = async (...args: unknown[]) => { calls.push(args) }
  const module = (service as any).incrementalInventoryModule(
    tenant, 'synthetic-token', 'GROUPS', owner,
  )
  await module.synchronize()
  ;(service as any).pendingAuditReconciliationWork = async () => []
  await (service as any).reconcileDirectoryAuditResources(
    tenant, 'synthetic-token', ['GROUPS'], owner,
  )
  assert.deepEqual(calls, [
    [tenant, 'synthetic-token', owner],
    [tenant, 'synthetic-token', owner],
  ])
})
