import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant-defaults', organizationId: 'organization-defaults' }
const owner = {
  customerTenantId: tenant.id, organizationId: tenant.organizationId,
  token: 'visit-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

for (const outcome of ['provider-result', 'provider-failure'] as const) {
  test(`security-defaults ${outcome} cannot write after visit takeover`, async () => {
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
      if (outcome === 'provider-failure') throw new Error('Provider unavailable')
      return new Response(JSON.stringify({ id: 'policy', isEnabled: true }), { status: 200 })
    }

    await assert.rejects(
      () => (service as any).syncSecurityDefaults(tenant, 'synthetic-token', owner),
      TenantVisitLeaseLostError,
    )
    assert.deepEqual(events, ['owner-check', 'running', 'provider-page', 'owner-check'])
  })
}

test('between-inventory security-defaults dispatch forwards the visit owner', async () => {
  const service = new TenantSyncService({} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  const calls: unknown[][] = []
  ;(service as any).syncSecurityDefaults = async (...args: unknown[]) => { calls.push(args) }
  const module = (service as any).incrementalInventoryModule(
    tenant, 'synthetic-token', 'SECURITY_DEFAULTS', owner,
  )
  assert.equal(module.resource, 'SECURITY_DEFAULTS')
  await module.synchronize()
  assert.deepEqual(calls, [[tenant, 'synthetic-token', owner]])
})

test('audit reconciliation forwards the visit owner into security defaults', async () => {
  const service = new TenantSyncService({} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  const calls: unknown[][] = []
  ;(service as any).syncSecurityDefaults = async (...args: unknown[]) => { calls.push(args) }
  ;(service as any).pendingAuditReconciliationWork = async () => []
  await (service as any).reconcileDirectoryAuditResources(
    tenant, 'synthetic-token', ['SECURITY_DEFAULTS'], owner,
  )
  assert.deepEqual(calls, [[tenant, 'synthetic-token', owner]])
})
