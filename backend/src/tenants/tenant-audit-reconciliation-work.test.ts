import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceAuditReconciliationCompletion,
  selectPendingAuditReconciliationWork,
} from './tenant-audit-reconciliation-work.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  customerTenantId: '22222222-2222-4222-8222-222222222222',
}
const owner = {
  ...scope,
  token: '33333333-3333-4333-8333-333333333333',
  generation: 7n,
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
}

function databaseWithRows(rows: Array<{ resourceType: string; requestedRevision: string }>,
  leaseIsCurrent = true) {
  const operations: string[] = []
  const database = {
    $transaction: async (work: (transaction: object) => Promise<unknown>) => work({
      $queryRawUnsafe: async (query: string, ...values: unknown[]) => {
        if (query.includes('FROM organizations')) {
          operations.push('organization')
          assert.deepEqual(values, [scope.organizationId])
          return [{ id: scope.organizationId }]
        }
        if (query.includes('FROM customer_tenants')) {
          operations.push('tenant')
          assert.deepEqual(values, [scope.customerTenantId, scope.organizationId])
          return [{ id: scope.customerTenantId }]
        }
        if (query.includes('FROM tenant_sync_visit_leases')) {
          operations.push('lease')
          assert.deepEqual(values, [scope.customerTenantId, scope.organizationId,
            owner.token, owner.generation.toString()])
          return leaseIsCurrent ? [{ generation: '7' }] : []
        }
        assert.match(query, /FROM tenant_audit_reconciliation_work/)
        assert.match(query, /requested_revision > completed_revision/)
        assert.match(query, /ORDER BY resource_type ASC/)
        assert.match(query, /LIMIT \$3::int/)
        assert.deepEqual(values, [scope.organizationId, scope.customerTenantId, 2])
        operations.push('pending')
        return rows
      },
    }),
  }
  return { database: database as any, operations }
}

test('pending audit work reads only unfinished tenant-scoped revisions after the exact owner check', async () => {
  const { database, operations } = databaseWithRows([
    { resourceType: 'AUTH_METHOD_POLICIES', requestedRevision: '3' },
    { resourceType: 'AUTH_REGISTRATIONS', requestedRevision: '2' },
  ])
  assert.deepEqual(await selectPendingAuditReconciliationWork(database, scope, owner, 2), [
    { resourceType: 'AUTH_METHOD_POLICIES', requestedRevision: 3n },
    { resourceType: 'AUTH_REGISTRATIONS', requestedRevision: 2n },
  ])
  assert.deepEqual(operations, ['organization', 'tenant', 'lease', 'pending'])
})

test('an empty provider page still permits selection of durable pending work', async () => {
  const { database, operations } = databaseWithRows([
    { resourceType: 'AUTH_REGISTRATIONS', requestedRevision: '2' },
  ])
  assert.deepEqual(await selectPendingAuditReconciliationWork(database, scope, owner, 2), [
    { resourceType: 'AUTH_REGISTRATIONS', requestedRevision: 2n },
  ])
  assert.deepEqual(operations, ['organization', 'tenant', 'lease', 'pending'])
})

test('foreign scope and invalid bounds reject before database access', async () => {
  const database = { $transaction: async () => assert.fail('transaction opened') } as any
  await assert.rejects(
    () => selectPendingAuditReconciliationWork(database, scope,
      { ...owner, customerTenantId: 'foreign' }, 2), TenantVisitLeaseLostError,
  )
  for (const limit of [0, 23, 1.5, Number.NaN]) {
    await assert.rejects(
      () => selectPendingAuditReconciliationWork(database, scope, owner, limit),
      /TENANT_AUDIT_RECONCILIATION_WORK_LIMIT_INVALID/,
    )
  }
})

