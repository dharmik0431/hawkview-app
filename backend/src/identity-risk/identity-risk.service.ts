import { ForbiddenException, Inject, Injectable } from '@nestjs/common'
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
  type MicrosoftRiskDetail,
  type MicrosoftRiskLevel,
  type MicrosoftRiskState,
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
  isPlainRecord,
  parsePageLimit,
  parseTimestamp,
  tenantScopedOpaqueId,
} from './identity-risk.validation.js'

const HAWKVIEW_SOURCE_LABEL = 'HawkView Identity Signals'
const MICROSOFT_SOURCE_LABEL = 'Microsoft Entra Risky Users'
const CURRENT_RUN_MAX_AGE_MS = 36 * 60 * 60 * 1_000
const MAX_SUMMARY_COUNT = 10_000
const MAX_MICROSOFT_SNAPSHOT_ROWS = 50_000

const findingStates = new Set(['OPEN', 'UPDATED', 'RESOLVED', 'EXPIRED'])
const severities = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
const confidences = new Set(['LOW', 'MEDIUM', 'HIGH'])
const coverages = new Set(['FULL', 'PARTIAL', 'UNAVAILABLE'])
const subjectTypes = new Set(['USER', 'MAILBOX', 'APPLICATION', 'UNKNOWN'])
const microsoftRiskLevels = new Set<MicrosoftRiskLevel>([
  'none',
  'low',
  'medium',
  'high',
  'hidden',
  'unknownFutureValue',
])
const microsoftRiskStates = new Set<MicrosoftRiskState>([
  'none',
  'atRisk',
  'remediated',
  'dismissed',
  'confirmedSafe',
  'confirmedCompromised',
  'unknownFutureValue',
])
const microsoftRiskDetails = new Set([
  'none',
  'adminGeneratedTemporaryPassword',
  'userPerformedSecuredPasswordChange',
  'userPerformedSecuredPasswordReset',
  'adminConfirmedSigninSafe',
  'aiConfirmedSigninSafe',
  'userPassedMFADrivenByRiskBasedPolicy',
  'adminDismissedAllRiskForUser',
  'adminConfirmedSigninCompromised',
  'hidden',
  'adminConfirmedUserCompromised',
  'm365DAdminDismissedDetection',
  'userChangedPasswordOnPremises',
  'adminDismissedRiskForSignIn',
  'adminConfirmedAccountSafe',
  'unknownFutureValue',
])

type ScopedTenant = Readonly<{
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
  alertDeliveryDisabled: boolean
}>

