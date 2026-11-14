import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantVisitLeaseLostError } from '../tenants/tenant-visit-lease-error.js'
import { persistCompletedAuthenticationWindow } from './authentication-window-collector.js'

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  customerTenantId: '22222222-2222-4222-8222-222222222222',
}
const owner = {
  ...scope,
  token: '33333333-3333-4333-8333-333333333333',
  generation: 7n,
  expiresAt: new Date('2026-09-08T12:05:00Z'),
}
const start = new Date('2026-09-08T11:00:00Z')
const end = new Date('2026-09-08T12:00:00Z')

function fixture(leasePresent = true) {
  const calls: string[] = []
  const prisma: any = {
    $transaction: async (work: (transaction: any) => Promise<unknown>) => {
      calls.push('transaction')
      return work({
        $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
          if (sql.includes('FROM organizations WHERE')) {
            assert.deepEqual(args, [scope.organizationId])
            calls.push('organization-lock')
            return [{ id: scope.organizationId }]
          }
          if (sql.includes('FROM customer_tenants WHERE')) {
            assert.deepEqual(args, [scope.customerTenantId, scope.organizationId])
            calls.push('tenant-lock')
            return [{ id: scope.customerTenantId }]
          }
          if (sql.includes('FROM tenant_sync_visit_leases')) {
            assert.deepEqual(args, [scope.customerTenantId, scope.organizationId, owner.token, '7'])
            calls.push('lease-lock')
            return leasePresent ? [{ generation: '7' }] : []
          }
          if (sql.includes("current_setting('TimeZone')")) {
            calls.push('utc-verification')
            return [{ timezone: 'UTC' }]
          }
          if (sql.includes('FROM tenant_entra_snapshots')) {
            calls.push('snapshot-read')
            return []
          }
          throw new Error(`Unexpected query: ${sql}`)
        },
        $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
          if (sql === "SET LOCAL TIME ZONE 'UTC'") calls.push('utc-setup')
          else if (sql.includes('pg_advisory_xact_lock')) {
            assert.deepEqual(args, [`hawkview:snapshot:${scope.customerTenantId}:SIGN_INS`])
            calls.push('snapshot-lock')
          } else throw new Error(`Unexpected execute: ${sql}`)
        },
        tenantEntraSnapshot: {
          upsert: async () => { calls.push('window-upsert') },
        },
      })
    },
  }
  return { prisma, calls }
}

const persist = (prisma: any, visitOwner?: typeof owner) =>
  persistCompletedAuthenticationWindow(prisma, scope, 'GRAPH_SIGN_INS', start, end, true,
    { events: 0, latestEventAt: null }, visitOwner)

test('a foreign visit owner is rejected before a completed-window transaction', async () => {
  const f = fixture()
  await assert.rejects(() => persist(f.prisma, { ...owner, customerTenantId: 'foreign' }), TenantVisitLeaseLostError)
  assert.deepEqual(f.calls, [])
})

test('a lost visit owner cannot publish a completed authentication window', async () => {
  const f = fixture(false)
  await assert.rejects(() => persist(f.prisma, owner), TenantVisitLeaseLostError)
  assert.deepEqual(f.calls, ['transaction', 'organization-lock', 'tenant-lock', 'lease-lock'])
})

test('a valid owner is locked before UTC setup and completed-window publication', async () => {
  const f = fixture()
  await persist(f.prisma, owner)
  assert.deepEqual(f.calls, [
    'transaction', 'organization-lock', 'tenant-lock', 'lease-lock',
    'utc-setup', 'utc-verification', 'snapshot-lock', 'snapshot-read', 'window-upsert',
  ])
})

test('the ownerless completed-window path retains its existing transaction order', async () => {
  const f = fixture()
  await persist(f.prisma)
  assert.deepEqual(f.calls, [
    'transaction', 'utc-setup', 'utc-verification', 'snapshot-lock', 'snapshot-read', 'window-upsert',
  ])
})
