import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant', organizationId: 'organization' }
const owner = {
  organizationId: tenant.organizationId, customerTenantId: tenant.id,
  token: 'owner-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}
const result = { rows: [{ name: 'example.test', isDefault: true, isInitial: false }], completeness: 'authoritative_complete' }

test('snapshot transaction rejects a lost owner before evidence, domain rows or baseline', async () => {
  for (const mode of ['lost', 'valid'] as const) {
    const events: string[] = []
    let transactionActive = false
    const transaction = {
      $queryRawUnsafe: async (sql: string) => {
        assert.equal(transactionActive, true)
        if (sql.includes('FROM organizations')) {
          events.push('organization-lock')
          return [{ id: tenant.organizationId }]
        }
        if (sql.includes('FROM customer_tenants')) {
          events.push('tenant-lock')
          return [{ id: tenant.id }]
        }
        if (sql.includes('FROM tenant_sync_visit_leases')) {
          events.push('owner-lock')
          return mode === 'lost' ? [] : [{ generation: '4' }]
        }
        assert.fail(`Unexpected query: ${sql}`)
      },
      $executeRawUnsafe: async (sql: string) => {
        assert.equal(transactionActive, true)
        assert.match(sql, /pg_advisory_xact_lock/)
        events.push('snapshot-lock')
      },
      tenantEntraSnapshot: {
        findUnique: async () => { events.push('snapshot-read'); return null },
        upsert: async () => { events.push('snapshot-write') },
      },
      changeEvidenceEvent: {
        createMany: async () => { events.push('evidence-write') },
      },
    }
    const database = {
      $transaction: async (work: (tx: typeof transaction) => Promise<void>) => {
        transactionActive = true
        try { await work(transaction) } finally { transactionActive = false }
      },
    }
    const service = new TenantSyncService(database as any, {} as any, {} as any,
      {} as any, { buildSnapshotDifferenceEvidence: () => { events.push('evidence-build'); return [{}] } } as any,
      {} as any)
    const persistDomains = async (tx: typeof transaction) => {
      assert.equal(tx, transaction, 'domain rows must share the fenced snapshot transaction')
      assert.equal(transactionActive, true)
      events.push('domain-write')
    }
    const save = () => (service as any).saveSnapshot(tenant, 'DOMAINS', result,
      persistDomains, false, undefined, undefined, owner)

    if (mode === 'lost') {
      await assert.rejects(save, (error: unknown) => error instanceof TenantVisitLeaseLostError)
      assert.deepEqual(events, ['organization-lock', 'tenant-lock', 'owner-lock'])
    } else {
      await assert.doesNotReject(save)
      assert.deepEqual(events, [
        'organization-lock', 'tenant-lock', 'owner-lock', 'snapshot-lock',
        'snapshot-read', 'evidence-build', 'evidence-write', 'domain-write', 'snapshot-write',
      ])
    }
  }
})

test('snapshot owner scope mismatch rejects before opening a transaction', async () => {
  const database = { $transaction: async () => assert.fail('mismatched owner entered a transaction') }
  const service = new TenantSyncService(database as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  await assert.rejects(
    () => (service as any).saveSnapshot(tenant, 'DOMAINS', result,
      undefined, false, undefined, undefined, { ...owner, customerTenantId: 'another-tenant' }),
    (error: unknown) => error instanceof TenantVisitLeaseLostError,
  )
})

test('complete snapshot acknowledges only its exact audit request in the same owner transaction', async () => {
  const events: string[] = []
  const requestedRevision = 7n
  const transaction = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
      if (sql.includes('FROM tenant_sync_visit_leases')) return [{ generation: '4' }]
      assert.fail(`Unexpected query: ${sql}`)
    },
    $executeRawUnsafe: async () => { events.push('snapshot-lock') },
    tenantEntraSnapshot: {
      findUnique: async () => null,
      upsert: async () => { events.push('snapshot-write') },
    },
    tenantAuditReconciliationWork: {
      updateMany: async ({ where, data }: {
        where: Record<string, unknown>
        data: { completedRevision: bigint; lastCompletedAt: Date }
      }) => {
        events.push('audit-completion')
        assert.deepEqual(where, {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          resourceType: 'DOMAINS',
          requestedRevision,
          completedRevision: { lt: requestedRevision },
        })
        assert.equal(data.completedRevision, requestedRevision)
        assert.ok(data.lastCompletedAt instanceof Date)
        return { count: 1 }
      },
    },
  }
  const database = {
    $transaction: async (work: (tx: typeof transaction) => Promise<void>) => {
      events.push('begin')
      await work(transaction)
      events.push('commit')
    },
  }
  const service = new TenantSyncService(database as any, {} as any, {} as any,
    {} as any, { buildSnapshotDifferenceEvidence: () => [] } as any, {} as any)
  await (service as any).saveSnapshot(tenant, 'DOMAINS', result,
    undefined, false, undefined, undefined, owner, requestedRevision)
  assert.deepEqual(events, ['begin', 'snapshot-lock', 'snapshot-write', 'audit-completion', 'commit'])
})

test('audit snapshot receipt rejects absent owner and incomplete source before any write', async () => {
  const database = { $transaction: async () => assert.fail('invalid receipt entered a transaction') }
  const service = new TenantSyncService(database as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  await assert.rejects(
    () => (service as any).saveSnapshot(tenant, 'DOMAINS', result,
      undefined, false, undefined, undefined, undefined, 7n),
    /TENANT_AUDIT_RECONCILIATION_SNAPSHOT_RECEIPT_INVALID/,
  )
  await assert.rejects(
    () => (service as any).saveSnapshot(tenant, 'DOMAINS',
      { ...result, completeness: 'partial_or_unknown' },
      undefined, false, undefined, undefined, owner, 7n),
    /Refusing to advance/,
  )
})
