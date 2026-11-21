import assert from 'node:assert/strict'
import test from 'node:test'
import { claimTenantUsersLease } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant', organizationId: 'organization' }
const owner = {
  organizationId: tenant.organizationId, customerTenantId: tenant.id,
  token: 'owner-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

function fixture(existing: boolean, liveByTransaction: boolean[]) {
  const events: string[] = []
  let transactionNumber = 0
  const database = {
    $transaction: async (work: (transaction: unknown) => Promise<unknown>) => {
      const number = transactionNumber++
      events.push('transaction')
      const transaction = {
        $executeRawUnsafe: async (sql: string) => {
          assert.equal(sql, "SET LOCAL TIME ZONE 'UTC'")
          events.push('utc-set')
          return 0
        },
        $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
          if (sql.includes("current_setting('TimeZone')")) {
            events.push('utc-check')
            return [{ timezone: 'UTC' }]
          }
          if (sql.includes('FROM organizations')) {
            assert.deepEqual(values, [tenant.organizationId])
            events.push('organization-lock')
            return [{ id: tenant.organizationId }]
          }
          if (sql.includes('FROM customer_tenants')) {
            assert.deepEqual(values, [tenant.id, tenant.organizationId])
            events.push('tenant-lock')
            return [{ id: tenant.id }]
          }
          if (sql.includes('FROM tenant_sync_visit_leases')) {
            assert.deepEqual(values, [tenant.id, tenant.organizationId, owner.token, '4'])
            events.push('owner-lock')
            return liveByTransaction[number] ? [{ generation: '4' }] : []
          }
          assert.fail(`Unexpected SQL: ${sql}`)
        },
        syncState: {
          findUnique: async () => {
            events.push('users-read')
            return existing ? { id: 'users-state', deltaLink: null } : null
          },
          updateMany: async () => { events.push('users-claim'); return { count: 1 } },
          create: async () => { events.push('users-create'); return {} },
        },
      }
      return work(transaction)
    },
  }
  const claim = (visitOwner?: typeof owner, clearDeltaLinkOnClaim = false) => claimTenantUsersLease(database as any, tenant, new Date(), visitOwner, clearDeltaLinkOnClaim)
  return { events, claim }
}

test('foreign visit owner cannot inspect or claim USERS', async () => {
  const { events, claim } = fixture(true, [true, true])
  await assert.rejects(() => claim({ ...owner, customerTenantId: 'foreign-tenant' }),
    TenantVisitLeaseLostError)
  assert.deepEqual(events, [])
})

test('superseded visit owner cannot read the existing USERS lease', async () => {
  const { events, claim } = fixture(true, [false])
  await assert.rejects(() => claim(owner), TenantVisitLeaseLostError)
  assert.deepEqual(events, [
    'transaction', 'utc-set', 'utc-check', 'organization-lock', 'tenant-lock', 'owner-lock',
  ])
})

test('takeover between USERS read and update cannot claim the existing row', async () => {
  const { events, claim } = fixture(true, [true, false])
  await assert.rejects(() => claim(owner), TenantVisitLeaseLostError)
  assert.equal(events.filter((event) => event === 'owner-lock').length, 2)
  assert.equal(events.includes('users-read'), true)
  assert.equal(events.includes('users-claim'), false)
})

test('takeover between missing-row read and create is not mistaken for a claim loser', async () => {
  const { events, claim } = fixture(false, [true, false])
  await assert.rejects(() => claim(owner), TenantVisitLeaseLostError)
  assert.equal(events.filter((event) => event === 'owner-lock').length, 2)
  assert.equal(events.includes('users-create'), false)
  assert.equal(events.filter((event) => event === 'users-read').length, 1)
})

test('live owner holds each claim transaction through the USERS update', async () => {
  const { events, claim } = fixture(true, [true, true])
  assert.equal((await claim(owner)).claimed, true)
  assert.equal(events.filter((event) => event === 'owner-lock').length, 2)
  assert.ok(events.lastIndexOf('owner-lock') < events.indexOf('users-claim'))
})

test('ownerless USERS claim preserves its existing path', async () => {
  const { events, claim } = fixture(true, [])
  assert.equal((await claim(undefined)).claimed, true)
  assert.equal(events.includes('owner-lock'), false)
  assert.equal(events.includes('users-claim'), true)
})


test('takeover before a full USERS claim refuses checkpoint invalidation', async () => {
  const { events, claim } = fixture(true, [true, false])
  await assert.rejects(() => claim(owner, true), TenantVisitLeaseLostError)
  assert.equal(events.includes('users-claim'), false)
})
