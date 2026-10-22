import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'

const NOW = new Date('2026-10-22T04:00:00.000Z')
const tenantId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function fixture(count: number) {
  const tenants = Array.from({ length: count }, (_, index) => ({
    id: tenantId(index + 1), organizationId: tenantId(50_000),
    microsoftTenantId: tenantId(100_000 + index), status: 'ACTIVE',
    connection: { status: 'CONNECTED', exchangeReadOnlyEnabledAt: null },
    syncStates: [],
  }))
  let cursor = { scopeKey: 'TENANT_SYNC', afterTenantId: null as string | null, revision: 0 }
  let casFailures = 0
  const scanned: string[][] = []
  const dispatched: string[] = []
  const prisma: any = {
    scheduledSyncCursor: {
      createMany: async () => ({ count: 1 }),
      findUnique: async () => ({ ...cursor }),
      updateMany: async ({ where, data }: any) => {
        if (casFailures > 0) { casFailures--; return { count: 0 } }
        if (where.revision !== cursor.revision) return { count: 0 }
        cursor = { ...cursor, afterTenantId: data.afterTenantId, revision: cursor.revision + 1 }
        return { count: 1 }
      },
    },
    customerTenant: {
      findMany: async ({ where, take }: any) => {
        const idRule = where.AND[1]?.id
        const page = tenants.filter(tenant =>
          (!idRule?.gt || tenant.id > idRule.gt) &&
          (!idRule?.lte || tenant.id <= idRule.lte)).slice(0, take)
        scanned.push(page.map(tenant => tenant.id))
        return page
      },
    },
  }
  const service = () => {
    const result: any = new TenantSyncService(prisma, {} as never, {} as never,
      {} as never, {} as never, {} as never)
    result.logger = { log() {}, warn() {}, error() {} }
    result.syncConnectedTenant = async (tenant: { id: string }) => {
      dispatched.push(tenant.id)
      return { status: 'SUCCEEDED', failedResources: [] }
    }
    result.runPostSyncIdentityRiskEvaluation = async () => {}
    return result as TenantSyncService
  }
  return { service, scanned, dispatched, cursor: () => ({ ...cursor }), failNextCas: () => { casFailures++ } }
}

test('a durable scan reaches tenant 1001 while the first 1000 remain continuously due', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const priorBatch = process.env.SCHEDULED_SYNC_BATCH_SIZE
  const priorScan = process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT
  process.env.SCHEDULED_SYNC_BATCH_SIZE = '10'
  process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT = '1000'
  try {
    const f = fixture(1001)
    const first = await f.service().syncDueTenants()
    assert.equal(first.succeeded, 10)
    assert.equal(f.cursor().afterTenantId, tenantId(1000))
    assert.equal(f.scanned[0]?.length, 1000)

    // A new service instance represents a process restart. No collector
    // mutated the fake due rows, so the first 1000 are still eligible.
    const second = await f.service().syncDueTenants()
    assert.equal(second.succeeded, 10)
    assert.equal(f.scanned[1]?.[0], tenantId(1001))
    assert.equal(f.scanned[2]?.[0], tenantId(1))
    assert.equal(f.dispatched[10], tenantId(1001), 'the wrapped prefix cannot beat the post-cursor tenant')
    assert.equal(f.cursor().afterTenantId, tenantId(999))
  } finally {
    if (priorBatch === undefined) delete process.env.SCHEDULED_SYNC_BATCH_SIZE
    else process.env.SCHEDULED_SYNC_BATCH_SIZE = priorBatch
    if (priorScan === undefined) delete process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT
    else process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT = priorScan
  }
})

test('cursor compare-and-swap loser rereads instead of dispatching a duplicate stale window', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const f = fixture(3)
  f.failNextCas()
  const result = await f.service().syncDueTenants()
  assert.equal(result.succeeded, 3)
  assert.equal(f.scanned.length, 2, 'a lost CAS retries the scan')
  assert.equal(f.cursor().revision, 1)
})

test('an exhausted keyset wraps to continuously due lower IDs on the next visit', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const f = fixture(3)
  assert.equal((await f.service().syncDueTenants()).succeeded, 3)
  assert.equal(f.cursor().afterTenantId, tenantId(3))
  assert.equal((await f.service().syncDueTenants()).succeeded, 3)
  assert.deepEqual(f.scanned.slice(1), [[], [tenantId(1), tenantId(2), tenantId(3)]])
  assert.equal(f.cursor().revision, 2)
})
