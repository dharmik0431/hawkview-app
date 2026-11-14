import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant-score', organizationId: 'organization-score' }
const owner = {
  customerTenantId: tenant.id, organizationId: tenant.organizationId,
  token: 'visit-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

test('a secure-score response cannot write snapshot or status after visit takeover', async () => {
  const events: string[] = []
  let checks = 0
  const transaction = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
      if (sql.includes('FROM tenant_sync_visit_leases')) {
        events.push('owner-check')
        return ++checks === 1 ? [{ generation: '4' }] : []
      }
      assert.fail(`Unexpected SQL: ${sql}`)
    },
    syncState: {
      upsert: async () => { events.push('running'); return { lastSuccessfulAt: null } },
      update: async () => { events.push('terminal') },
    },
    $executeRawUnsafe: async () => { events.push('snapshot-lock') },
    tenantEntraSnapshot: {
      findUnique: async () => { events.push('snapshot-read'); return null },
      upsert: async () => { events.push('snapshot-upsert') },
    },
    changeEvidenceEvent: { createMany: async () => { events.push('evidence-write') } },
  }
  const prisma = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
  }
  const service = new TenantSyncService(prisma as any, {} as any, {} as any,
    { resolveIncident: async () => { events.push('resolve') },
      publishIncident: async () => { events.push('publish') } } as any,
    {} as any, {} as any)
  ;(service as any).fetchGraphPage = async () => {
    events.push('provider-page')
    return new Response(JSON.stringify({ value: [{
      id: 'score', createdDateTime: '2026-09-26T00:00:00Z',
      currentScore: 70, maxScore: 100,
    }] }), { status: 200 })
  }

  await assert.rejects(
    () => (service as any).syncCurrentSecureScore(tenant, 'synthetic-token', owner),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(events, ['owner-check', 'running', 'provider-page', 'owner-check'])
})

test('between-inventory secure-score dispatch forwards the visit owner', async () => {
  const service = new TenantSyncService({} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  const calls: unknown[][] = []
  ;(service as any).syncCurrentSecureScore = async (...args: unknown[]) => { calls.push(args) }
  const module = (service as any).incrementalInventoryModule(
    tenant, 'synthetic-token', 'SECURE_SCORES', owner,
  )
  assert.equal(module.resource, 'SECURE_SCORES')
  await module.synchronize()
  assert.deepEqual(calls, [[tenant, 'synthetic-token', owner]])
})
