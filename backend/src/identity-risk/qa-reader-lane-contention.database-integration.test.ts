// HawkView QA — independent reproduction, not a product test.
// Proves a persisted COMPLETED assessment is reported to the user as
// indistinguishable from a tenant that has never collected, purely because the
// process-global sync memory lane was held by unrelated work at read time.
//
// The fixture below is copied from risk-assessment-connected.database-integration.test.ts
// deliberately: QA reproduces against the same proven setup rather than
// trusting or re-deriving the implementation's own helpers.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { PrismaService } from '../prisma/prisma.service.js'
import { IdentityRiskService } from './identity-risk.service.js'
import { IdentityRiskController } from './identity-risk.controller.js'
import { IdentityRiskEvaluatorService, IdentityRiskEvaluationScheduler } from './identity-risk-evaluator.service.js'
import { IdentityRiskSafetyService } from './identity-risk-safety.service.js'
import { RiskGlobalWorkStore } from './risk-global-work-store.js'
import { WrappedRiskKeyStore } from './wrapped-risk-key-store.js'
import { WrappedRiskPseudonymProvider } from './pilot-pseudonym-provider.js'
import { MailboxRiskProjector } from './mailbox-risk-projector.service.js'
import { RiskAssessmentProjector } from './risk-assessment-projector.service.js'
import { RiskAssessmentReader } from './risk-assessment-reader.service.js'
import { persistAuthenticationRecords } from './authentication-ingestion-integrity.js'
import { persistCompletedAuthenticationWindow } from './authentication-window-collector.js'
import { runInSyncMemoryLane } from '../tenants/tenant-sync.service.js'
import { mailboxSourceDigest, sourceAttestationKey, MAILBOX_SOURCE_VERSION } from './mailbox-source-attestation.js'
import { mailboxRule } from './mailbox-risk.test-fixtures.js'
import { IDENTITY_RISK_ENGINE_VERSION, IDENTITY_RISK_CATALOG_VERSION } from './identity-risk.contract.js'

const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const deadline = () => Date.now() + 6000

