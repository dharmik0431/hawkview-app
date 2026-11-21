import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantVisitLeaseLostError } from '../tenants/tenant-visit-lease-error.js'
import { assertRiskAttemptVisitOwner } from './risk-global-work-store.js'

const owner = {
  organizationId: 'organization', customerTenantId: 'tenant', token: 'token',
  generation: 7n, expiresAt: new Date('2026-11-01T01:00:00Z'),
}

test('risk attempt checks the exact live visit on its own connection in lock order', async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const client = {
    query: async (sql: string, values: unknown[]) => {
      queries.push({ sql, values })
      if (sql.includes('FROM organizations')) return { rows: [{ id: owner.organizationId }] }
      if (sql.includes('FROM customer_tenants')) return { rows: [{ id: owner.customerTenantId }] }
      if (sql.includes('FROM tenant_sync_visit_leases')) return { rows: [{ generation: '7' }] }
      assert.fail(`Unexpected risk visit query: ${sql}`)
    },
  }
  await assertRiskAttemptVisitOwner(client, owner, owner)
  assert.equal(queries.length, 3)
  assert.match(queries[0]!.sql, /FROM organizations.*FOR KEY SHARE/s)
  assert.deepEqual(queries[0]!.values, [owner.organizationId])
  assert.match(queries[1]!.sql, /FROM customer_tenants.*FOR NO KEY UPDATE/s)
  assert.deepEqual(queries[1]!.values, [owner.customerTenantId, owner.organizationId])
  assert.match(queries[2]!.sql, /FROM tenant_sync_visit_leases.*expires_at > clock_timestamp\(\).*FOR SHARE/s)
  assert.deepEqual(queries[2]!.values, [owner.customerTenantId, owner.organizationId, owner.token, '7'])
})

test('risk attempt rejects a foreign scope without touching the database', async () => {
  const client = { query: async () => assert.fail('foreign owner reached risk transaction') }
  for (const scope of [
    { organizationId: 'foreign', customerTenantId: owner.customerTenantId },
    { organizationId: owner.organizationId, customerTenantId: 'foreign' },
  ]) {
    await assert.rejects(assertRiskAttemptVisitOwner(client, scope, owner),
      (error: unknown) => error instanceof TenantVisitLeaseLostError)
  }
})

test('risk attempt refuses missing scope or superseded visit before the head reset', async () => {
  for (const missing of ['organization', 'tenant', 'owner'] as const) {
    const visited: string[] = []
    const client = {
      query: async (sql: string) => {
        if (sql.includes('FROM organizations')) {
          visited.push('organization')
          return { rows: missing === 'organization' ? [] : [{ id: owner.organizationId }] }
        }
        if (sql.includes('FROM customer_tenants')) {
          visited.push('tenant')
          return { rows: missing === 'tenant' ? [] : [{ id: owner.customerTenantId }] }
        }
        if (sql.includes('FROM tenant_sync_visit_leases')) {
          visited.push('owner')
          return { rows: missing === 'owner' ? [] : [{ generation: '7' }] }
        }
        assert.fail(`Unexpected risk visit query: ${sql}`)
      },
    }
    await assert.rejects(assertRiskAttemptVisitOwner(client, owner, owner),
      (error: unknown) => error instanceof TenantVisitLeaseLostError)
    assert.equal(visited.at(-1), missing)
  }
})
