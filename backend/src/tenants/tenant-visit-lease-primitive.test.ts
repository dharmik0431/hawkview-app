import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'
import { assertTenantVisitLeaseOwner } from './tenant-visit-lease-store.js'

const owner = {
  organizationId: 'organization', customerTenantId: 'tenant', token: 'token',
  generation: 3n, expiresAt: new Date('2026-10-30T23:00:00Z'),
}

test('visit write assertion locks the exact organization, tenant and live owner in order', async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const transaction = {
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
      queries.push({ sql, values })
      if (sql.includes('FROM organizations')) return [{ id: owner.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: owner.customerTenantId }]
      if (sql.includes('FROM tenant_sync_visit_leases')) return [{ generation: '3' }]
      assert.fail(`Unexpected lease query: ${sql}`)
    },
  }

  await assert.doesNotReject(assertTenantVisitLeaseOwner(transaction as any, owner))
  assert.equal(queries.length, 3)
  assert.match(queries[0].sql, /FROM organizations.*FOR KEY SHARE/s)
  assert.deepEqual(queries[0].values, [owner.organizationId])
  assert.match(queries[1].sql, /FROM customer_tenants.*FOR NO KEY UPDATE/s)
  assert.deepEqual(queries[1].values, [owner.customerTenantId, owner.organizationId])
  assert.match(queries[2].sql, /FROM tenant_sync_visit_leases.*expires_at > clock_timestamp\(\).*FOR SHARE/s)
  assert.deepEqual(queries[2].values,
    [owner.customerTenantId, owner.organizationId, owner.token, '3'])
})

test('visit write assertion rejects a missing scope or superseded owner before materialization', async () => {
  for (const missing of ['organization', 'tenant', 'owner'] as const) {
    const visited: string[] = []
    const transaction = {
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FROM organizations')) {
          visited.push('organization')
          return missing === 'organization' ? [] : [{ id: owner.organizationId }]
        }
        if (sql.includes('FROM customer_tenants')) {
          visited.push('tenant')
          return missing === 'tenant' ? [] : [{ id: owner.customerTenantId }]
        }
        if (sql.includes('FROM tenant_sync_visit_leases')) {
          visited.push('owner')
          return missing === 'owner' ? [] : [{ generation: '3' }]
        }
        assert.fail(`Unexpected lease query: ${sql}`)
      },
    }
    await assert.rejects(assertTenantVisitLeaseOwner(transaction as any, owner),
      (error: unknown) => error instanceof TenantVisitLeaseLostError)
    assert.deepEqual(visited, ['organization', 'tenant', 'owner'].slice(0, visited.length))
    assert.equal(visited.at(-1), missing)
  }
})
