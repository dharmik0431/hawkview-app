// HawkView QA — pre-implementation acceptance test for the greentech
// classification fix (b), written BEFORE the fix so the trap fails loudly
// rather than depending on review to catch it.
//
// THE TRAP: a tenant's window consists entirely of security-relevant events the
// classifier does not recognize — smart lockouts and blocked sign-ins. Today
// those are UNKNOWN, which caps the rule and correctly yields "not available".
// If (b) maps them to a benign outcome, they stop capping the rule AND stop
// being visible, so the tenant reports a confident EXACT 0 having examined none
// of them. That is a clean bill of health asserted over unexamined security
// events — the same defect class as the contradictory zero, by another route.
//
// This test PASSES today and must keep passing. If it starts failing, (b) has
// bought a reportable count by discarding evidence.
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

// UNRECOGNIZED: smart lockout and a blocked sign-in. Security-relevant, and
// outside the recognized set, so today they cap coverage as UNKNOWN.
const UNRECOGNIZED = [50053, 53003]
// NON_QUALIFYING: codes ALREADY classified out-of-scope today. This is the
// state fix (b) intends to put lockouts into, so running the same scenario
// against these codes shows what that state already does to the user — no
// waiting for (b), and no guessing at its design.
const NON_QUALIFYING = [50076, 50140]

async function securityEventTenant<T>(codes: readonly number[], work: (context: any) => Promise<T>): Promise<T> {
  const url = new URL(process.env.DATABASE_URL ?? '')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable loopback DB only')
  assert.match(url.pathname, /test|qa|^\/hawkview_ci$/i, 'Explicit test/QA database only')
  const prisma = new PrismaService(), client = new pg.Client({ connectionString: url.toString() })
  await prisma.$connect(); await client.connect()
  const environment = `qa-sec-${randomUUID().slice(0, 8)}`
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
    humanId: randomUUID(), appId: randomUUID(), identity: { subject: randomUUID() }, upn: 'synthetic@fixture.invalid' }
  try {
    await prisma.organization.create({ data: { id: scope.organizationId, name: 'QA security-events scope', slug: `qa-sec-${scope.organizationId}` } })
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
    // Mailbox evidence is complete and matches nothing, so the ONLY thing that
    // could hold the assessment back is how the sign-in events are classified.
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

    // The whole window: lockouts and blocked sign-ins. Nothing else.
    const rows = Array.from({ length: 12 }, (_, index) => {
      const eventDateTime = new Date(base.getTime() - (index + 1) * 60_000)
      const errorCode = codes[index % codes.length]!
      return { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, microsoftSignInId: `sec-${index}`, eventDateTime,
        raw: { id: `sec-${index}`, createdDateTime: eventDateTime.toISOString(), userId: scope.humanId, appId: scope.appId,
          ipAddress: '198.51.100.7', isInteractive: true,
          // A zero code must carry no unexplained text or it classifies as
          // UNKNOWN and caps, which would mask the very thing being measured.
          status: errorCode === 0 ? { errorCode: 0 } : { errorCode, failureReason: 'Security event the classifier does not recognize' } },
        riskLevel: 'high', ingestedAt: base, expiresAt: new Date(base.getTime() + 90 * 86_400_000) }
    })
    await persistAuthenticationRecords(prisma, scope, rows)
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
    return await work({ dto, headline: hawkViewRiskyUserCountPresentation(view), empty: riskAssessmentEmptyPresentation(view) })
  } finally {
    await client.query('ROLLBACK')
    await prisma.organization.deleteMany({ where: { id: scope.organizationId } })
    await prisma.user.deleteMany({ where: { id: scope.identity.subject } })
    await client.query('DELETE FROM identity_risk_scheduler_cursors WHERE environment=$1', [environment])
    await prisma.$disconnect(); await client.end()
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

/** Does anything a user can see disclose that events fell outside the assessed
 * scope? Deliberately a broad search rather than a named field, because no
 * mechanism exists yet and the acceptance rule must not presuppose its shape. */
const disclosesOutOfScope = (payload: unknown) => {
  const blob = JSON.stringify(payload) ?? ''
  return /"(excluded|outOfScope|notInScope|nonQualifying|unassessed|skipped|outsideScope)[A-Za-z]*"\s*:\s*(?!null|0[,}])/i.test(blob)
    || /outside the assessed scope|not assessed|excluded from|fell outside/i.test(blob)
}

