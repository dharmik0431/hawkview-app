import { createHash, randomUUID } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import {
  IDENTITY_RISK_CATALOG_VERSION,
  IDENTITY_RISK_ENGINE_VERSION,
  IDENTITY_RISK_MAX_FUTURE_SKEW_MS,
  IDENTITY_RISK_RUN_RETENTION_MS,
  type IdentityRiskBoundedCount,
  type IdentityRiskEvaluationRequest,
  type IdentityRiskSourceBatch,
  type IdentitySignalDetector,
  type IdentitySignalResult,
} from './identity-risk.contract.js'
import {
  identityRiskRulePresentation,
  isIdentityRiskRuleId,
  type IdentityRiskRuleId,
} from './identity-risk.catalog.js'
import { IdentityRiskSafetyService } from './identity-risk-safety.service.js'
import {
  boundedOpaqueId,
  boundedSafeString,
  isPlainRecord,
  parseTimestamp,
} from './identity-risk.validation.js'

const MAX_DETECTORS = 22
const MAX_RESULTS_PER_DETECTOR = 50_000
const MAX_MATCHED_RESULTS_PER_RUN = 2_000
const MAX_REASON_CODES_PER_RULE = 20
const MAX_COUNT = 1_000_000
const MAX_SOURCE_TYPES = 32
const MAX_SOURCE_RECORDS_PER_TYPE = 50_000
const RUN_LEASE_MS = 5 * 60 * 1_000
const NO_SOURCE_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

const outcomes = new Set(['MATCHED', 'NOT_MATCHED', 'NOT_EVALUATED', 'SUPPRESSED'])
const coverages = new Set(['FULL', 'PARTIAL', 'UNAVAILABLE'])
const severities = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
const confidences = new Set(['LOW', 'MEDIUM', 'HIGH'])
const subjectTypes = new Set(['USER', 'MAILBOX', 'APPLICATION', 'UNKNOWN'])
const resultKeys = new Set([
  'ruleId',
  'outcome',
  'coverage',
  'reasonCode',
  'subjectType',
  'subjectId',
  'severity',
  'confidence',
  'observedAt',
])
const reasonCodes = new Set([
  'ACCOUNT_CLASS_COVERAGE_INCOMPLETE',
  'ACCOUNT_CLASS_UNSUPPORTED',
  'ACCOUNT_CLASS_UNVERIFIED',
  'BASELINE_LEARNING',
  'DETECTOR_FAILED',
  'DETECTOR_OUTPUT_INVALID',
  'EVIDENCE_CAPPED',
  'EVIDENCE_MALFORMED',
  'EVIDENCE_STALE',
  'EVIDENCE_UNAVAILABLE',
  'FUTURE_TIMESTAMP',
  'INSUFFICIENT_INDEPENDENT_CONTEXT',
  'MAILBOX_RULE_PROJECTION_INCOMPLETE',
  'RESULT_LIMIT_EXCEEDED',
  'RULE_CONFIG_UNAPPROVED',
])

type MutableCount = { value: number; exact: boolean; capped: boolean }
type RuleAggregate = {
  ruleId: IdentityRiskRuleId
  eligible: MutableCount
  matched: MutableCount
  suppressed: MutableCount
  notMatched: MutableCount
  notEvaluated: MutableCount
  reasons: Map<string, MutableCount>
}

export type IdentityRiskEvaluationResult = Readonly<{
  status: 'OFF' | 'HARD_DISABLED' | 'IN_PROGRESS' | 'COMPLETED' | 'REPLAYED'
  runKey: string | null
  alertDeliveryDisabled: boolean
}>

function mode() {
  return process.env.HAWKVIEW_IDENTITY_RISK_MODE === 'shadow' ? 'SHADOW' : 'OFF'
}

function sha256(...parts: readonly string[]) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

@Injectable()
export class IdentityRiskPlatformClock {
  now() {
    return new Date()
  }
}