function mode() {
  return process.env.HAWKVIEW_IDENTITY_RISK_MODE === 'shadow' ? 'SHADOW' : 'OFF'
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

function runEnvelope(run: CompletedRun, now: Date): IdentityRiskEnvelope | null {
  if (
    run.engineVersion !== IDENTITY_RISK_ENGINE_VERSION ||
    run.catalogVersion !== IDENTITY_RISK_CATALOG_VERSION ||
    !coverages.has(run.capability)
  ) return null
  const evaluatedAt = parseTimestamp(run.completedAt, now)
  if (!evaluatedAt) return null
  const stale = now.getTime() - evaluatedAt.getTime() > CURRENT_RUN_MAX_AGE_MS
  return {
    version: IDENTITY_RISK_API_VERSION,
    channel: 'HAWKVIEW_IDENTITY_SIGNALS',
    engineVersion: run.engineVersion,
    catalogVersion: run.catalogVersion,
    evaluatedAt: evaluatedAt.toISOString(),
    capability: run.capability as IdentityRiskEnvelope['capability'],
    status: stale ? 'STALE' : 'AVAILABLE',
    sourceLabel: HAWKVIEW_SOURCE_LABEL,
    observedAt: evaluatedAt.toISOString(),
    freshness: stale ? 'STALE' : 'CURRENT',
    limitation: run.alertDeliveryDisabled
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
  const parsedObservation = parsedEvaluation
    ? parseTimestamp(observedAt, parsedEvaluation)
    : null
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
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async scope(
    identity: AuthenticatedIdentity,
    tenantId: string,
  ): Promise<ScopedTenant> {
    const user = await this.prisma.user.findUnique({
      where: { authProviderUserId: identity.subject },
      select: {
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
      evidenceDetailAllowed:
        membership?.role === 'MSP_OWNER' || membership?.role === 'MSP_ADMIN',
    }
  }

  private async latestRun(tenant: ScopedTenant, now: Date) {
    return this.prisma.identityRiskEvaluationRun.findFirst({
      where: {
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
        alertDeliveryDisabled: true,
      },
    })
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
    if (mode() === 'OFF') {
      return {
        ...unavailableEnvelope(
          'HAWKVIEW_IDENTITY_SIGNALS',
          'UNAVAILABLE',
          'HawkView identity signal evaluation is not enabled.',
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
    const envelope = runEnvelope(run, now)
    if (!envelope) return { ...projectionError('HAWKVIEW_IDENTITY_SIGNALS'), counts: unavailableCounts }
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
          countsCapped: true,
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
        select: { subjectId: true },
        take: MAX_SUMMARY_COUNT + 1,
      }),
    ])
    if (
      coverage.length > 22 ||
      coverage.some((row) => !isIdentityRiskRuleId(row.ruleId))
    ) return { ...projectionError('HAWKVIEW_IDENTITY_SIGNALS'), counts: unavailableCounts }
    const sum = (key: 'matchedCount' | 'suppressedCount' | 'notMatchedCount' | 'notEvaluatedCount') =>
      coverage.reduce((total, row) => total + row[key], 0)
    const countFromCoverage = (
      key: 'matchedCount' | 'suppressedCount' | 'notMatchedCount' | 'notEvaluatedCount',
    ): IdentityRiskBoundedCount => {
      const count = boundedCount(sum(key))
      return coverage.some((row) => row.countsCapped)
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
    if (mode() === 'OFF') {
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
    const envelope = runEnvelope(run, now)
    if (!envelope) {
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
      now,
    })
    const rows = await this.prisma.identityRiskFinding.findMany({
      where: {
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
    })
    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit)
    const projected = pageRows.map((row) => this.projectFinding(row, new Date(envelope.evaluatedAt as string)))
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
    if (mode() === 'OFF') {
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
    const run = await this.latestRun(tenant, now)
    const envelope = run ? runEnvelope(run, now) : null
    if (!run || !envelope) {
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
    const row = await this.prisma.identityRiskFinding.findFirst({
      where: {
        id: findingId,
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        expiresAt: { gt: now },
        matchedResult: { evaluationRunId: run.id },
      },
    })
    const finding = row
      ? this.projectFinding(row, new Date(envelope.evaluatedAt as string))
      : null
    if (row && !finding) {
      return {
        ...projectionError('HAWKVIEW_IDENTITY_SIGNALS'),
        finding: null,
        evidenceReferences: [],
      }
    }
    return { ...envelope, finding, evidenceReferences: [] }
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
    const [snapshot, syncState] = await Promise.all([
      this.prisma.tenantEntraSnapshot.findFirst({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          resourceType: 'RISKY_USERS',
        },
        select: { payload: true, observedAt: true },
      }),
      this.prisma.syncState.findFirst({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          resourceType: 'RISKY_USERS',
        },
        select: { status: true, lastSuccessfulAt: true },
      }),
    ])
    if (
      !snapshot ||
      !syncState?.lastSuccessfulAt ||
      !Array.isArray(snapshot.payload)
    ) {
      return {
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
    if (!envelope || snapshot.payload.length > MAX_MICROSOFT_SNAPSHOT_ROWS) {
      return {
        ...projectionError('MICROSOFT_ENTRA_RISKY_USERS'),
        users: [] as MicrosoftRiskyUserDto[],
        pageInfo: emptyPage(),
      }
    }
    if (envelope.freshness !== 'CURRENT') {
      return {
        ...unavailableEnvelope(
          'MICROSOFT_ENTRA_RISKY_USERS',
          'UNAVAILABLE',
          'Current Microsoft Identity Protection evidence is stale.',
        ),
        users: [] as MicrosoftRiskyUserDto[],
        pageInfo: emptyPage(),
      }
    }
    if (snapshot.payload.length === 0) {
      return {
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
        new Date(envelope.evaluatedAt as string),
      ),
    )
    if (users.some((user) => user === null)) {
      return {
        ...projectionError('MICROSOFT_ENTRA_RISKY_USERS'),
        users: [] as MicrosoftRiskyUserDto[],
        pageInfo: emptyPage(),
      }
    }
    const ordered = (users as MicrosoftRiskyUserDto[]).sort((left, right) =>
      right.observedAt.localeCompare(left.observedAt) || right.id.localeCompare(left.id),
    )
    const cursor = decodeIdentityRiskCursor({
      cursor: query.cursor,
      channel: 'm',
      organizationId: tenant.organizationId,
      customerTenantId: tenant.id,
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
      users: page,
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeIdentityRiskCursor({
                channel: 'm',
                organizationId: tenant.organizationId,
                customerTenantId: tenant.id,
                position: { observedAt: new Date(last.observedAt), id: last.id },
              })
            : null,
      },
    }
  }

  async pruneExpired(organizationId: string, customerTenantId: string, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      const finding = await transaction.identityRiskFinding.deleteMany({
        where: { organizationId, customerTenantId, expiresAt: { lte: now } },
      })
      const matched = await transaction.identityRiskMatchedResult.deleteMany({
        where: { organizationId, customerTenantId, expiresAt: { lte: now } },
      })
      const coverage = await transaction.identityRiskRuleCoverage.deleteMany({
        where: { organizationId, customerTenantId, expiresAt: { lte: now } },
      })
      const runs = await transaction.identityRiskEvaluationRun.deleteMany({
        where: { organizationId, customerTenantId, expiresAt: { lte: now } },
      })
      return {
        findings: finding.count,
        matchedResults: matched.count,
        coverage: coverage.count,
        runs: runs.count,
      }
    })
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
    evaluatedAt: Date,
  ): IdentityRiskFindingDto | null {
    const presentation = identityRiskRulePresentation(row.ruleId)
    const id = boundedOpaqueId(row.id, 200)
    const subjectId = boundedOpaqueId(row.subjectId, 128)
    const observedAt = parseTimestamp(row.observedAt, evaluatedAt)
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
        label: 'Tenant identity',
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
    evaluatedAt: Date,
  ): MicrosoftRiskyUserDto | null {
    if (!isPlainRecord(value)) return null
    const sourceId = boundedOpaqueId(value.id, 128)
    if (!sourceId) return null
    const labelCandidate =
      boundedSafeString(value.userDisplayName, 160) ??
      boundedSafeString(value.userPrincipalName, 160) ??
      'Microsoft identity'
    const identityLabel = /[<>\[\]{}\\]/.test(labelCandidate)
      ? 'Microsoft identity'
      : labelCandidate
    const riskLevel = typeof value.riskLevel === 'string'
      ? microsoftRiskLevels.has(value.riskLevel as MicrosoftRiskLevel)
        ? (value.riskLevel as MicrosoftRiskLevel)
        : 'unknownFutureValue'
      : null
    const riskState = typeof value.riskState === 'string'
      ? microsoftRiskStates.has(value.riskState as MicrosoftRiskState)
        ? (value.riskState as MicrosoftRiskState)
        : 'unknownFutureValue'
      : null
    const detail: MicrosoftRiskDetail | null =
      value.riskDetail === null || value.riskDetail === undefined
      ? null
      : typeof value.riskDetail === 'string'
        ? microsoftRiskDetails.has(value.riskDetail)
          ? (value.riskDetail as MicrosoftRiskDetail)
          : 'unknownFutureValue'
        : null
    const observedAt = parseTimestamp(
      value.riskLastUpdatedDateTime ?? snapshotObservedAt,
      evaluatedAt,
    )
    if (
      !riskLevel ||
      !riskState ||
      !observedAt ||
      (value.riskDetail !== null &&
        value.riskDetail !== undefined &&
        typeof value.riskDetail !== 'string')
    ) return null
    return {
      id: tenantScopedOpaqueId(
        'msru',
        tenant.organizationId,
        tenant.id,
        sourceId,
      ),
      identityLabel,
      riskLevel,
      riskState,
      riskDetail: detail,
      observedAt: observedAt.toISOString(),
    }
  }
}
