import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant-1', organizationId: 'org-1' }
const owner = {
  customerTenantId: tenant.id, organizationId: tenant.organizationId,
  token: 'owner-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}
const deltaLink = 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=prior'

function fixture(users: Record<string, unknown>[], options: { liveOwner?: boolean | boolean[]; resetDelta?: boolean } = {}) {
  const events: string[] = []
  let ownerChecks = 0
  const directoryUser = {
    upsert: async () => { events.push('user-upsert'); return {} },
    updateMany: async () => { events.push('user-sweep'); return { count: 1 } },
  }
  const prisma = {
    directoryUser,
    $transaction: async (work: unknown) => {
      if (Array.isArray(work)) return Promise.all(work)
      events.push('transaction-start')
      const transaction = {
        directoryUser,
        $executeRawUnsafe: async () => 0,
        $queryRawUnsafe: async (sql: string) => {
          if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
          if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
          if (sql.includes('FROM tenant_sync_visit_leases')) {
            events.push('owner-check')
            const live = Array.isArray(options.liveOwner)
              ? options.liveOwner[ownerChecks]
              : options.liveOwner
            ownerChecks++
            return live ? [{ generation: '4' }] : []
          }
          assert.fail(`Unexpected SQL: ${sql}`)
        },
      }
      try {
        return await (work as (transaction: any) => Promise<unknown>)(transaction)
      } finally {
        events.push('transaction-end')
      }
    },
  }
  const service = new TenantSyncService(
    prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  )
  let pageCount = 0
  ;(service as any).fetchGraphPage = async () => {
    pageCount++
    if (options.resetDelta && pageCount === 1) return new Response(JSON.stringify({
      error: { code: 'syncStateNotFound', message: 'Checkpoint expired.' },
    }), { status: 410, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({
      value: users,
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=next',
    }), { headers: { 'content-type': 'application/json' } })
  }
  const run = (checkpoint: string | null, visitOwner?: typeof owner) =>
    (service as any).synchronizeUsers(tenant, 'synthetic-token', checkpoint,
      true, undefined, undefined, visitOwner)
  return { events, run }
}

test('superseded visit cannot materialize a USERS delta batch', async () => {
  const { events, run } = fixture([{ id: 'user-1', userPrincipalName: 'user@example.test' }])
  const outcome = await run(deltaLink, owner).then(() => null, (error: unknown) => error)
  assert.equal(events.includes('user-upsert'), false)
  assert.equal(events.includes('owner-check'), true)
  assert.ok(outcome instanceof TenantVisitLeaseLostError)
})

test('superseded visit cannot tombstone USERS during a full rebuild', async () => {
  const { events, run } = fixture([])
  const outcome = await run(null, owner).then(() => null, (error: unknown) => error)
  assert.equal(events.includes('user-sweep'), false)
  assert.equal(events.includes('owner-check'), true)
  assert.ok(outcome instanceof TenantVisitLeaseLostError)
})

test('ownerless USERS delta retains its existing materialization path', async () => {
  const { events, run } = fixture([{ id: 'user-1', userPrincipalName: 'user@example.test' }])
  await run(deltaLink)
  assert.deepEqual(events, ['user-upsert'])
})

test('live visit checks ownership in the same transaction as its batch and sweep', async () => {
  const { events, run } = fixture([{ id: 'user-1', userPrincipalName: 'user@example.test' }], { liveOwner: true })
  await run(null, owner)
  assert.deepEqual(events, [
    'transaction-start', 'owner-check', 'user-upsert', 'transaction-end',
    'transaction-start', 'owner-check', 'user-sweep', 'transaction-end',
  ])
})

test('delta 410 rebuild retains the visit owner through its tombstone sweep', async () => {
  const { events, run } = fixture([], { resetDelta: true })
  const outcome = await run(deltaLink, owner).then(() => null, (error: unknown) => error)
  assert.ok(outcome instanceof TenantVisitLeaseLostError)
  assert.equal(events.includes('owner-check'), true)
  assert.equal(events.includes('user-sweep'), false)
})

test('each 250-row USERS batch rechecks ownership before its writes', async () => {
  const users = Array.from({ length: 251 }, (_, index) => ({
    id: `user-${index}`, userPrincipalName: `user-${index}@example.test`,
  }))
  const { events, run } = fixture(users, { liveOwner: [true, false] })
  await assert.rejects(() => run(deltaLink, owner), TenantVisitLeaseLostError)
  assert.equal(events.filter((event) => event === 'owner-check').length, 2)
  assert.equal(events.filter((event) => event === 'user-upsert').length, 250)
  assert.equal(events.includes('user-sweep'), false)
})
