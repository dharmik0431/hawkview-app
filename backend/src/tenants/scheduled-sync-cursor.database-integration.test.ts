import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { TenantSyncService } from './tenant-sync.service.js'

const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'

test('migrated cursor persists a scan position and rejects stale concurrent advancement',
  { skip: !enabled, timeout: 30_000 }, async () => {
    const url = assertDisposableTestDatabase()
    const adapter = () => new PrismaPg({ connectionString: url.toString(), max: 2 })
    const writer = new PrismaClient({ adapter: adapter() })
    const observer = new PrismaClient({ adapter: adapter() })
    const scopeKey = `sync-cursor-test-${randomUUID().slice(0, 18)}`
    const afterTenantId = randomUUID()
    const competingTenantId = randomUUID()
    try {
      assert.equal((await writer.scheduledSyncCursor.createMany({ data: [{ scopeKey }], skipDuplicates: true })).count, 1)
      assert.equal((await writer.scheduledSyncCursor.createMany({ data: [{ scopeKey }], skipDuplicates: true })).count, 0)
      const before = await observer.scheduledSyncCursor.findUniqueOrThrow({ where: { scopeKey } })
      assert.equal(before.afterTenantId, null)
      assert.equal(before.revision, 0)
      // The position has no FK: deleting a tenant must not reset the scan.
      const [first, second] = await Promise.all([
        writer.scheduledSyncCursor.updateMany({
          where: { scopeKey, revision: before.revision },
          data: { afterTenantId, revision: { increment: 1 } },
        }),
        observer.scheduledSyncCursor.updateMany({
          where: { scopeKey, revision: before.revision },
          data: { afterTenantId: competingTenantId, revision: { increment: 1 } },
        }),
      ])
      assert.equal(first.count + second.count, 1, 'only one concurrent worker advances the position')
      assert.equal((await writer.scheduledSyncCursor.updateMany({
        where: { scopeKey, revision: before.revision },
        data: { afterTenantId: randomUUID(), revision: { increment: 1 } },
      })).count, 0, 'a stale worker cannot later overwrite the committed position')
      const after = await observer.scheduledSyncCursor.findUniqueOrThrow({ where: { scopeKey } })
      assert.equal(after.afterTenantId, first.count ? afterTenantId : competingTenantId)
      assert.equal(after.revision, 1)
    } finally {
      await writer.scheduledSyncCursor.deleteMany({ where: { scopeKey } })
      await Promise.all([writer.$disconnect(), observer.$disconnect()])
    }
  })

test('migrated due query and cursor dispatch beyond 1000 continuously due tenants',
  { skip: !enabled, timeout: 90_000 }, async t => {
    const url = assertDisposableTestDatabase()
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString(), max: 5 }) })
    const organizationId = randomUUID()
    const priorBatch = process.env.SCHEDULED_SYNC_BATCH_SIZE
    const priorScan = process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT
    process.env.SCHEDULED_SYNC_BATCH_SIZE = '10'
    process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT = '1000'
    const provider = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('Unexpected provider call in cursor dispatch proof')
    })
    const attempted: string[] = []
    let ownsCursor = false
    try {
      assert.equal(await prisma.scheduledSyncCursor.findUnique({ where: { scopeKey: 'TENANT_SYNC' } }), null)
      ownsCursor = true
      await prisma.organization.create({ data: {
        id: organizationId, name: 'Synthetic cursor scale fixture', slug: organizationId,
      } })
      await prisma.$executeRaw`
        INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, status, updated_at)
        SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
          ${organizationId}::uuid,
          ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
          'ACTIVE', CURRENT_TIMESTAMP
        FROM generate_series(1, 1001) AS n`
      await prisma.$executeRaw`
        INSERT INTO tenant_connections (id, organization_id, customer_tenant_id, status, updated_at)
        SELECT gen_random_uuid(), organization_id, id, 'CONNECTED', CURRENT_TIMESTAMP
        FROM customer_tenants WHERE organization_id = ${organizationId}::uuid`
      const service: any = new TenantSyncService(prisma as any, {} as never, {} as never,
        {} as never, {} as never, {} as never)
      service.logger = { log() {}, warn() {}, error() {} }
      service.syncConnectedTenant = async (tenant: { id: string }) => {
        attempted.push(tenant.id)
        return { status: 'SUCCEEDED', failedResources: [] }
      }
      service.runPostSyncIdentityRiskEvaluation = async () => {}
      assert.equal((await service.syncDueTenants()).succeeded, 10)
      assert.equal((await prisma.scheduledSyncCursor.findUniqueOrThrow({ where: { scopeKey: 'TENANT_SYNC' } })).afterTenantId,
        '00000000-0000-4000-8000-000000001000')
      // No fixture row changes status. The first 1000 are still due on the
      // second tick, yet tenant 1001 must be selected before the wrapped prefix.
      assert.equal((await service.syncDueTenants()).succeeded, 10)
      assert.equal(attempted[10], '00000000-0000-4000-8000-000000001001')
      assert.equal(provider.mock.callCount(), 0)
    } finally {
      if (priorBatch === undefined) delete process.env.SCHEDULED_SYNC_BATCH_SIZE
      else process.env.SCHEDULED_SYNC_BATCH_SIZE = priorBatch
      if (priorScan === undefined) delete process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT
      else process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT = priorScan
      if (ownsCursor) await prisma.scheduledSyncCursor.deleteMany({ where: { scopeKey: 'TENANT_SYNC' } })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
      await prisma.$disconnect()
    }
  })