function add(count: MutableCount, increment = 1) {
  if (increment < 0 || !Number.isSafeInteger(increment)) return
  if (count.value > MAX_COUNT - increment) {
    count.value = MAX_COUNT
    count.exact = false
    count.capped = true
  } else {
    count.value += increment
  }
}

function emptyCount(): MutableCount {
  return { value: 0, exact: true, capped: false }
}

function emptyAggregate(ruleId: IdentityRiskRuleId): RuleAggregate {
  return {
    ruleId,
    eligible: emptyCount(),
    matched: emptyCount(),
    suppressed: emptyCount(),
    notMatched: emptyCount(),
    notEvaluated: emptyCount(),
    reasons: new Map(),
  }
}

function publicCount(count: MutableCount): IdentityRiskBoundedCount {
  return { value: count.value, exact: count.exact, capped: count.capped }
}

function addReason(aggregate: RuleAggregate, reasonCode: string) {
  const existing = aggregate.reasons.get(reasonCode)
  if (existing) return add(existing)
  if (aggregate.reasons.size >= MAX_REASON_CODES_PER_RULE) return
  const count = emptyCount()
  add(count)
  aggregate.reasons.set(reasonCode, count)
}

function aggregateJson(aggregates: readonly RuleAggregate[]) {
  const totals = {
    eligible: emptyCount(),
    matched: emptyCount(),
    suppressed: emptyCount(),
    notMatched: emptyCount(),
    notEvaluated: emptyCount(),
  }
  for (const aggregate of aggregates) {
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      add(totals[key], aggregate[key].value)
      if (!aggregate[key].exact) {
        totals[key].exact = false
        totals[key].capped = true
      }
    }
  }
  return {
    version: 1,
    counts: {
      eligibleSubjects: publicCount(totals.eligible),
      matchedResults: publicCount(totals.matched),
      suppressedResults: publicCount(totals.suppressed),
      notMatchedResults: publicCount(totals.notMatched),
      notEvaluatedResults: publicCount(totals.notEvaluated),
    },
  }
}

function exactResultKeys(value: Record<string, unknown>) {
  return Object.keys(value).every((key) => resultKeys.has(key))
}

function validateResult(
  value: unknown,
  detectorRuleId: IdentityRiskRuleId,
  platformNow: Date,
): IdentitySignalResult | null {
  if (!isPlainRecord(value) || !exactResultKeys(value)) return null
  if (
    value.ruleId !== detectorRuleId ||
    !outcomes.has(value.outcome as string) ||
    !coverages.has(value.coverage as string)
  ) return null
  if (value.reasonCode !== undefined) {
    const reason = boundedSafeString(value.reasonCode, 80)
    if (!reason || !reasonCodes.has(reason)) return null
  }
  if (value.subjectId !== undefined && !boundedOpaqueId(value.subjectId, 128)) return null
  if (value.subjectType !== undefined && !subjectTypes.has(value.subjectType as string)) return null

  if (value.outcome === 'MATCHED') {
    const observedAt = parseTimestamp(value.observedAt, platformNow)
    if (
      value.coverage === 'UNAVAILABLE' ||
      !boundedOpaqueId(value.subjectId, 128) ||
      !subjectTypes.has(value.subjectType as string) ||
      !severities.has(value.severity as string) ||
      !confidences.has(value.confidence as string) ||
      !observedAt
    ) return null
    return { ...value, observedAt } as IdentitySignalResult
  }
  if (
    value.severity !== undefined ||
    value.confidence !== undefined ||
    value.observedAt !== undefined
  ) return null
  return value as IdentitySignalResult
}

function rejectedResultReason(
  value: unknown,
  detectorRuleId: IdentityRiskRuleId,
  platformNow: Date,
) {
  if (
    isPlainRecord(value) &&
    value.ruleId === detectorRuleId &&
    value.outcome === 'MATCHED' &&
    value.observedAt !== undefined
  ) {
    const candidate = value.observedAt instanceof Date
      ? value.observedAt
      : typeof value.observedAt === 'string'
        ? new Date(value.observedAt)
        : null
    if (
      candidate &&
      Number.isFinite(candidate.getTime()) &&
      candidate.getTime() > platformNow.getTime() + IDENTITY_RISK_MAX_FUTURE_SKEW_MS
    ) return 'FUTURE_TIMESTAMP'
  }
  return 'DETECTOR_OUTPUT_INVALID'
}

