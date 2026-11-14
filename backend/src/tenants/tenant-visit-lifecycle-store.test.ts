import assert from 'node:assert/strict'
import test from 'node:test'
import { createTenantVisitLifecycleStore } from './tenant-visit-lifecycle-store.js'

const scope = { organizationId: 'organization', customerTenantId: 'tenant' }
const expiresAt = new Date('2030-01-01')

test('lifecycle acquisition, renewal and release use bounded transactions and exact lease identity', async () => {
  const transactions: Array<{ settings: string[]; queries: Array<{ sql: string; values: unknown[] }> }> = []
  const database = {
    $transaction: async (work: (transaction: any) => Promise<unknown>, options: unknown) => {
      assert.deepEqual(options, { maxWait: 2000, timeout: 5000 })
      const calls = { settings: [] as string[], queries: [] as Array<{ sql: string; values: unknown[] }> }
      transactions.push(calls)
      return work({
        $executeRawUnsafe: async (sql: string) => { calls.settings.push(sql); return 0 },
        $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
          calls.queries.push({ sql, values })
          if (sql.includes('FROM organizations')) return [{ id: scope.organizationId }]
          if (sql.includes('FROM customer_tenants')) return [{ id: scope.customerTenantId }]
          return [{ generation: '3', expiresAt }]
        },
      })
    },
  }
  const store = createTenantVisitLifecycleStore(database as any)
  const owner = await store.acquire(scope, 900_000)
  assert.ok(owner)
  assert.equal(owner.generation, 3n)
  assert.deepEqual(await store.renew(owner, 900_000), owner)
  assert.equal(await store.release(owner), true)
  assert.equal(transactions.length, 3)
  for (const tx of transactions) {
    assert.deepEqual(tx.settings, ["SET LOCAL lock_timeout = '1s'", "SET LOCAL statement_timeout = '2s'"])
  }
  assert.deepEqual(transactions[1].queries[0].values, [scope.customerTenantId, scope.organizationId, owner.token, '3', '900000'])
  assert.deepEqual(transactions[2].queries[0].values, [scope.customerTenantId, scope.organizationId, owner.token, '3'])
  assert.match(transactions[1].queries[0].sql, /expires_at > clock_timestamp\(\)/)
  assert.match(transactions[2].queries[0].sql, /owner_token=\$3::uuid AND generation=\$4::bigint/)
})

for (const error of [
  Object.assign(new Error('lock timeout'), { code: '55P03' }),
  Object.assign(new Error('raw query lock timeout'), { code: 'P2010', meta: { code: '55P03' } }),
  Object.assign(new Error('adapter lock timeout'), { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '55P03' } } } }),
]) {
  test(`admission returns busy after rolling back exact ${error.message}`, async () => {
    let rolledBack = false
    const store = createTenantVisitLifecycleStore({
      $transaction: async (work: any) => {
        try {
          return await work({
            $executeRawUnsafe: async () => 0,
            $queryRawUnsafe: async () => { throw error },
          })
        } catch (failure) { rolledBack = true; throw failure }
      },
    } as any)
    assert.equal(await store.acquire(scope, 900_000), null)
    assert.equal(rolledBack, true)
  })
}

for (const phase of ['query', 'start', 'commit', 'rollback'] as const) {
  test(`admission propagates ${phase} uncertainty instead of pretending it is busy`, async () => {
    const error = Object.assign(new Error(`synthetic ${phase} uncertainty`), { code: phase === 'query' ? '08006' : '55P03' })
    const store = createTenantVisitLifecycleStore({
      $transaction: async (work: any) => {
        if (phase === 'start') throw error
        const result = await work({
          $executeRawUnsafe: async () => 0,
          $queryRawUnsafe: async (sql: string) => {
            if (phase === 'query') throw error
            if (phase === 'rollback') throw Object.assign(new Error('original lock failure'), { code: '55P03' })
            if (sql.includes('FROM organizations')) return [{ id: scope.organizationId }]
            if (sql.includes('FROM customer_tenants')) return [{ id: scope.customerTenantId }]
            return [{ generation: '3', expiresAt }]
          },
        }).catch((failure: unknown) => { throw phase === 'rollback' ? error : failure })
        if (phase === 'commit') throw error
        return result
      },
    } as any)
    await assert.rejects(store.acquire(scope, 900_000), failure => failure === error)
  })
}
