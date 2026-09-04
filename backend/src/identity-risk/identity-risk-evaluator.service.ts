import { createHash, randomUUID } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import type { Prisma } from '../generated/prisma/client.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { enforceRiskUtcTransaction } from './risk-utc-session.js'
import { assertGlobalRiskCommitScope, assertRiskExecutionBudget, configureRiskStatementBudget } from './risk-global-commit-guard.js'
import { runRiskTransaction } from './risk-bounded-prisma-transaction.js'
import { withRiskKeyTransaction } from './mailbox-read-transaction.js'
import {
  IDENTITY_RISK_CATALOG_VERSION,
  IDENTITY_RISK_APPROVED_SOURCE_TYPES,
  IDENTITY_RISK_ENGINE_VERSION,
  IDENTITY_RISK_MAX_FUTURE_SKEW_MS,
  IDENTITY_RISK_RUN_RETENTION_MS,
  IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION,
  type IdentityRiskBoundedCount,
  type IdentityRiskApprovedEvaluationRequest,
  type IdentityRiskEvaluationRequest,
  type IdentityRiskSourceBatch,
  type IdentityRiskSourceEnvelope,
  type IdentityRiskSourcePayload,
  type IdentitySignalDetector,
  type IdentitySignalEvaluationContext,
  type IdentitySignalResult,
} from './identity-risk.contract.js'
import {
  approvedIdentitySignalDetectors,
  isApprovedIdentitySignalCandidateProjection,
} from './identity-risk-approved-evaluator.adapter.js'
import {
  identityRiskRulePresentation,
  isIdentityRiskRuleId,
  type IdentityRiskRuleId,
} from './identity-risk.catalog.js'
import { isIdentitySignalCandidateRuntime } from './identity-signal-runtime.js'
import {
  IdentityRiskSafetyService,
  type IdentityRiskSafetyState,
} from './identity-risk-safety.service.js'
import {
  boundedOpaqueId,
  boundedSafeString,
  isIdentityRiskOpaqueReferenceKind,
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
const MAX_SOURCE_ENVELOPES = MAX_SOURCE_TYPES * MAX_SOURCE_RECORDS_PER_TYPE
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
  'reasonCodes',
  'subjectType',
  'subjectId',
  'candidateReference',
  'severity',
  'confidence',
  'evidenceReferences',
  'observedAt',
  'sourceLabels',
])
const reasonCodes = new Set([
  'ACCOUNT_CLASS_COVERAGE_INCOMPLETE',
  'ACCOUNT_CLASS_UNSUPPORTED',
  'ACCOUNT_CLASS_UNVERIFIED',
  'BASELINE_LEARNING',
  'DETECTOR_FAILED',
  'DETECTOR_OUTPUT_CONFLICT',
  'DETECTOR_OUTPUT_INVALID',
  'EVALUATION_BUDGET_EXCEEDED',
  'EVIDENCE_CAPPED',
  'EVIDENCE_FUTURE_DATED',
  'EVIDENCE_MALFORMED',
  'EVIDENCE_PARTIAL',
  'EVIDENCE_STALE',
  'EVIDENCE_UNAVAILABLE',
  'EXPECTED_AUTH_RETRY',
  'FUTURE_TIMESTAMP',
  'APPROVED_MAINTENANCE_WINDOW',
  'APPROVED_SHARED_CONTEXT',
  'APPROVED_TRAVEL_EXCEPTION',
  'IDENTIFIER_DOMAIN_UNVERIFIED',
  'INSUFFICIENT_INDEPENDENT_CONTEXT',
  'MAILBOX_RULE_PROJECTION_INCOMPLETE',
  'NO_MATCH',
  'RESULT_LIMIT_EXCEEDED',
  'RULE_CONFIG_UNAPPROVED',
  'RULE_FEATURE_DISABLED',
  'RULE_MATCHED',
])

const sourcePayloadKeys = new Set([
  'candidate',
  'recordReference',
  'schemaVersion',
  'subjectReference',
])
const approvedSourceTypes = new Set<string>(IDENTITY_RISK_APPROVED_SOURCE_TYPES)

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

function exactDataKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>) {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  return keys.every((key) =>
    typeof key === 'string' &&
    allowed.has(key) &&
    descriptors[key]?.enumerable === true &&
    'value' in descriptors[key]!,
  )
}

function approvedSourceName(value: unknown): string | null {
  const source = boundedSafeString(value, 80)
  return source && approvedSourceTypes.has(source) ? source : null
}

function validSubjectReference(
  subjectType: unknown,
  subjectId: unknown,
): subjectId is string {
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

function freezeApprovedCandidate(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) freezeApprovedCandidate(descriptor.value)
  }
  Object.freeze(value)
}