// Two scenarios, one rule. UNRECOGNIZED is the state today; NON_QUALIFYING is
// the state fix (b) intends to move lockouts INTO, and it is reachable now
// because 50076/50140 already live there — so this shows what (b)'s target
// state already does to a user, without guessing at (b)'s design.
// PRE_EXISTING uses only 50076, which was already NON_QUALIFYING before any of
// this branch's work. Running it against origin/main settles whether the
// bare-zero trap is a production defect or something the branch introduced.
const PRE_EXISTING = [50076]
// MIXED is the realistic MFA-enforced tenant: mostly ordinary successes with
// MFA interrupts throughout. 8 of 12 events excluded, 4 genuinely assessed and
// matching nothing. If this ALSO renders a bare exact zero, the defect is not
// confined to all-excluded windows — it affects every such tenant continuously.
const MIXED = [50076, 50076, 0]
// CONTROL: real evaluated evidence, NOTHING excluded, no matches. This is the
// genuine scoped zero the brief permits. It must keep reporting EXACT 0 — a fix
// that withholds here has traded a false zero for no zero at all, which would
// be a worse outcome than the defect.
const CONTROL = [0]

// Expectations differ per scenario, because a blanket "never claim zero" rule
// would fail CONTROL, which is exactly the regression this must guard.
type Expectation = 'MUST_WITHHOLD' | 'MUST_NOT_SHOW_BARE_ZERO' | 'MUST_REPORT_EXACT_ZERO'
const SCENARIOS: readonly (readonly [string, readonly number[], Expectation])[] = [
  ['UNRECOGNIZED', UNRECOGNIZED, 'MUST_WITHHOLD'],
  ['NON_QUALIFYING', NON_QUALIFYING, 'MUST_NOT_SHOW_BARE_ZERO'],
  ['PRE_EXISTING', PRE_EXISTING, 'MUST_NOT_SHOW_BARE_ZERO'],
  ['MIXED', MIXED, 'MUST_NOT_SHOW_BARE_ZERO'],
  ['CONTROL', CONTROL, 'MUST_REPORT_EXACT_ZERO'],
]
for (const [label, codes, expectation] of SCENARIOS)
test(`${label}: a window of only security events must never render a BARE confident zero`,
  { skip: !enabled, timeout: 180_000 }, () => securityEventTenant(codes, async ({ dto, headline, empty }) => {
    const summary = { capability: dto.meta.capability, status: dto.meta.status, count: dto.summary.currentUsers,
      headline: headline.value, accessible: headline.accessibleValue, exact: headline.exact,
      emptyLabel: empty?.label ?? null, emptyDetail: empty?.detail ?? null,
      // Engineer's proposed tier-1 witness for "zero evidence survived".
      authSourceLatestEventAt: dto.sources.filter((source: any) => source.source !== 'MAILBOX_RULES')
        .map((source: any) => ({ source: source.source, latestEventAt: source.latestEventAt })),
      authRules: dto.rules.filter((rule: any) => rule.ruleId !== 'HV-ID-MBX-001.v1')
        .map((rule: any) => ({ ruleId: rule.ruleId, status: rule.status, reasonCode: rule.reasonCode, assessed: rule.assessedIdentities, matched: rule.matchedIdentities })) }
    console.log(JSON.stringify({ [`QA_SECURITY_EVENTS_${label}`]: summary }, null, 2))

    // THE ACCEPTANCE RULE, per the product brief: a current, sufficiently
    // complete assessment may show 0 FOR ITS ASSESSED SCOPE. So a zero is not
    // forbidden — an UNQUALIFIED zero is. Either withhold, or disclose that
    // these events fell outside what was assessed.
    const claimsZero = dto.summary.currentUsers.value === 0 && dto.summary.currentUsers.accuracy === 'EXACT'
    const discloses = disclosesOutOfScope({ dto, headline, empty })
    console.log(JSON.stringify({ [`QA_ACCEPTANCE_${label}`]: {
      claimsZero, disclosesOutOfScope: discloses, eventsInWindow: 12,
      expectation,
      verdict: expectation === 'MUST_REPORT_EXACT_ZERO'
        ? (claimsZero ? 'GENUINE ZERO PRESERVED (required)' : 'REGRESSION: the legitimate zero was destroyed')
        : !claimsZero ? 'WITHHELD (acceptable)'
          : discloses ? 'SCOPED ZERO WITH DISCLOSURE (acceptable)' : 'BARE ZERO (trap)',
    } }, null, 2))

    // Expressed as implications, not fixed shapes: any design reaching an
    // honest user-facing answer passes, however it does so.
    if (expectation === 'MUST_REPORT_EXACT_ZERO') {
      // The regression guard. Nothing was excluded here, so withholding would
      // mean the fix destroyed the legitimate zero it was meant to protect.
      assert.ok(claimsZero,
        `REGRESSION (${label}): a genuine zero over fully assessed evidence with nothing excluded must still report EXACT 0`)
    } else {
      assert.ok(!claimsZero || discloses,
        `TRAP (${label}): an exact zero is claimed over 12 security-relevant events with nothing disclosing they fell outside the assessed scope`)
      assert.ok(!(claimsZero && empty?.label === 'No findings in evaluated evidence' && !discloses),
        `TRAP (${label}): "No findings in evaluated evidence" claimed over events that were never assessed`)
      if (expectation === 'MUST_WITHHOLD') assert.equal(claimsZero, false,
        `(${label}): unprocessable evidence is a gap, not an exclusion, and must keep withholding the count`)
    }
  }))
