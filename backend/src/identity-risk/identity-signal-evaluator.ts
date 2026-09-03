import { createHash } from 'node:crypto'
import { domainToASCII } from 'node:url'

import {
  IDENTITY_RISK_ENGINE_VERSION,
  IDENTITY_SIGNAL_CATALOG_VERSION,
  IDENTITY_SIGNAL_CHANNEL,
  IDENTITY_SIGNAL_MAX_BATCH_CANDIDATES,
  IDENTITY_SIGNAL_MAX_BATCH_INPUT_BYTES,
  IDENTITY_SIGNAL_MAX_BATCH_OUTPUT_BYTES,
  type AccountClass,
  type ApprovedCatalog,
  type AuthEvent,
  type BehaviorBaseline,
  type CatalogType,
  type IdentitySignalCandidate,
  type IdentitySignalConfidence,
  type IdentitySignalEvaluationContext,
  type IdentitySignalReasonCode,
  type IdentitySignalResult,
  type IdentitySignalRuleId,
  type IdentitySignalSeverity,
  type NetworkContextEntry,
} from './identity-signal-contract.js'
import { identitySignalRuleDefinition } from './identity-signal-catalog.js'
import {
  boundedInputBytes,
  boundedRuntimeBytes,
  isApprovedCatalogRuntime,
  isEvaluationContextRuntime,
  isIdentitySignalCandidateRuntime,
  isOpaqueIdentityReference,
  parseCanonicalIdentityTimestamp,
} from './identity-signal-runtime.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000
const TEN_MINUTES_MS = 10 * 60 * 1000

const RULE_MAX_EVIDENCE_AGE_HOURS: Readonly<Record<IdentitySignalRuleId, number>> = Object.freeze({
  'HV-ID-EXP-001.v1': 36,
  'HV-ID-EXP-002.v1': 36,
  'HV-ID-EXP-003.v1': 36,
  'HV-ID-CHG-001.v1': 24,
  'HV-ID-CHG-002.v1': 36,
  'HV-ID-CHG-003.v1': 2,
  'HV-ID-CHG-004.v1': 2,
  'HV-ID-CHG-005.v1': 36,
  'HV-ID-APP-001.v1': 36,
  'HV-ID-APP-002.v1': 36,
  'HV-ID-MBX-001.v1': 36,
  'HV-ID-MBX-002.v1': 36,
  'HV-ID-MBX-003.v1': 2,
  'HV-ID-AUTH-001.v1': 36,
  'HV-ID-AUTH-002.v1': 2,
  'HV-ID-AUTH-003.v1': 2,
  'HV-ID-AUTH-004.v1': 2,
  'HV-ID-AUTH-005.v1': 2,
  'HV-ID-AUTH-006.v1': 2,
  'HV-ID-AUTH-007.v1': 36,
  'HV-ID-AUTH-008.v1': 2,
  'HV-ID-AUTH-009.v1': 2,
})

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => bytewiseCompare(left, right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  )
}

export function computeIdentitySignalCatalogDigest(catalog: Omit<ApprovedCatalog, 'digest'>): string {
  const { digest: _topLevelSignature, ...unsignedCatalog } = catalog as Omit<ApprovedCatalog, 'digest'> & { digest?: unknown }
  return createHash('sha256').update(JSON.stringify(canonicalize(unsignedCatalog))).digest('hex')
}

function parseTime(value: string): number | null {
  return parseCanonicalIdentityTimestamp(value)
}

function bytewiseCompare(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function sortedUnique<Value extends string>(values: readonly Value[]): Value[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))].sort(bytewiseCompare)
}

function projectedSubject(candidate: IdentitySignalCandidate) {
  return Object.freeze({
    ...candidate.subject,
    opaqueId: isOpaqueIdentityReference(candidate.subject.opaqueId)
      ? candidate.subject.opaqueId
      : 'INVALID_SUBJECT_REFERENCE',
  })
}

function operationalNotEvaluated(reason: Extract<IdentitySignalReasonCode, 'EVIDENCE_MALFORMED' | 'RULE_CONFIG_UNAPPROVED' | 'EVALUATION_BUDGET_EXCEEDED'>): IdentitySignalResult {
  return Object.freeze({
    engineVersion: IDENTITY_RISK_ENGINE_VERSION,
    catalogVersion: IDENTITY_SIGNAL_CATALOG_VERSION,
    channel: IDENTITY_SIGNAL_CHANNEL,
    ruleId: null,
    subject: Object.freeze({ type: 'SOURCE', opaqueId: 'EVALUATION_INPUT' }),
    status: 'NOT_EVALUATED',
    severity: null,
    confidence: null,
    coverage: 'UNAVAILABLE',
    reasonCodes: Object.freeze([reason]),
    evidenceReferences: Object.freeze([]),
    sourceLabels: Object.freeze([]),
    titleCode: 'IDENTITY_SIGNAL_EVALUATION_UNAVAILABLE',
    explanationCode: 'IDENTITY_SIGNAL_NOT_EVALUATED',
    investigationGuidanceCode: null,
    benignAlternativeCodes: Object.freeze([]),
  })
}

function result(
  candidate: IdentitySignalCandidate,
  values: Pick<IdentitySignalResult, 'status' | 'severity' | 'confidence' | 'coverage' | 'reasonCodes' | 'explanationCode' | 'benignAlternativeCodes'>,
): IdentitySignalResult {
  const output: IdentitySignalResult = {
    engineVersion: IDENTITY_RISK_ENGINE_VERSION,
    catalogVersion: IDENTITY_SIGNAL_CATALOG_VERSION,
    channel: IDENTITY_SIGNAL_CHANNEL,
    ruleId: candidate.ruleId,
    subject: projectedSubject(candidate),
    status: values.status,
    severity: values.severity,
    confidence: values.confidence,
    coverage: values.coverage,
    reasonCodes: Object.freeze(sortedUnique(values.reasonCodes)),
    evidenceReferences: Object.freeze(values.status === 'MATCHED' ? sortedUnique(candidate.evidenceReferences) : []),
    sourceLabels: Object.freeze(values.status === 'MATCHED' ? [...identitySignalRuleDefinition(candidate.ruleId).sourceLabels] : []),
    titleCode: identitySignalRuleDefinition(candidate.ruleId).titleCode,
    explanationCode: values.explanationCode,
    investigationGuidanceCode: values.status === 'MATCHED' ? 'REVIEW_IDENTITY_SIGNAL_EVIDENCE' : null,
    benignAlternativeCodes: Object.freeze([...values.benignAlternativeCodes].sort()),
  }
  return Object.freeze(output)
}

