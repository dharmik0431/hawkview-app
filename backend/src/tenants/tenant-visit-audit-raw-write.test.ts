import assert from 'node:assert/strict'
import test from 'node:test'
import { NotificationsService } from '../notifications/notifications.service.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant-audit', organizationId: 'organization-audit' }
const owner = {
  organizationId: tenant.organizationId, customerTenantId: tenant.id,
  token: 'owner-token', generation: 4n, expiresAt: new Date('2030-01-02T00:00:00Z'),
}
const records = [{
  microsoftAuditId: 'audit-one', eventDateTime: new Date('2026-11-11T12:00:00.000Z'),
  activityDisplayName: 'Update authentication method', result: null, category: null,
}]

function serviceWithPrisma(
  prisma: object,
  changeEvidence: object = { projectDirectoryAudits: async () => assert.fail('unexpected evidence projection') },
) {
  return new TenantSyncService(prisma as any, {} as any, {} as any,
    new NotificationsService(prisma as any), changeEvidence as any, {} as any)
}

test('directory audit raw write rejects foreign visit scope before database work', async () => {
  const service = serviceWithPrisma({
    $transaction: async () => assert.fail('foreign owner opened transaction'),
    directoryAuditLog: { createMany: async () => assert.fail('foreign owner wrote rows') },
  })
  await assert.rejects(
    () => (service as any).persistDirectoryAuditRows(tenant, records, { ...owner, organizationId: 'other' }),
    TenantVisitLeaseLostError,
  )
})

