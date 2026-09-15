import { ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common'
import { NATIVE_SUMMARY_TENANT_LIMIT, type NativeSummaryScope } from '../risky-users-wiring/native-risk-summary.js'
import { summarizeMicrosoftRisk, parseMicrosoftRiskRecord, MICROSOFT_RISK_MAX_ROWS } from './microsoft-risk-summary.js'
import { microsoftRiskSourceAllowed, collectedLicenseServicePlans } from '../tenants/collection-readiness.js'
import { MailboxInvestigationResolver } from './mailbox-investigation-resolver.js'
import { RiskAssessmentReader, unavailableAssessment } from './risk-assessment-reader.service.js'
import { recordRiskReader } from './risk-operational-diagnostics.js'
import { riskRuntimeConfig, riskScopeAllowed } from './risk-runtime-config.js'
import { isGlobalRiskConfig } from './risk-runtime-config.js'
import { enforceRiskUtcTransaction } from './risk-utc-session.js'
import type { Prisma } from '../generated/prisma/client.js'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import { PrismaService } from '../prisma/prisma.service.js'
import {
  IDENTITY_RISK_API_VERSION,
  IDENTITY_RISK_CATALOG_VERSION,
  IDENTITY_RISK_ENGINE_VERSION,
  MICROSOFT_RISK_CATALOG_VERSION,
  type IdentityRiskBoundedCount,
  type IdentityRiskEnvelope,
  type IdentityRiskFindingDto,
  type IdentityRiskPageInfo,
  type MailboxInvestigationDto,
  type MicrosoftRiskyUserDto,
} from './identity-risk.contract.js'
import {
  identityRiskRulePresentation,
  isIdentityRiskRuleId,
} from './identity-risk.catalog.js'
import {
  boundedOpaqueId,
  boundedSafeString,
  decodeIdentityRiskCursor,
  encodeIdentityRiskCursor,
  isIdentityRiskOpaqueReferenceKind,
  isPlainRecord,
  parsePageLimit,
  parseTimestamp,
  tenantScopedOpaqueId,
} from './identity-risk.validation.js'

const HAWKVIEW_SOURCE_LABEL = 'HawkView Identity Signals'
const MICROSOFT_SOURCE_LABEL = 'Microsoft Entra Risky Users'
const CURRENT_RUN_MAX_AGE_MS = 36 * 60 * 60 * 1_000
const MAX_SUMMARY_COUNT = 10_000

const findingStates = new Set(['OPEN', 'UPDATED', 'RESOLVED', 'EXPIRED'])
const severities = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
const confidences = new Set(['LOW', 'MEDIUM', 'HIGH'])
const coverages = new Set(['FULL', 'PARTIAL', 'UNAVAILABLE'])
const subjectTypes = new Set(['USER', 'MAILBOX', 'APPLICATION', 'UNKNOWN'])

type ScopedTenant = Readonly<{
  /** The database id of the operator this tenant was scoped FOR. Carried here
   * rather than looked up again because scope() already reads the user row, and
   * because an audit row that cannot name the operator answers nothing. */
  actorUserId: string
  id: string
  organizationId: string
  evidenceDetailAllowed: boolean
}>

type CompletedRun = Readonly<{
  id: string
  engineVersion: string
  catalogVersion: string
  capability: string
  completedAt: Date | null
  sourceObservedAt?: Date | null
}>

type HawkViewControlState = Readonly<{
  evaluationHardDisabled: boolean
  alertDeliveryDisabled: boolean
}>

function pilotReadAllowed(tenant: Pick<ScopedTenant, 'id' | 'organizationId'>) {
  const config = riskRuntimeConfig()
  return Boolean(config && riskScopeAllowed({
    organizationId: tenant.organizationId,
    customerTenantId: tenant.id,
    environment: config.environment,
  }, config))
}

function microsoftRiskDisplayEnabled() {
  return (
    process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED
      ?.trim()
      .toLowerCase() === 'true'
  )
}

function zeroCount(exact = false): IdentityRiskBoundedCount {
  return { value: 0, exact, capped: false }
}

function boundedCount(value: number): IdentityRiskBoundedCount {
  return value > MAX_SUMMARY_COUNT
    ? { value: MAX_SUMMARY_COUNT, exact: false, capped: true }
    : { value, exact: true, capped: false }
}

function projectEvidenceReferences(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some((reference) =>
      !isIdentityRiskOpaqueReferenceKind(reference, 'evidence')) ||
    new Set(value).size !== value.length
  ) return null
  return Object.freeze([...(value as string[])].sort())
}

function isProjectedSubjectReference(subjectType: unknown, subjectId: unknown) {
  if (subjectType === 'USER') {
    return isIdentityRiskOpaqueReferenceKind(subjectId, 'subject')
  }
  if (subjectType === 'APPLICATION') {
    return isIdentityRiskOpaqueReferenceKind(subjectId, 'application')
  }
  if (subjectType === 'MAILBOX') {
    return isIdentityRiskOpaqueReferenceKind(subjectId, 'mailbox')
  }
  if (subjectType === 'UNKNOWN') {
    return isIdentityRiskOpaqueReferenceKind(subjectId, ['source', 'tenant'])
  }
  return false
}

function emptyPage(): IdentityRiskPageInfo {
  return { hasMore: false, nextCursor: null }
}

function unavailableEnvelope(
  channel: IdentityRiskEnvelope['channel'],
  status: 'NOT_EVALUATED' | 'UNAVAILABLE' | 'ERROR',
  limitation: string,
): IdentityRiskEnvelope {
  return {
    version: IDENTITY_RISK_API_VERSION,
    channel,
    engineVersion:
      channel === 'HAWKVIEW_IDENTITY_SIGNALS'
        ? IDENTITY_RISK_ENGINE_VERSION
        : null,
    catalogVersion:
      channel === 'HAWKVIEW_IDENTITY_SIGNALS'
        ? IDENTITY_RISK_CATALOG_VERSION
        : MICROSOFT_RISK_CATALOG_VERSION,
    evaluatedAt: null,
    capability: 'UNAVAILABLE',
    status,
    sourceLabel:
      channel === 'HAWKVIEW_IDENTITY_SIGNALS'
        ? HAWKVIEW_SOURCE_LABEL
        : MICROSOFT_SOURCE_LABEL,
    observedAt: null,
    freshness: 'UNKNOWN',
    limitation,
  }
}

