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
const rawRow = (id: string, microsoftAuditId: string) => ({
  id, organizationId: tenant.organizationId, customerTenantId: tenant.id,
  microsoftAuditId, eventDateTime: observedAt,
  activityDisplayName: 'Update application', category: 'ApplicationManagement',
  operationType: 'Update', result: 'success', targetResources: [], initiatedBy: {},
  raw: {}, ingestedAt: observedAt, expiresAt: new Date('2027-05-03T00:00:00Z'),
})

function recoveryHarness(options: {
  missing: string[]; rows?: ReturnType<typeof rawRow>[];
  live?: boolean; loseBeforeProjection?: boolean;
}) {
  const operations: string[] = []
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const projected: Array<Record<string, unknown>> = []
  const rows = options.rows ?? options.missing.map((id) => rawRow(id, `audit-${id}`))
  let leaseChecks = 0
  const transaction = {
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
      queries.push({ sql, values })
      if (sql.includes('FROM organizations')) { operations.push('organization'); return [{ id: tenant.organizationId }] }
      if (sql.includes('FROM customer_tenants')) { operations.push('tenant'); return [{ id: tenant.id }] }
      if (sql.includes('FROM tenant_sync_visit_leases')) {
        operations.push('lease')
        leaseChecks += 1
        return options.live === false || (options.loseBeforeProjection && leaseChecks > 1)
          ? [] : [{ generation: '4' }]
      }
      assert.match(sql, /FROM directory_audit_logs d/)
      operations.push('missing-evidence-scan')
      return options.missing.map((id) => ({ id }))
    },
    directoryAuditLog: { findMany: async (args: any) => {
      operations.push('read-raw')
      assert.equal(args.where.organizationId, tenant.organizationId)
      assert.equal(args.where.customerTenantId, tenant.id)
      return rows.filter((row) => args.where.id.in.includes(row.id))
    } },
    changeEvidenceEvent: { createMany: async (args: any) => {
      operations.push('project')
      assert.equal(args.skipDuplicates, true)
      projected.push(...args.data)
      return { count: args.data.length }
    } },
  }
  const service = new ChangeEvidenceService({
    $transaction: async (work: (client: any) => Promise<unknown>) => work(transaction),
    changeEvidenceEvent: { createMany: async () => assert.fail('repair used the root client') },
  } as never)
  return { service, operations, queries, projected }
}

test('owner-bound repair selects absent evidence before its limit and projects in one transaction', async () => {
  const harness = recoveryHarness({ missing: ['raw-one', 'raw-two'] })
  const result = await harness.service.projectRetainedDirectoryAuditsMissingEvidence(tenant, owner, 1)
  assert.deepEqual(result, { attempted: 1, hasMore: true })
  assert.deepEqual(harness.operations, [
    'organization', 'tenant', 'lease', 'missing-evidence-scan', 'read-raw',
    'organization', 'tenant', 'lease', 'project',
  ])
  const scan = harness.queries.find(({ sql }) => sql.includes('FROM directory_audit_logs d'))!
  assert.match(scan.sql, /d\.expires_at > clock_timestamp\(\)/)
  assert.match(scan.sql, /NOT EXISTS \([\s\S]*e\.source='DIRECTORY_AUDIT'[\s\S]*e\.source_event_id=d\.microsoft_audit_id/)
  assert.ok(scan.sql.indexOf('NOT EXISTS') < scan.sql.indexOf('LIMIT'))
  assert.deepEqual(scan.values, [tenant.organizationId, tenant.id, 2])
  assert.equal(harness.projected.length, 1)
  assert.equal(harness.projected[0].sourceEventId, 'audit-raw-one')
})

test('empty retained-row repair still verifies the owner without writing evidence', async () => {
  const harness = recoveryHarness({ missing: [] })
  assert.deepEqual(
    await harness.service.projectRetainedDirectoryAuditsMissingEvidence(tenant, owner, 100),
    { attempted: 0, hasMore: false },
  )
  assert.deepEqual(harness.operations, ['organization', 'tenant', 'lease', 'missing-evidence-scan'])
})

test('lost or foreign owners cannot scan retained audit rows', async () => {
  const lost = recoveryHarness({ missing: ['raw-one'], live: false })
  await assert.rejects(
    lost.service.projectRetainedDirectoryAuditsMissingEvidence(tenant, owner, 1),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(lost.operations, ['organization', 'tenant', 'lease'])

  const foreign = recoveryHarness({ missing: ['raw-one'] })
  await assert.rejects(
    foreign.service.projectRetainedDirectoryAuditsMissingEvidence(
      tenant, { ...owner, customerTenantId: 'another-tenant' }, 1,
    ),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(foreign.operations, [])
})

test('owner loss after the scan prevents evidence publication', async () => {
  const harness = recoveryHarness({ missing: ['raw-one'], loseBeforeProjection: true })
  await assert.rejects(
    harness.service.projectRetainedDirectoryAuditsMissingEvidence(tenant, owner, 1),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(harness.operations, [
    'organization', 'tenant', 'lease', 'missing-evidence-scan', 'read-raw',
    'organization', 'tenant', 'lease',
  ])
  assert.equal(harness.projected.length, 0)
})

test('a raw row removed after selection aborts the repair transaction', async () => {
  const harness = recoveryHarness({ missing: ['raw-one'], rows: [] })
  await assert.rejects(
    harness.service.projectRetainedDirectoryAuditsMissingEvidence(tenant, owner, 1),
    /DIRECTORY_AUDIT_EVIDENCE_REPAIR_ROW_CHANGED/,
  )
  assert.equal(harness.projected.length, 0)
})

test('repair rejects an unbounded batch before opening a transaction', async () => {
  const service = new ChangeEvidenceService({
    $transaction: async () => assert.fail('invalid batch opened a transaction'),
  } as never)
  await assert.rejects(
    service.projectRetainedDirectoryAuditsMissingEvidence(tenant, owner, 1001),
    /DIRECTORY_AUDIT_EVIDENCE_REPAIR_LIMIT_INVALID/,
  )
})