function notEvaluated(candidate: IdentitySignalCandidate, reason: IdentitySignalReasonCode, coverage: 'PARTIAL' | 'UNAVAILABLE' = 'UNAVAILABLE') {
  return result(candidate, {
    status: 'NOT_EVALUATED', severity: null, confidence: null, coverage,
    reasonCodes: [reason], explanationCode: 'IDENTITY_SIGNAL_NOT_EVALUATED', benignAlternativeCodes: [],
  })
}

function notMatched(candidate: IdentitySignalCandidate) {
  return result(candidate, {
    status: 'NOT_MATCHED', severity: null, confidence: null, coverage: 'FULL',
    reasonCodes: ['NO_MATCH'], explanationCode: 'IDENTITY_SIGNAL_CONDITION_NOT_OBSERVED', benignAlternativeCodes: [],
  })
}

function matched(
  candidate: IdentitySignalCandidate,
  severity: IdentitySignalSeverity,
  explanationCode: string,
  benignAlternativeCodes: readonly string[],
  confidence: IdentitySignalConfidence = 'HIGH',
) {
  return result(candidate, {
    status: 'MATCHED', severity, confidence, coverage: 'FULL',
    reasonCodes: ['RULE_MATCHED'], explanationCode, benignAlternativeCodes,
  })
}

function suppressed(candidate: IdentitySignalCandidate, reason: Extract<IdentitySignalReasonCode, 'APPROVED_SHARED_CONTEXT' | 'EXPECTED_AUTH_RETRY' | 'APPROVED_TRAVEL_EXCEPTION' | 'APPROVED_MAINTENANCE_WINDOW'>) {
  return result(candidate, {
    status: 'SUPPRESSED', severity: null, confidence: null, coverage: 'FULL',
    reasonCodes: [reason], explanationCode: 'IDENTITY_SIGNAL_SUPPRESSED_BY_APPROVED_CONTEXT', benignAlternativeCodes: [],
  })
}

function catalogFor(context: IdentitySignalEvaluationContext, catalogType: CatalogType): ApprovedCatalog | null {
  const now = parseTime(context.evaluatedAt)
  if (now === null) return null
  const catalog = context.catalogs?.find((entry) => entry.catalogType === catalogType)
  if (!catalog || !isApprovedCatalogRuntime(catalog) || catalog.status !== 'APPROVED') return null
  const approvers = new Set(catalog.approverIds.filter(Boolean))
  if (approvers.size < 2) return null
  const normalizedValues = sortedUnique(catalog.values.map((value) => value.trim().toLowerCase()).filter(Boolean))
  if (JSON.stringify(catalog.values) !== JSON.stringify(normalizedValues)) return null
  const entries = catalog.contextEntries ?? []
  if (entries.length !== new Set(entries.map((entry) => entry.id)).size || entries.some((entry) => !validContextEntry(entry))) return null
  const effectiveAt = parseTime(catalog.effectiveAt)
  const expiresAt = catalog.expiresAt ? parseTime(catalog.expiresAt) : null
  if (effectiveAt === null || effectiveAt > now || (catalog.expiresAt && (expiresAt === null || expiresAt <= now))) return null
  const expected = computeIdentitySignalCatalogDigest({
    catalogType: catalog.catalogType,
    version: catalog.version,
    status: catalog.status,
    approverIds: catalog.approverIds,
    effectiveAt: catalog.effectiveAt,
    expiresAt: catalog.expiresAt,
    values: catalog.values,
    accountClasses: catalog.accountClasses,
    contextEntries: catalog.contextEntries,
  })
  return expected === catalog.digest.toLowerCase() ? catalog : null
}

function validContextEntry(entry: NetworkContextEntry) {
  const start = parseTime(entry.startsAt)
  const end = parseTime(entry.expiresAt)
  if (!entry.id || start === null || end === null || start >= end) return false
  if (entry.type === 'SHARED_EGRESS') return Boolean(entry.sourceFingerprint)
  if (entry.type === 'SHARED_DEVICE') return Boolean(entry.deviceFingerprint)
  if (entry.type === 'EXPECTED_AUTH_RETRY') return Boolean(entry.subjectId)
  if (entry.type === 'TRAVEL_EXCEPTION') return Boolean(entry.subjectId && entry.sourceFingerprint)
  return Boolean(entry.subjectId)
}

function normalizedCatalogValues(catalog: ApprovedCatalog) {
  return new Set(catalog.values.map((value) => value.trim().toLowerCase()).filter(Boolean))
}

function accountClass(context: IdentitySignalEvaluationContext, subjectId: string): AccountClass {
  return catalogFor(context, 'ACCOUNT_CLASS')?.accountClasses?.[subjectId] ?? 'UNKNOWN'
}

function contextEntries(context: IdentitySignalEvaluationContext, type: NetworkContextEntry['type']) {
  const now = parseTime(context.evaluatedAt)
  if (now === null) return []
  return (catalogFor(context, 'NETWORK_CONTEXT')?.contextEntries ?? [])
    .filter((entry) => entry.type === type)
    .filter((entry) => {
      const start = parseTime(entry.startsAt)
      const end = parseTime(entry.expiresAt)
      return start !== null && end !== null && start <= now && now < end
    })
    .sort((left, right) => bytewiseCompare(left.id, right.id))
}

