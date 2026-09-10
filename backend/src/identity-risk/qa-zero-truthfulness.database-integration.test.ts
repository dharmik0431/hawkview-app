// HawkView QA — does a "0" mean the same thing in both of these situations?
//   HUMAN_CLEAN  : real human sign-ins were examined and nothing matched.
//   EXCLUDED_ONLY: every sign-in was a service principal, so no human
//                  credential event was examined at all.
// After 8029b52 the second case no longer counts as a coverage gap, so the
// source reports READY. The question this test answers is what the SHIPPED UI
// then tells the user, and whether the API contract can express the difference.
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
import { mailboxSourceDigest, sourceAttestationKey, MAILBOX_SOURCE_VERSION } from './mailbox-source-attestation.js'
import { mailboxRule } from './mailbox-risk.test-fixtures.js'
import { IDENTITY_RISK_ENGINE_VERSION, IDENTITY_RISK_CATALOG_VERSION } from './identity-risk.contract.js'

const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const deadline = () => Date.now() + 6000
type Traffic = 'HUMAN_CLEAN' | 'EXCLUDED_ONLY' | 'NO_ROWS'

async function scenario(traffic: Traffic) {
  const url = new URL(process.env.DATABASE_URL ?? '')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable loopback DB only')
  assert.match(url.pathname, /test|qa|^\/hawkview_ci$/i, 'Explicit test/QA database only')
  const prisma = new PrismaService(), client = new pg.Client({ connectionString: url.toString() })
  await prisma.$connect(); await client.connect()
  const environment = `qa-zero-${randomUUID().slice(0, 8)}`
  const configuration = {
    HAWKVIEW_IDENTITY_RISK_MODE: 'shadow', HAWKVIEW_IDENTITY_RISK_ROLLOUT: 'global',
    HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'wrapped-v1', HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: environment,
    HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: undefined, SECRET_ENCRYPTION_KEY: '73'.repeat(32),
  }
  const prior = Object.fromEntries(Object.keys(configuration).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(configuration)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  const keys = new WrappedRiskKeyStore(), store = new RiskGlobalWorkStore()
  const base = new Date(Date.now() - 10_000), old = new Date(base.getTime() - 60_000)
  const scope = { organizationId: randomUUID(), customerTenantId: randomUUID(), microsoftTenantId: randomUUID(), environment,
    humanId: randomUUID(), appId: randomUUID(), identity: { subject: randomUUID() }, upn: `synthetic@fixture.invalid` }
  try {
    await prisma.organization.create({ data: { id: scope.organizationId, name: 'QA zero scope', slug: `qa-zero-${scope.organizationId}` } })
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

    // Mailbox evidence is identical in both scenarios and matches nothing
    // (internal-domain forwarding), so the ONLY variable is the sign-in traffic.
    for (const resourceType of ['EXCHANGE_MAILBOX_RULES', 'EXCHANGE_ACCEPTED_DOMAINS'] as const) {
      const payload = resourceType === 'EXCHANGE_MAILBOX_RULES' ? [mailboxRule('internal@fixture.invalid', { mailboxUserId: scope.humanId, mailboxUpn: scope.upn })] : [{ domain: 'fixture.invalid' }]
      await prisma.tenantEntraSnapshot.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, resourceType, payload, observedAt: base } })
      await prisma.tenantCollectionFieldState.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, fieldKey: sourceAttestationKey(resourceType),
        state: 'COMPLETE', source: MAILBOX_SOURCE_VERSION, correlationId: mailboxSourceDigest(scope, resourceType, base, payload), lastSuccessfulAt: base } })
      await prisma.syncState.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, resourceType, status: 'SUCCEEDED', lastSuccessfulAt: base } })
    }
    await prisma.tenantEntraSnapshot.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, resourceType: 'EXCHANGE_MAILBOXES', payload: [{ id: scope.humanId, mail: scope.upn }], observedAt: base } })
    await prisma.syncState.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, resourceType: 'EXCHANGE_MAILBOXES', status: 'SUCCEEDED', lastSuccessfulAt: base } })
    await prisma.tenantEntraSnapshot.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, resourceType: 'EXCHANGE_MAILBOX_SETTINGS', payload: [{ mailboxUserId: scope.humanId, userPurpose: 'user' }], observedAt: base } })
    await prisma.syncState.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, resourceType: 'EXCHANGE_MAILBOX_SETTINGS', status: 'SUCCEEDED', lastSuccessfulAt: base } })

    const signIn = (id: string, index: number, servicePrincipal: boolean) => {
      const eventDateTime = new Date(base.getTime() - (index + 1) * 60_000)
      return { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, microsoftSignInId: id, eventDateTime,
        raw: { id, createdDateTime: eventDateTime.toISOString(), userId: scope.humanId, appId: scope.appId, ipAddress: '192.0.2.10',
          isInteractive: !servicePrincipal, status: { errorCode: 0 },
          ...(servicePrincipal ? { signInEventTypes: ['servicePrincipal'] } : {}) },
        riskLevel: 'high', ingestedAt: base, expiresAt: new Date(base.getTime() + 90 * 86_400_000) }
    }
    // HUMAN_CLEAN: real human logins, all successful, nothing a rule matches.
    // EXCLUDED_ONLY: the same volume, but every row is a service principal.
    // NO_ROWS is the case that reaches READY with a zero denominator on the
    // BASELINE too, so it proves the defect independently of 8029b52.
    const rows = traffic === 'NO_ROWS' ? [] : Array.from({ length: 8 }, (_, i) => signIn(`evt-${i}`, i, traffic === 'EXCLUDED_ONLY'))
    if (rows.length) await persistAuthenticationRecords(prisma, scope, rows)
    await persistCompletedAuthenticationWindow(prisma, scope, 'GRAPH_SIGN_INS', new Date(base.getTime() - 86_400_000), base, true)
    await prisma.syncState.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, resourceType: 'SIGN_INS',
      status: 'SUCCEEDED', lastAttemptAt: base, lastSuccessfulAt: new Date() } })

    const provider = new WrappedRiskPseudonymProvider(keys), projector = new RiskAssessmentProjector(provider, new MailboxRiskProjector(provider))
    const service = new IdentityRiskService(prisma, undefined, new RiskAssessmentReader(provider))
    const lease = await store.claimCycle(deadline()); assert.ok(lease)
    let attemptId: string
    try { attemptId = await store.recordAttempt(scope, lease, deadline()) } finally { await store.releaseCycle(lease, deadline()) }
    const evaluationAt = new Date()
    const evaluator = new IdentityRiskEvaluatorService(prisma, new IdentityRiskSafetyService(prisma), { now: () => evaluationAt })
    const batch = await projector.load({ organizationId: scope.organizationId, customerTenantId: scope.customerTenantId }, evaluationAt, Date.now() + 25_000)
    const result = await new IdentityRiskEvaluationScheduler(evaluator).runAssessmentTenant({
      organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, globalAttemptId: attemptId, evaluationAt,
      windowStart: new Date(evaluationAt.getTime() - 86_400_000), windowEnd: evaluationAt, executionDeadlineAt: Date.now() + 20_000,
      engineVersion: IDENTITY_RISK_ENGINE_VERSION, catalogVersion: IDENTITY_RISK_CATALOG_VERSION, loadSources: async () => batch })
    assert.equal(result.status, 'COMPLETED')

    const dto = await new IdentityRiskController(service).assessment({ auth: scope.identity } as any, scope.customerTenantId, 'true')
    const { adaptRiskAssessmentResponse } = await import(new URL('../../../lib/identity-risk/adapter.ts', import.meta.url).href)
    const { hawkViewRiskyUserCountPresentation, riskAssessmentEmptyPresentation } = await import(new URL('../../../lib/identity-risk/presentation.ts', import.meta.url).href)
    const view = adaptRiskAssessmentResponse(dto, Date.now())
    const headline = hawkViewRiskyUserCountPresentation(view)
    const empty = riskAssessmentEmptyPresentation(view)
    return {
      capability: dto.meta.capability, status: dto.meta.status, count: dto.summary.currentUsers,
      headlineValue: headline.value, accessibleValue: headline.accessibleValue, exact: headline.exact,
      headlineDetail: headline.detail, emptyLabel: empty?.label ?? null, emptyDetail: empty?.detail ?? null,
      authRules: dto.rules.filter((r: any) => r.ruleId !== 'HV-ID-MBX-001.v1')
        .map((r: any) => ({ ruleId: r.ruleId, status: r.status, assessed: r.assessedIdentities, matched: r.matchedIdentities })),
    }
  } finally {
    await client.query('ROLLBACK')
    await prisma.organization.deleteMany({ where: { id: scope.organizationId } })
    await prisma.user.deleteMany({ where: { id: scope.identity.subject } })
    await client.query('DELETE FROM identity_risk_scheduler_cursors WHERE environment=$1', [environment])
    await prisma.$disconnect(); await client.end()
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

// Run sequentially in ONE test: both scenarios mutate the same process env, so
// concurrent fixtures would tear each other's configuration down.
test('does a zero count distinguish "examined humans, found nothing" from "examined no humans at all"?',
  { skip: !enabled, timeout: 180_000 }, async () => {
    const human = await scenario('HUMAN_CLEAN')
    const excluded = await scenario('NO_ROWS')
    console.log(JSON.stringify({ QA_ZERO_TRUTHFULNESS: { human_realTraffic: human, zeroDenominator: excluded } }, null, 2))

    // Both empty-state texts correctly DISCLAIM safety ("does not establish
    // that an identity is safe"), so there is nothing to assert there.
    // The headline a user actually reads.
    const sameHeadline = human.headlineValue === excluded.headlineValue &&
      human.accessibleValue === excluded.accessibleValue && human.exact === excluded.exact
    // Whether the API contract can express the difference at all, even if the
    // headline does not. assessedIdentities is the candidate carrier.
    const contractCanExpress =
      JSON.stringify(human.authRules) !== JSON.stringify(excluded.authRules)

    console.log(JSON.stringify({ QA_ZERO_VERDICT: {
      sameHeadlineToUser: sameHeadline,
      contractCanExpressDifference: contractCanExpress,
      humanAuthRules: human.authRules, excludedAuthRules: excluded.authRules,
      interpretation: sameHeadline && contractCanExpress
        ? 'UI-ONLY GAP: the payload distinguishes them, the headline does not'
        : sameHeadline && !contractCanExpress
          ? 'CONTRACT GAP: the response shape cannot express the difference; no UI fix can be complete'
          : 'DISTINGUISHED: the user-facing headline already differs',
    } }, null, 2))
  })