function approvedSourcePayload(value: unknown): IdentityRiskSourcePayload | null {
  if (!isPlainRecord(value) || !exactDataKeys(value, sourcePayloadKeys)) return null
  if (
    value.schemaVersion !== IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION ||
    !isIdentityRiskOpaqueReferenceKind(
      value.recordReference,
      ['event', 'observation', 'evidence'],
    ) ||
    !validSubjectReference(
      value.candidate && typeof value.candidate === 'object'
        ? (value.candidate as { subject?: { type?: unknown } }).subject?.type
        : undefined,
      value.subjectReference,
    ) ||
    !isIdentitySignalCandidateRuntime(value.candidate) ||
    !isApprovedIdentitySignalCandidateProjection(value.candidate) ||
    value.candidate.subject.opaqueId !== value.subjectReference
  ) return null
  const candidate = structuredClone(value.candidate)
  if (!isIdentitySignalCandidateRuntime(candidate)) return null
  freezeApprovedCandidate(candidate)
  return Object.freeze({
    schemaVersion: IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION,
    recordReference: value.recordReference,
    subjectReference: value.subjectReference,
    candidate,
  })
}

const MAX_CANONICAL_SOURCE_NODES = 2_000_000
const MAX_CANONICAL_SOURCE_BYTES = 64 * 1024 * 1024
type CanonicalBudget = { nodes: number; bytes: number }

function canonicalToken(
  hash: ReturnType<typeof createHash>,
  value: string,
  budget: CanonicalBudget,
) {
  budget.bytes += Buffer.byteLength(value)
  if (budget.bytes > MAX_CANONICAL_SOURCE_BYTES) return false
  hash.update(String(Buffer.byteLength(value))).update(':').update(value)
  return true
}

function canonicalValue(
  hash: ReturnType<typeof createHash>,
  value: unknown,
  budget: CanonicalBudget,
  ancestors: Set<object>,
  depth = 0,
): boolean {
  budget.nodes += 1
  if (budget.nodes > MAX_CANONICAL_SOURCE_NODES || depth > 16) return false
  if (value === null) return canonicalToken(hash, 'null', budget)
  if (typeof value === 'boolean') {
    return canonicalToken(hash, value ? 'boolean:true' : 'boolean:false', budget)
  }
  if (typeof value === 'string') {
    return canonicalToken(hash, `string:${value}`, budget)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false
    return canonicalToken(
      hash,
      `number:${Object.is(value, -0) ? '0' : String(value)}`,
      budget,
    )
  }
  if (value instanceof Date) {
    return validDate(value) && canonicalToken(hash, `date:${value.toISOString()}`, budget)
  }
  if (typeof value !== 'object' || ancestors.has(value)) return false
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (!canonicalToken(hash, `array:${value.length}`, budget)) return false
      return value.every((item) =>
        canonicalValue(hash, item, budget, ancestors, depth + 1),
      )
    }
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
      return false
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(value).sort()
    if (
      Reflect.ownKeys(descriptors).some((key) =>
        typeof key !== 'string' ||
        !descriptors[key]?.enumerable ||
        !('value' in descriptors[key]!),
      ) ||
      !canonicalToken(hash, `object:${keys.length}`, budget)
    ) return false
    return keys.every((key) =>
      canonicalToken(hash, `key:${key}`, budget) &&
      canonicalValue(hash, descriptors[key]!.value, budget, ancestors, depth + 1),
    )
  } finally {
    ancestors.delete(value)
  }
}

type CanonicalSourceRecord = Readonly<{
  identity: string
  signature: string
  source: string
  sortTime: Date
  payload: IdentityRiskSourcePayload
}>

const immutableEnvelopeKeys = [
  'authoritativeEventTime',
  'canonicalEventId',
  'kind',
  'payload',
  'sourceEventVersion',
  'sourceType',
].join(',')
const snapshotEnvelopeKeys = [
  'authoritativeObservationId',
  'kind',
  'objectId',
  'observedAt',
  'payload',
  'projectorSchemaVersion',
  'resourceType',
  'sourceWatermark',
].join(',')

function canonicalPayloadHash(
  payload: unknown,
  budget: CanonicalBudget,
): string | null {
  const hash = createHash('sha256')
  return canonicalValue(hash, payload, budget, new Set())
    ? hash.digest('hex')
    : null
}