function runEnvelope(
  run: CompletedRun,
  now: Date,
  alertDeliveryDisabled: boolean,
): IdentityRiskEnvelope | null {
  if (
    run.engineVersion !== IDENTITY_RISK_ENGINE_VERSION ||
    run.catalogVersion !== IDENTITY_RISK_CATALOG_VERSION ||
    !coverages.has(run.capability)
  ) return null
  const evaluatedAt = parseTimestamp(run.completedAt, now)
  if (!evaluatedAt) return null
  if (run.capability === 'UNAVAILABLE') {
    return {
      version: IDENTITY_RISK_API_VERSION,
      channel: 'HAWKVIEW_IDENTITY_SIGNALS',
      engineVersion: run.engineVersion,
      catalogVersion: run.catalogVersion,
      evaluatedAt: evaluatedAt.toISOString(),
      capability: 'UNAVAILABLE',
      status: 'NOT_EVALUATED',
      sourceLabel: HAWKVIEW_SOURCE_LABEL,
      observedAt: null,
      freshness: 'UNKNOWN',
      limitation:
        'Approved HawkView identity-signal source evidence is not available for this evaluation.',
    }
  }
  const observedAt = run.sourceObservedAt ? parseTimestamp(run.sourceObservedAt, now) : evaluatedAt
  if (!observedAt) return null
  const stale = now.getTime() - observedAt.getTime() > CURRENT_RUN_MAX_AGE_MS
  return {
    version: IDENTITY_RISK_API_VERSION,
    channel: 'HAWKVIEW_IDENTITY_SIGNALS',
    engineVersion: run.engineVersion,
    catalogVersion: run.catalogVersion,
    evaluatedAt: evaluatedAt.toISOString(),
    capability: run.capability as IdentityRiskEnvelope['capability'],
    status: stale ? 'STALE' : 'AVAILABLE',
    sourceLabel: HAWKVIEW_SOURCE_LABEL,
    observedAt: observedAt.toISOString(),
    freshness: stale ? 'STALE' : 'CURRENT',
    limitation: alertDeliveryDisabled
      ? 'Shadow-mode findings are investigation leads; customer alert delivery is disabled.'
      : 'Shadow-mode findings are investigation leads, not compromise verdicts.',
  }
}

function microsoftEnvelope(
  observedAt: Date,
  evaluatedAt: Date,
  now: Date,
): IdentityRiskEnvelope | null {
  const parsedEvaluation = parseTimestamp(evaluatedAt, now)
  const parsedObservation = parseTimestamp(observedAt, now)
  if (!parsedEvaluation || !parsedObservation) return null
  const stale = now.getTime() - parsedObservation.getTime() > CURRENT_RUN_MAX_AGE_MS
  return {
    version: IDENTITY_RISK_API_VERSION,
    channel: 'MICROSOFT_ENTRA_RISKY_USERS',
    engineVersion: null,
    catalogVersion: MICROSOFT_RISK_CATALOG_VERSION,
    evaluatedAt: parsedEvaluation.toISOString(),
    capability: 'FULL',
    status: stale ? 'STALE' : 'AVAILABLE',
    sourceLabel: MICROSOFT_SOURCE_LABEL,
    observedAt: parsedObservation.toISOString(),
    freshness: stale ? 'STALE' : 'CURRENT',
    limitation: stale
      ? 'Microsoft Entra risky-user evidence is stale and must not be treated as current.'
      : null,
  }
}

function projectionError(channel: IdentityRiskEnvelope['channel']) {
  return unavailableEnvelope(
    channel,
    'ERROR',
    channel === 'HAWKVIEW_IDENTITY_SIGNALS'
      ? 'HawkView identity signal evidence could not be safely projected.'
      : 'Microsoft Entra risky-user evidence could not be safely projected.',
  )
}