function runExpiry(batch: IdentityRiskSourceBatch, platformNow: Date) {
  const policy = new Date(
    platformNow.getTime() +
      (batch.earliestSourceExpiry
        ? IDENTITY_RISK_RUN_RETENTION_MS
        : NO_SOURCE_RUN_RETENTION_MS),
  )
  if (
    batch.earliestSourceExpiry &&
    batch.earliestSourceExpiry.getTime() < policy.getTime()
  ) return batch.earliestSourceExpiry
  return policy
}

function uniqueViolation(error: unknown) {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && error.code === 'P2002',
  )
}

@Injectable()
export class IdentityRiskEvaluatorService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IdentityRiskSafetyService)
    private readonly safety: IdentityRiskSafetyService,
    @Inject(IdentityRiskPlatformClock)
    private readonly clock: IdentityRiskPlatformClock = new IdentityRiskPlatformClock(),
  ) {}

  async evaluate(
    request: IdentityRiskEvaluationRequest,
  ): Promise<IdentityRiskEvaluationResult> {
    const platformNow = new Date(this.clock.now().getTime())
    this.validateRequest(request, platformNow)
    if (mode() === 'OFF') {
      return { status: 'OFF', runKey: null, alertDeliveryDisabled: true }
    }
    const safety = await this.safety.stateForTenant(
      request.organizationId,
      request.customerTenantId,
    )
    if (safety.evaluationHardDisabled) {
      if (safety.hardDisableEpisodeId) {
        await this.safety.recordHardStopBlocked({
          organizationId: request.organizationId,
          customerTenantId: request.customerTenantId,
          episodeId: safety.hardDisableEpisodeId,
          scopeType: safety.hardDisableScopeType ?? 'TENANT',
          now: platformNow,
        })
      }
      return {
        status: 'HARD_DISABLED',
        runKey: null,
        alertDeliveryDisabled: true,
      }
    }

    const batch = await request.loadSources()
    if (
      batch.context.organizationId !== request.organizationId ||
      batch.context.customerTenantId !== request.customerTenantId
    ) {
      const crossOrganization =
        batch.context.organizationId !== request.organizationId
      await this.safety.activate({
        controlType: 'EVALUATION_HARD_DISABLED',
        scope: crossOrganization
          ? { type: 'GLOBAL' }
          : {
              type: 'TENANT',
              organizationId: request.organizationId,
              customerTenantId: request.customerTenantId,
            },
        reasonCode: 'CROSS_TENANT_SCOPE_FAILURE',
        actorServiceId: 'identity-risk-evaluator',
        now: platformNow,
      })
      return {
        status: 'HARD_DISABLED',
        runKey: null,
        alertDeliveryDisabled: true,
      }
    }
    this.validateSourceBatch(request, batch)

    // Watermarks are restricted to bounded ASCII opaque IDs, so the default
    // code-unit sort is the canonical bytewise order used by the run key.
    const canonicalSourceWatermarks = [...batch.orderedSourceWatermarks].sort()
    const watermarkHash = sha256(...canonicalSourceWatermarks)
    const runKey = sha256(
      request.organizationId,
      request.customerTenantId,
      request.engineVersion,
      request.catalogVersion,
      request.windowStart.toISOString(),
      request.windowEnd.toISOString(),
      watermarkHash,
    )
    const expiresAt = runExpiry(batch, platformNow)
    const leaseToken = randomUUID()
    const claim = await this.claimRun({
      request,
      runKey,
      watermarkHash,
      expiresAt,
      leaseToken,
      alertDeliveryDisabled: safety.alertDeliveryDisabled,
      capability: batch.capability,
      platformNow,
    })
    if (claim === 'COMPLETED') {
      return {
        status: 'REPLAYED',
        runKey,
        alertDeliveryDisabled: safety.alertDeliveryDisabled,
      }
    }
    if (claim === 'BUSY') {
      return {
        status: 'IN_PROGRESS',
        runKey,
        alertDeliveryDisabled: safety.alertDeliveryDisabled,
      }
    }

    try {
      const evaluated = await this.runDetectors(
        request.detectors,
        batch,
        platformNow,
        runKey,
        request.organizationId,
        request.customerTenantId,
      )
      await this.persistCompletedRun({
        request,
        runId: claim.id,
        runKey,
        leaseToken,
        expiresAt,
        alertDeliveryDisabled: safety.alertDeliveryDisabled,
        capability: batch.capability,
        platformNow,
        ...evaluated,
      })
      return {
        status: 'COMPLETED',
        runKey,
        alertDeliveryDisabled: safety.alertDeliveryDisabled,
      }
    } catch {
      await this.prisma.identityRiskEvaluationRun.updateMany({
        where: {
          id: claim.id,
          organizationId: request.organizationId,
          customerTenantId: request.customerTenantId,
          leaseToken,
          status: 'RUNNING',
        },
        data: {
          status: 'FAILED',
          failureCode: 'EVALUATION_FAILED',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      })
      throw new Error('Identity risk evaluation failed.')
    }
  }

  private validateRequest(
    request: IdentityRiskEvaluationRequest,
    platformNow: Date,
  ) {
    if (
      !validDate(platformNow) ||
      request.engineVersion !== IDENTITY_RISK_ENGINE_VERSION ||
      request.catalogVersion !== IDENTITY_RISK_CATALOG_VERSION ||
      !validDate(request.windowStart) ||
      !validDate(request.windowEnd) ||
      !validDate(request.evaluationAt) ||
      request.windowStart.getTime() >= request.windowEnd.getTime() ||
      request.evaluationAt.getTime() >
        platformNow.getTime() + IDENTITY_RISK_MAX_FUTURE_SKEW_MS ||
      request.windowEnd.getTime() >
        platformNow.getTime() + IDENTITY_RISK_MAX_FUTURE_SKEW_MS ||
      request.windowEnd.getTime() >
        request.evaluationAt.getTime() + IDENTITY_RISK_MAX_FUTURE_SKEW_MS ||
      request.detectors.length === 0 ||
      request.detectors.length > MAX_DETECTORS ||
      new Set(request.detectors.map((detector) => detector.ruleId)).size !==
        request.detectors.length ||
      request.detectors.some((detector) => !isIdentityRiskRuleId(detector.ruleId))
    ) throw new Error('Identity risk evaluation request is invalid.')
  }

  private validateSourceBatch(
    request: IdentityRiskEvaluationRequest,
    batch: IdentityRiskSourceBatch,
  ) {
    const sourceEntries = isPlainRecord(batch.context.sources)
      ? Object.entries(batch.context.sources)
      : []
    if (
      !isPlainRecord(batch.context.sources) ||
      batch.context.engineVersion !== request.engineVersion ||
      batch.context.catalogVersion !== request.catalogVersion ||
      !validDate(batch.context.evaluationAt) ||
      batch.context.evaluationAt.getTime() !== request.evaluationAt.getTime() ||
      !coverages.has(batch.capability) ||
      sourceEntries.length > MAX_SOURCE_TYPES ||
      sourceEntries.some(
        ([source, rows]) =>
          !boundedOpaqueId(source, 80) ||
          !Array.isArray(rows) ||
          rows.length > MAX_SOURCE_RECORDS_PER_TYPE ||
          rows.some((row) => !isPlainRecord(row)),
      ) ||
      batch.orderedSourceWatermarks.length > 100 ||
      batch.orderedSourceWatermarks.some(
        (watermark) => !boundedOpaqueId(watermark, 128),
      ) ||
      new Set(batch.orderedSourceWatermarks).size !==
        batch.orderedSourceWatermarks.length ||
      sourceEntries.some(([source]) =>
        /RISKY_USERS|RISK_DETECTIONS|MICROSOFT_ENTRA_RISK/i.test(source),
      ) ||
      (batch.earliestSourceExpiry !== null &&
        !validDate(batch.earliestSourceExpiry))
    ) throw new Error('Identity risk source contract is invalid.')
  }

  private async claimRun(input: {
    request: IdentityRiskEvaluationRequest
    runKey: string
    watermarkHash: string
    expiresAt: Date
    leaseToken: string
    alertDeliveryDisabled: boolean
    capability: 'FULL' | 'PARTIAL' | 'UNAVAILABLE'
    platformNow: Date
  }): Promise<'COMPLETED' | 'BUSY' | { id: string }> {
    const now = input.platformNow
    try {
      const created = await this.prisma.identityRiskEvaluationRun.create({
        data: {
          organizationId: input.request.organizationId,
          customerTenantId: input.request.customerTenantId,
          runKey: input.runKey,
          engineVersion: input.request.engineVersion,
          catalogVersion: input.request.catalogVersion,
          status: 'RUNNING',
          windowStart: input.request.windowStart,
          windowEnd: input.request.windowEnd,
          sourceWatermarkHash: input.watermarkHash,
          capability: input.capability,
          aggregate: {},
          alertDeliveryDisabled: input.alertDeliveryDisabled,
          leaseToken: input.leaseToken,
          leaseExpiresAt: new Date(now.getTime() + RUN_LEASE_MS),
          expiresAt: input.expiresAt,
          createdAt: now,
        },
        select: { id: true },
      })
      return created
    } catch (error) {
      if (!uniqueViolation(error)) throw error
    }
    const existing = await this.prisma.identityRiskEvaluationRun.findUnique({
      where: {
        organizationId_customerTenantId_runKey: {
          organizationId: input.request.organizationId,
          customerTenantId: input.request.customerTenantId,
          runKey: input.runKey,
        },
      },
      select: { id: true, status: true, leaseExpiresAt: true },
    })
    if (!existing) throw new Error('Identity risk run claim failed.')
    if (existing.status === 'COMPLETED') return 'COMPLETED'
    if (
      existing.status === 'RUNNING' &&
      existing.leaseExpiresAt &&
      existing.leaseExpiresAt.getTime() > now.getTime()
    ) return 'BUSY'
    const reclaimed = await this.prisma.identityRiskEvaluationRun.updateMany({
      where: {
        id: existing.id,
        organizationId: input.request.organizationId,
        customerTenantId: input.request.customerTenantId,
        OR: [
          { status: 'FAILED' },
          { status: 'RUNNING', leaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: 'RUNNING',
        failureCode: null,
        leaseToken: input.leaseToken,
        leaseExpiresAt: new Date(now.getTime() + RUN_LEASE_MS),
        alertDeliveryDisabled: input.alertDeliveryDisabled,
        capability: input.capability,
      },
    })
    return reclaimed.count === 1 ? { id: existing.id } : 'BUSY'
  }

  private async runDetectors(
    detectors: readonly IdentitySignalDetector[],
    batch: IdentityRiskSourceBatch,
    platformNow: Date,
    runKey: string,
    organizationId: string,
    customerTenantId: string,
  ) {
    const aggregates: RuleAggregate[] = []
    const matches = new Map<string, IdentitySignalResult>()
    for (const detector of [...detectors].sort((left, right) =>
      left.ruleId.localeCompare(right.ruleId),
    )) {
      const ruleId = detector.ruleId as IdentityRiskRuleId
      const aggregate = emptyAggregate(ruleId)
      aggregates.push(aggregate)
      let raw: readonly IdentitySignalResult[]
      try {
        raw = await detector.evaluate(batch.context)
      } catch {
        raw = []
        add(aggregate.notEvaluated)
        addReason(aggregate, 'DETECTOR_FAILED')
        await this.safety.recordDetectorRejection({
          organizationId,
          customerTenantId,
          runKey,
          ruleId,
          reasonCode: 'DETECTOR_FAILED',
          now: platformNow,
        })
        throw new Error('Identity risk detector output was rejected.')
      }
      if (!Array.isArray(raw) || raw.length > MAX_RESULTS_PER_DETECTOR) {
        add(aggregate.notEvaluated)
        addReason(aggregate, 'RESULT_LIMIT_EXCEEDED')
        await this.safety.recordDetectorRejection({
          organizationId,
          customerTenantId,
          runKey,
          ruleId,
          reasonCode: 'RESULT_LIMIT_EXCEEDED',
          now: platformNow,
        })
        throw new Error('Identity risk detector output was rejected.')
      }
      const validated = raw.map((result) =>
        validateResult(result, ruleId, platformNow),
      )
      if (validated.some((result) => result === null)) {
        const rejectionReason = raw
          .map((result) => rejectedResultReason(result, ruleId, platformNow))
          .find((reason) => reason === 'FUTURE_TIMESTAMP') ??
          'DETECTOR_OUTPUT_INVALID'
        add(aggregate.notEvaluated)
        addReason(aggregate, rejectionReason)
        await this.safety.recordDetectorRejection({
          organizationId,
          customerTenantId,
          runKey,
          ruleId,
          reasonCode: rejectionReason,
          now: platformNow,
        })
        throw new Error('Identity risk detector output was rejected.')
      }
      for (const result of validated as IdentitySignalResult[]) {
        if (result.outcome !== 'NOT_EVALUATED') add(aggregate.eligible)
        if (result.outcome === 'MATCHED') {
          add(aggregate.matched)
          const key = sha256(
            organizationId,
            customerTenantId,
            runKey,
            ruleId,
            result.subjectType ?? '',
            result.subjectId ?? '',
            result.observedAt?.toISOString() ?? '',
          )
          matches.set(key, result)
        } else if (result.outcome === 'SUPPRESSED') {
          add(aggregate.suppressed)
        } else if (result.outcome === 'NOT_MATCHED') {
          add(aggregate.notMatched)
        } else {
          add(aggregate.notEvaluated)
          addReason(aggregate, result.reasonCode ?? 'EVIDENCE_UNAVAILABLE')
        }
      }
    }
    if (matches.size > MAX_MATCHED_RESULTS_PER_RUN) {
      throw new Error('Identity risk matched-result limit exceeded.')
    }
    return { aggregates, matches: [...matches.entries()] }
  }

  private async persistCompletedRun(input: {
    request: IdentityRiskEvaluationRequest
    runId: string
    runKey: string
    leaseToken: string
    expiresAt: Date
    alertDeliveryDisabled: boolean
    capability: 'FULL' | 'PARTIAL' | 'UNAVAILABLE'
    aggregates: readonly RuleAggregate[]
    matches: readonly [string, IdentitySignalResult][]
    platformNow: Date
  }) {
    await this.prisma.$transaction(async (transaction) => {
      for (const aggregate of input.aggregates) {
        await transaction.identityRiskRuleCoverage.upsert({
          where: {
            organizationId_customerTenantId_evaluationRunId_ruleId: {
              organizationId: input.request.organizationId,
              customerTenantId: input.request.customerTenantId,
              evaluationRunId: input.runId,
              ruleId: aggregate.ruleId,
            },
          },
          create: {
            organizationId: input.request.organizationId,
            customerTenantId: input.request.customerTenantId,
            evaluationRunId: input.runId,
            ruleId: aggregate.ruleId,
            eligibleCount: aggregate.eligible.value,
            matchedCount: aggregate.matched.value,
            suppressedCount: aggregate.suppressed.value,
            notMatchedCount: aggregate.notMatched.value,
            notEvaluatedCount: aggregate.notEvaluated.value,
            countsCapped: [
              aggregate.eligible,
              aggregate.matched,
              aggregate.suppressed,
              aggregate.notMatched,
              aggregate.notEvaluated,
            ].some((count) => count.capped),
            reasonCounts: [...aggregate.reasons]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([code, count]) => ({ code, count: publicCount(count) })),
            samplesTruncated: false,
            expiresAt: input.expiresAt,
            createdAt: input.platformNow,
          },
          update: {},
        })
      }
      for (const [resultKey, result] of input.matches) {
        const ruleId = result.ruleId as IdentityRiskRuleId
        const observedAt = result.observedAt as Date
        const matched = await transaction.identityRiskMatchedResult.upsert({
          where: {
            organizationId_customerTenantId_resultKey: {
              organizationId: input.request.organizationId,
              customerTenantId: input.request.customerTenantId,
              resultKey,
            },
          },
          create: {
            organizationId: input.request.organizationId,
            customerTenantId: input.request.customerTenantId,
            evaluationRunId: input.runId,
            resultKey,
            ruleId,
            subjectType: result.subjectType as string,
            subjectId: result.subjectId as string,
            severity: result.severity as string,
            confidence: result.confidence as string,
            coverage: result.coverage,
            observedAt,
            evidence: [],
            expiresAt: input.expiresAt,
            createdAt: input.platformNow,
          },
          update: {},
        })
        const bucket = observedAt.toISOString().slice(0, 13)
        const dedupeKey = sha256(
          input.request.organizationId,
          input.request.customerTenantId,
          result.subjectType ?? '',
          result.subjectId ?? '',
          ruleId,
          bucket,
          input.request.engineVersion,
        )
        await transaction.identityRiskFinding.upsert({
          where: {
            organizationId_customerTenantId_dedupeKey: {
              organizationId: input.request.organizationId,
              customerTenantId: input.request.customerTenantId,
              dedupeKey,
            },
          },
          create: {
            organizationId: input.request.organizationId,
            customerTenantId: input.request.customerTenantId,
            matchedResultId: matched.id,
            dedupeKey,
            ruleId,
            ruleVersion: 'v1',
            subjectType: result.subjectType as string,
            subjectId: result.subjectId as string,
            severity: result.severity as string,
            confidence: result.confidence as string,
            coverage: result.coverage,
            observedAt,
            expiresAt: input.expiresAt,
            createdAt: input.platformNow,
            updatedAt: input.platformNow,
          },
          update: {
            matchedResultId: matched.id,
            state: 'UPDATED',
            severity: result.severity as string,
            confidence: result.confidence as string,
            coverage: result.coverage,
            observedAt,
            expiresAt: input.expiresAt,
            updatedAt: input.platformNow,
          },
        })
        if (!identityRiskRulePresentation(ruleId)) {
          throw new Error('Identity risk catalog projection is unavailable.')
        }
      }
      const updated = await transaction.identityRiskEvaluationRun.updateMany({
        where: {
          id: input.runId,
          organizationId: input.request.organizationId,
          customerTenantId: input.request.customerTenantId,
          leaseToken: input.leaseToken,
          status: 'RUNNING',
        },
        data: {
          status: 'COMPLETED',
          aggregate: aggregateJson(input.aggregates),
          capability:
            input.capability === 'FULL' &&
            input.aggregates.some((aggregate) => aggregate.notEvaluated.value > 0)
              ? 'PARTIAL'
              : input.capability,
          alertDeliveryDisabled: input.alertDeliveryDisabled,
          completedAt: input.platformNow,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      })
      if (updated.count !== 1) throw new Error('Identity risk run lease was lost.')
    })
  }
}

/**
 * Stable internal scheduler boundary. A cron or replay worker supplies only an
 * allowlisted source loader and detector set; this class owns no rule formulas.
 */
@Injectable()
export class IdentityRiskEvaluationScheduler {
  constructor(
    @Inject(IdentityRiskEvaluatorService)
    private readonly evaluator: IdentityRiskEvaluatorService,
  ) {}

  runTenant(request: IdentityRiskEvaluationRequest) {
    return this.evaluator.evaluate(request)
  }
}
