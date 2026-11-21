import assert from 'node:assert/strict'
import test from 'node:test'
import { DIRECTORY_ROLE_URL } from './directory-role-collector.js'
import { TenantSyncService } from './tenant-sync.service.js'

const tenant = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  microsoftTenantId: '33333333-3333-4333-8333-333333333333',
}
const owner = {
  customerTenantId: tenant.id, organizationId: tenant.organizationId,
  token: '44444444-4444-4444-8444-444444444444', generation: 4n,
  expiresAt: new Date('2030-01-01T00:00:00Z'),
}

function legacyService() {
  const transaction = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
      if (sql.includes('FROM tenant_sync_visit_leases')) return [{ generation: owner.generation.toString() }]
      if (sql.includes('pg_advisory_xact_lock_shared')) return [{ locked: 1 }]
      if (sql.includes('FROM platform_microsoft_connectors')) return []
      if (sql.includes('FROM customer_tenants')) return [{ status: 'ACTIVE' }]
      if (sql.includes('FROM tenant_connections')) return [{ status: 'CONNECTED', mode: 'CUSTOMER_MANAGED', incarnation: null }]
      if (sql.includes('FROM sync_states')) return [{ role_scope_incarnation: null, role_scope_version: null }]
      assert.fail(`Unexpected SQL: ${sql}`)
    },
  }
  const prisma = { $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction) }
  return new TenantSyncService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any)
}

test('customer-managed Directory Roles fallback forwards an optional visit owner to generic materialization', async () => {
  const service = legacyService()
  const calls: unknown[][] = []
  ;(service as any).syncEntraCollection = async (...args: unknown[]) => { calls.push(args) }

  await (service as any).syncDirectoryRoles(tenant, 'synthetic-token', owner)
  assert.deepEqual(calls, [[tenant, 'synthetic-token', 'DIRECTORY_ROLES', DIRECTORY_ROLE_URL, owner, undefined]])

  calls.length = 0
  await (service as any).syncDirectoryRoles(tenant, 'synthetic-token')
  assert.deepEqual(calls, [[tenant, 'synthetic-token', 'DIRECTORY_ROLES', DIRECTORY_ROLE_URL, undefined, undefined]])
})

test('incremental Directory Roles dispatch forwards the visit owner', async () => {
  const service = legacyService()
  const calls: unknown[][] = []
  ;(service as any).syncDirectoryRoles = async (...args: unknown[]) => { calls.push(args) }
  const inventoryModule = (service as any).incrementalInventoryModule(tenant, 'synthetic-token', 'DIRECTORY_ROLES', owner)
  assert.equal(inventoryModule.resource, 'DIRECTORY_ROLES')
  await inventoryModule.synchronize()
  assert.deepEqual(calls, [[tenant, 'synthetic-token', owner]])
})

test('audit reconciliation Directory Roles dispatch forwards the visit owner', async () => {
  const service = legacyService()
  const calls: unknown[][] = []
  ;(service as any).syncDirectoryRoles = async (...args: unknown[]) => { calls.push(args) }
  ;(service as any).pendingAuditReconciliationWork = async () => []
  await (service as any).reconcileDirectoryAuditResources(
    tenant, 'synthetic-token', ['DIRECTORY_ROLES'], owner,
  )
  assert.deepEqual(calls, [[tenant, 'synthetic-token', owner]])
})


test('customer-managed Directory Roles fallback forwards the exact requested audit revision', async () => {
  const service = legacyService()
  const calls: unknown[][] = []
  ;(service as any).syncEntraCollection = async (...args: unknown[]) => { calls.push(args) }
  await (service as any).syncDirectoryRoles(tenant, 'synthetic-token', owner, 4n)
  assert.deepEqual(calls, [[tenant, 'synthetic-token', 'DIRECTORY_ROLES', DIRECTORY_ROLE_URL, owner, 4n]])
})
