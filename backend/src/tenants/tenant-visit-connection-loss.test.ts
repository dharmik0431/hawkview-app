import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = {
  id: 'tenant', organizationId: 'organization',
  connection: { connectionMode: 'CUSTOMER_MANAGED' },
}
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
      if (sql.includes('FROM organizations')) { events.push('organization-lock'); return [{ id: owner.organizationId }] }
      if (sql.includes('FROM customer_tenants')) { events.push('tenant-lock'); return [{ id: owner.customerTenantId }] }
      if (sql.includes('FROM tenant_sync_visit_leases')) {
        events.push('owner-lock')
        return live ? [{ generation: '4' }] : []
      }
      assert.fail(`Unexpected lease query: ${sql}`)
    },
    customerTenant: { update: async () => { assert.equal(inTransaction, true); events.push('tenant-write') } },
    tenantConnection: { update: async () => { assert.equal(inTransaction, true); events.push('connection-write') } },
  }
  const database = {
    customerTenant: { update: (args: unknown) => ({ kind: 'tenant', args }) },
    tenantConnection: { update: (args: unknown) => ({ kind: 'connection', args }) },
    $transaction: async (work: any) => {
      if (Array.isArray(work)) {
        events.push('legacy-transaction')
        for (const item of work) events.push(`legacy-${item.kind}-write`)
        return work
      }
      events.push('transaction')
      inTransaction = true
      try { return await work(transaction) } finally { inTransaction = false }
    },
  }
  const notifications = {
    publishIncident: async () => { events.push('notice:legacy') },
    publishIncidentInTransaction: async (_input: unknown, visitOwner: typeof owner, actualTransaction: unknown) => {
      assert.equal(visitOwner, owner)
      assert.equal(actualTransaction, transaction)
      assert.equal(inTransaction, true)
      events.push('notice:owner')
    },
  }
  const service = new TenantSyncService(database as any, {} as any, {} as any,
    notifications as any, {} as any, {} as any)
  const mark = (visitOwner?: typeof owner) => (service as any).markConnectionUnavailable(
    tenant, new Error('Synthetic authentication failure.'), undefined, visitOwner)
  return { events, mark }
}

test('customer-managed connection loss rejects an out-of-scope owner before any work', async () => {
  const { events, mark } = fixture(true)
  await assert.rejects(() => mark({ ...owner, customerTenantId: 'other' }),
    (error: unknown) => error instanceof TenantVisitLeaseLostError)
  assert.deepEqual(events, [])
})

test('customer-managed connection loss rejects a superseded owner before status and notice writes', async () => {
  const { events, mark } = fixture(false)
  await assert.rejects(() => mark(owner),
    (error: unknown) => error instanceof TenantVisitLeaseLostError)
  assert.deepEqual(events, ['transaction', 'organization-lock', 'tenant-lock', 'owner-lock'])
})

test('customer-managed connection loss holds the live owner through status writes and passes it to notice', async () => {
  const { events, mark } = fixture(true)
  await mark(owner)
  assert.deepEqual(events, [
    'transaction', 'organization-lock', 'tenant-lock', 'owner-lock',
    'tenant-write', 'connection-write', 'notice:owner',
  ])
})

test('ownerless customer-managed connection loss retains its existing transaction and notice path', async () => {
  const { events, mark } = fixture(false)
  await mark()
  assert.deepEqual(events, [
    'legacy-transaction', 'legacy-tenant-write', 'legacy-connection-write', 'notice:legacy',
  ])
})

test('managed connection loss without captured authority refuses a visit owner without any write', async () => {
  const database = { $transaction: async () => assert.fail('managed publication must not begin') }
  const service = new TenantSyncService(database as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  await assert.rejects(
    () => (service as any).markConnectionUnavailable(
      { ...tenant, connection: { connectionMode: 'HAWKVIEW_MANAGED' } },
      new Error('Synthetic authentication failure.'), undefined, owner,
    ),
    (error: unknown) => error instanceof TenantVisitLeaseLostError,
  )
})