function exactContextMatch(entry: NetworkContextEntry, values: {
  subjectId?: string
  appId?: string
  client?: string
  deviceFingerprint?: string
  sourceFingerprint?: string
}) {
  return (!entry.subjectId || entry.subjectId === values.subjectId) &&
    (!entry.appId || entry.appId.toLowerCase() === values.appId?.toLowerCase()) &&
    (!entry.client || entry.client.toLowerCase() === values.client?.toLowerCase()) &&
    (!entry.deviceFingerprint || entry.deviceFingerprint === values.deviceFingerprint) &&
    (!entry.sourceFingerprint || entry.sourceFingerprint === values.sourceFingerprint)
}

function contextCoversEvents(entry: NetworkContextEntry, events: readonly AuthEvent[]) {
  const start = parseTime(entry.startsAt)
  const end = parseTime(entry.expiresAt)
  const times = events.map((event) => parseTime(event.occurredAt))
  return start !== null && end !== null && times.every((time) => time !== null && start <= time && time < end)
}

function semanticTimestamps(candidate: IdentitySignalCandidate): readonly string[] {
  switch (candidate.ruleId) {
    case 'HV-ID-EXP-001.v1':
    case 'HV-ID-EXP-002.v1':
    case 'HV-ID-CHG-004.v1':
    case 'HV-ID-CHG-005.v1':
    case 'HV-ID-APP-002.v1':
    case 'HV-ID-MBX-001.v1':
    case 'HV-ID-MBX-002.v1':
    case 'HV-ID-AUTH-003.v1':
    case 'HV-ID-AUTH-007.v1':
      return []
    case 'HV-ID-EXP-003.v1':
      return candidate.lastSuccessfulInteractiveSignInAt ? [candidate.lastSuccessfulInteractiveSignInAt] : []
    case 'HV-ID-CHG-001.v1':
      return [candidate.lifecycleAt, candidate.privilegeAt]
    case 'HV-ID-CHG-002.v1':
      return [...(candidate.authoritativeCreatedAt ? [candidate.authoritativeCreatedAt] : []), candidate.privilegeAt]
    case 'HV-ID-CHG-003.v1':
      return [candidate.anchorAt, ...candidate.events.map((event) => event.occurredAt)]
    case 'HV-ID-APP-001.v1':
      return [...(candidate.authoritativeCreatedAt ? [candidate.authoritativeCreatedAt] : []), candidate.observedAt]
    case 'HV-ID-MBX-003.v1':
      return [candidate.mailboxChangeAt, candidate.independentSignInAt]
    case 'HV-ID-AUTH-001.v1':
      return [candidate.disabledAt, candidate.activityAt]
    case 'HV-ID-AUTH-002.v1':
      return [candidate.eventAt, ...(candidate.lastSuccessfulInteractiveSignInAt ? [candidate.lastSuccessfulInteractiveSignInAt] : [])]
    case 'HV-ID-AUTH-004.v1':
      return [candidate.previous.occurredAt, candidate.current.occurredAt]
    case 'HV-ID-AUTH-005.v1':
    case 'HV-ID-AUTH-006.v1':
    case 'HV-ID-AUTH-008.v1':
      return candidate.events.map((event) => event.occurredAt)
    case 'HV-ID-AUTH-009.v1':
      return [candidate.occurredAt]
  }
}

function gate(context: IdentitySignalEvaluationContext, candidate: IdentitySignalCandidate): IdentitySignalResult | null {
  if (context.engineVersion !== IDENTITY_RISK_ENGINE_VERSION || context.catalogVersion !== IDENTITY_SIGNAL_CATALOG_VERSION) {
    return notEvaluated(candidate, 'RULE_CONFIG_UNAPPROVED')
  }
  if (context.featureFlags?.[candidate.ruleId] !== true) return notEvaluated(candidate, 'RULE_FEATURE_DISABLED')
  if (context.readiness !== 'READY' || candidate.evidenceState === 'UNAVAILABLE') return notEvaluated(candidate, 'EVIDENCE_UNAVAILABLE')
  if (context.capability === 'UNAVAILABLE') return notEvaluated(candidate, 'EVIDENCE_UNAVAILABLE')
  const definition = identitySignalRuleDefinition(candidate.ruleId)
  if (context.capability === 'PARTIAL' || candidate.evidenceState === 'PARTIAL' || ((candidate.requiresFullCapability || definition.requiresFullCapability) && context.capability !== 'FULL')) {
    return notEvaluated(candidate, 'EVIDENCE_PARTIAL', 'PARTIAL')
  }
  if (candidate.evidenceState === 'CAPPED') return notEvaluated(candidate, 'EVIDENCE_CAPPED', 'PARTIAL')
  if (candidate.evidenceState === 'MALFORMED') return notEvaluated(candidate, 'EVIDENCE_MALFORMED')
  const now = parseTime(context.evaluatedAt)
  if (now === null || context.futureClockSkewToleranceMs === null || !Number.isInteger(context.futureClockSkewToleranceMs) || context.futureClockSkewToleranceMs < 0 || context.futureClockSkewToleranceMs > 300_000) {
    return notEvaluated(candidate, 'RULE_CONFIG_UNAPPROVED')
  }
  for (const timestamp of semanticTimestamps(candidate)) {
    const parsed = parseTime(timestamp)
    if (parsed === null) return notEvaluated(candidate, 'EVIDENCE_MALFORMED')
    if (parsed > now + context.futureClockSkewToleranceMs) return notEvaluated(candidate, 'EVIDENCE_FUTURE_DATED')
  }
  const maximum = RULE_MAX_EVIDENCE_AGE_HOURS[candidate.ruleId]
  if (candidate.evidence.length === 0) return notEvaluated(candidate, 'EVIDENCE_UNAVAILABLE')
  for (const evidence of candidate.evidence) {
    const observedAt = parseTime(evidence.observedAt)
    if (observedAt === null || !Number.isFinite(evidence.maxAgeHours) || evidence.maxAgeHours <= 0 || evidence.maxAgeHours > maximum) {
      return notEvaluated(candidate, 'EVIDENCE_MALFORMED')
    }
    if (observedAt > now + context.futureClockSkewToleranceMs) return notEvaluated(candidate, 'EVIDENCE_FUTURE_DATED')
    if (now - observedAt > evidence.maxAgeHours * HOUR_MS) return notEvaluated(candidate, 'EVIDENCE_STALE', 'PARTIAL')
  }
  for (const requiredCatalog of definition.requiredCatalogs) {
    if (!catalogFor(context, requiredCatalog)) return notEvaluated(candidate, 'RULE_CONFIG_UNAPPROVED')
  }
  return null
}

