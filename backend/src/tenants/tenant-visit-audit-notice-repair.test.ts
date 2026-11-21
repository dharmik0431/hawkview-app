import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DIRECTORY_AUDIT_SECURITY_SEARCH_TERMS,
  directoryAuditSecurityIncident,
} from './directory-audit-security-incident.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = {
  id: '22222222-2222-4222-8222-222222222222',
  organizationId: '11111111-1111-4111-8111-111111111111',
}
const owner = {
  customerTenantId: tenant.id,
  organizationId: tenant.organizationId,
  token: '33333333-3333-4333-8333-333333333333',
  generation: 2n,
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
}
const raw = (id: string, activityDisplayName = 'Update authentication method') => ({
  id,
  microsoftAuditId: id,
  eventDateTime: new Date('2026-11-12T00:00:00.000Z'),
  activityDisplayName,
  result: 'success',
  category: 'UserManagement',
})

test('retained notice repair selects missing security rows before its cap and writes under one owner transaction', async () => {
  const ids = ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555']
  const operations: string[] = []
  let inTransaction = false
  const transaction = {
    $queryRawUnsafe: async (query: string, ...args: unknown[]) => {
      assert.equal(inTransaction, true)
      if (query.includes('FROM directory_audit_logs d')) {
        operations.push('missing-row-select')
        assert.ok(query.indexOf('NOT EXISTS') < query.indexOf('LIMIT $3::int'))
        assert.match(query, /d\.expires_at > clock_timestamp\(\)/)
        assert.match(query, /n\.customer_tenant_id=d\.customer_tenant_id/)
        assert.match(query, /n\.event_type='security\.directory_change'/)
        assert.deepEqual(args, [tenant.organizationId, tenant.id, 2, ...DIRECTORY_AUDIT_SECURITY_SEARCH_TERMS])
        return ids.map((id) => ({ id }))
      }
      operations.push(query.includes('organizations') ? 'organization-lock' :
        query.includes('customer_tenants') ? 'tenant-lock' : 'lease-lock')
      return query.includes('tenant_sync_visit_leases') ? [{ generation: '2' }] : [{ id: 'scope' }]
    },
    directoryAuditLog: {
      findMany: async ({ where }: { where: { id: { in: string[] }; organizationId: string; customerTenantId: string } }) => {
        operations.push('raw-read')
        assert.deepEqual(where, {
          id: { in: [ids[0]] }, organizationId: tenant.organizationId, customerTenantId: tenant.id,
        })
        return [raw(ids[0])]
      },
    },
  }
  const database = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => {
      inTransaction = true
      try { return await work(transaction) } finally { inTransaction = false }
    },
  }
  const notifications = {
    publishIncidentIfMissingInTransaction: async (input: { dedupeKey: string; eventType: string },
      currentOwner: unknown, tx: unknown) => {
      assert.equal(inTransaction, true)
      operations.push('notice-insert')
      assert.equal(input.dedupeKey, `security:directory-audit:${ids[0]}`)
      assert.equal(input.eventType, 'security.directory_change')
      assert.equal(currentOwner, owner)
      assert.equal(tx, transaction)
    },
  }
  const service = new TenantSyncService(database as any, {} as any, {} as any,
    notifications as any, {} as any, {} as any) as any

  assert.deepEqual(await service.repairRetainedDirectoryAuditNotices(tenant, owner, 1), {
    attempted: 1, hasMore: true,
  })
  assert.deepEqual(operations, [
    'organization-lock', 'tenant-lock', 'lease-lock', 'missing-row-select',
    'raw-read', 'notice-insert',
  ])
})

test('retained notice repair rejects foreign or lost owners before any notice write', async () => {
  let transactions = 0
  const transaction = {
    $queryRawUnsafe: async (query: string) =>
      query.includes('tenant_sync_visit_leases') ? [] : [{ id: 'scope' }],
  }
  const database = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => {
      transactions += 1
      return work(transaction)
    },
  }
  const notifications = {
    publishIncidentIfMissingInTransaction: async () => assert.fail('lost owner published notice'),
  }
  const service = new TenantSyncService(database as any, {} as any, {} as any,
    notifications as any, {} as any, {} as any) as any
  await assert.rejects(() => service.repairRetainedDirectoryAuditNotices(tenant,
    { ...owner, customerTenantId: 'other-tenant' }, 100), TenantVisitLeaseLostError)
  assert.equal(transactions, 0)
  await assert.rejects(() => service.repairRetainedDirectoryAuditNotices(tenant, owner, 100),
    TenantVisitLeaseLostError)
  assert.equal(transactions, 1)
})

test('retained notice repair fails closed if selected raw rows disappear or classification drifts', async () => {
  const id = '66666666-6666-4666-8666-666666666666'
  let selected = false
  let records: ReturnType<typeof raw>[] = []
  const transaction = {
    $queryRawUnsafe: async (query: string) => {
      if (query.includes('FROM directory_audit_logs d')) {
        selected = true
        return [{ id }]
      }
      return query.includes('tenant_sync_visit_leases') ? [{ generation: '2' }] : [{ id: 'scope' }]
    },
    directoryAuditLog: { findMany: async () => records },
  }
  const database = { $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction) }
  const notifications = {
    publishIncidentIfMissingInTransaction: async () => assert.fail('invalid selection published notice'),
  }
  const service = new TenantSyncService(database as any, {} as any, {} as any,
    notifications as any, {} as any, {} as any) as any
  await assert.rejects(() => service.repairRetainedDirectoryAuditNotices(tenant, owner, 100),
    /DIRECTORY_AUDIT_NOTICE_REPAIR_ROW_CHANGED/)
  assert.equal(selected, true)
  records = [raw(id, 'Updated group display name')]
  await assert.rejects(() => service.repairRetainedDirectoryAuditNotices(tenant, owner, 100),
    /DIRECTORY_AUDIT_NOTICE_REPAIR_CLASSIFICATION_DRIFT/)
})

test('every retained-row SQL search term maps to a security notice', () => {
  for (const term of DIRECTORY_AUDIT_SECURITY_SEARCH_TERMS) {
    assert.ok(directoryAuditSecurityIncident(tenant, raw('audit', term)), term)
  }
  assert.equal(directoryAuditSecurityIncident(tenant, raw('audit', 'Updated group display name')), null)
})