function canonicalSourceRecord(
  envelope: IdentityRiskSourceEnvelope,
  request: IdentityRiskEvaluationRequest,
  platformNow: Date,
  watermarks: ReadonlySet<string>,
  budget: CanonicalBudget,
): CanonicalSourceRecord | null {
  if (!isPlainRecord(envelope)) return null
  const payload = approvedSourcePayload(envelope.payload)
  if (!payload) return null
  const payloadHash = canonicalPayloadHash(payload, budget)
  if (!payloadHash) return null

  if (envelope.kind === 'IMMUTABLE_EVENT') {
    if (Object.keys(envelope).sort().join(',') !== immutableEnvelopeKeys) return null
    const source = approvedSourceName(envelope.sourceType)
    const eventId = boundedOpaqueId(envelope.canonicalEventId, 160)
    const version = boundedOpaqueId(envelope.sourceEventVersion, 80)
    const eventTime = parseTimestamp(envelope.authoritativeEventTime, platformNow)
    if (
      !source ||
      !eventId ||
      !version ||
      !eventTime
    ) return null
    const identity = sha256(
      request.organizationId,
      request.customerTenantId,
      'IMMUTABLE_EVENT',
      source,
      eventId,
      eventTime.toISOString(),
      version,
    )
    return {
      identity,
      signature: payloadHash,
      source,
      sortTime: eventTime,
      payload,
    }
  }

  if (envelope.kind === 'AUTHORITATIVE_SNAPSHOT') {
    if (Object.keys(envelope).sort().join(',') !== snapshotEnvelopeKeys) return null
    const source = approvedSourceName(envelope.resourceType)
    const objectId = boundedOpaqueId(envelope.objectId, 160)
    const observationId = boundedOpaqueId(
      envelope.authoritativeObservationId,
      160,
    )
    const projectorVersion = boundedOpaqueId(envelope.projectorSchemaVersion, 80)
    const watermark = boundedOpaqueId(envelope.sourceWatermark, 128)
    const observedAt = parseTimestamp(envelope.observedAt, platformNow)
    if (
      !source ||
      !objectId ||
      !observationId ||
      !projectorVersion ||
      !watermark ||
      !watermarks.has(watermark) ||
      !observedAt
    ) return null
    const identity = sha256(
      request.organizationId,
      request.customerTenantId,
      'AUTHORITATIVE_SNAPSHOT',
      source,
      objectId,
      observationId,
    )
    return {
      identity,
      signature: sha256(
        observedAt.toISOString(),
        projectorVersion,
        watermark,
        payloadHash,
      ),
      source,
      sortTime: observedAt,
      payload,
    }
  }
  return null
}

type CanonicalizedSources =
  | Readonly<{
      status: 'OK'
      sources: IdentitySignalEvaluationContext['sources']
      sourceContentHash: string
    }>
  | Readonly<{ status: 'INTEGRITY_CONFLICT' | 'REJECTED' }>

