import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const owner = {
  organizationId: 'organization', customerTenantId: 'tenant', token: 'owner-token',
  generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

function statusFixture(live: boolean) {
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
      if (sql.includes("current_setting('TimeZone')")) { events.push('utc-read'); return [{ timezone: 'UTC' }] }
      assert.fail(`Unexpected status query: ${sql}`)
    },
    $executeRawUnsafe: async (sql: string) => {
      assert.equal(inTransaction, true)
      assert.equal(sql, "SET LOCAL TIME ZONE 'UTC'")
      events.push('utc-set')
    },
  }
  const database = {
    $transaction: async <T>(work: (tx: typeof transaction) => Promise<T>): Promise<T> => {
      events.push('transaction')
      inTransaction = true
      try { return await work(transaction) } finally { inTransaction = false }
    },
  }
  const service = new TenantSyncService(database as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  return { service, database, transaction, events, isInTransaction: () => inTransaction }
}

test('lost visit owner stops a resource status write before callback or UTC mutation', async () => {
  for (const resource of ['DOMAINS', 'USERS']) {
    const fixture = statusFixture(false)
    await assert.rejects(
      () => (fixture.service as any).withSnapshotUtc(resource, async () => {
        fixture.events.push('status-write')
      }, owner),
      (error: unknown) => error instanceof TenantVisitLeaseLostError,
    )
    assert.deepEqual(fixture.events,
      ['transaction', 'organization-lock', 'tenant-lock', 'owner-lock'])
  }
})

test('live visit owner checks the same transaction before resource status and UTC work', async () => {
  for (const resource of ['DOMAINS', 'USERS']) {
    const fixture = statusFixture(true)
    await (fixture.service as any).withSnapshotUtc(resource, async (tx: unknown) => {
      assert.equal(tx, fixture.transaction)
      assert.equal(fixture.isInTransaction(), true)
      fixture.events.push('status-write')
    }, owner)
    assert.deepEqual(fixture.events, resource === 'USERS'
      ? ['transaction', 'organization-lock', 'tenant-lock', 'owner-lock', 'utc-set', 'utc-read', 'status-write']
      : ['transaction', 'organization-lock', 'tenant-lock', 'owner-lock', 'status-write'])
  }
})

test('ownerless DOMAINS status retains its existing direct database path', async () => {
  const fixture = statusFixture(false)
  await (fixture.service as any).withSnapshotUtc('DOMAINS', async (db: unknown) => {
    assert.equal(db, fixture.database)
    fixture.events.push('status-write')
  })
  assert.deepEqual(fixture.events, ['status-write'])
})