@Injectable()
export class IdentityRiskService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(MailboxInvestigationResolver)
    private readonly mailboxResolver?: MailboxInvestigationResolver,
    @Optional() @Inject(RiskAssessmentReader) private readonly assessmentReader?: RiskAssessmentReader,
  ) {}

  private async utcRead<T>(read: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (transaction) => {
      await enforceRiskUtcTransaction(transaction)
      return read(transaction)
    }, { timeout: 10_000 })
  }

  private async currentControls(
    tenant: ScopedTenant,
  ): Promise<HawkViewControlState> {
    const controls = await this.prisma.identityRiskOperationalControl.findMany({
      where: {
        state: 'ACTIVE',
        OR: [
          { scopeType: 'GLOBAL', scopeKey: 'GLOBAL' },
          {
            scopeType: 'TENANT',
            scopeKey: `${tenant.organizationId}:${tenant.id}`,
            organizationId: tenant.organizationId,
            customerTenantId: tenant.id,
          },
        ],
      },
      select: { controlType: true },
    })
    return {
      evaluationHardDisabled: controls.some(
        (control) => control.controlType === 'EVALUATION_HARD_DISABLED',
      ),
      alertDeliveryDisabled: controls.some(
        (control) => control.controlType === 'ALERT_DELIVERY_DISABLED',
      ),
    }
  }

  /** The SAME authorization as every other identity-risk read, exposed so a
   * second reader does not grow a second copy of it.
   *
   * `scope` resolves the caller from their auth subject, requires an ACTIVE
   * membership in an ACTIVE organization, and finds the tenant only within
   * those organizations — so a caller cannot name a tenant belonging to
   * somebody else. `pilotReadAllowed` is the separate gate on who may read
   * identity-risk data at all.
   *
   * Additive: nothing existing changes. A reimplementation in the new reader
   * would be two copies of a rule whose failure mode is cross-tenant data
   * exposure, and a new endpoint quietly skipping the pilot gate would widen
   * who can read this while looking like a feature.
   *
   * Returns null rather than throwing when the pilot gate declines, because
   * "you may not read this yet" is a different answer from "this is not yours"
   * and the caller renders them differently. `scope` still throws Forbidden
   * for the second.
   */
  async authorizeRiskyUsersRead(identity: AuthenticatedIdentity, tenantId: string) {
    const tenant = await this.scope(identity, tenantId)
    // THREE gates, not two. I originally named the pilot gate and the tenant
    // scope and missed this one — the operator kill switch, which every other
    // identity-risk read checks (assessment, findings, findingDetail,
    // mailboxInvestigation). Missing it means pulling the emergency stop no
    // longer stops the display, on the code path most likely to need stopping
    // because it is the rebuilt engine's first exposure to customers.
    //
    // Each gate keeps its own answer. "Not enabled for this tenant" and
    // "an operator has halted evaluation" send a reader to different places,
    // and collapsing them into one unavailable is the undifferentiated answer
    // this whole vocabulary exists to remove.
    if (!pilotReadAllowed(tenant)) return { gate: 'NOT_ENABLED_FOR_TENANT' as const }
    if ((await this.currentControls(tenant)).evaluationHardDisabled) {
      return { gate: 'EVALUATION_DISABLED' as const }
    }
    // The role tier decides whether the SUBJECT CAN BE NAMED, not whether the
    // page can be seen. Counts and coverage travel to every role; the display
    // name and UPN travel only to MSP_OWNER and MSP_ADMIN, which is what
    // evidenceDetailAllowed already means on the existing detail endpoints.
    return { gate: null, tenant } as const
  }

  private async activeRiskReader(identity: AuthenticatedIdentity, client: Pick<Prisma.TransactionClient, 'user'> = this.prisma) {
    const user = await client.user.findUnique({
      where: { authProviderUserId: identity.subject },
      select: {
        id: true,
        disabledAt: true,
        memberships: {
          where: {
            status: 'ACTIVE',
            organization: { status: 'ACTIVE' },
          },
          select: { organizationId: true, role: true },
        },
      },
    })
    if (!user || user.disabledAt) throw new ForbiddenException('Tenant access denied')
    return user
  }

  /** One authorization snapshot and bounded batch reads, never N tenant reads. */
  async authorizeRiskyUsersFleetRead(identity: AuthenticatedIdentity, client: Prisma.TransactionClient): Promise<NativeSummaryScope> {
    const user = await this.activeRiskReader(identity, client)
    const organizationIds = [...new Set(user.memberships.map((membership) => membership.organizationId))]
    if (organizationIds.length === 0) return { totalTenants: 0, tenants: [] }
    const where = { organizationId: { in: organizationIds } }
    const totalTenants = await client.customerTenant.count({ where })
    const candidates = await client.customerTenant.findMany({
      where, select: { id: true, organizationId: true },
      orderBy: [{ organizationId: 'asc' }, { id: 'asc' }], take: NATIVE_SUMMARY_TENANT_LIMIT + 1,
    })
    if (candidates.some((tenant) => !organizationIds.includes(tenant.organizationId)) ||
      candidates.length !== Math.min(totalTenants, NATIVE_SUMMARY_TENANT_LIMIT + 1)) throw new Error('Invalid summary scope')
    const tenants = candidates.slice(0, NATIVE_SUMMARY_TENANT_LIMIT)
    if (tenants.length === 0) return { totalTenants, tenants: [] }
    const controls = await client.identityRiskOperationalControl.findMany({
      where: { state: 'ACTIVE', controlType: 'EVALUATION_HARD_DISABLED', OR: [
        { scopeType: 'GLOBAL', scopeKey: 'GLOBAL' },
        ...tenants.map((tenant) => ({ scopeType: 'TENANT', scopeKey: `${tenant.organizationId}:${tenant.id}`, organizationId: tenant.organizationId, customerTenantId: tenant.id })),
      ] },
      select: { scopeType: true, scopeKey: true, organizationId: true, customerTenantId: true },
      take: NATIVE_SUMMARY_TENANT_LIMIT + 2,
    })
    if (controls.length > tenants.length + 1) throw new Error('Invalid summary controls')
    const halted = controls.some((control) => control.scopeType === 'GLOBAL' && control.scopeKey === 'GLOBAL')
    return { totalTenants, tenants: tenants.map((tenant) => ({ ...tenant,
      gate: !pilotReadAllowed(tenant) ? 'NOT_ENABLED_FOR_TENANT' : halted || controls.some((control) =>
        control.scopeType === 'TENANT' && control.scopeKey === `${tenant.organizationId}:${tenant.id}` &&
        control.organizationId === tenant.organizationId && control.customerTenantId === tenant.id) ? 'EVALUATION_DISABLED' : null,
    })) }
  }

  private async scope(
    identity: AuthenticatedIdentity,
    tenantId: string,
  ): Promise<ScopedTenant> {
    const user = await this.activeRiskReader(identity)
    const organizationIds = user.memberships.map(
      (membership) => membership.organizationId,
    )
    const tenant = await this.prisma.customerTenant.findFirst({
      where: {
        id: tenantId,
        organizationId: { in: organizationIds },
      },
      select: { id: true, organizationId: true },
    })
    if (!tenant) throw new ForbiddenException('Tenant access denied')
    const membership = user.memberships.find(
      (candidate) => candidate.organizationId === tenant.organizationId,
    )
    return {
      ...tenant,
      actorUserId: user.id,
      evidenceDetailAllowed:
        membership?.role === 'MSP_OWNER' || membership?.role === 'MSP_ADMIN',
    }
  }

  private async latestRun(tenant: ScopedTenant, now: Date) {
    return this.utcRead(async (transaction) => {
    const config = riskRuntimeConfig()
    let head: { completedRunId: string | null } | undefined
    if (isGlobalRiskConfig(config)) {
      const heads = await transaction.$queryRawUnsafe<Array<{ completedRunId: string | null }>>(`SELECT completed_run_id AS "completedRunId"
        FROM identity_risk_attempt_heads WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid
        AND environment=$3 FOR SHARE`, tenant.organizationId, tenant.id, config.environment)
      if (heads.length !== 1) return null
      head = heads[0]
    }
    const run = await transaction.identityRiskEvaluationRun.findFirst({
      where: {
        ...(head?.completedRunId ? { id: head.completedRunId } : {}),
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        status: 'COMPLETED',
        expiresAt: { gt: now },
      },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        engineVersion: true,
        catalogVersion: true,
        capability: true,
        completedAt: true,
        sourceObservedAt: true,
        pseudonymKeyVersionId: true,
      },
    })
    if (run && isGlobalRiskConfig(config)) {
      // Pending/failed attempt: prior metadata may explain ERROR, but it cannot
      // supply current clean counts. Successful attempts select their linked
      // run by ID, never by app/DB timestamp comparison or completion order.
      if (!head?.completedRunId) return { ...run, completedAt: null }
      if (run.pseudonymKeyVersionId) {
        const key = await transaction.identityRiskPseudonymKeyVersion.findFirst({ where: {
          id: run.pseudonymKeyVersionId, organizationId: tenant.organizationId, customerTenantId: tenant.id,
          environment: config.environment, status: 'ACTIVE', retiredAt: null, destroyedAt: null,
          provider: 'WRAPPED_AES_GCM_V1', wrappedKey: { isNot: null },
        }, select: { id: true } })
        if (!key) return { ...run, completedAt: null }
      }
    }
    return run
    })
  }

  async assessment(identity:AuthenticatedIdentity,tenantId:string) {
    const tenant=await this.scope(identity,tenantId)
    const now=new Date()
    if(!pilotReadAllowed(tenant)||(await this.currentControls(tenant)).evaluationHardDisabled)return unavailableAssessment('EVALUATION_DISABLED',now)
    const run=await this.latestRun(tenant,now)
    if(!run||!this.assessmentReader){
      recordRiskReader(!run ? 'NO_COMPLETED_RUN' : 'READ_FAILED')
      return unavailableAssessment('WAITING_FOR_COLLECTION',now)
    }
    let result
    try{result=await this.assessmentReader.read({organizationId:tenant.organizationId,customerTenantId:tenant.id},run,now,tenant.evidenceDetailAllowed)}
    catch{return unavailableAssessment('EVALUATION_FAILED',now)}
    const refreshed=await this.scope(identity,tenantId)
    if(refreshed.organizationId!==tenant.organizationId||refreshed.evidenceDetailAllowed!==tenant.evidenceDetailAllowed||!pilotReadAllowed(refreshed)||
      (await this.currentControls(refreshed)).evaluationHardDisabled)return unavailableAssessment('EVALUATION_DISABLED',now)
    const latest=await this.latestRun(refreshed,now)
    if(latest?.id!==run.id||latest?.completedAt?.getTime()!==run.completedAt?.getTime())return unavailableAssessment('EVALUATION_FAILED',now)
    return result
  }

  async summary(identity: AuthenticatedIdentity, tenantId: string) {
    const tenant = await this.scope(identity, tenantId)
    const unavailableCounts = {
      identitiesNeedingReview: zeroCount(),
      openFindings: zeroCount(),
      evaluatedRules: zeroCount(),
      matchedResults: zeroCount(),
      suppressedResults: zeroCount(),
      notMatchedResults: zeroCount(),
      notEvaluatedResults: zeroCount(),
    }
    if (!pilotReadAllowed(tenant)) {
      return {
        ...unavailableEnvelope(
          'HAWKVIEW_IDENTITY_SIGNALS',
          'UNAVAILABLE',
          'HawkView identity signal evaluation is not enabled.',
        ),
        counts: unavailableCounts,
      }
    }
    const initialControls = await this.currentControls(tenant)
    if (initialControls.evaluationHardDisabled) {
      return {
        ...unavailableEnvelope(
          'HAWKVIEW_IDENTITY_SIGNALS',
          'UNAVAILABLE',
          'HawkView identity signal evaluation is temporarily disabled by an operational safety control.',
        ),
        counts: unavailableCounts,
      }
    }
    const now = new Date()
    const run = await this.latestRun(tenant, now)
    if (!run) {
      return {
        ...unavailableEnvelope(
          'HAWKVIEW_IDENTITY_SIGNALS',
          'NOT_EVALUATED',
          'No completed shadow evaluation is available.',
        ),
        counts: unavailableCounts,
      }
    }
    const [coverage, openFindingCount, subjects] = await Promise.all([
      this.prisma.identityRiskRuleCoverage.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          evaluationRunId: run.id,
          expiresAt: { gt: now },
        },
        select: {
          ruleId: true,
          matchedCount: true,
          suppressedCount: true,
          notMatchedCount: true,
          notEvaluatedCount: true,
          matchedCountCapped: true,
          suppressedCountCapped: true,
          notMatchedCountCapped: true,
          notEvaluatedCountCapped: true,
        },
        take: 23,
      }),
      this.prisma.identityRiskFinding.count({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          state: { in: ['OPEN', 'UPDATED'] },
          expiresAt: { gt: now },
          matchedResult: { evaluationRunId: run.id },
        },
      }),
      this.prisma.identityRiskFinding.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          state: { in: ['OPEN', 'UPDATED'] },
          expiresAt: { gt: now },
          matchedResult: { evaluationRunId: run.id },
        },
        distinct: ['subjectId'],
        select: { subjectId: true, subjectType: true },
        take: MAX_SUMMARY_COUNT + 1,
      }),
    ])
    if (
      coverage.length > 22 ||
      coverage.some((row) =>
        !isIdentityRiskRuleId(row.ruleId) ||
        (row.matchedCountCapped && row.matchedCount !== 1_000_000) ||
        (row.suppressedCountCapped && row.suppressedCount !== 1_000_000) ||
        (row.notMatchedCountCapped && row.notMatchedCount !== 1_000_000) ||
        (row.notEvaluatedCountCapped && row.notEvaluatedCount !== 1_000_000),
      ) ||
      subjects.some((row) =>
        !isProjectedSubjectReference(row.subjectType, row.subjectId))
    ) return { ...projectionError('HAWKVIEW_IDENTITY_SIGNALS'), counts: unavailableCounts }
    const currentControls = await this.currentControls(tenant)
    if (!pilotReadAllowed(tenant) || currentControls.evaluationHardDisabled) {
      return {
        ...unavailableEnvelope(
          'HAWKVIEW_IDENTITY_SIGNALS',
          'UNAVAILABLE',
          'HawkView identity signal evaluation is temporarily disabled by an operational safety control.',
        ),
        counts: unavailableCounts,
      }
    }
    const envelope = runEnvelope(
      run,
      now,
      currentControls.alertDeliveryDisabled,
    )
    if (!envelope) return { ...projectionError('HAWKVIEW_IDENTITY_SIGNALS'), counts: unavailableCounts }
    const sum = (key: 'matchedCount' | 'suppressedCount' | 'notMatchedCount' | 'notEvaluatedCount') =>
      coverage.reduce((total, row) => total + row[key], 0)
    const countFromCoverage = (
      key: 'matchedCount' | 'suppressedCount' | 'notMatchedCount' | 'notEvaluatedCount',
    ): IdentityRiskBoundedCount => {
      const count = boundedCount(sum(key))
      const cappedKey = `${key}Capped` as
        | 'matchedCountCapped'
        | 'suppressedCountCapped'
        | 'notMatchedCountCapped'
        | 'notEvaluatedCountCapped'
      return coverage.some((row) => row[cappedKey])
        ? { value: count.value, exact: false, capped: true }
        : count
    }
    return {
      ...envelope,
      counts: {
        identitiesNeedingReview: boundedCount(subjects.length),
        openFindings: boundedCount(openFindingCount),
        evaluatedRules: boundedCount(coverage.length),
        matchedResults: countFromCoverage('matchedCount'),
        suppressedResults: countFromCoverage('suppressedCount'),
        notMatchedResults: countFromCoverage('notMatchedCount'),
        notEvaluatedResults: countFromCoverage('notEvaluatedCount'),
      },
    }
  }

  async findings(
    identity: AuthenticatedIdentity,
    tenantId: string,
    query: { limit?: unknown; cursor?: unknown } = {},
  ) {
    const tenant = await this.scope(identity, tenantId)
    const limit = parsePageLimit(query.limit)
    if (!pilotReadAllowed(tenant)) {
      return {
        ...unavailableEnvelope(
          'HAWKVIEW_IDENTITY_SIGNALS',
          'UNAVAILABLE',
          'HawkView identity signal evaluation is not enabled.',
        ),
        findings: [] as IdentityRiskFindingDto[],
        pageInfo: emptyPage(),
      }
    }
    const initialControls = await this.currentControls(tenant)
    if (initialControls.evaluationHardDisabled) {
      return {
        ...unavailableEnvelope(
          'HAWKVIEW_IDENTITY_SIGNALS',
          'UNAVAILABLE',
          'HawkView identity signal evaluation is temporarily disabled by an operational safety control.',
        ),
        findings: [] as IdentityRiskFindingDto[],
        pageInfo: emptyPage(),
      }
    }
    const now = new Date()
    const run = await this.latestRun(tenant, now)
    if (!run) {
      return {
        ...unavailableEnvelope(
          'HAWKVIEW_IDENTITY_SIGNALS',
          'NOT_EVALUATED',
          'No completed shadow evaluation is available.',
        ),
        findings: [] as IdentityRiskFindingDto[],
        pageInfo: emptyPage(),
      }
    }
    if (!runEnvelope(run, now, initialControls.alertDeliveryDisabled)) {
      return {
        ...projectionError('HAWKVIEW_IDENTITY_SIGNALS'),
        findings: [] as IdentityRiskFindingDto[],
        pageInfo: emptyPage(),
      }
    }
    const cursor = decodeIdentityRiskCursor({
      cursor: query.cursor,
      channel: 'h',
      organizationId: tenant.organizationId,
      customerTenantId: tenant.id,
      datasetIdentity: run.id,
      now,
    })
    const rows = await this.utcRead((transaction) => transaction.identityRiskFinding.findMany({
      where: {
        state: { not: 'UNKNOWN' },
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        expiresAt: { gt: now },
        matchedResult: { evaluationRunId: run.id },
        ...(cursor
          ? {
              OR: [
                { observedAt: { lt: cursor.observedAt } },
                { observedAt: cursor.observedAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    }))
    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit)
    const currentControls = await this.currentControls(tenant)
    if (!pilotReadAllowed(tenant) || currentControls.evaluationHardDisabled) {
      return {
        ...unavailableEnvelope(
          'HAWKVIEW_IDENTITY_SIGNALS',
          'UNAVAILABLE',
          'HawkView identity signal evaluation is temporarily disabled by an operational safety control.',
        ),
        findings: [] as IdentityRiskFindingDto[],
        pageInfo: emptyPage(),
      }
    }
    const envelope = runEnvelope(
      run,
      now,
      currentControls.alertDeliveryDisabled,
    )
    if (!envelope) {
      return {
        ...projectionError('HAWKVIEW_IDENTITY_SIGNALS'),
        findings: [] as IdentityRiskFindingDto[],
        pageInfo: emptyPage(),
      }
    }
    const projected = pageRows.map((row) => this.projectFinding(row, now))
    if (projected.some((finding) => finding === null)) {
      return {
        ...projectionError('HAWKVIEW_IDENTITY_SIGNALS'),
        findings: [] as IdentityRiskFindingDto[],
        pageInfo: emptyPage(),
      }
    }
    const last = pageRows.at(-1)
    return {
      ...envelope,
      findings: projected as IdentityRiskFindingDto[],
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeIdentityRiskCursor({
                channel: 'h',
                organizationId: tenant.organizationId,
                customerTenantId: tenant.id,
                datasetIdentity: run.id,
                position: { observedAt: last.observedAt, id: last.id },
              })
            : null,
      },
    }
  }

  async findingDetail(
    identity: AuthenticatedIdentity,
    tenantId: string,
    findingId: string,
  ) {
    const tenant = await this.scope(identity, tenantId)
    if (!tenant.evidenceDetailAllowed) throw new ForbiddenException('Tenant access denied')
    const now = new Date()
    if (!pilotReadAllowed(tenant)) {
      return {
        ...unavailableEnvelope(
          'HAWKVIEW_IDENTITY_SIGNALS',
          'UNAVAILABLE',
          'HawkView identity signal evaluation is not enabled.',
        ),
        finding: null,
        evidenceReferences: [],
      }
    }
    const initialControls = await this.currentControls(tenant)
    if (initialControls.evaluationHardDisabled) {
      return {
        ...unavailableEnvelope(
          'HAWKVIEW_IDENTITY_SIGNALS',
          'UNAVAILABLE',
          'HawkView identity signal evaluation is temporarily disabled by an operational safety control.',
        ),
        finding: null,
        evidenceReferences: [],
      }
    }
    const run = await this.latestRun(tenant, now)
    const initialEnvelope = run
      ? runEnvelope(run, now, initialControls.alertDeliveryDisabled)
      : null
    if (!run || !initialEnvelope) {
      return {
        ...(run
          ? projectionError('HAWKVIEW_IDENTITY_SIGNALS')
          : unavailableEnvelope(
              'HAWKVIEW_IDENTITY_SIGNALS',
              'NOT_EVALUATED',
              'No completed shadow evaluation is available.',
            )),
        finding: null,
        evidenceReferences: [],
      }
    }
    const row = await this.utcRead((transaction) => transaction.identityRiskFinding.findFirst({
      where: {
        state: { not: 'UNKNOWN' },
        id: findingId,
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        expiresAt: { gt: now },
        matchedResult: { evaluationRunId: run.id },
      },
      include: {
        matchedResult: { select: { evidence: true } },
      },
    }))
    const currentControls = await this.currentControls(tenant)
    if (!pilotReadAllowed(tenant) || currentControls.evaluationHardDisabled) {
      return {
        ...unavailableEnvelope(
          'HAWKVIEW_IDENTITY_SIGNALS',
          'UNAVAILABLE',
          'HawkView identity signal evaluation is temporarily disabled by an operational safety control.',
        ),
        finding: null,
        evidenceReferences: [],
      }
    }
    const envelope = runEnvelope(
      run,
      now,
      currentControls.alertDeliveryDisabled,
    )
    if (!envelope) {
      return {
        ...projectionError('HAWKVIEW_IDENTITY_SIGNALS'),
        finding: null,
        evidenceReferences: [],
      }
    }
    const finding = row
      ? this.projectFinding(row, now)
      : null
    const evidenceReferences = row
      ? projectEvidenceReferences(row.matchedResult.evidence)
      : []
    if (row && (!finding || !evidenceReferences)) {
      return {
        ...projectionError('HAWKVIEW_IDENTITY_SIGNALS'),
        finding: null,
        evidenceReferences: [],
      }
    }
    return { ...envelope, finding, evidenceReferences }
  }

  async investigationAccess(identity: AuthenticatedIdentity, tenantId: string) {
    const tenant = await this.scope(identity, tenantId)
    const allowed = tenant.evidenceDetailAllowed && pilotReadAllowed(tenant) &&
      !(await this.currentControls(tenant)).evaluationHardDisabled && pilotReadAllowed(tenant)
    return { version: IDENTITY_RISK_API_VERSION, allowed }
  }

  /** Explicit privileged lookup only. Lists and ordinary finding detail stay opaque. */
  async mailboxInvestigation(
    identity: AuthenticatedIdentity,
    tenantId: string,
    findingId: string,
  ): Promise<MailboxInvestigationDto> {
    const tenant = await this.scope(identity, tenantId)
    if (!tenant.evidenceDetailAllowed) throw new ForbiddenException('Tenant access denied')
    const unavailable: MailboxInvestigationDto = { version: 1, status: 'UNAVAILABLE', mailbox: null }
    if (!pilotReadAllowed(tenant) || !this.mailboxResolver || !boundedOpaqueId(findingId, 200)) return unavailable
    if ((await this.currentControls(tenant)).evaluationHardDisabled) return unavailable
    const now = new Date()
    const run = await this.latestRun(tenant, now)
    if (!run || !run.pseudonymKeyVersionId ||
      !boundedOpaqueId(run.pseudonymKeyVersionId, 128) || !run.sourceObservedAt ||
      runEnvelope(run, now, true)?.freshness !== 'CURRENT' || run.capability !== 'FULL') return unavailable
    const observedAt = parseTimestamp(run.sourceObservedAt, now)
    if (!observedAt || now.getTime() - observedAt.getTime() > CURRENT_RUN_MAX_AGE_MS) return unavailable
    const row = await this.utcRead((transaction) => transaction.identityRiskFinding.findFirst({
      where: {
        id: findingId, organizationId: tenant.organizationId, customerTenantId: tenant.id,
        ruleId: 'HV-ID-MBX-001.v1', subjectType: 'MAILBOX',
        state: { in: ['OPEN', 'UPDATED'] }, coverage: 'FULL', expiresAt: { gt: now },
        matchedResult: {
          organizationId: tenant.organizationId, customerTenantId: tenant.id,
          evaluationRunId: run.id, ruleId: 'HV-ID-MBX-001.v1', subjectType: 'MAILBOX',
          coverage: 'FULL', expiresAt: { gt: now },
        },
      },
      select: {
        subjectId: true, observedAt: true,
        matchedResult: { select: { subjectId: true, evaluationRunId: true } },
      },
    }))
    if (!row || !isIdentityRiskOpaqueReferenceKind(row.subjectId, 'mailbox') ||
      row.subjectId !== row.matchedResult.subjectId || row.matchedResult.evaluationRunId !== run.id ||
      !parseTimestamp(row.observedAt, now) || now.getTime() - row.observedAt.getTime() > CURRENT_RUN_MAX_AGE_MS ||
      !pilotReadAllowed(tenant) || (await this.currentControls(tenant)).evaluationHardDisabled || !pilotReadAllowed(tenant)) return unavailable
    try {
      const resolved = await this.mailboxResolver.resolve(
        { organizationId: tenant.organizationId, customerTenantId: tenant.id },
        { subjectId: row.subjectId, pseudonymKeyVersionId: run.pseudonymKeyVersionId, sourceObservedAt: observedAt },
        now,
      )
      // Recheck authority after async inventory lookup. Never echo provider errors/payloads.
      const currentScope = await this.scope(identity, tenantId)
      if (!currentScope.evidenceDetailAllowed || currentScope.organizationId !== tenant.organizationId ||
        !pilotReadAllowed(tenant) || (await this.currentControls(tenant)).evaluationHardDisabled || !pilotReadAllowed(tenant)) return unavailable
      const id = boundedOpaqueId(resolved.mailboxId, 128)
      const label = boundedSafeString(resolved.label, 160)
      const resolvedAt = parseTimestamp(resolved.observedAt, new Date())
      if (resolved.status !== 'AVAILABLE' || !id || !label || /[<>\[\]{}\\]/u.test(label) ||
        !resolvedAt || new Date().getTime() - resolvedAt.getTime() > CURRENT_RUN_MAX_AGE_MS) return unavailable
      return {
        version: 1, status: 'AVAILABLE',
        mailbox: { id, label, observedAt: resolvedAt.toISOString(), inventoryPath: `/tenants/${encodeURIComponent(tenant.id)}/exchange` },
      }
    } catch {
      return unavailable
    }
  }

  async microsoftRiskyUsers(
    identity: AuthenticatedIdentity,
    tenantId: string,
    query: { limit?: unknown; cursor?: unknown } = {},
  ) {
    const tenant = await this.scope(identity, tenantId)
    const limit = parsePageLimit(query.limit)
    if (!microsoftRiskDisplayEnabled()) {
      return {
        microsoftRiskSummary: summarizeMicrosoftRisk({ payload: null, snapshotObservedAt: null, collectionSucceededAt: null, collectionStatus: null, sourceAllowed: false, now: new Date() }),
        ...unavailableEnvelope(
          'MICROSOFT_ENTRA_RISKY_USERS',
          'UNAVAILABLE',
          'Microsoft Entra risky-user display is not enabled.',
        ),
        users: [] as MicrosoftRiskyUserDto[],
        pageInfo: emptyPage(),
      }
    }
    const now = new Date()
    const [snapshot, syncState, eligibility] = await Promise.all([
      this.prisma.tenantEntraSnapshot.findFirst({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          resourceType: 'RISKY_USERS',
        },
        select: { payload: true, observedAt: true },
        orderBy: { observedAt: 'desc' },
      }),
      this.prisma.syncState.findFirst({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          resourceType: 'RISKY_USERS',
        },
        select: { status: true, lastSuccessfulAt: true },
      }),
      this.prisma.customerTenant.findFirst({
        where: { id: tenant.id, organizationId: tenant.organizationId },
        select: {
          connection: { select: { status: true, lastErrorCode: true, lastVerifiedAt: true, consentedPermissions: true } },
          tenantLicenses: { select: { servicePlans: true } },
          syncStates: { where: { resourceType: 'LICENSES' }, select: { resourceType: true, status: true, lastAttemptAt: true, lastSuccessfulAt: true } },
        },
      }),
    ])
    const sourceAllowed = Boolean(eligibility && microsoftRiskSourceAllowed({
      connectionStatus: eligibility.connection?.status,
      connectionLastErrorCode: eligibility.connection?.lastErrorCode,
      connectionVerifiedAt: eligibility.connection?.lastVerifiedAt,
      consentedPermissions: eligibility.connection?.consentedPermissions ?? [],
      licenseServicePlans: collectedLicenseServicePlans(eligibility.tenantLicenses),
      // Eligibility needs success/freshness, not diagnostic provider text.
      syncStates: eligibility.syncStates.map((state) => ({ ...state, lastErrorCode: null, lastErrorMessage: null })),
      now,
    }))
    const microsoftRiskSummary = summarizeMicrosoftRisk({ payload: snapshot?.payload, snapshotObservedAt: snapshot?.observedAt, collectionSucceededAt: syncState?.lastSuccessfulAt, collectionStatus: syncState?.status, sourceAllowed, now })
    if (
      !snapshot ||
      !syncState?.lastSuccessfulAt ||
      !Array.isArray(snapshot.payload)
    ) {
      return {
        microsoftRiskSummary,
        ...unavailableEnvelope(
          'MICROSOFT_ENTRA_RISKY_USERS',
          'UNAVAILABLE',
          'Current Microsoft Identity Protection evidence is unavailable.',
        ),
        users: [] as MicrosoftRiskyUserDto[],
        pageInfo: emptyPage(),
      }
    }
    if (syncState.status !== 'SUCCEEDED') {
      return {
        microsoftRiskSummary,
        ...unavailableEnvelope(
          'MICROSOFT_ENTRA_RISKY_USERS',
          syncState.status === 'FAILED' ? 'ERROR' : 'UNAVAILABLE',
          'The current Microsoft risky-user collection did not complete successfully.',
        ),
        users: [] as MicrosoftRiskyUserDto[],
        pageInfo: emptyPage(),
      }
    }
    const envelope = microsoftEnvelope(
      snapshot.observedAt,
      syncState.lastSuccessfulAt,
      now,
    )
    if (!envelope || snapshot.payload.length > MICROSOFT_RISK_MAX_ROWS) {
      return {
        microsoftRiskSummary,
        ...projectionError('MICROSOFT_ENTRA_RISKY_USERS'),
        users: [] as MicrosoftRiskyUserDto[],
        pageInfo: emptyPage(),
      }
    }
    if (envelope.freshness !== 'CURRENT' || microsoftRiskSummary.availability === 'UNAVAILABLE') {
      return {
        microsoftRiskSummary,
        ...unavailableEnvelope(
          'MICROSOFT_ENTRA_RISKY_USERS',
          'UNAVAILABLE',
          microsoftRiskSummary.reasonCode === 'STALE_EVIDENCE' ? 'Current Microsoft Identity Protection evidence is stale.' : 'Current Microsoft Identity Protection evidence is unavailable.',
        ),
        users: [] as MicrosoftRiskyUserDto[],
        pageInfo: emptyPage(),
      }
    }
    if (snapshot.payload.length === 0) {
      return {
        microsoftRiskSummary,
        ...envelope,
        users: [] as MicrosoftRiskyUserDto[],
        pageInfo: emptyPage(),
      }
    }
    const users = snapshot.payload.map((row) =>
      this.projectMicrosoftRiskyUser(
        row,
        tenant,
        snapshot.observedAt,
        now,
      ),
    )
    if (users.every((user) => user === null)) {
      return {
        microsoftRiskSummary,
        ...projectionError('MICROSOFT_ENTRA_RISKY_USERS'),
        users: [] as MicrosoftRiskyUserDto[],
        pageInfo: emptyPage(),
      }
    }
    const ordered = users.filter((user): user is MicrosoftRiskyUserDto => user !== null).sort((left, right) =>
      right.observedAt.localeCompare(left.observedAt) || right.id.localeCompare(left.id),
    )
    const cursor = decodeIdentityRiskCursor({
      cursor: query.cursor,
      channel: 'm',
      organizationId: tenant.organizationId,
      customerTenantId: tenant.id,
      datasetIdentity: `${envelope.observedAt}:${envelope.evaluatedAt}`,
      now,
    })
    const afterCursor = cursor
      ? ordered.filter((user) =>
          user.observedAt < cursor.observedAt.toISOString() ||
          (user.observedAt === cursor.observedAt.toISOString() && user.id < cursor.id),
        )
      : ordered
    const hasMore = afterCursor.length > limit
    const page = afterCursor.slice(0, limit)
    const last = page.at(-1)
    return {
      ...envelope,
      microsoftRiskSummary,
      capability: microsoftRiskSummary.availability === 'PARTIAL' ? 'PARTIAL' as const : envelope.capability,
      limitation: microsoftRiskSummary.availability === 'PARTIAL' ? 'Microsoft risk evidence is incomplete or conflicting; observed active evidence requires review and the exact active total is unknown.' : envelope.limitation,
      users: page,
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeIdentityRiskCursor({
                channel: 'm',
                organizationId: tenant.organizationId,
                customerTenantId: tenant.id,
                datasetIdentity: `${envelope.observedAt}:${envelope.evaluatedAt}`,
                position: { observedAt: new Date(last.observedAt), id: last.id },
              })
            : null,
      },
    }
  }

  private projectFinding(
    row: {
      id: string
      state: string
      severity: string
      confidence: string
      coverage: string
      ruleId: string
      subjectType: string
      subjectId: string
      observedAt: Date
    },
    platformNow: Date,
  ): IdentityRiskFindingDto | null {
    const presentation = identityRiskRulePresentation(row.ruleId)
    const id = boundedOpaqueId(row.id, 200)
    const subjectId = isProjectedSubjectReference(row.subjectType, row.subjectId)
      ? row.subjectId
      : null
    const observedAt = parseTimestamp(row.observedAt, platformNow)
    if (
      !presentation ||
      !isIdentityRiskRuleId(row.ruleId) ||
      !id ||
      !subjectId ||
      !findingStates.has(row.state) ||
      !severities.has(row.severity) ||
      !confidences.has(row.confidence) ||
      !coverages.has(row.coverage) ||
      !subjectTypes.has(row.subjectType) ||
      !observedAt
    ) return null
    return {
      id,
      state: row.state as IdentityRiskFindingDto['state'],
      severity: row.severity as IdentityRiskFindingDto['severity'],
      confidence: row.confidence as IdentityRiskFindingDto['confidence'],
      coverage: row.coverage as IdentityRiskFindingDto['coverage'],
      title: presentation.title,
      explanation: presentation.explanation,
      affectedIdentity: {
        id: subjectId,
        label: row.subjectType === 'MAILBOX' ? 'Affected mailbox (restricted details)' : 'Tenant identity',
        type: row.subjectType as IdentityRiskFindingDto['affectedIdentity']['type'],
      },
      investigationGuidanceCode: presentation.investigationGuidanceCode,
      investigationGuidance: presentation.investigationGuidance,
      benignAlternativeCodes: presentation.benignAlternativeCodes.slice(0, 10),
      sourceLabels: presentation.sourceLabels.slice(0, 10),
      missingEvidenceLabels: [],
      observedAt: observedAt.toISOString(),
      ruleIds: [row.ruleId],
    }
  }

  private projectMicrosoftRiskyUser(
    value: unknown,
    tenant: ScopedTenant,
    snapshotObservedAt: Date,
    platformNow: Date,
  ): MicrosoftRiskyUserDto | null {
    if (!isPlainRecord(value)) return null
    const record = parseMicrosoftRiskRecord(value, snapshotObservedAt, platformNow)
    if (!record) return null
    const labelCandidate =
      boundedSafeString(value.userDisplayName, 160) ??
      boundedSafeString(value.userPrincipalName, 160) ??
      'Microsoft identity'
    const identityLabel = /[<>\[\]{}\\]/.test(labelCandidate)
      ? 'Microsoft identity'
      : labelCandidate
    return {
      id: tenantScopedOpaqueId(
        'msru',
        tenant.organizationId,
        tenant.id,
        record.sourceId,
      ),
      identityLabel,
      riskLevel: record.riskLevel,
      riskState: record.riskState,
      riskDetail: record.riskDetail,
      observedAt: record.observedAt.toISOString(),
    }
  }
}