function canonicalizeSourceEnvelopesUnchecked(
  batch: IdentityRiskSourceBatch,
  request: IdentityRiskEvaluationRequest,
  platformNow: Date,
): CanonicalizedSources {
  if (
    !Array.isArray(batch.sourceEnvelopes) ||
    batch.sourceEnvelopes.length > MAX_SOURCE_ENVELOPES
  ) return { status: 'REJECTED' }
  const budget: CanonicalBudget = { nodes: 0, bytes: 0 }
  const watermarks = new Set(batch.orderedSourceWatermarks)
  const records = new Map<string, CanonicalSourceRecord>()
  const sourceCounts = new Map<string, number>()
  for (const envelope of batch.sourceEnvelopes) {
    const record = canonicalSourceRecord(
      envelope,
      request,
      platformNow,
      watermarks,
      budget,
    )
    if (!record) return { status: 'REJECTED' }
    const sourceCount = (sourceCounts.get(record.source) ?? 0) + 1
    sourceCounts.set(record.source, sourceCount)
    if (
      sourceCounts.size > MAX_SOURCE_TYPES ||
      sourceCount > MAX_SOURCE_RECORDS_PER_TYPE
    ) return { status: 'REJECTED' }
    const existing = records.get(record.identity)
    if (existing && existing.signature !== record.signature) {
      return { status: 'INTEGRITY_CONFLICT' }
    }
    if (!existing) records.set(record.identity, record)
  }

  const ordered = [...records.values()].sort((left, right) =>
    left.sortTime.getTime() - right.sortTime.getTime() ||
    left.identity.localeCompare(right.identity),
  )
  const grouped = new Map<string, IdentityRiskSourcePayload[]>()
  const hash = createHash('sha256')
  for (const record of ordered) {
    const rows = grouped.get(record.source)
    if (rows) rows.push(record.payload)
    else grouped.set(record.source, [record.payload])
    if (
      !canonicalToken(hash, record.identity, budget) ||
      !canonicalToken(hash, record.signature, budget)
    ) return { status: 'REJECTED' }
  }
  const sources = Object.create(null) as Record<
    string,
    readonly IdentityRiskSourcePayload[]
  >
  for (const [source, rows] of grouped) {
    Object.defineProperty(sources, source, {
      value: Object.freeze([...rows]),
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  Object.freeze(sources)
  return {
    status: 'OK',
    sources,
    sourceContentHash: hash.digest('hex'),
  }
}

function canonicalizeSourceEnvelopes(
  batch: IdentityRiskSourceBatch,
  request: IdentityRiskEvaluationRequest,
  platformNow: Date,
): CanonicalizedSources {
  try {
    return canonicalizeSourceEnvelopesUnchecked(batch, request, platformNow)
  } catch {
    return { status: 'REJECTED' }
  }
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

function normalizedReasonCodes(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_REASON_CODES_PER_RULE ||
    value.some((reason) =>
      typeof reason !== 'string' ||
      !reasonCodes.has(reason) ||
      !boundedSafeString(reason, 80),
    ) ||
    new Set(value).size !== value.length
  ) return null
  return Object.freeze([...value].sort())
}

function normalizedOpaqueReferences(value: unknown): readonly string[] | null {
  if (value === undefined) return Object.freeze([])
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some((reference) =>
      !isIdentityRiskOpaqueReferenceKind(reference, 'evidence')) ||
    new Set(value).size !== value.length
  ) return null
  return Object.freeze([...value].sort())
}

function normalizedSourceLabels(value: unknown): readonly string[] | null {
  if (value === undefined) return Object.freeze([])
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some((label) => !boundedSafeString(label, 128)) ||
    new Set(value).size !== value.length
  ) return null
  return Object.freeze([...value].sort())
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
  const normalizedReasons = normalizedReasonCodes(value.reasonCodes)
  const evidenceReferences = normalizedOpaqueReferences(value.evidenceReferences)
  const sourceLabels = normalizedSourceLabels(value.sourceLabels)
  const candidateReference = value.candidateReference === undefined
    ? undefined
    : isIdentityRiskOpaqueReferenceKind(value.candidateReference, 'contribution')
      ? value.candidateReference
      : null
  if (
    !normalizedReasons ||
    !evidenceReferences ||
    !sourceLabels ||
    candidateReference === null ||
    !validSubjectReference(value.subjectType, value.subjectId) ||
    !subjectTypes.has(value.subjectType as string)
  ) return null

  if (value.outcome === 'MATCHED') {
    const observedAt = parseTimestamp(value.observedAt, platformNow)
    if (
      value.coverage === 'UNAVAILABLE' ||
      !severities.has(value.severity as string) ||
      !confidences.has(value.confidence as string) ||
      !observedAt
    ) return null
    return Object.freeze({
      ...value,
      reasonCodes: normalizedReasons,
      evidenceReferences,
      sourceLabels,
      ...(candidateReference === undefined ? {} : { candidateReference }),
      observedAt,
    }) as IdentitySignalResult
  }
  if (
    value.severity !== undefined ||
    value.confidence !== undefined ||
    value.observedAt !== undefined
  ) return null
  return Object.freeze({
    ...value,
    reasonCodes: normalizedReasons,
    evidenceReferences,
    sourceLabels,
    ...(candidateReference === undefined ? {} : { candidateReference }),
  }) as IdentitySignalResult
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
    assertRiskExecutionBudget(request)
    if (mode() === 'OFF') {
      return { status: 'OFF', runKey: null, alertDeliveryDisabled: true }
    }
    let safety = await this.safetyForRequest(request)
    if (safety.evaluationHardDisabled) {
      return this.hardDisabledResult(request, safety, platformNow)
    }

    const batch = await request.loadSources()
    assertRiskExecutionBudget(request)
    if (
      batch.context.organizationId !== request.organizationId ||
      batch.context.customerTenantId !== request.customerTenantId
    ) {
      const crossOrganization =
        batch.context.organizationId !== request.organizationId
      await this.safety.activate({
        executionDeadlineAt: request.executionDeadlineAt,
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
    this.validateSourceBatch(request, batch, platformNow)

    // A control may be activated while the allowlisted loader is in flight.
    // Re-read it before hashing, claiming, or evaluating any returned source.
    safety = await this.safetyForRequest(request)
    if (safety.evaluationHardDisabled) {
      return this.hardDisabledResult(request, safety, platformNow)
    }

    // Watermarks are restricted to bounded ASCII opaque IDs, so the default
    // code-unit sort is the canonical bytewise order used by the run key.
    const canonicalSourceWatermarks = [...batch.orderedSourceWatermarks].sort()
    const watermarkHash = sha256(...canonicalSourceWatermarks,
      ...(batch.pseudonymKeyVersionId ? [batch.pseudonymKeyVersionId] : []))
    const canonicalSources = canonicalizeSourceEnvelopes(
      batch,
      request,
      platformNow,
    )
    if (canonicalSources.status !== 'OK') {
      const reasonCode = canonicalSources.status === 'INTEGRITY_CONFLICT'
        ? 'SOURCE_INTEGRITY_CONFLICT'
        : 'SECRET_EXPOSURE'
      await this.safety.activate({
        executionDeadlineAt: request.executionDeadlineAt,
        controlType: 'EVALUATION_HARD_DISABLED',
        scope: {
          type: 'TENANT',
          organizationId: request.organizationId,
          customerTenantId: request.customerTenantId,
        },
        reasonCode,
        actorServiceId: 'identity-risk-evaluator',
        now: platformNow,
      })
      return {
        status: 'HARD_DISABLED',
        runKey: null,
        alertDeliveryDisabled: true,
      }
    }
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
      sourceContentHash: canonicalSources.sourceContentHash,
      expiresAt,
      leaseToken,
      capability: batch.capability,
      platformNow,
      pseudonymKeyVersionId: batch.pseudonymKeyVersionId,
      sourceObservedAt: batch.sourceObservedAt,
      mailboxAttestations: batch.mailboxAttestations,
    })
    if (claim === 'SOURCE_INTEGRITY_CONFLICT') {
      await this.safety.activate({
        executionDeadlineAt: request.executionDeadlineAt,
        controlType: 'EVALUATION_HARD_DISABLED',
        scope: {
          type: 'TENANT',
          organizationId: request.organizationId,
          customerTenantId: request.customerTenantId,
        },
        reasonCode: 'SOURCE_INTEGRITY_CONFLICT',
        actorServiceId: 'identity-risk-evaluator',
        now: platformNow,
      })
      return {
        status: 'HARD_DISABLED',
        runKey: null,
        alertDeliveryDisabled: true,
      }
    }
    if (typeof claim === 'object' && 'hardDisabled' in claim) {
      return this.hardDisabledResult(
        request,
        claim.hardDisabled,
        platformNow,
      )
    }
    safety = await this.safetyForRequest(request)
    if (safety.evaluationHardDisabled) {
      if (typeof claim === 'object') {
        await this.failOwnedRun(request, claim.id, leaseToken, 'EVALUATION_HARD_DISABLED')
      }
      return this.hardDisabledResult(request, safety, platformNow)
    }
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
        {
          ...batch,
          context: {
            ...batch.context,
            capability: batch.capability,
            sources: canonicalSources.sources,
          },
        },
        platformNow,
        runKey,
        request.organizationId,
        request.customerTenantId,
        request.executionDeadlineAt,
      )
      const persisted = await this.persistCompletedRun({
        pseudonymKeyVersionId: batch.pseudonymKeyVersionId,
        mailboxAttestations: batch.mailboxAttestations,
        request,
        runId: claim.id,
        runKey,
        leaseToken,
        expiresAt,
        capability: batch.capability,
        platformNow,
        ...evaluated,
      })
      if (persisted.status === 'HARD_DISABLED') {
        return this.hardDisabledResult(
          request,
          persisted.safety,
          platformNow,
        )
      }
      return {
        status: 'COMPLETED',
        runKey,
        alertDeliveryDisabled: persisted.safety.alertDeliveryDisabled,
      }
    } catch {
      await this.failOwnedRun(request, claim.id, leaseToken, 'EVALUATION_FAILED')
      throw new Error('Identity risk evaluation failed.')
    }
  }

  private async safetyForRequest(request: IdentityRiskEvaluationRequest): Promise<IdentityRiskSafetyState> {
    if (request.executionDeadlineAt === undefined) return this.safety.stateForTenant(request.organizationId, request.customerTenantId)
    return withRiskKeyTransaction(request.executionDeadlineAt, async client => {
      const rows = await client.query<{ control_type: string; episode_id: string; scope_type: 'GLOBAL' | 'TENANT' }>(`
        SELECT control_type,episode_id,scope_type FROM identity_risk_operational_controls WHERE state='ACTIVE'
        AND ((scope_type='GLOBAL' AND scope_key='GLOBAL') OR
          (scope_type='TENANT' AND scope_key=$3 AND organization_id=$1::uuid AND customer_tenant_id=$2::uuid)) LIMIT 4`,
      [request.organizationId, request.customerTenantId, `${request.organizationId}:${request.customerTenantId}`])
      const hard = rows.rows.find(row => row.control_type === 'EVALUATION_HARD_DISABLED')
      return { evaluationHardDisabled: Boolean(hard), alertDeliveryDisabled: rows.rows.some(row => row.control_type === 'ALERT_DELIVERY_DISABLED'),
        hardDisableEpisodeId: hard?.episode_id ?? null, hardDisableScopeType: hard?.scope_type ?? null }
    })
  }

  private async hardDisabledResult(
    request: IdentityRiskEvaluationRequest,
    safety: IdentityRiskSafetyState,
    platformNow: Date,
  ): Promise<IdentityRiskEvaluationResult> {
    if (safety.hardDisableEpisodeId) {
      await this.safety.recordHardStopBlocked({
        executionDeadlineAt: request.executionDeadlineAt,
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

  private async failOwnedRun(
    request: IdentityRiskEvaluationRequest,
    runId: string,
    leaseToken: string,
    failureCode: 'EVALUATION_FAILED' | 'EVALUATION_HARD_DISABLED',
  ) {
    if (request.executionDeadlineAt !== undefined) {
      // No abandoned write after deadline: an unmarked run retains its bounded
      // lease and the durable attempt suppresses any prior healthy-looking run.
      if (request.executionDeadlineAt - Date.now() < 100) return
      try {
        await withRiskKeyTransaction(request.executionDeadlineAt, async client => {
          await client.query(`UPDATE identity_risk_evaluation_runs SET status='FAILED',failure_code=$5,
            lease_token=NULL,lease_expires_at=NULL WHERE id=$1::uuid AND organization_id=$2::uuid
            AND customer_tenant_id=$3::uuid AND lease_token=$4::uuid AND status='RUNNING'`,
          [runId, request.organizationId, request.customerTenantId, leaseToken, failureCode])
        })
      } catch { /* The bounded lease is the fail-closed recovery mechanism. */ }
      return
    }
    await this.prisma.identityRiskEvaluationRun.updateMany({
      where: {
        id: runId,
        organizationId: request.organizationId,
        customerTenantId: request.customerTenantId,
        leaseToken,
        status: 'RUNNING',
      },
      data: {
        status: 'FAILED',
        failureCode,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    })
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
    platformNow: Date,
  ) {
    if (
      (batch.pseudonymKeyVersionId !== undefined &&
        (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(batch.pseudonymKeyVersionId) || !validDate(batch.sourceObservedAt))) ||
      (batch.sourceObservedAt !== undefined && (!validDate(batch.sourceObservedAt) ||
        batch.sourceObservedAt.getTime() > platformNow.getTime() + IDENTITY_RISK_MAX_FUTURE_SKEW_MS)) ||
      !isPlainRecord(batch.context) ||
      Object.keys(batch.context).sort().join(',') !==
        'catalogVersion,customerTenantId,engineVersion,evaluationAt,organizationId' ||
      batch.context.engineVersion !== request.engineVersion ||
      batch.context.catalogVersion !== request.catalogVersion ||
      !validDate(batch.context.evaluationAt) ||
      batch.context.evaluationAt.getTime() !== request.evaluationAt.getTime() ||
      batch.context.evaluationAt.getTime() >
        platformNow.getTime() + IDENTITY_RISK_MAX_FUTURE_SKEW_MS ||
      !coverages.has(batch.capability) ||
      batch.orderedSourceWatermarks.length > 100 ||
      batch.orderedSourceWatermarks.some(
        (watermark) => !boundedOpaqueId(watermark, 128),
      ) ||
      new Set(batch.orderedSourceWatermarks).size !==
        batch.orderedSourceWatermarks.length ||
      (batch.earliestSourceExpiry !== null &&
        !validDate(batch.earliestSourceExpiry))
    ) throw new Error('Identity risk source contract is invalid.')
  }

  private async lockedSafetyState(
    transaction: Prisma.TransactionClient,
    organizationId: string,
    customerTenantId: string,
    includeAlertDelivery: boolean,
  ): Promise<IdentityRiskSafetyState> {
    const controlTypes = includeAlertDelivery
      ? ['ALERT_DELIVERY_DISABLED', 'EVALUATION_HARD_DISABLED'] as const
      : ['EVALUATION_HARD_DISABLED'] as const
    const scopeKeys = ['GLOBAL', `${organizationId}:${customerTenantId}`]
    const lockKeys = controlTypes
      .flatMap((controlType) => scopeKeys.map((scope) =>
        `hawkview:identity-risk-control:${controlType}:${scope}`,
      ))
      .sort()
    for (const lockKey of lockKeys) {
      await transaction.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        lockKey,
      )
    }
    const controls = await transaction.identityRiskOperationalControl.findMany({
      where: {
        state: 'ACTIVE',
        controlType: { in: [...controlTypes] },
        OR: [
          { scopeType: 'GLOBAL', scopeKey: 'GLOBAL' },
          {
            scopeType: 'TENANT',
            scopeKey: `${organizationId}:${customerTenantId}`,
            organizationId,
            customerTenantId,
          },
        ],
      },
      select: { controlType: true, episodeId: true, scopeType: true },
    })
    const hard = controls.find(
      (control) => control.controlType === 'EVALUATION_HARD_DISABLED',
    )
    return {
      evaluationHardDisabled: Boolean(hard),
      alertDeliveryDisabled: controls.some(
        (control) => control.controlType === 'ALERT_DELIVERY_DISABLED',
      ),
      hardDisableEpisodeId: hard?.episodeId ?? null,
      hardDisableScopeType:
        hard?.scopeType === 'GLOBAL' || hard?.scopeType === 'TENANT'
          ? hard.scopeType
          : null,
    }
  }

  private async claimRun(input: {
    mailboxAttestations?: IdentityRiskSourceBatch['mailboxAttestations']
    pseudonymKeyVersionId?: string
    sourceObservedAt?: Date
    request: IdentityRiskEvaluationRequest
    runKey: string
    watermarkHash: string
    sourceContentHash: string
    expiresAt: Date
    leaseToken: string
    capability: 'FULL' | 'PARTIAL' | 'UNAVAILABLE'
    platformNow: Date
  }): Promise<
    | 'COMPLETED'
    | 'BUSY'
    | 'SOURCE_INTEGRITY_CONFLICT'
    | { id: string }
    | { hardDisabled: IdentityRiskSafetyState }
  > {
    const now = input.platformNow
    return runRiskTransaction(this.prisma, input.request, async (transaction) => {
      await configureRiskStatementBudget(transaction, input.request)
      await enforceRiskUtcTransaction(transaction)
      assertRiskExecutionBudget(input.request)
      const safety = await this.lockedSafetyState(
        transaction,
        input.request.organizationId,
        input.request.customerTenantId,
        false,
      )
      if (safety.evaluationHardDisabled) return { hardDisabled: safety }
      await assertGlobalRiskCommitScope(transaction, input.request, input.capability, input.mailboxAttestations)
      if (input.pseudonymKeyVersionId) {
        // Lock the pinned version through persistence claim; revoked/foreign versions cannot start a run.
        const keys = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM identity_risk_pseudonym_key_versions
          WHERE id=${input.pseudonymKeyVersionId}::uuid
            AND organization_id=${input.request.organizationId}::uuid
            AND customer_tenant_id=${input.request.customerTenantId}::uuid
            AND status='ACTIVE' AND retired_at IS NULL AND activated_at <= ${now}
          FOR SHARE`
        if (keys.length !== 1) throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
      }
      await transaction.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        `hawkview:identity-risk-run:${input.request.organizationId}:${input.request.customerTenantId}:${input.runKey}`,
      )
      const existing = await transaction.identityRiskEvaluationRun.findUnique({
        where: {
          organizationId_customerTenantId_runKey: {
            organizationId: input.request.organizationId,
            customerTenantId: input.request.customerTenantId,
            runKey: input.runKey,
          },
        },
        select: {
          id: true,
          status: true,
          leaseExpiresAt: true,
          sourceContentHash: true,
        },
      })
      if (existing) {
        if (existing.sourceContentHash !== input.sourceContentHash) {
          return 'SOURCE_INTEGRITY_CONFLICT'
        }
        if (existing.status === 'COMPLETED') return 'COMPLETED'
        if (
          existing.status === 'RUNNING' &&
          existing.leaseExpiresAt &&
          existing.leaseExpiresAt.getTime() > now.getTime()
        ) return 'BUSY'
        const reclaimed = await transaction.identityRiskEvaluationRun.updateMany({
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
            alertDeliveryDisabled: safety.alertDeliveryDisabled,
            capability: input.capability,
          },
        })
        return reclaimed.count === 1 ? { id: existing.id } : 'BUSY'
      }
      const created = await transaction.identityRiskEvaluationRun.create({
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
          sourceContentHash: input.sourceContentHash,
          pseudonymKeyVersionId: input.pseudonymKeyVersionId ?? null,
          sourceObservedAt: input.sourceObservedAt ?? null,
          capability: input.capability,
          aggregate: {},
          alertDeliveryDisabled: safety.alertDeliveryDisabled,
          leaseToken: input.leaseToken,
          leaseExpiresAt: new Date(now.getTime() + RUN_LEASE_MS),
          expiresAt: input.expiresAt,
          createdAt: now,
        },
        select: { id: true },
      })
      return created
    })
  }

  private async runDetectors(
    detectors: readonly IdentitySignalDetector[],
    batch: Omit<IdentityRiskSourceBatch, 'context'> & {
      context: IdentitySignalEvaluationContext
    },
    platformNow: Date,
    runKey: string,
    organizationId: string,
    customerTenantId: string,
    executionDeadlineAt?: number,
  ) {
    const aggregates: RuleAggregate[] = []
    const matches = new Map<string, IdentitySignalResult>()
    const trustedContext = Object.freeze({
      ...batch.context,
      evaluationAt: new Date(platformNow.getTime()),
      capability: batch.capability,
    })
    for (const detector of [...detectors].sort((left, right) =>
      left.ruleId.localeCompare(right.ruleId),
    )) {
      assertRiskExecutionBudget({ executionDeadlineAt })
      const ruleId = detector.ruleId as IdentityRiskRuleId
      const aggregate = emptyAggregate(ruleId)
      aggregates.push(aggregate)
      let raw: readonly IdentitySignalResult[]
      try {
        raw = await detector.evaluate(trustedContext)
      } catch {
        raw = []
        add(aggregate.notEvaluated)
        addReason(aggregate, 'DETECTOR_FAILED')
        await this.safety.recordDetectorRejection({
          executionDeadlineAt,
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
          executionDeadlineAt,
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
          executionDeadlineAt,
          organizationId,
          customerTenantId,
          runKey,
          ruleId,
          reasonCode: rejectionReason,
          now: platformNow,
        })
        throw new Error('Identity risk detector output was rejected.')
      }
      const distinctResults: IdentitySignalResult[] = []
      const resultSignatures = new Map<string, string>()
      // Legacy/internal detectors that do not carry a server-derived candidate
      // identity keep the stricter one-outcome-per-subject behavior. The
      // production approved adapter always supplies candidateReference, so two
      // legitimate candidates for one subject can have different outcomes.
      const unboundSubjectOutcomes = new Map<string, string>()
      for (const result of validated as IdentitySignalResult[]) {
        if (result.candidateReference === undefined) {
          const subjectKey = sha256(ruleId, result.subjectType, result.subjectId)
          const existingOutcome = unboundSubjectOutcomes.get(subjectKey)
          if (existingOutcome && existingOutcome !== result.outcome) {
            await this.safety.recordDetectorRejection({
              executionDeadlineAt,
              organizationId,
              customerTenantId,
              runKey,
              ruleId,
              reasonCode: 'DETECTOR_OUTPUT_CONFLICT',
              now: platformNow,
            })
            throw new Error('Identity risk detector output was rejected.')
          }
          unboundSubjectOutcomes.set(subjectKey, result.outcome)
        }
        const duplicateKey = sha256(
          ruleId,
          result.subjectType,
          result.subjectId,
          result.candidateReference ?? result.observedAt?.toISOString() ?? '',
        )
        const signature = sha256(
          duplicateKey,
          result.outcome,
          result.coverage,
          result.severity ?? '',
          result.confidence ?? '',
          ...result.reasonCodes,
          ...(result.evidenceReferences ?? []),
          ...(result.sourceLabels ?? []),
        )
        const existing = resultSignatures.get(duplicateKey)
        if (existing === signature) continue
        if (existing) {
          await this.safety.recordDetectorRejection({
            executionDeadlineAt,
            organizationId,
            customerTenantId,
            runKey,
            ruleId,
            reasonCode: 'DETECTOR_OUTPUT_CONFLICT',
            now: platformNow,
          })
          throw new Error('Identity risk detector output was rejected.')
        }
        resultSignatures.set(duplicateKey, signature)
        distinctResults.push(result)
      }
      for (const result of distinctResults) {
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
            result.candidateReference ?? '',
            result.observedAt?.toISOString() ?? '',
          )
          matches.set(key, result)
        } else if (result.outcome === 'SUPPRESSED') {
          add(aggregate.suppressed)
        } else if (result.outcome === 'NOT_MATCHED') {
          add(aggregate.notMatched)
        } else {
          add(aggregate.notEvaluated)
          for (const reasonCode of result.reasonCodes) {
            addReason(aggregate, reasonCode)
          }
        }
      }
    }
    if (matches.size > MAX_MATCHED_RESULTS_PER_RUN) {
      throw new Error('Identity risk matched-result limit exceeded.')
    }
    return { aggregates, matches: [...matches.entries()] }
  }

  private async persistCompletedRun(input: {
    mailboxAttestations?: IdentityRiskSourceBatch['mailboxAttestations']
    pseudonymKeyVersionId?: string
    request: IdentityRiskEvaluationRequest
    runId: string
    runKey: string
    leaseToken: string
    expiresAt: Date
    capability: 'FULL' | 'PARTIAL' | 'UNAVAILABLE'
    aggregates: readonly RuleAggregate[]
    matches: readonly [string, IdentitySignalResult][]
    platformNow: Date
  }) {
    return runRiskTransaction(this.prisma, input.request, async (transaction) => {
      await configureRiskStatementBudget(transaction, input.request)
      await enforceRiskUtcTransaction(transaction)
      const safety = await this.lockedSafetyState(
        transaction,
        input.request.organizationId,
        input.request.customerTenantId,
        true,
      )
      if (safety.evaluationHardDisabled) {
        const failed = await transaction.identityRiskEvaluationRun.updateMany({
          where: {
            id: input.runId,
            organizationId: input.request.organizationId,
            customerTenantId: input.request.customerTenantId,
            leaseToken: input.leaseToken,
            status: 'RUNNING',
          },
          data: {
            status: 'FAILED',
            failureCode: 'EVALUATION_HARD_DISABLED',
            leaseToken: null,
            leaseExpiresAt: null,
          },
        })
        if (failed.count !== 1) throw new Error('Identity risk run lease was lost.')
        return { status: 'HARD_DISABLED' as const, safety }
      }
      await assertGlobalRiskCommitScope(transaction, input.request, input.capability, input.mailboxAttestations)
      if (input.pseudonymKeyVersionId) {
        const keys = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM identity_risk_pseudonym_key_versions
          WHERE id=${input.pseudonymKeyVersionId}::uuid AND organization_id=${input.request.organizationId}::uuid
            AND customer_tenant_id=${input.request.customerTenantId}::uuid AND status='ACTIVE' AND retired_at IS NULL
          FOR SHARE`
        if (keys.length !== 1) throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
      }
      if (input.matches.some(([, result]) =>
        !validSubjectReference(result.subjectType, result.subjectId) ||
        (result.candidateReference !== undefined &&
          !isIdentityRiskOpaqueReferenceKind(
            result.candidateReference,
            'contribution',
          )) ||
        !normalizedOpaqueReferences(result.evidenceReferences),
      )) {
        throw new Error('Identity risk persistence boundary rejected an opaque reference.')
      }
      for (const aggregate of input.aggregates) {
        assertRiskExecutionBudget(input.request)
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
            eligibleCountCapped: aggregate.eligible.capped,
            matchedCountCapped: aggregate.matched.capped,
            suppressedCountCapped: aggregate.suppressed.capped,
            notMatchedCountCapped: aggregate.notMatched.capped,
            notEvaluatedCountCapped: aggregate.notEvaluated.capped,
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
        assertRiskExecutionBudget(input.request)
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
            evidence: result.evidenceReferences ?? [],
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
      assertRiskExecutionBudget(input.request)
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
          alertDeliveryDisabled: safety.alertDeliveryDisabled,
          completedAt: input.platformNow,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      })
      if (updated.count !== 1) throw new Error('Identity risk run lease was lost.')
      return { status: 'COMPLETED' as const, safety }
    })
  }
}

/**
 * Stable internal scheduler boundary. A cron or replay worker supplies only an
 * allowlisted source loader and approved evaluator configuration. Detector
 * formulas always come from the version-pinned implementation.
 */
@Injectable()
export class IdentityRiskEvaluationScheduler {
  constructor(
    @Inject(IdentityRiskEvaluatorService)
    private readonly evaluator: IdentityRiskEvaluatorService,
  ) {}

  runTenant(request: IdentityRiskApprovedEvaluationRequest) {
    const { approvedEvaluator, ...platformRequest } = request
    return this.evaluator.evaluate({
      ...platformRequest,
      detectors: approvedIdentitySignalDetectors(approvedEvaluator),
    })
  }
}