function baselineIsMature(baseline: BehaviorBaseline, classification: AccountClass) {
  if (baseline.status !== 'MATURE') return false
  const requiredDays = classification === 'PRIVILEGED_HUMAN' ? 14 : 7
  return baseline.activeDays >= requiredDays && baseline.successfulInteractiveSignIns >= 20
}

function requireHumanClass(context: IdentitySignalEvaluationContext, candidate: IdentitySignalCandidate) {
  const classification = accountClass(context, candidate.subject.opaqueId)
  if (classification === 'UNKNOWN') return { classification, failure: notEvaluated(candidate, 'ACCOUNT_CLASS_UNVERIFIED') }
  if (classification === 'SERVICE' || classification === 'SHARED' || classification === 'BREAK_GLASS') {
    return { classification, failure: notEvaluated(candidate, 'ACCOUNT_CLASS_UNSUPPORTED') }
  }
  return { classification, failure: null }
}

function timeWithin(value: string, startExclusive: number, endInclusive: number) {
  const time = parseTime(value)
  return time !== null && time > startExclusive && time <= endInclusive
}

function hasEventSequence(events: readonly AuthEvent[], failureKinds: readonly AuthEvent['outcome'][], threshold: number) {
  const ordered = [...events].sort((left, right) => {
    const time = (parseTime(left.occurredAt) ?? 0) - (parseTime(right.occurredAt) ?? 0)
    return time || bytewiseCompare(left.id, right.id)
  })
  const distinct = [...new Map(ordered.map((entry) => [entry.id, entry])).values()]
  for (const success of distinct.filter((entry) => entry.outcome === 'SUCCESS')) {
    const successAt = parseTime(success.occurredAt)
    if (successAt === null) continue
    const candidates = distinct.filter((entry) => failureKinds.includes(entry.outcome) && timeWithin(entry.occurredAt, successAt - 25 * 60 * 1000, successAt))
    for (const anchor of candidates) {
      const anchorAt = parseTime(anchor.occurredAt)
      if (anchorAt === null || successAt <= anchorAt || successAt > anchorAt + 25 * 60 * 1000) continue
      const failures = candidates.filter((entry) => timeWithin(entry.occurredAt, anchorAt - 1, anchorAt + TEN_MINUTES_MS))
      if (failures.length >= threshold && successAt <= (parseTime(failures.at(-1)?.occurredAt ?? '') ?? 0) + FIFTEEN_MINUTES_MS) {
        return { matched: true, failures, success }
      }
    }
  }
  return { matched: false, failures: [] as AuthEvent[], success: null }
}

function externalDomain(address: string): string | null {
  const at = address.lastIndexOf('@')
  if (at <= 0 || at === address.length - 1) return null
  const ascii = domainToASCII(address.slice(at + 1).trim().toLowerCase())
  return ascii && !ascii.includes('@') ? ascii : null
}

function oneBandHigher(value: Exclude<IdentitySignalSeverity, 'CRITICAL'>): IdentitySignalSeverity {
  if (value === 'LOW') return 'MEDIUM'
  if (value === 'MEDIUM') return 'HIGH'
  return 'CRITICAL'
}

