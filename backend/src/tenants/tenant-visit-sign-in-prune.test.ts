import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant', organizationId: 'organization' }
const cutoff = new Date('2030-01-01T00:00:00Z')
const owner = {
  organizationId: tenant.organizationId, customerTenantId: tenant.id,
  token: 'owner-token', generation: 4n, expiresAt: new Date('2030-01-02T00:00:00Z'),
}

function serviceWithPrisma(prisma: object) {
  return new TenantSyncService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any)
}

test('optional sign-in prune rejects a foreign owner before database work', async () => {
  const service = serviceWithPrisma({
    $transaction: async () => assert.fail('foreign owner opened transaction'),
    signInLog: { deleteMany: async () => assert.fail('foreign owner deleted rows') },
  })
  await assert.rejects(
    () => (service as any).pruneExpiredSignInLogs(tenant, cutoff, { ...owner, customerTenantId: 'other' }),
    (error: unknown) => error instanceof TenantVisitLeaseLostError,
  )
})

test('optional sign-in prune does not delete rows after visit loss', async () => {
  const operations: string[] = []
  const service = serviceWithPrisma({
    $transaction: async (work: (transaction: any) => Promise<unknown>) => work({
      $queryRawUnsafe: async (query: string) => {
        operations.push(query.includes('organizations') ? 'organization' :
          query.includes('customer_tenants') ? 'tenant' : 'lease')
        return query.includes('tenant_sync_visit_leases') ? [] : [{ id: 'synthetic' }]
      },
      signInLog: { deleteMany: async () => assert.fail('lost owner deleted rows') },
    }),
  })
  await assert.rejects(
    () => (service as any).pruneExpiredSignInLogs(tenant, cutoff, owner),
    (error: unknown) => error instanceof TenantVisitLeaseLostError,
  )
  assert.deepEqual(operations, ['organization', 'tenant', 'lease'])
})

test('optional sign-in prune checks live ownership before deletion in one transaction', async () => {
  const operations: string[] = []
  const service = serviceWithPrisma({
    $transaction: async (work: (transaction: any) => Promise<unknown>) => work({
      $queryRawUnsafe: async (query: string) => {
        operations.push(query.includes('organizations') ? 'organization' :
          query.includes('customer_tenants') ? 'tenant' : 'lease')
        return query.includes('tenant_sync_visit_leases') ? [{ generation: '4' }] : [{ id: 'synthetic' }]
      },
      signInLog: { deleteMany: async (args: unknown) => {
        operations.push('delete')
        assert.deepEqual(args, { where: { customerTenantId: tenant.id, expiresAt: { lte: cutoff } } })
      } },
    }),
    signInLog: { deleteMany: async () => assert.fail('unguarded deletion') },
  })
  await (service as any).pruneExpiredSignInLogs(tenant, cutoff, owner)
  assert.deepEqual(operations, ['organization', 'tenant', 'lease', 'delete'])
})

test('ownerless sign-in prune keeps the direct deletion path', async () => {
  const operations: string[] = []
  const service = serviceWithPrisma({
    $transaction: async () => assert.fail('legacy prune opened transaction'),
    signInLog: { deleteMany: async (args: unknown) => {
      operations.push('delete')
      assert.deepEqual(args, { where: { customerTenantId: tenant.id, expiresAt: { lte: cutoff } } })
    } },
  })
  await (service as any).pruneExpiredSignInLogs(tenant, cutoff)
  assert.deepEqual(operations, ['delete'])
})
