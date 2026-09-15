import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { PrismaService } from '../prisma/prisma.service.js'
import { assertDisposableNativeAlertDatabase } from '../prisma/native-alert-test-database.js'
import { RiskHistoryRetention, riskHistoryRetentionConfig } from './risk-history-retention.js'
import { RUN_STATUS, RUN_ENGINE_VERSION, RUN_CATALOG_VERSION } from '../risky-users-wiring/persist-run.js'
import { NATIVE_RULE_ID, NOT_ASSESSED } from '../risky-users-wiring/publish-to-intake.js'

// Retention fixtures, not a substitute for the independent production publisher
// acceptance test. No provider, email or production service is invoked here.
type Scope = { organizationId: string; customerTenantId: string }
type Fixture = { c: pg.Client; prisma: PrismaService; scopes: Scope[]; worker: RiskHistoryRetention;
  config: NonNullable<ReturnType<typeof riskHistoryRetentionConfig>>; lease: { key: string; id: string } }

async function fixture(work: (f: Fixture) => Promise<void>) {
  const url = assertDisposableNativeAlertDatabase(process.env, { retention: true })
  assert.equal(process.env.TZ, 'UTC', 'UTC Node process required')
  const c = new pg.Client({ connectionString: url.toString() })
  const prisma = new PrismaService()
  const scopes: Scope[] = []
  const orgs: string[] = []
  let lease: Fixture['lease'] | null = null
  try {
    await c.connect()
    await c.query("SET TIME ZONE 'UTC'")
    assert.equal((await c.query("SELECT current_setting('TimeZone') AS zone")).rows[0].zone, 'UTC')
    assert.ok((await c.query('SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).rows[0].n >= 65)
    await prisma.$connect()
    for (let i = 0; i < 2; i++) {
      const organizationId = randomUUID()
      await prisma.organization.create({ data: { id: organizationId, name: 'Synthetic native retention', slug: organizationId } })
      orgs.push(organizationId)
      const customerTenantId = randomUUID()
      await prisma.customerTenant.create({ data: { id: customerTenantId, organizationId,
        microsoftTenantId: randomUUID(), displayName: 'example.invalid', status: 'ACTIVE' } })
      scopes.push({ organizationId, customerTenantId })
    }
    const worker = new RiskHistoryRetention()
    const config = riskHistoryRetentionConfig({ HAWKVIEW_RISK_HISTORY_RETENTION_MODE: 'delete',
      HAWKVIEW_RISK_HISTORY_RETENTION_SCOPES: JSON.stringify([scopes[0]]) })!
    lease = await worker.claim(config, Date.now() + 3000)
    assert.ok(lease)
    await work({ c, prisma, scopes, worker, config, lease })
  } finally {
    // Only random UUID organizations created above; no broad cleanup or shared config.
    try {
      for (const id of orgs) await prisma.organization.delete({ where: { id } })
      if (lease) await c.query('DELETE FROM identity_risk_history_cursors WHERE scope_key=$1 AND lease_id=$2::uuid', [lease.key, lease.id])
    } finally {
      await prisma.$disconnect()
      await c.end()
    }
  }
}

async function graph(prisma: PrismaService, scope: Scope,
  options: { ageDays?: number; liveRun?: boolean; liveChild?: boolean; leased?: boolean } = {}) {
  const now = Date.now()
  const createdAt = new Date(now - (options.ageDays ?? 91) * 86_400_000)
  const completedAt = new Date(createdAt.getTime() + 1000)
  const expired = new Date(now - 86_400_000)
  const future = new Date(now + 86_400_000)
  const run = await prisma.identityRiskEvaluationRun.create({ data: {
    ...scope, runKey: randomUUID(), engineVersion: RUN_ENGINE_VERSION, catalogVersion: RUN_CATALOG_VERSION,
    status: RUN_STATUS, windowStart: createdAt, windowEnd: completedAt,
    sourceWatermarkHash: 'synthetic', sourceContentHash: 'synthetic', createdAt, completedAt,
    expiresAt: options.liveRun ? future : expired, leaseExpiresAt: options.leased ? future : null,
  } })
  const matched = await prisma.identityRiskMatchedResult.create({ data: {
    ...scope, evaluationRunId: run.id, resultKey: randomUUID(), ruleId: NATIVE_RULE_ID,
    subjectType: 'USER', subjectId: 'opaque-synthetic-subject', severity: NOT_ASSESSED,
    confidence: NOT_ASSESSED, coverage: NOT_ASSESSED, observedAt: createdAt,
    createdAt, expiresAt: options.liveChild ? future : expired,
  } })
  const finding = await prisma.identityRiskFinding.create({ data: {
    ...scope, matchedResultId: matched.id, dedupeKey: randomUUID(), ruleId: NATIVE_RULE_ID,
    ruleVersion: 'v1', subjectType: 'USER', subjectId: matched.subjectId, state: 'OPEN',
    severity: NOT_ASSESSED, confidence: NOT_ASSESSED, coverage: NOT_ASSESSED,
    observedAt: createdAt, createdAt, updatedAt: createdAt, expiresAt: options.liveChild ? future : expired,
  } })
  return { run, matched, finding }
}

const prune = (f: Fixture) => f.worker.prune(f.scopes[0]!, f.config, f.lease, Date.now() + 3000)
async function snapshot(prisma: PrismaService, value: Awaited<ReturnType<typeof graph>>) {
  return Promise.all([
    prisma.identityRiskEvaluationRun.findUnique({ where: { id: value.run.id } }),
    prisma.identityRiskMatchedResult.findUnique({ where: { id: value.matched.id } }),
    prisma.identityRiskFinding.findUnique({ where: { id: value.finding.id } }),
  ])
}

test('native retention: expired91d graph is pruned, incident/notification/withheld provenance and other organization remain', { skip: process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1' }, async () => fixture(async f => {
  const scope = f.scopes[0]!
  const expired = await graph(f.prisma, scope)
  const foreign = await graph(f.prisma, f.scopes[1]!)
  const foreignBefore = await snapshot(f.prisma, foreign)
  const now = new Date()
  const incidentKey = `synthetic:${expired.finding.id}`
  const incident = await f.prisma.alertIncident.create({ data: {
    organizationId: scope.organizationId, incidentKey, alertTypeId: 'security.suspected_credential_attack',
    ownership: 'UNACKNOWLEDGED', condition: 'ACTIVE', investigation: 'OPEN',
    ownershipAt: now, conditionAt: now, investigationAt: now,
  } })
  const notification = await f.prisma.notification.create({ data: {
    ...scope, dedupeKey: randomUUID(), eventType: 'identity_risk_finding', category: 'security', severity: 'warning',
    title: 'Synthetic retained alert', description: 'Synthetic retention fixture only', source: 'identity-risk',
    incidentKey, alertTypeId: incident.alertTypeId, metadata: { findingId: expired.finding.id },
  } })
  const notice = await f.prisma.alertWithheldNotice.create({ data: {
    organizationId: scope.organizationId, dedupeKey: randomUUID(), alertTypeId: incident.alertTypeId,
    findingId: expired.finding.id, because: 'RECORD_ONLY',
  } })
  assert.equal((await f.worker.preflight(f.config, Date.now() + 3000)).candidateRunsObserved, 1)
  assert.deepEqual(await prune(f), { findings: 1, matchedResults: 1, coverage: 0, runs: 1 })
  assert.deepEqual(await snapshot(f.prisma, expired), [null, null, null])
  assert.deepEqual(await snapshot(f.prisma, foreign), foreignBefore)
  assert.deepEqual(await f.prisma.alertIncident.findUnique({ where: { id: incident.id } }), incident)
  assert.deepEqual(await f.prisma.notification.findUnique({ where: { id: notification.id } }), notification)
  assert.deepEqual(await f.prisma.alertWithheldNotice.findUnique({ where: { id: notice.id } }), notice)
  // Alert snapshots retain opaque historical provenance, not a claim of live evidence.
  assert.deepEqual(await prune(f), { findings: 0, matchedResults: 0, coverage: 0, runs: 0 })
}))

test('native retention: current evidence, independent expiry,90d age floor and live lease stay protected', { skip: process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1' }, async () => fixture(async f => {
  const kept = await Promise.all([
    graph(f.prisma, f.scopes[0]!, { liveChild: true }),
    graph(f.prisma, f.scopes[0]!, { liveRun: true }),
    graph(f.prisma, f.scopes[0]!, { ageDays: 89 }),
    graph(f.prisma, f.scopes[0]!, { leased: true }),
  ])
  const before = await Promise.all(kept.map(value => snapshot(f.prisma, value)))
  assert.deepEqual(await prune(f), { findings: 0, matchedResults: 0, coverage: 0, runs: 0 })
  assert.deepEqual(await Promise.all(kept.map(value => snapshot(f.prisma, value))), before)
  await assert.rejects(f.worker.prune(f.scopes[1]!, f.config, f.lease, Date.now() + 3000), /RISK_HISTORY_UNAVAILABLE/)
}))

test('native retention: failure after finding deletion rolls back the entire graph', { skip: process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1' }, async () => fixture(async f => {
  const value = await graph(f.prisma, f.scopes[0]!)
  const before = await snapshot(f.prisma, value)
  const original = (f.worker as any).tx.bind(f.worker)
  let injected = false
  ;(f.worker as any).tx = (deadline: number, work: (c: pg.Client) => Promise<unknown>) => original(deadline, async (c: pg.Client) => {
    const query = c.query.bind(c)
    ;(c as any).query = (sql: string, ...args: unknown[]) => {
      if (sql.includes('DELETE FROM identity_risk_matched_results')) {
        injected = true
        throw new Error('SYNTHETIC_RETENTION_ROLLBACK')
      }
      return (query as any)(sql, ...args)
    }
    try { return await work(c) } finally { c.query = query }
  })
  await assert.rejects(prune(f), /IDENTITY_RISK_SOURCE_UNAVAILABLE/)
  assert.equal(injected, true, 'Failure must occur after the native finding-delete statement')
  assert.deepEqual(await snapshot(f.prisma, value), before)
}))
