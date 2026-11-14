import assert from 'node:assert/strict'
import test from 'node:test'
import { ChangeEvidenceService } from './change-evidence.service.js'
import { TenantVisitLeaseLostError } from '../tenants/tenant-visit-lease-error.js'

const tenant = { id: 'tenant-audit', organizationId: 'organization-audit' }
const owner = {
  organizationId: tenant.organizationId, customerTenantId: tenant.id,
  token: 'owner-token', generation: 4n, expiresAt: new Date('2030-01-02T00:00:00Z'),
}
const observedAt = new Date('2026-11-03T00:00:00Z')
const records = [{
  microsoftAuditId: 'audit-one', eventDateTime: observedAt,
  activityDisplayName: 'Update application', category: 'ApplicationManagement',
  operationType: 'Update', result: 'success', targetResources: [], initiatedBy: {},
  raw: {}, ingestedAt: observedAt, expiresAt: new Date('2027-05-03T00:00:00Z'),
}]

test('directory audit projection rejects a foreign visit before database work', async () => {
  const service = new ChangeEvidenceService({
    $transaction: async () => assert.fail('foreign owner opened a transaction'),
    changeEvidenceEvent: { createMany: async () => assert.fail('foreign owner projected evidence') },
  } as never)
  await assert.rejects(
    service.projectDirectoryAudits(tenant, records, { ...owner, customerTenantId: 'other' }),
    TenantVisitLeaseLostError,
  )
})

test('lost visit cannot project directory audit evidence', async () => {
  const operations: string[] = []
  const service = new ChangeEvidenceService({
    $transaction: async (work: (transaction: any) => Promise<unknown>) => work({
      $queryRawUnsafe: async (query: string) => {
        operations.push(query.includes('organizations') ? 'organization' :
          query.includes('customer_tenants') ? 'tenant' : 'lease')
        return query.includes('tenant_sync_visit_leases') ? [] : [{ id: 'synthetic' }]
      },
      changeEvidenceEvent: { createMany: async () => assert.fail('lost owner projected evidence') },
    }),
    changeEvidenceEvent: { createMany: async () => assert.fail('unguarded evidence projection') },
  } as never)
  await assert.rejects(service.projectDirectoryAudits(tenant, records, owner), TenantVisitLeaseLostError)
  assert.deepEqual(operations, ['organization', 'tenant', 'lease'])
})

test('directory audit evidence projection checks the live visit in its write transaction', async () => {
  const operations: string[] = []
  const service = new ChangeEvidenceService({
    $transaction: async (work: (transaction: any) => Promise<unknown>) => work({
      $queryRawUnsafe: async (query: string) => {
        operations.push(query.includes('organizations') ? 'organization' :
          query.includes('customer_tenants') ? 'tenant' : 'lease')
        return query.includes('tenant_sync_visit_leases') ? [{ generation: '4' }] : [{ id: 'synthetic' }]
      },
      changeEvidenceEvent: { createMany: async (args: any) => {
        operations.push('project')
        assert.equal(args.skipDuplicates, true)
        assert.equal(args.data[0].organizationId, tenant.organizationId)
        assert.equal(args.data[0].customerTenantId, tenant.id)
        assert.equal(args.data[0].source, 'DIRECTORY_AUDIT')
      } },
    }),
    changeEvidenceEvent: { createMany: async () => assert.fail('unguarded evidence projection') },
  } as never)
  await service.projectDirectoryAudits(tenant, records, owner)
  assert.deepEqual(operations, ['organization', 'tenant', 'lease', 'project'])
})

test('caller-owned transaction checks the visit and writes evidence without opening another transaction', async () => {
  const operations: string[] = []
  const transaction = {
    $queryRawUnsafe: async (query: string) => {
      operations.push(query.includes('organizations') ? 'organization' :
        query.includes('customer_tenants') ? 'tenant' : 'lease')
      return query.includes('tenant_sync_visit_leases') ? [{ generation: '4' }] : [{ id: 'synthetic' }]
    },
    changeEvidenceEvent: { createMany: async (args: any) => {
      operations.push('project')
      assert.equal(args.skipDuplicates, true)
      assert.equal(args.data[0].organizationId, tenant.organizationId)
      assert.equal(args.data[0].customerTenantId, tenant.id)
      assert.equal(args.data[0].source, 'DIRECTORY_AUDIT')
    } },
  }
  const service = new ChangeEvidenceService({
    $transaction: async () => assert.fail('caller-owned write opened a nested transaction'),
    changeEvidenceEvent: { createMany: async () => assert.fail('caller-owned write used root client') },
  } as never)
  await service.projectDirectoryAudits(tenant, records, owner, transaction as never)
  assert.deepEqual(operations, ['organization', 'tenant', 'lease', 'project'])
})

test('caller-owned transaction refuses evidence after visit ownership is lost', async () => {
  const operations: string[] = []
  const transaction = {
    $queryRawUnsafe: async (query: string) => {
      operations.push(query.includes('organizations') ? 'organization' :
        query.includes('customer_tenants') ? 'tenant' : 'lease')
      return query.includes('tenant_sync_visit_leases') ? [] : [{ id: 'synthetic' }]
    },
    changeEvidenceEvent: { createMany: async () => assert.fail('lost owner projected evidence') },
  }
  const service = new ChangeEvidenceService({
    $transaction: async () => assert.fail('caller-owned write opened a nested transaction'),
    changeEvidenceEvent: { createMany: async () => assert.fail('caller-owned write used root client') },
  } as never)
  await assert.rejects(
    service.projectDirectoryAudits(tenant, records, owner, transaction as never),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(operations, ['organization', 'tenant', 'lease'])
})

test('caller-owned transaction requires a visit owner', async () => {
  const service = new ChangeEvidenceService({
    $transaction: async () => assert.fail('ownerless caller-owned write opened a transaction'),
    changeEvidenceEvent: { createMany: async () => assert.fail('ownerless caller-owned write projected evidence') },
  } as never)
  await assert.rejects(
    service.projectDirectoryAudits(tenant, records, undefined, {
      changeEvidenceEvent: { createMany: async () => assert.fail('ownerless caller-owned write projected evidence') },
    } as never),
    /TENANT_VISIT_OWNER_REQUIRED/,
  )
})

test('ownerless directory audit projection keeps the direct write path', async () => {
  const operations: string[] = []
  const service = new ChangeEvidenceService({
    $transaction: async () => assert.fail('ownerless projection opened a transaction'),
    changeEvidenceEvent: { createMany: async (args: any) => {
      operations.push('project')
      assert.equal(args.skipDuplicates, true)
    } },
  } as never)
  await service.projectDirectoryAudits(tenant, records)
  assert.deepEqual(operations, ['project'])
})
