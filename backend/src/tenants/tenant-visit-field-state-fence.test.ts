import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant', organizationId: 'organization' }
const owner = {
  organizationId: tenant.organizationId, customerTenantId: tenant.id,
  token: 'owner-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

function fixture(live: boolean) {
  const events: string[] = []
  let inTransaction = false
  const transaction = {
    $queryRawUnsafe: async (sql: string) => {
      assert.equal(inTransaction, true)
      if (sql.includes('FROM organizations')) { events.push('organization-lock'); return [{ id: tenant.organizationId }] }
      if (sql.includes('FROM customer_tenants')) { events.push('tenant-lock'); return [{ id: tenant.id }] }
      if (sql.includes('FROM tenant_sync_visit_leases')) {
        events.push('owner-lock')
        return live ? [{ generation: '4' }] : []
      }
      assert.fail(`Unexpected field-state query: ${sql}`)
    },
    tenantCollectionFieldState: {
      upsert: async (args: { create: { fieldKey: string; organizationId: string; customerTenantId: string } }) => {
        assert.equal(inTransaction, true)
        assert.equal(args.create.organizationId, tenant.organizationId)
        assert.equal(args.create.customerTenantId, tenant.id)
        events.push(`transaction-write:${args.create.fieldKey}`)
      },
    },
  }
  const database = {
    syncState: { findMany: async () => { events.push('sync-read'); return [] } },
    tenantEntraSnapshot: { findMany: async () => { events.push('snapshot-read'); return [] } },
    tenantCollectionFieldState: {
      upsert: async () => { assert.equal(inTransaction, false); events.push('legacy-write') },
    },
    $transaction: async <T>(work: (tx: typeof transaction) => Promise<T>): Promise<T> => {
      events.push('transaction')
      inTransaction = true
      try { return await work(transaction) } finally { inTransaction = false }
    },
  }
  const service = new TenantSyncService(database as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  return { service, events }
}

test('scope mismatch rejects field-state refresh before reads or writes', async () => {
  const { service, events } = fixture(true)
  await assert.rejects(
    () => (service as any).refreshCollectionFieldStates(tenant, { ...owner, customerTenantId: 'other' }),
    (error: unknown) => error instanceof TenantVisitLeaseLostError,
  )
  assert.deepEqual(events, [])
})

test('lost owner prevents every materialized field-state write', async () => {
  const { service, events } = fixture(false)
  await assert.rejects(
    () => (service as any).refreshCollectionFieldStates(tenant, owner),
    (error: unknown) => error instanceof TenantVisitLeaseLostError,
  )
  assert.deepEqual(events, [
    'sync-read', 'snapshot-read', 'transaction',
    'organization-lock', 'tenant-lock', 'owner-lock',
  ])
})

test('live owner locks the visit before all field-state writes in one transaction', async () => {
  const { service, events } = fixture(true)
  await (service as any).refreshCollectionFieldStates(tenant, owner)
  assert.deepEqual(events.slice(0, 6), [
    'sync-read', 'snapshot-read', 'transaction',
    'organization-lock', 'tenant-lock', 'owner-lock',
  ])
  const writes = events.slice(6)
  assert.equal(writes.length, 13)
  assert.equal(new Set(writes).size, writes.length)
  assert.ok(writes.every((event) => event.startsWith('transaction-write:')))
})

test('ownerless field-state refresh retains the existing direct write path', async () => {
  const { service, events } = fixture(false)
  await (service as any).refreshCollectionFieldStates(tenant)
  assert.deepEqual(events.slice(0, 2), ['sync-read', 'snapshot-read'])
  assert.equal(events.filter((event) => event === 'legacy-write').length, 13)
  assert.equal(events.includes('transaction'), false)
})