async function fixture(work: (f: any) => Promise<void>) {
  const url = new URL(process.env.DATABASE_URL ?? '')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable loopback DB only')
  assert.match(url.pathname, /test|qa|^\/hawkview_ci$/i, 'Explicit test/QA or repository CI database only')
  const prisma = new PrismaService(), client = new pg.Client({ connectionString: url.toString() })
  await prisma.$connect(); await client.connect()
  const environment = `qa-lane-${randomUUID().slice(0, 8)}`
  const configuration = {
    HAWKVIEW_IDENTITY_RISK_MODE: 'shadow', HAWKVIEW_IDENTITY_RISK_ROLLOUT: 'global',
    HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'wrapped-v1', HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: environment,
    HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: undefined, SECRET_ENCRYPTION_KEY: '73'.repeat(32),
  }
  const prior = Object.fromEntries(Object.keys(configuration).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(configuration)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  const scopes: any[] = [], ownerIds: string[] = []
  const store = new RiskGlobalWorkStore(), keys = new WrappedRiskKeyStore()
  const base = new Date(Date.now() - 10_000), old = new Date(base.getTime() - 60_000)
  try {
    for (let index = 0; index < 2; index++) {
      const scope = {
        organizationId: randomUUID(), customerTenantId: randomUUID(), microsoftTenantId: randomUUID(), environment,
        humanId: randomUUID(), appId: randomUUID(), identity: { subject: randomUUID() }, upn: `synthetic-${index}@fixture.invalid`,
      }
      scopes.push(scope); ownerIds.push(scope.identity.subject)
      await prisma.organization.create({ data: { id: scope.organizationId, name: 'QA lane scope', slug: `qa-lane-${scope.organizationId}` } })
      await prisma.customerTenant.create({ data: { id: scope.customerTenantId, organizationId: scope.organizationId, microsoftTenantId: scope.microsoftTenantId, displayName: 'Synthetic tenant', status: 'ACTIVE' } })
      await prisma.tenantConnection.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, status: 'CONNECTED' } })
      await prisma.user.create({ data: { id: scope.identity.subject, authProviderUserId: scope.identity.subject, email: `${scope.identity.subject}@fixture.invalid`,
        memberships: { create: { organizationId: scope.organizationId, role: 'MSP_OWNER', status: 'ACTIVE' } } } })
      await prisma.directoryUser.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, microsoftUserId: scope.humanId,
        displayName: 'Synthetic human', userPrincipalName: scope.upn, userType: 'Member', lastSeenAt: old, updatedAt: old } })
      await keys.ensureVersion({ organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, environment }, deadline())
      for (const resourceType of ['USERS', 'APPLICATIONS', 'SECURITY_DEFAULTS'] as const) {
        const payload = resourceType === 'APPLICATIONS' ? [{ appId: scope.appId, displayName: 'Synthetic application' }] : resourceType === 'SECURITY_DEFAULTS' ? [{ isEnabled: true }] : []
        await prisma.tenantEntraSnapshot.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, resourceType, payload, observedAt: old, updatedAt: old } })
        await prisma.syncState.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, resourceType, status: 'SUCCEEDED', lastAttemptAt: old, lastSuccessfulAt: base, updatedAt: base } })
      }
    }
    const [scope] = scopes
    const record = (id: string, index: number, success = false, overrides: any = {}) => {
      const eventDateTime = new Date(base.getTime() - (success ? 30_000 : (10 - index) * 60_000))
      const graph = { id, createdDateTime: eventDateTime.toISOString(), userId: scope.humanId, appId: scope.appId, ipAddress: '192.0.2.10', isInteractive: true, status: { errorCode: success ? 0 : 50126 } }
      return { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, microsoftSignInId: id, eventDateTime,
        raw: { ...graph, ...overrides }, riskLevel: 'high', ingestedAt: base, expiresAt: new Date(base.getTime() + 90 * 86_400_000) }
    }
    const records = Array.from({ length: 10 }, (_, i) => record(`failure-${i}`, i)); records.push(record('success', 0, true))
    await persistAuthenticationRecords(prisma, scope, records)
    await persistCompletedAuthenticationWindow(prisma, scope, 'GRAPH_SIGN_INS', new Date(base.getTime() - 86_400_000), base, true)
    await prisma.syncState.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, resourceType: 'SIGN_INS',
      status: 'SUCCEEDED', lastAttemptAt: base, lastSuccessfulAt: new Date() } })
    const provider = new WrappedRiskPseudonymProvider(keys), projector = new RiskAssessmentProjector(provider, new MailboxRiskProjector(provider))
    const reader = new RiskAssessmentReader(provider), service = new IdentityRiskService(prisma, undefined, reader)
    const begin = async () => { const lease = await store.claimCycle(deadline()); assert.ok(lease); try { return await store.recordAttempt(scope, lease, deadline()) } finally { await store.releaseCycle(lease, deadline()) } }
    const evaluate = async (evaluationAt = new Date()) => {
      const globalAttemptId = await begin()
      const evaluator = new IdentityRiskEvaluatorService(prisma, new IdentityRiskSafetyService(prisma), { now: () => evaluationAt })
      const scheduler = new IdentityRiskEvaluationScheduler(evaluator)
      const batch = await projector.load({ organizationId: scope.organizationId, customerTenantId: scope.customerTenantId }, evaluationAt, Date.now() + 25_000)
      return scheduler.runAssessmentTenant({ organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, globalAttemptId, evaluationAt,
        windowStart: new Date(evaluationAt.getTime() - 86_400_000), windowEnd: evaluationAt, executionDeadlineAt: Date.now() + 20_000,
        engineVersion: IDENTITY_RISK_ENGINE_VERSION, catalogVersion: IDENTITY_RISK_CATALOG_VERSION, loadSources: async () => batch })
    }
    await work({ prisma, client, scopes, scope, base, reader, service, evaluate })
  } finally {
    await client.query('ROLLBACK')
    for (const scope of scopes) await prisma.organization.deleteMany({ where: { id: scope.organizationId } })
    if (ownerIds.length) await prisma.user.deleteMany({ where: { id: { in: ownerIds } } })
    await client.query('DELETE FROM identity_risk_scheduler_cursors WHERE environment=$1', [environment])
    await prisma.$disconnect(); await client.end()
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

async function seedMailbox(f: any) {
  const stamp = f.base
  for (const resourceType of ['EXCHANGE_MAILBOX_RULES', 'EXCHANGE_ACCEPTED_DOMAINS'] as const) {
    const payload = resourceType === 'EXCHANGE_MAILBOX_RULES' ? [mailboxRule('forward@outside.invalid', { mailboxUserId: f.scope.humanId, mailboxUpn: f.scope.upn })] : [{ domain: 'fixture.invalid' }]
    await f.prisma.tenantEntraSnapshot.create({ data: { organizationId: f.scope.organizationId, customerTenantId: f.scope.customerTenantId, resourceType, payload, observedAt: stamp } })
    await f.prisma.tenantCollectionFieldState.create({ data: { organizationId: f.scope.organizationId, customerTenantId: f.scope.customerTenantId, fieldKey: sourceAttestationKey(resourceType),
      state: 'COMPLETE', source: MAILBOX_SOURCE_VERSION, correlationId: mailboxSourceDigest(f.scope, resourceType, stamp, payload), lastSuccessfulAt: stamp } })
    await f.prisma.syncState.create({ data: { organizationId: f.scope.organizationId, customerTenantId: f.scope.customerTenantId, resourceType, status: 'SUCCEEDED', lastSuccessfulAt: stamp } })
  }
  await f.prisma.tenantEntraSnapshot.create({ data: { organizationId: f.scope.organizationId, customerTenantId: f.scope.customerTenantId, resourceType: 'EXCHANGE_MAILBOXES', payload: [{ id: f.scope.humanId, mail: f.scope.upn }], observedAt: stamp } })
  await f.prisma.syncState.create({ data: { organizationId: f.scope.organizationId, customerTenantId: f.scope.customerTenantId, resourceType: 'EXCHANGE_MAILBOXES', status: 'SUCCEEDED', lastSuccessfulAt: stamp } })
  await f.prisma.tenantEntraSnapshot.create({ data: { organizationId: f.scope.organizationId, customerTenantId: f.scope.customerTenantId, resourceType: 'EXCHANGE_MAILBOX_SETTINGS', payload: [{ mailboxUserId: f.scope.humanId, userPurpose: 'user' }], observedAt: stamp } })
  await f.prisma.syncState.create({ data: { organizationId: f.scope.organizationId, customerTenantId: f.scope.customerTenantId, resourceType: 'EXCHANGE_MAILBOX_SETTINGS', status: 'SUCCEEDED', lastSuccessfulAt: stamp } })
}

// Holds the process-global lane exactly the way a background tenant sync or the
// 45s risk cycle does, then runs the read the user's browser would trigger.
async function whileLaneHeld<T>(work: () => Promise<T>): Promise<T> {
  let release!: () => void
  const held = runInSyncMemoryLane(() => new Promise<void>(resolve => { release = resolve }))
  try { return await work() } finally { release(); await held }
}

test('QA REPRO: a persisted COMPLETED assessment reads as never-collected while the sync lane is held',
  { skip: !enabled, timeout: 120_000 }, () => fixture(async f => {
    await seedMailbox(f)
    assert.equal((await f.evaluate()).status, 'COMPLETED')

    const scope = { organizationId: f.scope.organizationId, customerTenantId: f.scope.customerTenantId }
    const run = await f.prisma.identityRiskEvaluationRun.findFirst({ where: { ...scope, status: 'COMPLETED' }, orderBy: { completedAt: 'desc' } })
    assert.ok(run?.completedAt, 'A durable COMPLETED run must exist in Postgres before we read')

    const controller = new IdentityRiskController(f.service)
    const request = { auth: f.scope.identity } as any
    const { adaptRiskAssessmentResponse } = await import(new URL('../../../lib/identity-risk/adapter.ts', import.meta.url).href)
    const { hawkViewRiskyUserCountPresentation } = await import(new URL('../../../lib/identity-risk/presentation.ts', import.meta.url).href)
    const present = (dto: any) => hawkViewRiskyUserCountPresentation(adaptRiskAssessmentResponse(dto, Date.now()))

    // A — lane free. The data is real, complete and exactly countable.
    const free = await controller.assessment(request, f.scope.customerTenantId, 'true')
    console.log(JSON.stringify({ BASELINE_DIAGNOSTIC: { capability: free.meta.capability, status: free.meta.status,
      freshness: free.meta.freshness, evaluatedAt: free.meta.evaluatedAt, count: free.summary.currentUsers,
      users: free.users.length,
      sources: free.sources.map((s: any) => ({ source: s.source, status: s.status, reasonCode: s.reasonCode, freshness: s.freshness, lastSuccess: s.lastSuccessfulCollectionAt })),
      rules: free.rules.map((r: any) => ({ ruleId: r.ruleId, status: r.status, reasonCode: r.reasonCode, selectedSource: r.selectedSource, assessed: r.assessedIdentities, matched: r.matchedIdentities })) } }, null, 2))
    assert.equal(free.meta.capability, 'FULL', 'Baseline must be a fully-ready assessment or the repro proves nothing')
    assert.deepEqual(free.summary.currentUsers, { value: 1, accuracy: 'EXACT' })
    assert.equal(present(free).value, '1')

    // B — identical database state, lane held by unrelated work.
    const busy = await whileLaneHeld(() => controller.assessment(request, f.scope.customerTenantId, 'true'))

    // C — a tenant that has genuinely never been collected.
    const never = await controller.assessment({ auth: f.scopes[1].identity } as any, f.scopes[1].customerTenantId, 'true')

    // The run is still there and untouched; only the reader's answer changed.
    const after = await f.prisma.identityRiskEvaluationRun.findFirst({ where: { ...scope, status: 'COMPLETED' }, orderBy: { completedAt: 'desc' } })
    assert.equal(after.id, run.id, 'The persisted assessment must be unchanged by a busy-lane read')

    console.log(JSON.stringify({
      QA_REPRO: {
        A_laneFree: { capability: free.meta.capability, status: free.meta.status, evaluatedAt: free.meta.evaluatedAt,
          count: free.summary.currentUsers, headline: present(free).value, accessible: present(free).accessibleValue,
          sourceStatuses: free.sources.map((s: any) => s.status), ruleReasons: free.rules.map((r: any) => r.reasonCode) },
        B_laneBusy: { capability: busy.meta.capability, status: busy.meta.status, evaluatedAt: busy.meta.evaluatedAt,
          count: busy.summary.currentUsers, headline: present(busy).value, accessible: present(busy).accessibleValue,
          sourceStatuses: busy.sources.map((s: any) => s.status), ruleReasons: busy.rules.map((r: any) => r.reasonCode) },
        C_neverCollected: { capability: never.meta.capability, status: never.meta.status, evaluatedAt: never.meta.evaluatedAt,
          count: never.summary.currentUsers, headline: present(never).value, accessible: present(never).accessibleValue,
          sourceStatuses: never.sources.map((s: any) => s.status), ruleReasons: never.rules.map((r: any) => r.reasonCode) },
      },
    }, null, 2))

    // The defect: B loses a count that demonstrably exists ...
    assert.equal(busy.meta.capability, 'UNAVAILABLE', 'DEFECT: valid persisted assessment reported unavailable')
    assert.deepEqual(busy.summary.currentUsers, { value: null, accuracy: 'UNKNOWN' }, 'DEFECT: exact count of 1 became "not available"')
    assert.equal(busy.meta.evaluatedAt, null, 'DEFECT: the real evaluation timestamp is withheld')

    // ... and is indistinguishable from a tenant that never collected anything.
    assert.deepEqual(busy.sources.map((s: any) => s.status), never.sources.map((s: any) => s.status),
      'DEFECT: busy-lane source badges are identical to never-collected')
    assert.deepEqual(present(busy), present(never),
      'DEFECT: the user-visible count presentation is byte-identical to a tenant that has never collected')
  }))

// Acceptance criteria for the repair. RED today by design; must go GREEN on the
// candidate branch without any of the other assertions here regressing.
test('QA ACCEPTANCE: a busy lane must never be presented as never-collected, claim zero, or bypass authorization',
  { skip: !enabled, timeout: 120_000 }, () => fixture(async f => {
    await seedMailbox(f)
    assert.equal((await f.evaluate()).status, 'COMPLETED')

    const controller = new IdentityRiskController(f.service)
    const request = { auth: f.scope.identity } as any
    const { adaptRiskAssessmentResponse } = await import(new URL('../../../lib/identity-risk/adapter.ts', import.meta.url).href)
    const { hawkViewRiskyUserCountPresentation } = await import(new URL('../../../lib/identity-risk/presentation.ts', import.meta.url).href)
    const present = (dto: any) => hawkViewRiskyUserCountPresentation(adaptRiskAssessmentResponse(dto, Date.now()))

    const busy = await whileLaneHeld(() => controller.assessment(request, f.scope.customerTenantId, 'true'))
    const never = await controller.assessment({ auth: f.scopes[1].identity } as any, f.scopes[1].customerTenantId, 'true')

    // 1. Either the read survives a busy lane, or the user can at least tell the
    //    two situations apart. Collapsing both into one screen is the defect.
    const recovered = busy.meta.capability === 'FULL' &&
      busy.summary.currentUsers.value === 1 && busy.summary.currentUsers.accuracy === 'EXACT'
    const distinguishable = JSON.stringify(present(busy)) !== JSON.stringify(present(never)) ||
      JSON.stringify(busy.sources.map((s: any) => s.status)) !== JSON.stringify(never.sources.map((s: any) => s.status))
    assert.ok(recovered || distinguishable,
      'A transient busy lane must not render identically to a tenant that has never collected')

    // 2. Whatever it reports, it must never assert a clean zero it did not compute.
    assert.notEqual(present(busy).value, '0', 'A busy lane must never display a zero count')
    assert.notEqual(busy.summary.currentUsers.value, 0)

    // 3. Authorization must still be enforced while the lane is busy — a retry or
    //    a second lane must not reorder the tenant-scope check.
    await whileLaneHeld(async () => {
      await assert.rejects(() => controller.assessment({ auth: f.scopes[1].identity } as any, f.scope.customerTenantId, 'true'),
        /Tenant access denied/, 'Cross-tenant read must stay denied while the lane is busy')
      await f.prisma.user.update({ where: { id: f.scope.identity.subject }, data: { disabledAt: new Date() } })
      await assert.rejects(() => controller.assessment(request, f.scope.customerTenantId, 'true'),
        /Tenant access denied/, 'Disabled identity must stay denied while the lane is busy')
      await f.prisma.user.update({ where: { id: f.scope.identity.subject }, data: { disabledAt: null } })
    })
  }))