test('lost owner cannot read pending work', async () => {
  const { database, operations } = databaseWithRows([], false)
  await assert.rejects(
    () => selectPendingAuditReconciliationWork(database, scope, owner, 2),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(operations, ['organization', 'tenant', 'lease'])
})

test('unexpected ledger resource or revision fails closed', async () => {
  for (const row of [
    { resourceType: 'USERS', requestedRevision: '2' },
    { resourceType: 'GROUPS', requestedRevision: '0' },
  ]) {
    const { database } = databaseWithRows([row])
    await assert.rejects(
      () => selectPendingAuditReconciliationWork(database, scope, owner, 2),
      /TENANT_AUDIT_RECONCILIATION_WORK_ROW_INVALID/,
    )
  }
})

function completionDatabase(rows: Array<{ completedRevision: string }>, leaseIsCurrent = true) {
  const operations: string[] = []
  const database = {
    $transaction: async (work: (transaction: object) => Promise<unknown>) => work({
      $queryRawUnsafe: async (query: string, ...values: unknown[]) => {
        if (query.includes('FROM organizations')) {
          operations.push('organization')
          return [{ id: scope.organizationId }]
        }
        if (query.includes('FROM customer_tenants')) {
          operations.push('tenant')
          return [{ id: scope.customerTenantId }]
        }
        if (query.includes('FROM tenant_sync_visit_leases')) {
          operations.push('lease')
          return leaseIsCurrent ? [{ generation: '7' }] : []
        }
        assert.match(query, /UPDATE tenant_audit_reconciliation_work/)
        assert.match(query, /requested_revision=\$4::bigint/)
        assert.match(query, /completed_revision < \$4::bigint/)
        assert.match(query, /last_completed_at=clock_timestamp\(\)/)
        assert.deepEqual(values, [scope.organizationId, scope.customerTenantId, 'GROUPS', '3'])
        operations.push('complete')
        return rows
      },
    }),
  }
  return { database: database as any, operations }
}

test('exact owner and requested revision gate completion in one transaction', async () => {
  const { database, operations } = completionDatabase([{ completedRevision: '3' }])
  assert.equal(await advanceAuditReconciliationCompletion(database, scope, owner, 'GROUPS', 3n), true)
  assert.deepEqual(operations, ['organization', 'tenant', 'lease', 'complete'])
})

test('superseded or already completed revision is not acknowledged', async () => {
  const { database, operations } = completionDatabase([])
  assert.equal(await advanceAuditReconciliationCompletion(database, scope, owner, 'GROUPS', 3n), false)
  assert.deepEqual(operations, ['organization', 'tenant', 'lease', 'complete'])
})

test('foreign owner and invalid completion input reject before database work', async () => {
  const database = { $transaction: async () => assert.fail('transaction opened') } as any
  await assert.rejects(
    () => advanceAuditReconciliationCompletion(database, scope,
      { ...owner, customerTenantId: 'foreign' }, 'GROUPS', 3n),
    TenantVisitLeaseLostError,
  )
  await assert.rejects(
    () => advanceAuditReconciliationCompletion(database, scope, owner, 'USERS' as any, 3n),
    /TENANT_AUDIT_RECONCILIATION_WORK_RESOURCE_INVALID/,
  )
  for (const revision of [0n, -1n, 9223372036854775808n, 3 as any]) {
    await assert.rejects(
      () => advanceAuditReconciliationCompletion(database, scope, owner, 'GROUPS', revision),
      /TENANT_AUDIT_RECONCILIATION_WORK_REVISION_INVALID/,
    )
  }
})

test('lost owner cannot advance completion', async () => {
  const { database, operations } = completionDatabase([], false)
  await assert.rejects(
    () => advanceAuditReconciliationCompletion(database, scope, owner, 'GROUPS', 3n),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(operations, ['organization', 'tenant', 'lease'])
})

test('unexpected completion result rolls back', async () => {
  const { database } = completionDatabase([{ completedRevision: '2' }])
  await assert.rejects(
    () => advanceAuditReconciliationCompletion(database, scope, owner, 'GROUPS', 3n),
    /TENANT_AUDIT_RECONCILIATION_WORK_COMPLETION_INVALID/,
  )
})
