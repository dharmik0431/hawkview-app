import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { TenantSyncService, claimTenantUsersLease } from '../tenants/tenant-sync.service.js'
import { IdentityRiskEvaluatorService } from './identity-risk-evaluator.service.js'
import { enforceRiskUtcTransaction } from './risk-utc-session.js'
import { sourceAttestationKey } from './mailbox-source-attestation.js'
import { IDENTITY_RISK_ENGINE_VERSION, IDENTITY_RISK_CATALOG_VERSION } from './identity-risk.contract.js'

test('real Prisma mailbox writers and evaluator preserve instants across session/Node timezones without changing the pool',
  { skip: process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1', timeout: 60000 }, async () => {
    const url = new URL(process.env.DATABASE_URL ?? '')
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable loopback PostgreSQL only')
    const originalNodeTimezone = process.env.TZ
    try {
      for (const nodeTimezone of ['UTC', 'America/New_York', 'Asia/Kolkata']) {
        process.env.TZ = nodeTimezone
        for (const databaseTimezone of ['UTC', 'America/New_York', 'Asia/Kolkata']) {
          const startup = new URL(url)
          startup.searchParams.set('options', `-c timezone=${databaseTimezone}`)
          const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: startup.toString(), max: 1 }) })
          const rollback = new Error('ROLLBACK_SYNTHETIC_UTC_FIXTURE')
          try {
            const sessionZone = () => prisma.$queryRawUnsafe<Array<{ timezone: string }>>("SELECT current_setting('TimeZone') AS timezone")
            assert.equal((await sessionZone())[0]?.timezone, databaseTimezone)
            await prisma.$transaction(async (transaction) => { await enforceRiskUtcTransaction(transaction) })
            assert.equal((await sessionZone())[0]?.timezone, databaseTimezone, 'SET LOCAL must not escape a successful commit')
            await assert.rejects(prisma.$transaction(async (transaction) => {
              await enforceRiskUtcTransaction(transaction)
              const scope = { organizationId: randomUUID(), customerTenantId: randomUUID() }
              await transaction.organization.create({ data: { id: scope.organizationId, name: 'Synthetic UTC', slug: `utc-${scope.organizationId}` } })
              await transaction.customerTenant.create({ data: { id: scope.customerTenantId, organizationId: scope.organizationId, microsoftTenantId: randomUUID() } })
              // Every production callback starts from a deliberately non-UTC
              // session again, so an earlier callback cannot hide a missing guard.
              const scopedPrisma = { $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => {
                await transaction.$executeRawUnsafe("SELECT set_config('TimeZone', $1, true)", databaseTimezone)
                return work(transaction)
              } }
              const expectedSnapshots = new Map<string, Date>()
              const tenant = { id: scope.customerTenantId, organizationId: scope.organizationId }
              const sync = new TenantSyncService(scopedPrisma as any, {} as any, {} as any,
                { resolveIncident: async () => {}, publishIncident: async () => {} } as any,
                { buildSnapshotDifferenceEvidence: ({ resourceType, observedAt }: any) => { expectedSnapshots.set(resourceType, observedAt); return [] } } as any,
                {} as any)
              for (const resource of ['EXCHANGE_MAILBOX_RULES', 'EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOXES']) {
                await (sync as any).runSnapshotSync(tenant, resource, () =>
                  (sync as any).saveSnapshot(tenant, resource, { completeness: 'authoritative_complete', rows: [] }, undefined, true))
                const snapshot = await transaction.tenantEntraSnapshot.findUniqueOrThrow({ where: { customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType: resource as any } } })
                assert.equal(snapshot.observedAt.getTime(), expectedSnapshots.get(resource)?.getTime())
                const raw = await transaction.$queryRawUnsafe<Array<{ milliseconds: number }>>(
                  'SELECT (extract(epoch from observed_at)*1000)::double precision AS milliseconds FROM tenant_entra_snapshots WHERE id=$1::uuid', snapshot.id)
                assert.equal(raw[0]?.milliseconds, expectedSnapshots.get(resource)?.getTime())
                const state = await transaction.syncState.findUniqueOrThrow({ where: { customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType: resource as any } } })
                assert.equal(state.status, 'SUCCEEDED')
                assert.ok(state.lastSuccessfulAt!.getTime() >= snapshot.observedAt.getTime())
                assert.ok(state.lastSuccessfulAt!.getTime() - snapshot.observedAt.getTime() < 10000)
                if (resource !== 'EXCHANGE_MAILBOXES') {
                  const attestation = await transaction.tenantCollectionFieldState.findUniqueOrThrow({ where: { customerTenantId_fieldKey: { customerTenantId: tenant.id, fieldKey: sourceAttestationKey(resource as any) } } })
                  assert.equal(attestation.lastAttemptAt?.getTime(), snapshot.observedAt.getTime())
                  if (attestation.lastSuccessfulAt) assert.equal(attestation.lastSuccessfulAt.getTime(), snapshot.observedAt.getTime())
                }
              }
              const now = new Date('2026-09-04T12:34:56.789Z')
              assert.equal(now.toISOString(), '2026-09-04T12:34:56.789Z')
              const lease = await claimTenantUsersLease(scopedPrisma, tenant, now)
              assert.equal(lease.claimed, true)
              const users = await transaction.syncState.findUniqueOrThrow({ where: { customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType: 'USERS' } } })
              assert.equal(users.lastAttemptAt?.getTime(), now.getTime())
              const evaluator = new IdentityRiskEvaluatorService(scopedPrisma as any, {} as any)
              const request = { ...scope, engineVersion: IDENTITY_RISK_ENGINE_VERSION, catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
                windowStart: new Date(now.getTime() - 3600000), windowEnd: now, evaluationAt: now }
              const input = { request, platformNow: now, sourceObservedAt: new Date(now.getTime() - 1000), runKey: 'synthetic-utc-run',
                watermarkHash: 'synthetic-watermark', sourceContentHash: 'synthetic-content', leaseToken: randomUUID(),
                expiresAt: new Date(now.getTime() + 3600000), capability: 'UNAVAILABLE' }
              const claimed = await (evaluator as any).claimRun(input)
              assert.ok(claimed.id)
              const run = await transaction.identityRiskEvaluationRun.findUniqueOrThrow({ where: { id: claimed.id } })
              assert.equal(run.createdAt.getTime(), now.getTime())
              assert.equal(run.windowEnd.getTime(), now.getTime())
              assert.equal(run.sourceObservedAt?.getTime(), now.getTime() - 1000)
              assert.equal(run.leaseExpiresAt?.getTime(), now.getTime() + 5 * 60000)
              assert.equal(run.expiresAt.getTime(), input.expiresAt.getTime())
              await (evaluator as any).persistCompletedRun({ ...input, runId: claimed.id, aggregates: [], matches: [] })
              const completed = await transaction.identityRiskEvaluationRun.findUniqueOrThrow({ where: { id: claimed.id } })
              assert.equal(completed.completedAt?.getTime(), now.getTime())
              assert.equal(completed.status, 'COMPLETED')
              const epoch = await transaction.$queryRawUnsafe<Array<{ milliseconds: number }>>(
                'SELECT (extract(epoch from completed_at)*1000)::double precision AS milliseconds FROM identity_risk_evaluation_runs WHERE id=$1::uuid', claimed.id)
              assert.equal(epoch[0]?.milliseconds, now.getTime())
              throw rollback
            }, { timeout: 15000 }), (error) => error === rollback)
            assert.equal((await sessionZone())[0]?.timezone, databaseTimezone, 'SET LOCAL must not escape rollback')
          } finally { await prisma.$disconnect() }
        }
      }
    } finally {
      if (originalNodeTimezone === undefined) delete process.env.TZ
      else process.env.TZ = originalNodeTimezone
    }
  })