function haversineKm(left: { latitude: number; longitude: number }, right: { latitude: number; longitude: number }) {
  const radians = (degrees: number) => degrees * Math.PI / 180
  const latitudeDelta = radians(right.latitude - left.latitude)
  const longitudeDelta = radians(right.longitude - left.longitude)
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(longitudeDelta / 2) ** 2
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function evaluateValidatedIdentitySignal(
  context: IdentitySignalEvaluationContext,
  candidate: IdentitySignalCandidate,
): IdentitySignalResult {
  const blocked = gate(context, candidate)
  if (blocked) return blocked

  switch (candidate.ruleId) {
    case 'HV-ID-EXP-001.v1':
      if (candidate.effectiveMfa === 'UNKNOWN') return notEvaluated(candidate, 'EVIDENCE_UNAVAILABLE')
      return candidate.enabled && candidate.privileged && candidate.effectiveMfa === 'NOT_ENFORCED'
        ? matched(candidate, 'MEDIUM', 'PRIVILEGED_IDENTITY_LACKS_VERIFIED_EFFECTIVE_MFA', ['APPROVED_TEMPORARY_MFA_EXCEPTION'])
        : notMatched(candidate)
    case 'HV-ID-EXP-002.v1':
      if (candidate.userType === 'UNKNOWN') return notEvaluated(candidate, 'EVIDENCE_UNAVAILABLE')
      return candidate.enabled && candidate.privileged && candidate.userType === 'GUEST'
        ? matched(candidate, 'MEDIUM', 'ENABLED_PRIVILEGED_GUEST_IDENTITY', ['APPROVED_TEMPORARY_GUEST_ACCESS'])
        : notMatched(candidate)
    case 'HV-ID-EXP-003.v1': {
      const classification = accountClass(context, candidate.subject.opaqueId)
      if (!baselineIsMature(candidate.baseline, classification)) return notEvaluated(candidate, 'BASELINE_LEARNING', 'PARTIAL')
      const last = candidate.lastSuccessfulInteractiveSignInAt ? parseTime(candidate.lastSuccessfulInteractiveSignInAt) : null
      const now = parseTime(context.evaluatedAt)!
      return candidate.enabled && candidate.privileged && (last === null || now - last >= 45 * DAY_MS)
        ? matched(candidate, 'MEDIUM', 'ENABLED_DORMANT_PRIVILEGED_IDENTITY', ['APPROVED_DORMANT_EMERGENCY_ACCOUNT'])
        : notMatched(candidate)
    }
    case 'HV-ID-CHG-001.v1': {
      const operations = normalizedCatalogValues(catalogFor(context, 'PRIVILEGED_ROLE_GROUP')!)
      const lifecycle = parseTime(candidate.lifecycleAt)
      const privilege = parseTime(candidate.privilegeAt)
      if (lifecycle === null || privilege === null) return notEvaluated(candidate, 'EVIDENCE_MALFORMED')
      return candidate.privilegeSucceeded && operations.has(candidate.privilegeOperation.toLowerCase()) && privilege >= lifecycle && privilege < lifecycle + DAY_MS
        ? matched(candidate, 'HIGH', 'NEW_OR_REENABLED_IDENTITY_RECEIVED_PRIVILEGE', ['APPROVED_ACCOUNT_PROVISIONING'])
        : notMatched(candidate)
    }
    case 'HV-ID-CHG-002.v1': {
      const operations = normalizedCatalogValues(catalogFor(context, 'PRIVILEGED_ROLE_GROUP')!)
      const privilege = parseTime(candidate.privilegeAt)
      const created = candidate.authoritativeCreatedAt ? parseTime(candidate.authoritativeCreatedAt) : null
      if (privilege === null || (candidate.authoritativeCreatedAt && created === null)) return notEvaluated(candidate, 'EVIDENCE_MALFORMED')
      const newIdentity = created !== null && privilege >= created && privilege - created < 7 * DAY_MS
      return candidate.privilegeSucceeded && operations.has(candidate.privilegeOperation.toLowerCase()) && (candidate.userType === 'GUEST' || newIdentity)
        ? matched(candidate, 'HIGH', 'GUEST_OR_NEW_IDENTITY_RECEIVED_PRIVILEGE', ['APPROVED_TEMPORARY_ACCESS', 'APPROVED_ACCOUNT_PROVISIONING'])
        : notMatched(candidate)
    }
    case 'HV-ID-CHG-003.v1': {
      const approved = normalizedCatalogValues(catalogFor(context, 'HIGH_IMPACT_OPERATION')!)
      const anchor = parseTime(candidate.anchorAt)
      if (anchor === null) return notEvaluated(candidate, 'EVIDENCE_MALFORMED')
      const events = new Map(candidate.events
        .filter((entry) => entry.succeeded && entry.actorId === candidate.actorId && approved.has(entry.operation.toLowerCase()))
        .filter((entry) => timeWithin(entry.occurredAt, anchor - FIFTEEN_MINUTES_MS, anchor))
        .map((entry) => [entry.id, entry]))
      return events.size >= 5
        ? matched(candidate, 'MEDIUM', 'BURST_OF_PRIVILEGED_ADMINISTRATIVE_CHANGES', ['APPROVED_MAINTENANCE_ACTIVITY'], 'MEDIUM')
        : notMatched(candidate)
    }
    case 'HV-ID-CHG-004.v1': {
      const approved = normalizedCatalogValues(catalogFor(context, 'HIGH_IMPACT_OPERATION')!)
      const mature = candidate.baselineActiveDays >= 30 && candidate.actorBaselineEvents >= 20 && candidate.tenantBaselineEvents >= 100
      if (!mature) return notEvaluated(candidate, 'BASELINE_LEARNING', 'PARTIAL')
      return candidate.succeeded && approved.has(candidate.operation.toLowerCase()) && candidate.actorOperationCount === 0 && candidate.tenantOperationCount <= 2
        ? matched(candidate, 'MEDIUM', 'UNUSUAL_PRIVILEGED_CHANGE_FOR_ACTOR', ['APPROVED_RARE_ADMINISTRATIVE_TASK'], 'MEDIUM')
        : notMatched(candidate)
    }
    case 'HV-ID-CHG-005.v1': {
      if (!candidate.succeeded) return notMatched(candidate)
      const weakened = candidate.change === 'SECURITY_DEFAULTS'
        ? candidate.before === true && candidate.after === false
        : candidate.change === 'MFA_POLICY'
          ? candidate.before === 'enabled' && (candidate.after === 'reportOnly' || candidate.after === 'disabled')
          : candidate.before === 'present' && candidate.after === 'absent'
      return weakened
        ? matched(candidate, 'HIGH', 'IDENTITY_PROTECTION_CONFIGURATION_WEAKENED', ['APPROVED_POLICY_CHANGE'])
        : notMatched(candidate)
    }
    case 'HV-ID-APP-001.v1': {
      const catalog = normalizedCatalogValues(catalogFor(context, 'HIGH_IMPACT_APPLICATION_PERMISSION')!)
      const created = candidate.authoritativeCreatedAt ? parseTime(candidate.authoritativeCreatedAt) : null
      const observed = parseTime(candidate.observedAt)
      if (created === null || observed === null) return notEvaluated(candidate, 'EVIDENCE_UNAVAILABLE')
      const newApplication = observed >= created && observed - created <= DAY_MS
      return newApplication && candidate.declaredPermissions.some((permission) => catalog.has(permission.toLowerCase()))
        ? matched(candidate, 'MEDIUM', 'NEW_APPLICATION_DECLARES_HIGH_IMPACT_PERMISSION', ['APPROVED_APPLICATION_ROLLOUT'], 'MEDIUM')
        : notMatched(candidate)
    }
    case 'HV-ID-APP-002.v1': {
      const catalog = normalizedCatalogValues(catalogFor(context, 'HIGH_IMPACT_APPLICATION_PERMISSION')!)
      return candidate.applicationPermissionIds.some((permission) => catalog.has(permission.toLowerCase())) && candidate.credentialMetadataChanged && candidate.authoritativeComparable && candidate.succeeded
        ? matched(candidate, 'MEDIUM', 'HIGH_IMPACT_APPLICATION_CREDENTIAL_METADATA_CHANGED', ['APPROVED_CREDENTIAL_ROTATION'], 'MEDIUM')
        : notMatched(candidate)
    }
    case 'HV-ID-MBX-001.v1': {
      const domains = candidate.verifiedAcceptedDomains.map((value) => domainToASCII(value.trim().toLowerCase())).filter(Boolean)
      if (domains.length !== candidate.verifiedAcceptedDomains.length || domains.length === 0) return notEvaluated(candidate, 'IDENTIFIER_DOMAIN_UNVERIFIED')
      const recipients = candidate.recipientAddresses.map(externalDomain)
      if (recipients.some((value) => value === null)) return notEvaluated(candidate, 'EVIDENCE_MALFORMED')
      return candidate.enabled && recipients.some((value) => !domains.includes(value!))
        ? matched(candidate, 'HIGH', 'ENABLED_MAILBOX_RULE_FORWARDS_OR_REDIRECTS_EXTERNALLY', ['APPROVED_EXTERNAL_FORWARDING'])
        : notMatched(candidate)
    }
    case 'HV-ID-MBX-002.v1': {
      if (candidate.conditionsCompleteness !== 'COMPLETE' || candidate.actionsCompleteness !== 'COMPLETE') {
        return notEvaluated(candidate, 'MAILBOX_RULE_PROJECTION_INCOMPLETE', 'PARTIAL')
      }
      const destructive = candidate.actions.delete || candidate.actions.permanentDelete || candidate.actions.moveTarget
      const concealment = candidate.actions.markAsRead || candidate.actions.stopProcessing
      return candidate.enabled && candidate.populatedConditionCount === 0 && candidate.populatedExceptionCount === 0 && destructive && concealment
        ? matched(candidate, 'MEDIUM', 'MATCH_ALL_MAILBOX_RULE_CONCEALS_MESSAGES', ['APPROVED_MAILBOX_AUTOMATION'], 'MEDIUM')
        : notMatched(candidate)
    }
    case 'HV-ID-MBX-003.v1': {
      if (!candidate.projectionComplete) return notEvaluated(candidate, 'MAILBOX_RULE_PROJECTION_INCOMPLETE', 'PARTIAL')
      const change = parseTime(candidate.mailboxChangeAt)
      const signIn = parseTime(candidate.independentSignInAt)
      const independent = candidate.independentSignInRuleId.startsWith('HV-ID-AUTH-')
      return change !== null && signIn !== null && independent && change >= signIn && change < signIn + 2 * HOUR_MS
        ? matched(candidate, oneBandHigher(candidate.baseSeverity), 'MAILBOX_RULE_CHANGED_AFTER_INDEPENDENT_AUTHENTICATION_SIGNAL', ['APPROVED_MAILBOX_CHANGE_AFTER_SIGN_IN'])
        : notMatched(candidate)
    }
    case 'HV-ID-AUTH-001.v1': {
      const disabled = parseTime(candidate.disabledAt)
      const activity = parseTime(candidate.activityAt)
      if (disabled === null || activity === null) return notEvaluated(candidate, 'EVIDENCE_MALFORMED')
      return activity > disabled
        ? matched(candidate, candidate.outcome === 'SUCCESS' ? 'HIGH' : 'MEDIUM', 'AUTHENTICATION_ACTIVITY_AFTER_ACCOUNT_DISABLE', ['DELAYED_DIRECTORY_STATE'])
        : notMatched(candidate)
    }
    case 'HV-ID-AUTH-002.v1': {
      const classification = requireHumanClass(context, candidate)
      if (classification.failure) return classification.failure
      if (!baselineIsMature(candidate.baseline, classification.classification)) return notEvaluated(candidate, 'BASELINE_LEARNING', 'PARTIAL')
      const event = parseTime(candidate.eventAt)
      const last = candidate.lastSuccessfulInteractiveSignInAt ? parseTime(candidate.lastSuccessfulInteractiveSignInAt) : null
      if (event === null || (candidate.lastSuccessfulInteractiveSignInAt && last === null)) return notEvaluated(candidate, 'EVIDENCE_MALFORMED')
      return candidate.successfulInteractive && (last === null || event - last >= 45 * DAY_MS)
        ? matched(candidate, 'MEDIUM', 'SUCCESSFUL_INTERACTIVE_SIGN_IN_AFTER_DORMANCY', ['APPROVED_ACCOUNT_REACTIVATION'], 'MEDIUM')
        : notMatched(candidate)
    }
    case 'HV-ID-AUTH-003.v1': {
      const classification = requireHumanClass(context, candidate)
      if (classification.failure) return classification.failure
      if (!baselineIsMature(candidate.baseline, classification.classification)) return notEvaluated(candidate, 'BASELINE_LEARNING', 'PARTIAL')
      const properties: Array<[string, string | number | undefined]> = [
        ['country', candidate.properties.country?.toUpperCase()], ['asn', candidate.properties.asn],
        ['device', candidate.properties.device], ['client', candidate.properties.client?.toLowerCase()], ['app', candidate.properties.app?.toLowerCase()],
      ]
      const usable = properties.filter(([, value]) => value !== undefined && value !== '')
      if (usable.length < 3) return notEvaluated(candidate, 'INSUFFICIENT_INDEPENDENT_CONTEXT', 'PARTIAL')
      const unfamiliarBefore = usable.filter(([key, value]) => {
        const familiarity = candidate.baseline.propertyFrequency?.[`${key}:${String(value)}`]
        return !familiarity || familiarity.events < 5 || familiarity.days < 3
      })
      const sharedEgress = contextEntries(context, 'SHARED_EGRESS').some((entry) => exactContextMatch(entry, { sourceFingerprint: candidate.sourceFingerprint }))
      const sharedDevice = contextEntries(context, 'SHARED_DEVICE').some((entry) => exactContextMatch(entry, { deviceFingerprint: candidate.properties.device }))
      const remaining = usable.filter(([key]) => !(sharedEgress && (key === 'country' || key === 'asn')) && !(sharedDevice && key === 'device'))
      if (remaining.length < 3) return notEvaluated(candidate, 'INSUFFICIENT_INDEPENDENT_CONTEXT', 'PARTIAL')
      const unfamiliarAfter = unfamiliarBefore.filter(([key]) => remaining.some(([remainingKey]) => remainingKey === key))
      if (unfamiliarBefore.length >= 2 && unfamiliarAfter.length < 2) return suppressed(candidate, 'APPROVED_SHARED_CONTEXT')
      return unfamiliarAfter.length >= 2
        ? matched(candidate, 'MEDIUM', 'MULTIPLE_UNFAMILIAR_SIGN_IN_PROPERTY_GROUPS', ['APPROVED_TRAVEL_OR_NETWORK_CHANGE'], 'MEDIUM')
        : unfamiliarAfter.length === 1
          ? matched(candidate, 'LOW', 'ONE_UNFAMILIAR_SIGN_IN_PROPERTY_GROUP', ['NORMAL_PROPERTY_CHANGE'], 'LOW')
          : notMatched(candidate)
    }
    case 'HV-ID-AUTH-004.v1': {
      if (!baselineIsMature(candidate.baseline, 'HUMAN')) return notEvaluated(candidate, 'BASELINE_LEARNING', 'PARTIAL')
      const previous = parseTime(candidate.previous.occurredAt)
      const current = parseTime(candidate.current.occurredAt)
      const coordinatesValid = [candidate.previous, candidate.current].every((entry) =>
        Number.isFinite(entry.latitude) && Number.isFinite(entry.longitude) &&
        entry.latitude >= -90 && entry.latitude <= 90 && entry.longitude >= -180 && entry.longitude <= 180)
      if (previous === null || current === null || !coordinatesValid) {
        return notEvaluated(candidate, 'EVIDENCE_MALFORMED')
      }
      const elapsedHours = (current - previous) / HOUR_MS
      if (elapsedHours <= 0 || elapsedHours > 24) return notEvaluated(candidate, 'EVIDENCE_MALFORMED')
      const distance = haversineKm(candidate.previous, candidate.current)
      if (distance < 500 || distance / elapsedHours <= 900) return notMatched(candidate)
      const exception = contextEntries(context, 'TRAVEL_EXCEPTION').some((entry) =>
        exactContextMatch(entry, { subjectId: candidate.subject.opaqueId, sourceFingerprint: candidate.current.sourceFingerprint }) ||
        exactContextMatch(entry, { subjectId: candidate.subject.opaqueId, sourceFingerprint: candidate.previous.sourceFingerprint }))
      const sharedEgress = contextEntries(context, 'SHARED_EGRESS').some((entry) =>
        exactContextMatch(entry, { sourceFingerprint: candidate.current.sourceFingerprint }) ||
        exactContextMatch(entry, { sourceFingerprint: candidate.previous.sourceFingerprint }))
      return exception || sharedEgress
        ? suppressed(candidate, 'APPROVED_TRAVEL_EXCEPTION')
        : matched(candidate, 'MEDIUM', 'SIGN_IN_TRAVEL_SPEED_EXCEEDS_THRESHOLD', ['VPN_NAT_MOBILE_OR_LEGITIMATE_TRAVEL'], 'MEDIUM')
    }
    case 'HV-ID-AUTH-005.v1': {
      const classification = requireHumanClass(context, candidate)
      if (classification.failure) return classification.failure
      const subjectEvents = candidate.events.filter((event) => event.subjectId === candidate.subject.opaqueId)
      const sequence = hasEventSequence(subjectEvents, ['FAILURE'], 10)
      if (!sequence.matched || !sequence.success) return notMatched(candidate)
      const expected = contextEntries(context, 'EXPECTED_AUTH_RETRY').some((entry) =>
        contextCoversEvents(entry, [sequence.success!, ...sequence.failures]) &&
        [sequence.success!, ...sequence.failures].every((event) => exactContextMatch(entry, {
          subjectId: event.subjectId, appId: event.appId, client: event.client,
          deviceFingerprint: event.deviceFingerprint, sourceFingerprint: event.sourceFingerprint,
        })))
      return expected
        ? suppressed(candidate, 'EXPECTED_AUTH_RETRY')
        : matched(candidate, 'MEDIUM', 'FAILURE_BURST_FOLLOWED_BY_SUCCESS', ['USER_MISTAKES_OR_HEALTH_CHECKS'], 'MEDIUM')
    }
    case 'HV-ID-AUTH-006.v1': {
      if (!candidate.normalizedMfaDetailComplete) return notEvaluated(candidate, 'EVIDENCE_PARTIAL', 'PARTIAL')
      const sequence = hasEventSequence(candidate.events.filter((event) => event.subjectId === candidate.subject.opaqueId), ['MFA_DENIED', 'MFA_TIMEOUT'], 3)
      return sequence.matched
        ? matched(candidate, 'HIGH', 'MFA_DENIAL_OR_TIMEOUT_BURST_FOLLOWED_BY_SUCCESS', ['LEGITIMATE_MFA_RETRIES'])
        : notMatched(candidate)
    }
    case 'HV-ID-AUTH-007.v1': {
      const clients = normalizedCatalogValues(catalogFor(context, 'LEGACY_CLIENT')!)
      return candidate.privileged && candidate.succeeded && clients.has(candidate.client.toLowerCase())
        ? matched(candidate, 'HIGH', 'PRIVILEGED_IDENTITY_USED_LEGACY_AUTHENTICATION', ['APPROVED_LEGACY_PROTOCOL_EXCEPTION'])
        : notMatched(candidate)
    }
    case 'HV-ID-AUTH-008.v1': {
      if (!candidate.tenantWideComplete) return notEvaluated(candidate, 'EVIDENCE_PARTIAL', 'PARTIAL')
      const uniqueEvents = [...new Map(candidate.events.map((event) => [event.id, event])).values()]
      const classified = uniqueEvents.map((event) => ({ event, classification: accountClass(context, event.subjectId) }))
      const eligible = classified.filter(({ classification }) => classification === 'HUMAN' || classification === 'PRIVILEGED_HUMAN')
      const failures = eligible.filter(({ event }) => event.outcome === 'FAILURE')
      const successes = eligible.filter(({ event }) => event.outcome === 'SUCCESS')
      const sourceKeys = sortedUnique(failures.map(({ event }) => event.sourceFingerprint ?? (event.sourceAsn === undefined ? '' : `asn:${event.sourceAsn}`)))
      for (const source of sourceKeys) {
        const sourceFailures = failures.filter(({ event }) => (event.sourceFingerprint ?? `asn:${event.sourceAsn}`) === source)
        for (const anchor of sourceFailures) {
          const anchorAt = parseTime(anchor.event.occurredAt)
          if (anchorAt === null) continue
          const windowFailures = sourceFailures.filter(({ event }) => timeWithin(event.occurredAt, anchorAt - 1, anchorAt + TEN_MINUTES_MS))
          const identities = new Set(windowFailures.map(({ event }) => event.subjectId))
          const lastFailure = Math.max(...windowFailures.map(({ event }) => parseTime(event.occurredAt) ?? 0))
          const success = successes.find(({ event }) => identities.has(event.subjectId) && (event.sourceFingerprint ?? `asn:${event.sourceAsn}`) === source && timeWithin(event.occurredAt, lastFailure, lastFailure + FIFTEEN_MINUTES_MS))
          if (windowFailures.length >= 10 && identities.size >= 5 && success) {
            const episodeEvents = [...windowFailures.map(({ event }) => event), success.event]
            const sharedEgress = contextEntries(context, 'SHARED_EGRESS').some((entry) => contextCoversEvents(entry, episodeEvents) && exactContextMatch(entry, { sourceFingerprint: source }))
            const sharedDevice = contextEntries(context, 'SHARED_DEVICE').some((entry) => contextCoversEvents(entry, episodeEvents) && windowFailures.every(({ event }) => exactContextMatch(entry, { deviceFingerprint: event.deviceFingerprint })))
            return sharedEgress || sharedDevice
              ? suppressed(candidate, 'APPROVED_SHARED_CONTEXT')
              : matched(candidate, 'MEDIUM', 'PASSWORD_SPRAY_PATTERN_FOLLOWED_BY_SUCCESS', ['SHARED_EGRESS_OR_HEALTH_CHECKS'], 'MEDIUM')
          }
        }
      }
      const unknown = classified.some(({ classification }) => classification === 'UNKNOWN')
      return unknown ? notEvaluated(candidate, 'ACCOUNT_CLASS_COVERAGE_INCOMPLETE', 'PARTIAL') : notMatched(candidate)
    }
    case 'HV-ID-AUTH-009.v1': {
      const classification = accountClass(context, candidate.subject.opaqueId)
      if (classification === 'UNKNOWN') return notEvaluated(candidate, 'ACCOUNT_CLASS_UNVERIFIED')
      if (classification !== 'BREAK_GLASS') return notEvaluated(candidate, 'ACCOUNT_CLASS_UNSUPPORTED')
      if (!candidate.successfulInteractive) return notMatched(candidate)
      const occurredAt = parseTime(candidate.occurredAt)
      if (occurredAt === null) return notEvaluated(candidate, 'EVIDENCE_MALFORMED')
      const maintenance = contextEntries(context, 'MAINTENANCE').some((entry) => {
        const startsAt = parseTime(entry.startsAt)
        const expiresAt = parseTime(entry.expiresAt)
        return startsAt !== null && expiresAt !== null && startsAt <= occurredAt && occurredAt < expiresAt && exactContextMatch(entry, { subjectId: candidate.subject.opaqueId })
      })
      return maintenance
        ? suppressed(candidate, 'APPROVED_MAINTENANCE_WINDOW')
        : matched(candidate, 'CRITICAL', 'UNEXPECTED_INTERACTIVE_BREAK_GLASS_USE', ['EMERGENCY_USE_OUTSIDE_RECORDED_WINDOW'])
    }
  }
}

export function evaluateIdentitySignal(context: unknown, candidate: unknown): IdentitySignalResult {
  try {
    if (!isEvaluationContextRuntime(context)) return operationalNotEvaluated('RULE_CONFIG_UNAPPROVED')
    if (!isIdentitySignalCandidateRuntime(candidate)) return operationalNotEvaluated('EVIDENCE_MALFORMED')
    return evaluateValidatedIdentitySignal(context, candidate)
  } catch {
    return operationalNotEvaluated('EVIDENCE_MALFORMED')
  }
}

function evaluateIdentitySignalsWithinBoundary(
  context: unknown,
  candidates: readonly unknown[],
): readonly IdentitySignalResult[] {
  if (!Array.isArray(candidates)) return Object.freeze([operationalNotEvaluated('EVIDENCE_MALFORMED')])
  if (candidates.length > IDENTITY_SIGNAL_MAX_BATCH_CANDIDATES) {
    return Object.freeze([operationalNotEvaluated('EVALUATION_BUDGET_EXCEEDED')])
  }
  if (!isEvaluationContextRuntime(context)) return Object.freeze([operationalNotEvaluated('RULE_CONFIG_UNAPPROVED')])
  let inputBytes = boundedInputBytes(context, IDENTITY_SIGNAL_MAX_BATCH_INPUT_BYTES)
  if (inputBytes === null) return Object.freeze([operationalNotEvaluated('EVALUATION_BUDGET_EXCEEDED')])
  for (const candidate of candidates) {
    const candidateBytes = boundedInputBytes(candidate, IDENTITY_SIGNAL_MAX_BATCH_INPUT_BYTES - inputBytes)
    if (candidateBytes === null) return Object.freeze([operationalNotEvaluated('EVALUATION_BUDGET_EXCEEDED')])
    inputBytes += candidateBytes
  }
  const results = candidates.map((candidate) => evaluateIdentitySignal(context, candidate))
  let outputBytes = 0
  for (const output of results) {
    const resultBytes = boundedRuntimeBytes(output, IDENTITY_SIGNAL_MAX_BATCH_OUTPUT_BYTES - outputBytes)
    if (resultBytes === null) return Object.freeze([operationalNotEvaluated('EVALUATION_BUDGET_EXCEEDED')])
    outputBytes += resultBytes
  }
  return Object.freeze(results.sort((left, right) => bytewiseCompare(
    `${left.ruleId ?? ''}:${left.subject.type}:${left.subject.opaqueId}`,
    `${right.ruleId ?? ''}:${right.subject.type}:${right.subject.opaqueId}`,
  )))
}

export function evaluateIdentitySignals(context: unknown, candidates: readonly unknown[]): readonly IdentitySignalResult[] {
  try {
    return evaluateIdentitySignalsWithinBoundary(context, candidates)
  } catch {
    return Object.freeze([operationalNotEvaluated('EVIDENCE_MALFORMED')])
  }
}
