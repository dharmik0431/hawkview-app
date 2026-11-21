import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant-audit', organizationId: 'organization-audit' }
const cutoff = new Date('2030-01-01T00:00:00Z')
const owner = {
  organizationId: tenant.organizationId, customerTenantId: tenant.id,
  token: 'owner-token', generation: 4n, expiresAt: new Date('2030-01-02T00:00:00Z'),
}

function serviceWithPrisma(prisma: object) {
  return new TenantSyncService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any)
}

test('directory audit retention rejects foreign visit scope before database work', async () => {
  const service = serviceWithPrisma({
    $transaction: async () => assert.fail('foreign owner opened transaction'),
    directoryAuditLog: { deleteMany: async () => assert.fail('foreign owner deleted rows') },
  })
  await assert.rejects(
    () => (service as any).pruneExpiredDirectoryAuditLogs(tenant, cutoff, { ...owner, organizationId: 'other' }),
    TenantVisitLeaseLostError,
  )
})

test('directory audit retention refuses deletion after visit loss', async () => {
  const operations: string[] = []
  const service = serviceWithPrisma({
    $transaction: async (work: (transaction: any) => Promise<unknown>) => work({
      $queryRawUnsafe: async (query: string) => {
        operations.push(query.includes('organizations') ? 'organization' :
          query.includes('customer_tenants') ? 'tenant' : 'lease')
        return query.includes('tenant_sync_visit_leases') ? [] : [{ id: 'synthetic' }]
      },
      directoryAuditLog: { deleteMany: async () => assert.fail('lost visitor deleted rows') },
    }),
    directoryAuditLog: { deleteMany: async () => assert.fail('unguarded deletion') },
  })
  await assert.rejects(
    () => (service as any).pruneExpiredDirectoryAuditLogs(tenant, cutoff, owner),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(operations, ['organization', 'tenant', 'lease'])
})

test('directory audit retention locks live owner in the deletion transaction', async () => {
  const operations: string[] = []
  const service = serviceWithPrisma({
    $transaction: async (work: (transaction: any) => Promise<unknown>) => work({
      $queryRawUnsafe: async (query: string) => {
        operations.push(query.includes('organizations') ? 'organization' :
          query.includes('customer_tenants') ? 'tenant' : 'lease')
        return query.includes('tenant_sync_visit_leases') ? [{ generation: '4' }] : [{ id: 'synthetic' }]
      },
      directoryAuditLog: { deleteMany: async (args: unknown) => {
        operations.push('delete')
        assert.deepEqual(args, { where: { customerTenantId: tenant.id, expiresAt: { lte: cutoff } } })
      } },
    }),
    directoryAuditLog: { deleteMany: async () => assert.fail('unguarded deletion') },
  })
  await (service as any).pruneExpiredDirectoryAuditLogs(tenant, cutoff, owner)
  assert.deepEqual(operations, ['organization', 'tenant', 'lease', 'delete'])
})

test('ownerless directory audit retention keeps direct deletion', async () => {
  const service = serviceWithPrisma({
    $transaction: async () => assert.fail('legacy deletion opened transaction'),
    directoryAuditLog: { deleteMany: async (args: unknown) => {
      assert.deepEqual(args, { where: { customerTenantId: tenant.id, expiresAt: { lte: cutoff } } })
    } },
  })
  await (service as any).pruneExpiredDirectoryAuditLogs(tenant, cutoff)
})