test('directory audit raw write refuses a lost visitor before insertion', async () => {
  const operations: string[] = []
  const service = serviceWithPrisma({
    $transaction: async (work: (transaction: any) => Promise<unknown>) => work({
      $queryRawUnsafe: async (query: string) => {
        operations.push(query.includes('organizations') ? 'organization' :
          query.includes('customer_tenants') ? 'tenant' : 'lease')
        return query.includes('tenant_sync_visit_leases') ? [] : [{ id: 'synthetic' }]
      },
      directoryAuditLog: { createMany: async () => assert.fail('lost visitor wrote rows') },
    }),
    directoryAuditLog: { createMany: async () => assert.fail('unguarded insertion') },
  })
  await assert.rejects(
    () => (service as any).persistDirectoryAuditRows(tenant, records, owner),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(operations, ['organization', 'tenant', 'lease'])
})

test('owner-bound audit writes the notice even when the raw insert is a duplicate', async () => {
  const operations: string[] = []
  let inTransaction = false
  const transaction = {
    $queryRawUnsafe: async (query: string) => {
      assert.equal(inTransaction, true)
      operations.push(query.includes('organizations') ? 'organization' :
        query.includes('customer_tenants') ? 'tenant' : 'lease')
      return query.includes('tenant_sync_visit_leases') ? [{ generation: '4' }] : [{ id: 'synthetic' }]
    },
    directoryAuditLog: { createMany: async (args: unknown) => {
      assert.equal(inTransaction, true)
      operations.push('raw-insert')
      assert.deepEqual(args, { data: records, skipDuplicates: true })
      return { count: 0 }
    } },
    notification: {
      createMany: async ({ data, skipDuplicates }: any) => {
        assert.equal(inTransaction, true)
        operations.push('notice-insert')
        assert.equal(skipDuplicates, true)
        assert.equal(data[0].dedupeKey, 'security:directory-audit:audit-one')
      },
      findUnique: async () => {
        assert.equal(inTransaction, true)
        operations.push('notice-read')
        return { customerTenantId: tenant.id, recipientUserId: null,
          eventType: 'security.directory_change', source: 'microsoft.directoryAudit' }
      },
    },
  }
  const service = serviceWithPrisma({
    $transaction: async (work: (transaction: any) => Promise<unknown>) => {
      inTransaction = true
      try {
        return await work(transaction)
      } finally {
        inTransaction = false
      }
    },
    directoryAuditLog: { createMany: async () => assert.fail('unguarded insertion') },
  }, {
    projectDirectoryAudits: async (currentTenant: unknown, currentRecords: unknown,
      currentOwner: unknown, currentTransaction: unknown) => {
      assert.equal(inTransaction, true)
      operations.push('evidence-project')
      assert.equal(currentTenant, tenant)
      assert.equal(currentRecords, records)
      assert.equal(currentOwner, owner)
      assert.equal(currentTransaction, transaction)
    },
  })
  const result = await (service as any).persistDirectoryAuditRows(tenant, records, owner)
  assert.deepEqual(result, { count: 0 })
  assert.deepEqual(operations, [
    'organization', 'tenant', 'lease', 'raw-insert',
    'organization', 'tenant', 'lease', 'notice-insert', 'notice-read',
    'evidence-project',
  ])
})

test('owner-bound audit enqueues only resources from rows inserted in the same transaction', async () => {
  const requested: string[] = []
  let insertedRows = [{ microsoftAuditId: 'audit-one' }]
  let submittedRecords = records
  let inTransaction = false
  const transaction = {
    $queryRawUnsafe: async (query: string) =>
      query.includes('tenant_sync_visit_leases') ? [{ generation: '4' }] : [{ id: 'synthetic' }],
    directoryAuditLog: {
      createManyAndReturn: async ({ data, skipDuplicates, select }: any) => {
        assert.equal(inTransaction, true)
        assert.deepEqual({ data, skipDuplicates, select }, {
          data: submittedRecords, skipDuplicates: true, select: { microsoftAuditId: true },
        })
        return insertedRows
      },
    },
    notification: {
      createMany: async () => undefined,
      findUnique: async () => ({ customerTenantId: tenant.id, recipientUserId: null,
        eventType: 'security.directory_change', source: 'microsoft.directoryAudit' }),
    },
    tenantAuditReconciliationWork: {
      upsert: async ({ where, create, update }: any) => {
        assert.equal(inTransaction, true)
        requested.push(create.resourceType)
        assert.deepEqual(where.organizationId_customerTenantId_resourceType, {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          resourceType: create.resourceType,
        })
        assert.deepEqual(update, { requestedRevision: { increment: 1n } })
      },
    },
  }
  const service = serviceWithPrisma({
    $transaction: async (work: (transaction: any) => Promise<unknown>) => {
      inTransaction = true
      try { return await work(transaction) } finally { inTransaction = false }
    },
  }, { projectDirectoryAudits: async () => { assert.equal(inTransaction, true) } })

  const first = await (service as any).persistDirectoryAuditRows(tenant, submittedRecords, owner, true)
  assert.equal(first.count, 1)
  assert.deepEqual(first.requestedResources, ['AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES'])
  assert.deepEqual(requested, first.requestedResources)

  submittedRecords = [records[0]!, {
    ...records[0]!, activityDisplayName: 'Add member to group',
  }]
  const sameId = await (service as any).persistDirectoryAuditRows(tenant, submittedRecords, owner, true)
  assert.deepEqual(sameId.requestedResources, first.requestedResources,
    'a skipped same-ID row cannot add another resource classification')
  assert.deepEqual(requested, [...first.requestedResources, ...first.requestedResources])

  submittedRecords = records
  insertedRows = []
  const duplicate = await (service as any).persistDirectoryAuditRows(tenant, submittedRecords, owner, true)
  assert.equal(duplicate.count, 0)
  assert.deepEqual(duplicate.requestedResources, [])
  assert.deepEqual(requested, [...first.requestedResources, ...first.requestedResources],
    'a duplicate provider page must not advance requested revisions')
})

test('failed audit work enqueue rejects the entire owner-bound write', async () => {
  let committed = false
  const service = serviceWithPrisma({
    $transaction: async (work: (transaction: any) => Promise<unknown>) => {
      const result = await work({
        $queryRawUnsafe: async (query: string) =>
          query.includes('tenant_sync_visit_leases') ? [{ generation: '4' }] : [{ id: 'synthetic' }],
        directoryAuditLog: {
          createManyAndReturn: async () => [{ microsoftAuditId: 'audit-one' }],
        },
        notification: {
          createMany: async () => undefined,
          findUnique: async () => ({ customerTenantId: tenant.id, recipientUserId: null,
            eventType: 'security.directory_change', source: 'microsoft.directoryAudit' }),
        },
        tenantAuditReconciliationWork: {
          upsert: async () => { throw new Error('synthetic ledger failure') },
        },
      })
      committed = true
      return result
    },
  }, { projectDirectoryAudits: async () => undefined })
  await assert.rejects(
    () => (service as any).persistDirectoryAuditRows(tenant, records, owner, true),
    /synthetic ledger failure/,
  )
  assert.equal(committed, false)
})

test('a failed evidence projection prevents the owner-bound raw and notice transaction from completing', async () => {
  const operations: string[] = []
  let committed = false
  const service = serviceWithPrisma({
    $transaction: async (work: (transaction: any) => Promise<unknown>) => {
      const result = await work({
        $queryRawUnsafe: async (query: string) =>
          query.includes('tenant_sync_visit_leases') ? [{ generation: '4' }] : [{ id: 'synthetic' }],
        directoryAuditLog: { createMany: async () => { operations.push('raw-insert') } },
        notification: {
          createMany: async () => { operations.push('notice-insert') },
          findUnique: async () => ({ customerTenantId: tenant.id, recipientUserId: null,
            eventType: 'security.directory_change', source: 'microsoft.directoryAudit' }),
        },
      })
      committed = true
      return result
    },
  }, {
    projectDirectoryAudits: async () => {
      operations.push('evidence-project')
      throw new Error('synthetic evidence failure')
    },
  })
  await assert.rejects(
    () => (service as any).persistDirectoryAuditRows(tenant, records, owner),
    /synthetic evidence failure/,
  )
  assert.deepEqual(operations, ['raw-insert', 'notice-insert', 'evidence-project'])
  assert.equal(committed, false, 'the transaction callback must reject before success')
})

test('a failed security notice prevents the owner-bound raw transaction from completing', async () => {
  const operations: string[] = []
  let committed = false
  const service = serviceWithPrisma({
    $transaction: async (work: (transaction: any) => Promise<unknown>) => {
      const result = await work({
        $queryRawUnsafe: async (query: string) =>
          query.includes('tenant_sync_visit_leases') ? [{ generation: '4' }] : [{ id: 'synthetic' }],
        directoryAuditLog: { createMany: async () => { operations.push('raw-insert') } },
        notification: { createMany: async () => {
          operations.push('notice-insert')
          throw new Error('synthetic notice failure')
        } },
      })
      committed = true
      return result
    },
  })
  await assert.rejects(
    () => (service as any).persistDirectoryAuditRows(tenant, records, owner),
    /synthetic notice failure/,
  )
  assert.deepEqual(operations, ['raw-insert', 'notice-insert'])
  assert.equal(committed, false, 'the transaction callback must reject before success')
})

test('ownerless directory audit raw write keeps its direct insertion path', async () => {
  const operations: string[] = []
  const service = serviceWithPrisma({
    $transaction: async () => assert.fail('legacy insertion opened transaction'),
    directoryAuditLog: { createMany: async (args: unknown) => {
      operations.push('insert')
      assert.deepEqual(args, { data: records, skipDuplicates: true })
    } },
  })
  await (service as any).persistDirectoryAuditRows(tenant, records)
  assert.deepEqual(operations, ['insert'])
})
