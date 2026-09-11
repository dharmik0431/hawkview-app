import type {
  HawkViewIdentityFinding,
  HawkViewIdentityRiskCounts,
  HawkViewIdentitySignalsView,
  IdentityRiskCapability,
  IdentityRiskChannelMeta,
  CorrelationRef,
  FindingSignal,
  SignalInstant,
  RiskAssessmentCountReason,
  IdentityRiskChannelReason,
  IdentityRiskChannelStatus,
  IdentityRiskFreshness,
  IdentityRiskPageInfo,
  IdentityRiskViewModel,
  MicrosoftEntraRiskyUser,
  MicrosoftEntraRiskyUsersView,
  RiskAssessment,
  RiskAssessmentFinding,
  RiskAssessmentReadiness,
  RiskAssessmentReason,
  RiskAssessmentRuleId,
  RiskAssessmentSource,
  RiskAssessmentSummary,
  RiskAssessmentUser,
  RiskConditionalAccessPolicy,
  RiskEvidenceWindow,
  RiskProtection,
  RiskProtectionEvidence,
  RiskRecommendedAction,
  RiskRuleReadiness,
  RiskSourceReadiness,
} from './types'
import { RISK_ASSESSMENT_RULE_TUPLES } from './types.ts'

const capabilities = ['FULL', 'PARTIAL', 'UNAVAILABLE'] as const
const statuses = [
  'AVAILABLE',
  'UNAVAILABLE',
  'STALE',
  'LEARNING',
  'NOT_EVALUATED',
  'ERROR',
] as const
const freshnessValues = ['CURRENT', 'STALE', 'UNKNOWN'] as const
const channelReasons = [
  'LICENSE_REQUIRED',
  'MISSING_PERMISSION',
  'WAITING_FOR_COLLECTION',
  'COLLECTION_FAILED',
  'COLLECTION_STALE',
  'SOURCE_UNAVAILABLE',
  'EVALUATION_DISABLED',
] as const
const MAX_PAGE_SIZE = 100
const MAX_SUMMARY_COUNT = 10_000
const MAX_ASSESSMENT_COUNT = 1_000_000
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000
const hawkViewSourceLabel = 'HawkView Identity Signals'
const microsoftSourceLabel = 'Microsoft Entra Risky Users'
const hawkViewEngineVersion = 'hawkview-identity-engine/1'
const hawkViewCatalogVersion = 'hawkview-identity-signals/v1'
const microsoftCatalogVersion = 'microsoft-entra-risky-users/v1'
const assessmentSchema = 'hawkview-risk-assessment/v1'
const assessmentRuleIds = [
  'HV-ID-AUTH-010.v1',
  'HV-ID-AUTH-005.v2',
  'HV-ID-MBX-001.v1',
] as const

const MAX_REPORTED_RULES = 64
/** Widest activity-window tolerance in the known catalogue. */
const DEFAULT_ACTIVITY_WINDOW_TOLERANCE_MS = 36 * 60 * 60_000
const RULE_ID_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*.v[0-9]{1,3}$/

/**
 * The client keeps a catalogue of the rules it knows, and holds those to their
 * published version, priority, evidence sources and activity-window tolerance.
 *
 * A rule the client does not know is accepted on generic validation rather than
 * discarding the assessment. Backend rule catalogues change on their own
 * schedule, and a technician losing every finding in a tenant because one new
 * check appeared is a far worse failure than showing that check without the
 * client's own metadata for it.
 *
 * An unrecognised rule is still held to every evidence requirement that a known
 * one is — see evaluatedRuleScope in presentation.ts. What it loses is only the
 * client-side cross-check that the rule's version and evidence sources match
 * this table, which detects a stale table rather than bad evidence.
 */
function knownRule(ruleId: string) {
  return Object.hasOwn(RISK_ASSESSMENT_RULE_TUPLES, ruleId)
    ? RISK_ASSESSMENT_RULE_TUPLES[ruleId as RiskAssessmentRuleId]
    : null
}


/**
 * A finding rests on a handful of signals, not an unbounded stream. The cap is
 * a sanity bound on a hostile or broken payload rather than a product limit.
 */
const MAX_FINDING_SIGNALS = 32

const signalInstantKinds = ['EVENT_OCCURRED', 'STATE_OBSERVED'] as const

/**
 * Optional and additive, and absent means absent: the key missing says this
 * server does not speak the field, and the finding-level count and dates are
 * read instead. That matters in production rather than in principle, because
 * frontend and backend ship through separate systems and every release has a
 * window where one side is old.
 *
 * An empty array is rejected rather than tolerated. Under the published
 * contract a signal missing from the array was never evaluated, so an empty one
 * says every signal was never evaluated -- a finding resting on nothing, which
 * is self-contradicting rather than ambiguous. Accepting it as a sentinel for
 * "old server" would reject every finding in the tenant for the length of a
 * deploy, which fails silently and reads exactly like a clean tenant.
 */
function adaptFindingSignals(
  value: unknown,
  trustedCurrentTimeMs: number
): FindingSignal[] | null | false {
  if (value === undefined) return null
  if (!Array.isArray(value)) return false
  if (value.length === 0 || value.length > MAX_FINDING_SIGNALS) return false

  const signals: FindingSignal[] = []
  for (const entry of value) {
    const source = record(entry)
    if (!source || !hasKeys(source, ['signal', 'count', 'latest', 'capped'])) {
      return false
    }
    const signal = boundedString(source.signal, 120)
    const count = source.count
    const capped = source.capped
    if (
      !signal ||
      !Number.isSafeInteger(count) ||
      (count as number) < 0 ||
      (count as number) > MAX_ASSESSMENT_COUNT ||
      typeof capped !== 'boolean'
    ) {
      return false
    }

    let latest: SignalInstant | null = null
    if (source.latest !== null && source.latest !== undefined) {
      const instant = record(source.latest)
      if (!instant || !hasKeys(instant, ['at', 'kind'])) return false
      const at = nullableDateTime(instant.at, trustedCurrentTimeMs)
      const kind = enumValue(instant.kind, signalInstantKinds)
      if (!at || !kind) return false
      latest = { at, kind }
    }

    // A count above zero with no instant is evidence that exists and carries no
    // time, which the contract permits. A zero with an instant is not: nothing
    // occurred for that timestamp to mark.
    if (count === 0 && latest !== null) return false

    signals.push({ signal, count: count as number, latest, capped })
  }

  // Two entries for the same signal would make every per-signal count
  // ambiguous, and the surface would render one of them as though it were the
  // whole.
  if (new Set(signals.map((item) => item.signal)).size !== signals.length) {
    return false
  }
  return signals
}

function reportedRuleId(value: unknown): string | null {
  const ruleId = boundedString(value, 64)
  return ruleId && RULE_ID_PATTERN.test(ruleId) ? ruleId : null
}
const assessmentSources = [
  'M365_AUDIT_STS',
  'GRAPH_SIGN_INS',
  'MAILBOX_RULES',
] as const
const assessmentReadiness = [
  'READY',
  'PARTIAL',
  'INAPPLICABLE',
  'WAITING',
  'MISSING_PERMISSION',
  'LICENSE_REQUIRED',
  'STALE',
  'FAILED',
  'INSUFFICIENT_FIELDS',
  'UNSUPPORTED',
  'DISABLED',
] as const
const assessmentReasons = [
  'READY',
  'WAITING_FOR_COLLECTION',
  'MISSING_PERMISSION',
  'LICENSE_REQUIRED',
  'COLLECTION_FAILED',
  'COLLECTION_STALE',
  'INCOMPLETE_WINDOW',
  'SOURCE_UNAVAILABLE',
  'INSUFFICIENT_FIELDS',
  'USER_BINDING_UNRESOLVED',
  'APPLICATION_BINDING_UNRESOLVED',
  'CLIENT_SOURCE_UNQUALIFIED',
  'UNSUPPORTED_RECORD',
  'CONFLICTING_EVIDENCE',
  'CAPACITY_LIMIT',
  'EVALUATION_FAILED',
  'EVALUATION_DISABLED',
  'KEY_UNAVAILABLE',
  'DIRECTORY_SYNC_MISSING',
  'DIRECTORY_SYNC_NOT_SUCCEEDED',
  'DIRECTORY_SYNC_UNDATED',
  'DIRECTORY_SYNC_STALE',
  'DIRECTORY_SYNC_NEWER_ATTEMPT',
  'RULE_ENDPOINT_NOT_FOUND',
  'RULE_VALIDATION_UNATTESTABLE',
  'SOURCE_NOT_ATTESTED',
  'ATTESTED_COMPLETE',
  'CHECK_NOT_APPLICABLE',
  'UNRESOLVED_SUBJECT_IDENTITY',
  'UNINTERPRETABLE_EVIDENCE',
] as const
const assessmentCountReasons = [
  'UNRESOLVED_SUBJECT_IDENTITY',
  'UNINTERPRETABLE_EVIDENCE',
  'CAPACITY_LIMIT',
  'INCOMPLETE_WINDOW',
  'COLLECTION_STALE',
  'SOURCE_UNAVAILABLE',
] as const
const recommendationCodes = [
  'CONFIRM_EXPECTED_ACTIVITY',
  'REVIEW_SIGN_INS',
  'CHECK_SAVED_CREDENTIALS',
  'VERIFY_MFA_ENFORCEMENT',
  'REVIEW_MAILBOX_FORWARDING',
  'FOLLOW_INCIDENT_PROCEDURE',
] as const

const ruleCatalog = new Set([
  'HV-ID-APP-001.v1',
  'HV-ID-APP-002.v1',
  'HV-ID-AUTH-001.v1',
  'HV-ID-AUTH-002.v1',
  'HV-ID-AUTH-003.v1',
  'HV-ID-AUTH-004.v1',
  'HV-ID-AUTH-005.v1',
  'HV-ID-AUTH-006.v1',
  'HV-ID-AUTH-007.v1',
  'HV-ID-AUTH-008.v1',
  'HV-ID-AUTH-009.v1',
  'HV-ID-CHG-001.v1',
  'HV-ID-CHG-002.v1',
  'HV-ID-CHG-003.v1',
  'HV-ID-CHG-004.v1',
  'HV-ID-CHG-005.v1',
  'HV-ID-EXP-001.v1',
  'HV-ID-EXP-002.v1',
  'HV-ID-EXP-003.v1',
  'HV-ID-MBX-001.v1',
  'HV-ID-MBX-002.v1',
  'HV-ID-MBX-003.v1',
])
const guidanceCatalog = Object.freeze({
  REVIEW_ACTIVITY:
    'Review the bounded source evidence with an authorized administrator.',
  REVIEW_ACCESS:
    'Review the identity, role assignment, and related authorized change evidence.',
  REVIEW_MAILBOX_RULE:
    'Review the mailbox rule and confirm the destination is authorized.',
  REVIEW_CONFIGURATION:
    'Review the configuration and confirm the change is authorized.',
})
const benignAlternativeCodes = new Set([
  'APPROVED_ACCOUNT_PROVISIONING',
  'APPROVED_SHARED_CONTEXT',
  'APPROVED_EXTERNAL_FORWARDING',
])
const sourceLabelCatalog = new Set([
  'Microsoft Entra directory audit',
  'Microsoft Entra sign-in activity',
  'Microsoft 365 Unified Audit',
  'Exchange Online mailbox audit',
  'Microsoft Graph mailbox-rule snapshot',
  'Microsoft Graph verified tenant domains',
])
const missingEvidenceCatalog = new Set([
  'ACCOUNT_CLASS_COVERAGE_INCOMPLETE',
  'ACCOUNT_CLASS_UNSUPPORTED',
  'ACCOUNT_CLASS_UNVERIFIED',
  'INSUFFICIENT_INDEPENDENT_CONTEXT',
  'MAILBOX_RULE_PROJECTION_INCOMPLETE',
  'RULE_CONFIG_UNAPPROVED',
])
const microsoftRiskDetailCatalog = new Set([
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

type RecordValue = Record<string, unknown>

/**
 * Optional on the wire. A server that does not send one yields null, which the
 * view treats as "cannot be compared" rather than as "Microsoft found nothing".
 * An unavailable ref still carries its reason, so a row can state a capability
 * rather than shrug.
 */
function adaptCorrelation(value: unknown): CorrelationRef | null | undefined {
  if (value === undefined || value === null) return null
  const source = record(value)
  if (!source || typeof source.available !== 'boolean') return undefined
  if (source.available === false) {
    if (!hasKeys(source, ['available', 'because'])) return undefined
    const because = boundedString(source.because, 300)
    return because ? { available: false, because } : undefined
  }
  if (!hasKeys(source, ['available', 'shape', 'ref'])) return undefined
  const shape = enumValue(source.shape, [
    'DIRECTORY_OBJECT_ID',
    'USER_PRINCIPAL_NAME',
  ] as const)
  const ref = boundedString(source.ref, 320)
  return shape && ref ? { available: true, shape, ref } : undefined
}

function record(value: unknown): RecordValue | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? (value as RecordValue)
    : null
}

/**
 * Required-key check: every listed key must be present, and any additional key
 * the server sends is ignored.
 *
 * Unknown fields are safe to ignore here because every adapter below builds its
 * result from explicitly named fields — nothing is spread or passed through, so
 * an unrecognised field cannot reach the view model or the screen.
 *
 * This replaces an exact-key check that rejected the entire response whenever a
 * single unrecognised field appeared. That made the wire format unchangeable
 * while both sides ship from this repository, and a rejected response reached
 * the technician as an unevaluated tenant — the state collapse this surface
 * exists to prevent.
 */
function hasKeys(value: RecordValue, keys: readonly string[]) {
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function containsSecret(value: string) {
  const candidates = [value]
  let decoded = value
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      candidates.push(next)
      decoded = next
    } catch {
      break
    }
  }

  return candidates.some((candidate) => {
    const trimmed = candidate.trim()
    return (
      /^[\[{]/.test(trimmed) ||
      /\b(?:password|passwd|pwd|secret|token|access[-_ ]?token|refresh[-_ ]?token|api[-_ ]?key|client[-_ ]?secret|authorization|authorization[-_ ]?code|private[-_ ]?key|session[-_ ]?id|oauth[-_ ]?code|account[-_ ]?key|signature|sig|code|credential|cookie)\b[\s"'\[\]{}:,=%]+\S+/i.test(
        candidate
      ) ||
      /\bbearer\s+[A-Za-z0-9._~+\/=:-]{8,}/i.test(candidate) ||
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(candidate) ||
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,})\b/.test(
        candidate
      ) ||
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(
        candidate
      ) ||
      /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/i.test(candidate) ||
      /[?&](?:access_token|refresh_token|token|code|key|sig|password|secret)=/i.test(
        candidate
      )
    )
  })
}

function boundedString(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > max ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    containsSecret(normalized)
  ) {
    return null
  }
  return normalized
}

function dateTime(value: unknown): string | null {
  const candidate = boundedString(value, 100)
  if (
    typeof value !== 'string' ||
    !candidate ||
    candidate !== value ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate)
  ) {
    return null
  }
  const parsed = new Date(candidate)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === candidate
    ? candidate
    : null
}

function observedDateTime(
  value: unknown,
  evaluatedAt: string,
  trustedCurrentTimeMs: number
): string | null {
  const candidate = dateTime(value)
  if (!candidate) return null
  const candidateTime = new Date(candidate).getTime()
  return candidateTime <=
    new Date(evaluatedAt).getTime() + MAX_FUTURE_SKEW_MS &&
    candidateTime <= trustedCurrentTimeMs + MAX_FUTURE_SKEW_MS
    ? candidate
    : null
}

function isFutureDateTime(value: unknown, trustedCurrentTimeMs: number) {
  const candidate = dateTime(value)
  return (
    candidate !== null &&
    new Date(candidate).getTime() > trustedCurrentTimeMs + MAX_FUTURE_SKEW_MS
  )
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T
): T[number] | null {
  return typeof value === 'string' && allowed.includes(value)
    ? (value as T[number])
    : null
}

function catalogList(
  value: unknown,
  catalog: ReadonlySet<string>,
  maxItems: number,
  maxLength: number
): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null
  const values = value.map((item) => boundedString(item, maxLength))
  if (
    !values.every((item): item is string => item !== null) ||
    values.some((item) => !catalog.has(item)) ||
    new Set(values).size !== values.length
  ) {
    return null
  }
  return values
}

function fallbackMeta(
  status: IdentityRiskChannelStatus,
  limitation: string,
  reasonCode: IdentityRiskChannelReason | null = null
): IdentityRiskChannelMeta {
  return {
    capability: 'UNAVAILABLE',
    status,
    freshness: 'UNKNOWN',
    sourceLabel: 'Not reported',
    engineVersion: null,
    catalogVersion: null,
    evaluatedAt: null,
    observedAt: null,
    limitation,
    reasonCode,
  }
}

function adaptMeta(
  value: RecordValue,
  expectedSourceLabel: typeof hawkViewSourceLabel | typeof microsoftSourceLabel,
  trustedCurrentTimeMs: number
): IdentityRiskChannelMeta | null {
  const capability = enumValue(value.capability, capabilities)
  const status = enumValue(value.status, statuses)
  const freshness = enumValue(value.freshness, freshnessValues)
  const sourceLabel = boundedString(value.sourceLabel, 160)
  const engineVersion =
    value.engineVersion === null ? null : boundedString(value.engineVersion, 64)
  const catalogVersion = boundedString(value.catalogVersion, 64)
  const evaluatedAt =
    value.evaluatedAt === null ? null : dateTime(value.evaluatedAt)
  const observedAt =
    value.observedAt === null || !evaluatedAt
      ? null
      : observedDateTime(value.observedAt, evaluatedAt, trustedCurrentTimeMs)
  const limitation =
    value.limitation === null ? null : boundedString(value.limitation, 500)
  // Optional, and additive. Absent means the cause was not reported, which the
  // UI states plainly rather than inventing a cause for.
  const reasonCode =
    value.reasonCode === undefined || value.reasonCode === null
      ? null
      : enumValue(value.reasonCode, channelReasons)

  if (
    !capability ||
    !status ||
    !freshness ||
    !sourceLabel ||
    sourceLabel !== expectedSourceLabel ||
    (expectedSourceLabel === hawkViewSourceLabel
      ? engineVersion !== hawkViewEngineVersion ||
        catalogVersion !== hawkViewCatalogVersion
      : engineVersion !== null || catalogVersion !== microsoftCatalogVersion) ||
    (evaluatedAt !== null &&
      new Date(evaluatedAt).getTime() >
        trustedCurrentTimeMs + MAX_FUTURE_SKEW_MS) ||
    (value.evaluatedAt !== null && !evaluatedAt) ||
    (value.observedAt !== null && !observedAt) ||
    (value.limitation !== null && !limitation) ||
    (value.reasonCode !== undefined && value.reasonCode !== null && !reasonCode)
  ) {
    return null
  }

  const coherentState =
    (status === 'AVAILABLE' &&
      capability !== 'UNAVAILABLE' &&
      freshness === 'CURRENT' &&
      evaluatedAt !== null &&
      observedAt !== null &&
      (capability === 'FULL' || limitation !== null)) ||
    (status === 'STALE' &&
      capability !== 'UNAVAILABLE' &&
      freshness === 'STALE' &&
      evaluatedAt !== null &&
      observedAt !== null &&
      limitation !== null) ||
    (status === 'LEARNING' &&
      capability !== 'UNAVAILABLE' &&
      freshness === 'UNKNOWN' &&
      evaluatedAt !== null &&
      limitation !== null) ||
    (status === 'NOT_EVALUATED' &&
      capability === 'UNAVAILABLE' &&
      freshness === 'UNKNOWN' &&
      observedAt === null &&
      limitation !== null) ||
    ((status === 'UNAVAILABLE' || status === 'ERROR') &&
      capability === 'UNAVAILABLE' &&
      freshness === 'UNKNOWN' &&
      evaluatedAt === null &&
      observedAt === null &&
      limitation !== null)

  if (!coherentState) return null

  return {
    capability,
    status,
    freshness,
    sourceLabel,
    engineVersion,
    catalogVersion,
    evaluatedAt,
    observedAt,
    limitation,
    reasonCode,
  }
}

function sameMeta(
  left: IdentityRiskChannelMeta,
  right: IdentityRiskChannelMeta
) {
  return (
    left.capability === right.capability &&
    left.status === right.status &&
    left.freshness === right.freshness &&
    left.sourceLabel === right.sourceLabel &&
    left.engineVersion === right.engineVersion &&
    left.catalogVersion === right.catalogVersion &&
    left.evaluatedAt === right.evaluatedAt &&
    left.observedAt === right.observedAt &&
    left.limitation === right.limitation &&
    left.reasonCode === right.reasonCode
  )
}

function adaptPageInfo(value: unknown): IdentityRiskPageInfo | null {
  const source = record(value)
  if (!source || !hasKeys(source, ['hasMore', 'nextCursor'])) return null
  if (typeof source.hasMore !== 'boolean') return null
  const nextCursor =
    source.nextCursor === null ? null : boundedString(source.nextCursor, 256)
  if (
    (source.nextCursor !== null &&
      (!nextCursor || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(nextCursor))) ||
    (source.hasMore && nextCursor === null) ||
    (!source.hasMore && nextCursor !== null)
  ) {
    return null
  }
  return { hasMore: source.hasMore, nextCursor }
}

function adaptBoundedCount(value: unknown) {
  const source = record(value)
  if (!source || !hasKeys(source, ['value', 'exact', 'capped'])) return null
  if (
    !Number.isSafeInteger(source.value) ||
    (source.value as number) < 0 ||
    (source.value as number) > MAX_SUMMARY_COUNT ||
    typeof source.exact !== 'boolean' ||
    typeof source.capped !== 'boolean' ||
    (source.exact && source.capped) ||
    (source.capped && source.value !== MAX_SUMMARY_COUNT) ||
    (!source.exact && !source.capped && source.value !== 0)
  ) {
    return null
  }
  return {
    value: source.value as number,
    exact: source.exact,
    capped: source.capped,
  }
}

function adaptCounts(value: unknown): HawkViewIdentityRiskCounts | null {
  const source = record(value)
  const keys = [
    'identitiesNeedingReview',
    'openFindings',
    'evaluatedRules',
    'matchedResults',
    'suppressedResults',
    'notMatchedResults',
    'notEvaluatedResults',
  ] as const
  if (!source || !hasKeys(source, keys)) return null

  const counts = Object.fromEntries(
    keys.map((key) => [key, adaptBoundedCount(source[key])])
  ) as Record<(typeof keys)[number], ReturnType<typeof adaptBoundedCount>>
  if (!Object.values(counts).every((count) => count !== null)) return null

  const adapted = counts as HawkViewIdentityRiskCounts
  const evaluatedRulesUnavailable =
    adapted.evaluatedRules.value === 0 &&
    !adapted.evaluatedRules.exact &&
    !adapted.evaluatedRules.capped
  if (
    !evaluatedRulesUnavailable &&
    (!adapted.evaluatedRules.exact ||
      adapted.evaluatedRules.capped ||
      adapted.evaluatedRules.value > ruleCatalog.size)
  ) {
    return null
  }
  return adapted
}

function countsMatchMeta(
  counts: HawkViewIdentityRiskCounts,
  meta: IdentityRiskChannelMeta
) {
  const values = Object.values(counts)
  return meta.evaluatedAt === null
    ? values.every(
        (count) => count.value === 0 && !count.exact && !count.capped
      )
    : values.every((count) => count.exact || count.capped)
}

function adaptFinding(
  value: unknown,
  evaluatedAt: string,
  trustedCurrentTimeMs: number
): HawkViewIdentityFinding | null {
  const source = record(value)
  if (
    !source ||
    !hasKeys(source, [
      'id',
      'state',
      'severity',
      'confidence',
      'coverage',
      'title',
      'explanation',
      'affectedIdentity',
      'observedAt',
      'ruleIds',
      'sourceLabels',
      'missingEvidenceLabels',
      'benignAlternativeCodes',
      'investigationGuidanceCode',
      'investigationGuidance',
    ])
  ) {
    return null
  }
  const id = boundedString(source.id, 200)
  const state = enumValue(source.state, [
    'OPEN',
    'UPDATED',
    'RESOLVED',
    'EXPIRED',
  ] as const)
  const severity = enumValue(source.severity, [
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL',
  ] as const)
  const confidence = enumValue(source.confidence, [
    'LOW',
    'MEDIUM',
    'HIGH',
  ] as const)
  const coverage = enumValue(source.coverage, capabilities)
  const title = boundedString(source.title, 160)
  const explanation = boundedString(source.explanation, 1_000)
  const affectedIdentitySource = record(source.affectedIdentity)
  if (
    !affectedIdentitySource ||
    !hasKeys(affectedIdentitySource, ['id', 'label', 'type'])
  ) {
    return null
  }
  const affectedIdentityId = boundedString(affectedIdentitySource.id, 128)
  const affectedIdentityLabel = boundedString(affectedIdentitySource.label, 160)
  const affectedIdentityType = enumValue(affectedIdentitySource?.type, [
    'USER',
    'MAILBOX',
    'APPLICATION',
    'UNKNOWN',
  ] as const)
  const observedAt = observedDateTime(
    source.observedAt,
    evaluatedAt,
    trustedCurrentTimeMs
  )
  const ruleIds = catalogList(source.ruleIds, ruleCatalog, 10, 150)
  const sourceLabels = catalogList(
    source.sourceLabels,
    sourceLabelCatalog,
    10,
    120
  )
  const missingEvidenceLabels = catalogList(
    source.missingEvidenceLabels,
    missingEvidenceCatalog,
    10,
    120
  )
  const benignAlternatives = catalogList(
    source.benignAlternativeCodes,
    benignAlternativeCodes,
    10,
    120
  )
  const investigationGuidanceCode = boundedString(
    source.investigationGuidanceCode,
    120
  )
  const investigationGuidance = boundedString(source.investigationGuidance, 300)
  const catalogGuidance = investigationGuidanceCode
    ? guidanceCatalog[investigationGuidanceCode as keyof typeof guidanceCatalog]
    : null

  if (
    !id ||
    !/^[A-Za-z0-9._:-]+$/.test(id) ||
    !state ||
    !severity ||
    !confidence ||
    !coverage ||
    !title ||
    !explanation ||
    !affectedIdentityId ||
    !/^[A-Za-z0-9._:-]+$/.test(affectedIdentityId) ||
    !affectedIdentityLabel ||
    /[<>\[\]{}\\]/.test(affectedIdentityLabel) ||
    !affectedIdentityType ||
    !observedAt ||
    !ruleIds ||
    ruleIds.length === 0 ||
    !sourceLabels ||
    !missingEvidenceLabels ||
    !benignAlternatives ||
    !investigationGuidanceCode ||
    !catalogGuidance ||
    !investigationGuidance ||
    investigationGuidance !== catalogGuidance
  ) {
    return null
  }

  return {
    id,
    state,
    severity,
    confidence,
    coverage,
    title,
    explanation,
    affectedIdentity: {
      id: affectedIdentityId,
      label: affectedIdentityLabel,
      type: affectedIdentityType,
    },
    observedAt,
    ruleIds,
    sourceLabels,
    missingEvidenceLabels,
    benignAlternativeCodes: benignAlternatives,
    investigationGuidanceCode,
    investigationGuidance: catalogGuidance,
  }
}

function adaptMicrosoftUser(
  value: unknown,
  evaluatedAt: string,
  trustedCurrentTimeMs: number
): MicrosoftEntraRiskyUser | null {
  const source = record(value)
  if (
    !source ||
    !hasKeys(source, [
      'id',
      'identityLabel',
      'riskLevel',
      'riskState',
      'riskDetail',
      'observedAt',
    ])
  ) {
    return null
  }
  const id = boundedString(source.id, 200)
  const identityLabel = boundedString(source.identityLabel, 200)
  const riskLevel = enumValue(source.riskLevel, [
    'none',
    'low',
    'medium',
    'high',
    'hidden',
    'unknownFutureValue',
  ] as const)
  const riskState = enumValue(source.riskState, [
    'none',
    'atRisk',
    'remediated',
    'dismissed',
    'confirmedSafe',
    'confirmedCompromised',
    'unknownFutureValue',
  ] as const)
  const riskDetail =
    source.riskDetail === null || source.riskDetail === undefined
      ? null
      : boundedString(source.riskDetail, 200)
  const observedAt = observedDateTime(
    source.observedAt,
    evaluatedAt,
    trustedCurrentTimeMs
  )

  if (
    !id ||
    !/^[A-Za-z0-9._:-]+$/.test(id) ||
    !identityLabel ||
    /[<>\[\]{}\\]/.test(identityLabel) ||
    !riskLevel ||
    !riskState ||
    (source.riskDetail !== null &&
      source.riskDetail !== undefined &&
      (!riskDetail || !microsoftRiskDetailCatalog.has(riskDetail))) ||
    !observedAt
  ) {
    return null
  }

  const correlation = adaptCorrelation(source.correlation)
  if (correlation === undefined) return null

  return {
    id,
    identityLabel,
    correlation,
    riskLevel,
    riskState,
    riskDetail,
    observedAt,
  }
}

export function unavailableHawkViewIdentitySignals(
  status: IdentityRiskChannelStatus,
  limitation: string
): HawkViewIdentitySignalsView {
  return {
    channel: 'HAWKVIEW_IDENTITY_SIGNALS',
    meta: fallbackMeta(status, limitation),
    counts: null,
    findings: null,
    pageInfo: null,
  }
}

export function unavailableMicrosoftEntraRiskyUsers(
  status: IdentityRiskChannelStatus,
  limitation: string,
  reasonCode: IdentityRiskChannelReason | null = null
): MicrosoftEntraRiskyUsersView {
  return {
    channel: 'MICROSOFT_ENTRA_RISKY_USERS',
    meta: fallbackMeta(status, limitation, reasonCode),
    users: null,
    pageInfo: null,
  }
}

export function adaptIdentityRiskResponses(input: {
  hawkViewSummary: unknown
  hawkViewFindings: unknown
  microsoftRiskyUsers: unknown
}): IdentityRiskViewModel {
  // DTO timestamps are untrusted input. This independent receipt-time ceiling
  // is an availability guard; the backend separately enforces platform time.
  const trustedCurrentTimeMs = Date.now()
  const summary = record(input.hawkViewSummary)
  const findingEnvelope = record(input.hawkViewFindings)
  const microsoftEnvelope = record(input.microsoftRiskyUsers)

  let hawkView = unavailableHawkViewIdentitySignals(
    'NOT_EVALUATED',
    'HawkView identity signal evaluation has not been reported in a supported format.'
  )
  if (
    summary?.version === 1 &&
    summary.channel === 'HAWKVIEW_IDENTITY_SIGNALS' &&
    hasKeys(summary, [
      'version',
      'channel',
      'engineVersion',
      'catalogVersion',
      'capability',
      'status',
      'sourceLabel',
      'evaluatedAt',
      'observedAt',
      'freshness',
      'limitation',
      'counts',
    ]) &&
    findingEnvelope?.version === 1 &&
    findingEnvelope.channel === 'HAWKVIEW_IDENTITY_SIGNALS' &&
    hasKeys(findingEnvelope, [
      'version',
      'channel',
      'engineVersion',
      'catalogVersion',
      'capability',
      'status',
      'sourceLabel',
      'evaluatedAt',
      'observedAt',
      'freshness',
      'limitation',
      'findings',
      'pageInfo',
    ])
  ) {
    const meta = adaptMeta(summary, hawkViewSourceLabel, trustedCurrentTimeMs)
    const findingMeta = adaptMeta(
      findingEnvelope,
      hawkViewSourceLabel,
      trustedCurrentTimeMs
    )
    const counts = adaptCounts(summary.counts)
    const rawFindings = findingEnvelope.findings
    const findings =
      Array.isArray(rawFindings) &&
      rawFindings.length <= MAX_PAGE_SIZE &&
      (meta?.evaluatedAt || rawFindings.length === 0)
        ? rawFindings.map((finding) =>
            adaptFinding(
              finding,
              meta?.evaluatedAt as string,
              trustedCurrentTimeMs
            )
          )
        : null
    const pageInfo = adaptPageInfo(findingEnvelope.pageInfo)
    if (
      meta &&
      findingMeta &&
      counts &&
      countsMatchMeta(counts, meta) &&
      sameMeta(meta, findingMeta) &&
      findings &&
      findings.every(
        (finding): finding is HawkViewIdentityFinding => finding !== null
      ) &&
      new Set(findings.map((finding) => finding.id)).size === findings.length &&
      pageInfo
    ) {
      hawkView = {
        channel: 'HAWKVIEW_IDENTITY_SIGNALS',
        meta,
        counts,
        findings,
        pageInfo,
      }
    } else {
      const futureEvaluation =
        isFutureDateTime(summary.evaluatedAt, trustedCurrentTimeMs) ||
        isFutureDateTime(findingEnvelope.evaluatedAt, trustedCurrentTimeMs)
      hawkView = unavailableHawkViewIdentitySignals(
        'ERROR',
        futureEvaluation
          ? 'HawkView identity signal evaluation time is in the future, so this evidence is unavailable and must not be treated as current.'
          : 'HawkView identity signal data did not match the supported frontend contract.'
      )
    }
  }

  let microsoft = unavailableMicrosoftEntraRiskyUsers(
    'NOT_EVALUATED',
    'Microsoft Entra risky-user evidence has not been reported in a supported format.'
  )
  if (
    microsoftEnvelope?.version === 1 &&
    microsoftEnvelope.channel === 'MICROSOFT_ENTRA_RISKY_USERS' &&
    hasKeys(microsoftEnvelope, [
      'version',
      'channel',
      'engineVersion',
      'catalogVersion',
      'capability',
      'status',
      'sourceLabel',
      'evaluatedAt',
      'observedAt',
      'freshness',
      'limitation',
      'users',
      'pageInfo',
    ])
  ) {
    const meta = adaptMeta(
      microsoftEnvelope,
      microsoftSourceLabel,
      trustedCurrentTimeMs
    )
    const rawUsers = microsoftEnvelope.users
    const users =
      Array.isArray(rawUsers) &&
      rawUsers.length <= MAX_PAGE_SIZE &&
      (meta?.evaluatedAt || rawUsers.length === 0)
        ? rawUsers.map((user) =>
            adaptMicrosoftUser(
              user,
              meta?.evaluatedAt as string,
              trustedCurrentTimeMs
            )
          )
        : null
    const pageInfo = adaptPageInfo(microsoftEnvelope.pageInfo)
    if (
      meta &&
      users &&
      users.every((user): user is MicrosoftEntraRiskyUser => user !== null) &&
      new Set(users.map((user) => user.id)).size === users.length &&
      pageInfo
    ) {
      microsoft = {
        channel: 'MICROSOFT_ENTRA_RISKY_USERS',
        meta,
        users,
        pageInfo,
      }
    } else {
      const futureEvaluation = isFutureDateTime(
        microsoftEnvelope.evaluatedAt,
        trustedCurrentTimeMs
      )
      microsoft = unavailableMicrosoftEntraRiskyUsers(
        'ERROR',
        futureEvaluation
          ? 'Microsoft Entra risky-user evaluation time is in the future, so this evidence is unavailable and must not be treated as current.'
          : 'Microsoft Entra risky-user data did not match the supported frontend contract.'
      )
    }
  }

  return { hawkView, microsoft }
}

const assessmentMetaKeys = [
  'version',
  'channel',
  'engineVersion',
  'catalogVersion',
  'evaluatedAt',
  'capability',
  'status',
  'sourceLabel',
  'observedAt',
  'freshness',
  'limitation',
] as const

function nullableDateTime(
  value: unknown,
  trustedCurrentTimeMs: number
): string | null | undefined {
  if (value === null) return null
  const parsed = dateTime(value)
  if (
    !parsed ||
    new Date(parsed).getTime() > trustedCurrentTimeMs + MAX_FUTURE_SKEW_MS
  ) {
    return undefined
  }
  return parsed
}

function adaptEvidenceWindow(
  value: unknown,
  trustedCurrentTimeMs: number
): RiskEvidenceWindow | null {
  const source = record(value)
  if (!source || !hasKeys(source, ['start', 'end'])) return null
  const start = nullableDateTime(source.start, trustedCurrentTimeMs)
  const end = nullableDateTime(source.end, trustedCurrentTimeMs)
  if (
    start === undefined ||
    end === undefined ||
    (start !== null &&
      end !== null &&
      new Date(start).getTime() > new Date(end).getTime())
  ) {
    return null
  }
  return { start, end }
}

function boundedStringList(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
  pattern?: RegExp
): string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) return null
  const values = value.map((item) => boundedString(item, maximumLength))
  if (
    !values.every((item): item is string => item !== null) ||
    (pattern && values.some((item) => !pattern.test(item))) ||
    new Set(values).size !== values.length
  ) {
    return null
  }
  return values
}

function adaptSourceReadiness(
  value: unknown,
  trustedCurrentTimeMs: number
): RiskSourceReadiness | null {
  const source = record(value)
  if (
    !source ||
    !hasKeys(source, [
      'source',
      'status',
      'reasonCode',
      'explanation',
      'window',
      'lastSuccessfulCollectionAt',
      'latestEventAt',
      'latestIngestionAt',
      'freshness',
    ])
  ) {
    return null
  }
  const selectedSource = enumValue(source.source, assessmentSources)
  const status = enumValue(source.status, assessmentReadiness)
  const reasonCode = enumValue(source.reasonCode, assessmentReasons)
  const explanation = boundedString(source.explanation, 600)
  const window = adaptEvidenceWindow(source.window, trustedCurrentTimeMs)
  const lastSuccessfulCollectionAt = nullableDateTime(
    source.lastSuccessfulCollectionAt,
    trustedCurrentTimeMs
  )
  const latestEventAt = nullableDateTime(
    source.latestEventAt,
    trustedCurrentTimeMs
  )
  const latestIngestionAt = nullableDateTime(
    source.latestIngestionAt,
    trustedCurrentTimeMs
  )
  const freshness = enumValue(source.freshness, freshnessValues)
  if (
    !selectedSource ||
    !status ||
    !reasonCode ||
    !explanation ||
    !window ||
    lastSuccessfulCollectionAt === undefined ||
    latestEventAt === undefined ||
    latestIngestionAt === undefined ||
    !freshness
  ) {
    return null
  }
  return {
    source: selectedSource,
    status,
    reasonCode,
    explanation,
    window,
    lastSuccessfulCollectionAt,
    latestEventAt,
    latestIngestionAt,
    freshness,
  }
}

function nullableCount(value: unknown): number | null | undefined {
  if (value === null) return null
  return Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_ASSESSMENT_COUNT
    ? (value as number)
    : undefined
}

function adaptRuleReadiness(
  value: unknown,
  trustedCurrentTimeMs: number
): RiskRuleReadiness | null {
  const source = record(value)
  if (
    !source ||
    !hasKeys(source, [
      'ruleId',
      'ruleVersion',
      'title',
      'status',
      'reasonCode',
      'explanation',
      'selectedSource',
      'window',
      'evaluatedAt',
      'assessedIdentities',
      'matchedIdentities',
      'countsCapped',
    ])
  ) {
    return null
  }
  const ruleId = reportedRuleId(source.ruleId)
  const catalogued = ruleId ? knownRule(ruleId) : null
  const ruleVersion = boundedString(source.ruleVersion, 40)
  const title = assessmentText(source.title, 180)
  const status = enumValue(source.status, assessmentReadiness)
  const reasonCode = enumValue(source.reasonCode, assessmentReasons)
  const explanation = boundedString(source.explanation, 600)
  const selectedSource =
    source.selectedSource === null
      ? null
      : enumValue(source.selectedSource, assessmentSources)
  const window = adaptEvidenceWindow(source.window, trustedCurrentTimeMs)
  const evaluatedAt = nullableDateTime(source.evaluatedAt, trustedCurrentTimeMs)
  const assessedIdentities = nullableCount(source.assessedIdentities)
  const matchedIdentities = nullableCount(source.matchedIdentities)
  if (
    !ruleId ||
    !ruleVersion ||
    (catalogued && ruleVersion !== catalogued.version) ||
    !title ||
    !status ||
    !reasonCode ||
    !explanation ||
    (source.selectedSource !== null && !selectedSource) ||
    (catalogued &&
      selectedSource !== null &&
      !(catalogued.sources as readonly string[]).includes(selectedSource)) ||
    !window ||
    evaluatedAt === undefined ||
    assessedIdentities === undefined ||
    matchedIdentities === undefined ||
    (assessedIdentities !== null &&
      matchedIdentities !== null &&
      matchedIdentities > assessedIdentities) ||
    typeof source.countsCapped !== 'boolean'
  ) {
    return null
  }
  return {
    ruleId,
    ruleVersion,
    title,
    status,
    reasonCode,
    explanation,
    selectedSource,
    window,
    evaluatedAt,
    assessedIdentities,
    matchedIdentities,
    countsCapped: source.countsCapped,
  }
}

function adaptConditionalAccessPolicy(
  value: unknown
): RiskConditionalAccessPolicy | null {
  const source = record(value)
  if (
    !source ||
    !hasKeys(source, ['id', 'name', 'state', 'outcome', 'materialConditions'])
  ) {
    return null
  }
  const id = boundedString(source.id, 160)
  const name = authorizedLabel(source.name, 256)
  const state = enumValue(source.state, [
    'ENABLED',
    'REPORT_ONLY',
    'DISABLED',
  ] as const)
  const outcome = enumValue(source.outcome, [
    'UNIVERSAL',
    'CONDITIONAL',
    'NOT_ENFORCED',
  ] as const)
  const materialConditions = boundedStringList(
    source.materialConditions,
    20,
    180
  )
  if (
    !id ||
    !/^[A-Za-z0-9._:-]+$/.test(id) ||
    !name ||
    !state ||
    !outcome ||
    !materialConditions
  ) {
    return null
  }
  return { id, name, state, outcome, materialConditions }
}

function adaptProtection(
  value: unknown,
  trustedCurrentTimeMs: number
): RiskProtection | null {
  const source = record(value)
  if (
    !source ||
    !hasKeys(source, [
      'conditionalAccess',
      'securityDefaults',
      'legacyPerUserMfa',
      'registration',
      'explanation',
    ])
  )
    return null
  const conditionalAccess = record(source.conditionalAccess)
  if (
    !conditionalAccess ||
    !hasKeys(conditionalAccess, [
      'contractVersion',
      'status',
      'policies',
      'observedAt',
      'evaluatedAt',
      'source',
      'freshness',
      'reasonCodes',
    ])
  )
    return null
  const caStatus = enumValue(conditionalAccess.status, [
    'COVERED_BY_CONDITIONAL_ACCESS',
    'CONDITIONALLY_COVERED',
    'REPORT_ONLY',
    'NOT_COVERED',
    'UNKNOWN',
  ] as const)
  const rawPolicies = conditionalAccess.policies
  const policies =
    Array.isArray(rawPolicies) && rawPolicies.length <= 100
      ? rawPolicies.map(adaptConditionalAccessPolicy)
      : null
  const caObservedAt = nullableDateTime(
    conditionalAccess.observedAt,
    trustedCurrentTimeMs
  )
  const caEvaluatedAt = nullableDateTime(
    conditionalAccess.evaluatedAt,
    trustedCurrentTimeMs
  )
  const reasonCodes = boundedStringList(
    conditionalAccess.reasonCodes,
    32,
    120,
    /^[A-Z0-9_:-]+$/
  )
  const caFreshness = enumValue(conditionalAccess.freshness, freshnessValues)
  const securityDefaults = adaptProtectionEvidence(
    source.securityDefaults,
    ['ENABLED', 'DISABLED'],
    trustedCurrentTimeMs
  )
  const legacyPerUserMfa = adaptProtectionEvidence(
    source.legacyPerUserMfa,
    ['ENFORCED', 'ENABLED', 'DISABLED'],
    trustedCurrentTimeMs
  )
  const registration = adaptProtectionEvidence(
    source.registration,
    ['REGISTERED', 'NOT_REGISTERED'],
    trustedCurrentTimeMs
  )
  const explanation = boundedString(source.explanation, 800)
  if (
    conditionalAccess.contractVersion !== 1 ||
    !caStatus ||
    !policies ||
    policies.some((policy) => policy === null) ||
    new Set(policies.map((policy) => policy?.id)).size !== policies.length ||
    caObservedAt === undefined ||
    caEvaluatedAt === undefined ||
    !reasonCodes ||
    conditionalAccess.source !== 'EFFECTIVE_MFA_V1' ||
    !caFreshness ||
    !securityDefaults ||
    !legacyPerUserMfa ||
    !registration ||
    !explanation
  )
    return null
  return {
    conditionalAccess: {
      contractVersion: 1,
      status: caStatus,
      policies: policies as RiskConditionalAccessPolicy[],
      observedAt: caObservedAt,
      evaluatedAt: caEvaluatedAt,
      source: 'EFFECTIVE_MFA_V1',
      freshness: caFreshness,
      reasonCodes,
    },
    securityDefaults,
    legacyPerUserMfa,
    registration,
    explanation,
  }
}

function adaptProtectionEvidence<const State extends string>(
  value: unknown,
  states: readonly State[],
  trustedCurrentTimeMs: number
): RiskProtectionEvidence<State> | null {
  const item = record(value)
  if (
    !item ||
    !hasKeys(item, ['state', 'source', 'observedAt', 'freshness', 'reasonCode'])
  )
    return null
  const state = enumValue(item.state, [...states, 'UNKNOWN'] as const)
  const source = enumValue(item.source, [
    'MICROSOFT_GRAPH',
    'EFFECTIVE_MFA_V1',
    'NOT_REPORTED',
  ] as const)
  const observedAt = nullableDateTime(item.observedAt, trustedCurrentTimeMs)
  const freshness = enumValue(item.freshness, freshnessValues)
  const reasonCode = enumValue(item.reasonCode, [
    'VERIFIED',
    'NOT_REPORTED',
    'STALE',
    'FAILED',
    'MISSING_PERMISSION',
    'INCOMPLETE',
  ] as const)
  if (
    !state ||
    !source ||
    observedAt === undefined ||
    !freshness ||
    !reasonCode
  )
    return null
  return { state, source, observedAt, freshness, reasonCode }
}

function adaptRecommendedAction(value: unknown): RiskRecommendedAction | null {
  const source = record(value)
  if (!source || !hasKeys(source, ['code', 'text'])) return null
  const code = enumValue(source.code, recommendationCodes)
  const text = boundedString(source.text, 400)
  return code && text ? { code, text } : null
}

function adaptAssessmentFinding(
  value: unknown,
  trustedCurrentTimeMs: number
): RiskAssessmentFinding | null {
  const source = record(value)
  if (
    !source ||
    !hasKeys(source, [
      'id',
      'ruleId',
      'ruleVersion',
      'priority',
      'confidence',
      'activityState',
      'title',
      'explanation',
      'firstSeen',
      'lastSeen',
      'evaluatedAt',
      'activityWindowEndsAt',
      'window',
      'evidenceCount',
      'evidenceCountCapped',
      'selectedSource',
      'application',
      'device',
      'clientSource',
      'evidenceReferences',
      'eventProtection',
      'caveats',
      'recommendedActions',
    ])
  )
    return null
  const id = boundedString(source.id, 200)
  const ruleId = reportedRuleId(source.ruleId)
  const catalogued = ruleId ? knownRule(ruleId) : null
  const ruleVersion = boundedString(source.ruleVersion, 40)
  const priority = enumValue(source.priority, [
    'LOW',
    'MEDIUM',
    'HIGH',
  ] as const)
  const confidence = enumValue(source.confidence, [
    'LOW',
    'MEDIUM',
    'HIGH',
  ] as const)
  const activityState = enumValue(source.activityState, [
    'CURRENT',
    'HISTORICAL',
    'UNKNOWN',
  ] as const)
  const title = assessmentText(source.title, 180)
  const explanation = assessmentText(source.explanation, 1_200)
  const firstSeen = nullableDateTime(source.firstSeen, trustedCurrentTimeMs)
  const lastSeen = nullableDateTime(source.lastSeen, trustedCurrentTimeMs)
  const evaluatedAt = nullableDateTime(source.evaluatedAt, trustedCurrentTimeMs)
  // This is a detector window end, allowed to be after receipt time.
  const activityWindowEndsAt = dateTime(source.activityWindowEndsAt)
  const window = adaptEvidenceWindow(source.window, trustedCurrentTimeMs)
  const signals = adaptFindingSignals(source.signals, trustedCurrentTimeMs)
  const selectedSource = enumValue(source.selectedSource, assessmentSources)
  const application = record(source.application)
  const applicationState = enumValue(application?.state, [
    'RESOLVED',
    'NOT_REPORTED',
  ] as const)
  const applicationLabel =
    application?.label === null
      ? null
      : authorizedLabel(application?.label, 256)
  const device = record(source.device)
  const deviceState = enumValue(device?.state, [
    'NOT_REPORTED',
    'INSUFFICIENT_FIELDS',
  ] as const)
  const client = record(source.clientSource)
  const qualification = enumValue(client?.qualification, [
    'QUALIFIED',
    'NOT_REPORTED',
    'INSUFFICIENT_FIELDS',
  ] as const)
  const rawReferences = source.evidenceReferences
  const references =
    Array.isArray(rawReferences) && rawReferences.length <= 50
      ? rawReferences.map((reference) => {
          const item = record(reference)
          if (!item || !hasKeys(item, ['id', 'recordedAt', 'ingestedAt']))
            return null
          const referenceId = boundedString(item.id, 160)
          const recordedAt = nullableDateTime(
            item.recordedAt,
            trustedCurrentTimeMs
          )
          const ingestedAt = nullableDateTime(
            item.ingestedAt,
            trustedCurrentTimeMs
          )
          if (
            !referenceId ||
            !/^hvr1_evidence_[a-f0-9]{64}$/.test(referenceId) ||
            !recordedAt ||
            ingestedAt === undefined
          )
            return null
          return { id: referenceId, recordedAt, ingestedAt }
        })
      : null
  const eventProtection = enumValue(source.eventProtection, [
    'MFA_SATISFIED',
    'BLOCKED_BY_POLICY',
    'NOT_REPORTED',
  ] as const)
  const caveats = boundedStringList(source.caveats, 20, 500)
  const rawActions = source.recommendedActions
  const actions =
    Array.isArray(rawActions) && rawActions.length <= recommendationCodes.length
      ? rawActions.map(adaptRecommendedAction)
      : null
  if (
    !id ||
    !/^hvr1_contribution_[a-f0-9]{64}$/.test(id) ||
    !ruleId ||
    !ruleVersion ||
    (catalogued && ruleVersion !== catalogued.version) ||
    !priority ||
    (catalogued && priority !== catalogued.priority) ||
    !confidence ||
    !activityState ||
    !title ||
    !explanation ||
    !firstSeen ||
    !lastSeen ||
    !evaluatedAt ||
    signals === false ||
    !activityWindowEndsAt ||
    Date.parse(activityWindowEndsAt) < Date.parse(lastSeen) ||
    Date.parse(activityWindowEndsAt) - Date.parse(lastSeen) >
      (ruleId === 'HV-ID-MBX-001.v1'
        ? 36 * 60 * 60_000
        : ruleId === 'HV-ID-AUTH-005.v2'
          ? 10 * 60_000
          : catalogued
            ? 15 * 60_000
            : DEFAULT_ACTIVITY_WINDOW_TOLERANCE_MS) ||
    new Date(firstSeen).getTime() > new Date(lastSeen).getTime() ||
    new Date(lastSeen).getTime() >
      new Date(evaluatedAt).getTime() + MAX_FUTURE_SKEW_MS ||
    !window ||
    !Number.isSafeInteger(source.evidenceCount) ||
    (source.evidenceCount as number) < 1 ||
    (source.evidenceCount as number) > MAX_ASSESSMENT_COUNT ||
    typeof source.evidenceCountCapped !== 'boolean' ||
    !selectedSource ||
    (catalogued &&
      !(catalogued.sources as readonly string[]).includes(selectedSource)) ||
    !application ||
    !hasKeys(application, ['id', 'state', 'label']) ||
    !applicationState ||
    (application.label !== null && !applicationLabel) ||
    (applicationState === 'RESOLVED'
      ? typeof application.id !== 'string' ||
        !/^hvr1_application_[a-f0-9]{64}$/.test(application.id)
      : application.id !== null || application.label !== null) ||
    !device ||
    !hasKeys(device, ['state', 'label']) ||
    !deviceState ||
    device.label !== null ||
    !client ||
    !hasKeys(client, ['reference', 'qualification']) ||
    !qualification ||
    (client.reference !== null &&
      (typeof client.reference !== 'string' ||
        !/^hvr1_context_[a-f0-9]{64}$/.test(client.reference))) ||
    (qualification === 'QUALIFIED' && client.reference === null) ||
    (ruleId !== 'HV-ID-MBX-001.v1' && applicationState !== 'RESOLVED') ||
    (ruleId === 'HV-ID-AUTH-005.v2' && qualification !== 'QUALIFIED') ||
    !references ||
    references.some((reference) => reference === null) ||
    new Set(references.map((reference) => reference?.id)).size !==
      references.length ||
    !eventProtection ||
    !caveats ||
    !actions ||
    actions.some((action) => action === null) ||
    new Set(actions.map((action) => action?.code)).size !== actions.length
  )
    return null
  return {
    id,
    ruleId,
    ruleVersion,
    priority,
    confidence,
    activityState,
    title,
    explanation,
    firstSeen,
    lastSeen,
    evaluatedAt,
    activityWindowEndsAt,
    window,
    evidenceCount: source.evidenceCount as number,
    evidenceCountCapped: source.evidenceCountCapped,
    signals: signals as FindingSignal[] | null,
    selectedSource,
    application: {
      id: application.id as string | null,
      state: applicationState,
      label: applicationLabel,
    },
    device: { state: deviceState, label: null },
    clientSource: {
      reference: client.reference as string | null,
      qualification,
    },
    evidenceReferences:
      references as RiskAssessmentFinding['evidenceReferences'],
    eventProtection,
    caveats,
    recommendedActions: actions as RiskRecommendedAction[],
  }
}

/** The approved detector copy uses these exact phrases, not credential values. */
function assessmentText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string' || value.length > maximum) return null
  const probe = value.replace(
    /invalid-credential (?=attempts|failures)/g,
    'invalid-authentication '
  )
  return boundedString(probe, maximum + 20) ? value.trim() : null
}

const priorityRank = { LOW: 1, MEDIUM: 2, HIGH: 3 } as const

/** Resolved directory/policy labels may legitimately mention password or token policy. */
function authorizedLabel(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  const label = value.trim()
  if (
    !label ||
    label.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(label) ||
    /\b(?:password|passwd|pwd|secret|token|access_token|refresh_token|authorization|cookie)\s*[:=]\s*\S+/i.test(
      label
    ) ||
    /\bbearer\s+[A-Za-z0-9._~+\/=:-]{8,}/i.test(label) ||
    /-----BEGIN .*PRIVATE KEY-----/.test(label) ||
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,})\b/.test(
      label
    )
  )
    return null
  return label
}

function adaptAssessmentUser(
  value: unknown,
  trustedCurrentTimeMs: number
): RiskAssessmentUser | null {
  const source = record(value)
  if (
    !source ||
    !hasKeys(source, [
      'id',
      'label',
      'subjectType',
      'priority',
      'protection',
      'findings',
    ])
  )
    return null
  const subjectType = enumValue(source.subjectType, [
    'USER',
    'MAILBOX',
  ] as const)
  const id = boundedString(source.id, 160)
  const label = authorizedLabel(source.label, 320)
  // Resolved for authorised callers at read time; never persisted in the
  // finding row. Absent on servers that do not resolve it, and absent is shown
  // as the opaque reference rather than as a blank identity.
  const displayName =
    source.displayName === undefined || source.displayName === null
      ? null
      : authorizedLabel(source.displayName, 320)
  const userPrincipalName =
    source.userPrincipalName === undefined || source.userPrincipalName === null
      ? null
      : authorizedLabel(source.userPrincipalName, 320)
  const correlation = adaptCorrelation(source.correlation)
  const priority =
    source.priority === null
      ? null
      : enumValue(source.priority, ['LOW', 'MEDIUM', 'HIGH'] as const)
  const protection = adaptProtection(source.protection, trustedCurrentTimeMs)
  const rawFindings = source.findings
  const findings =
    Array.isArray(rawFindings) && rawFindings.length <= 200
      ? rawFindings.map((finding) =>
          adaptAssessmentFinding(finding, trustedCurrentTimeMs)
        )
      : null
  const idPattern =
    subjectType === 'MAILBOX'
      ? /^hvr1_mailbox_[a-f0-9]{64}$/
      : /^hvr1_subject_[a-f0-9]{64}$/
  if (
    !subjectType ||
    !id ||
    !idPattern.test(id) ||
    !label ||
    /[<>{}\[\]\\]/.test(label) ||
    (source.priority !== null && !priority) ||
    !protection ||
    !findings ||
    findings.some((finding) => finding === null) ||
    findings.some(
      (finding) =>
        subjectType === 'MAILBOX' && finding?.ruleId !== 'HV-ID-MBX-001.v1'
    ) ||
    new Set(findings.map((finding) => finding?.id)).size !== findings.length
  )
    return null
  const currentPriorities = (findings as RiskAssessmentFinding[])
    .filter((finding) => finding.activityState === 'CURRENT')
    .map((finding) => finding.priority)
  const highestCurrent =
    currentPriorities.length > 0
      ? currentPriorities.reduce((highest, candidate) =>
          priorityRank[candidate] > priorityRank[highest] ? candidate : highest
        )
      : null
  if (priority !== highestCurrent) return null
  if (
    correlation === undefined ||
    (source.displayName !== undefined &&
      source.displayName !== null &&
      !displayName) ||
    (source.userPrincipalName !== undefined &&
      source.userPrincipalName !== null &&
      !userPrincipalName)
  ) {
    return null
  }
  return {
    id,
    label,
    displayName,
    userPrincipalName,
    correlation,
    subjectType,
    priority,
    protection,
    findings: findings as RiskAssessmentFinding[],
  }
}

export function adaptRiskAssessmentResponse(
  value: unknown,
  trustedCurrentTimeMs = Date.now()
): RiskAssessment | null {
  const source = record(value)
  const rootKeys = [
    'version',
    'schemaVersion',
    'meta',
    'sources',
    'rules',
    'users',
    'page',
  ] as const
  const hasSummary = Boolean(
    source && Object.prototype.hasOwnProperty.call(source, 'summary')
  )
  if (!source || !hasKeys(source, rootKeys)) return null
  const rawMeta = record(source.meta)
  if (
    source.version !== 1 ||
    source.schemaVersion !== assessmentSchema ||
    !rawMeta ||
    !hasKeys(rawMeta, assessmentMetaKeys) ||
    rawMeta.version !== 1 ||
    rawMeta.channel !== 'HAWKVIEW_IDENTITY_SIGNALS'
  )
    return null
  const meta = adaptAssessmentMeta(rawMeta, trustedCurrentTimeMs)
  const sources =
    Array.isArray(source.sources) &&
    source.sources.length <= assessmentSources.length
      ? source.sources.map((item) =>
          adaptSourceReadiness(item, trustedCurrentTimeMs)
        )
      : null
  const rules =
    Array.isArray(source.rules) && source.rules.length <= MAX_REPORTED_RULES
      ? source.rules.map((item) =>
          adaptRuleReadiness(item, trustedCurrentTimeMs)
        )
      : null
  const users =
    Array.isArray(source.users) && source.users.length <= MAX_PAGE_SIZE
      ? source.users.map((item) =>
          adaptAssessmentUser(item, trustedCurrentTimeMs)
        )
      : null
  const page = adaptPageInfo(source.page)
  const summary = hasSummary
    ? adaptAssessmentSummary(source.summary, trustedCurrentTimeMs)
    : null
  if (
    !meta ||
    !sources ||
    sources.some((item) => item === null) ||
    new Set(sources.map((item) => item?.source)).size !== sources.length ||
    !rules ||
    rules.some((item) => item === null) ||
    new Set(rules.map((item) => item?.ruleId)).size !== rules.length ||
    !users ||
    users.some((item) => item === null) ||
    new Set(users.map((item) => item?.id)).size !== users.length ||
    !page ||
    (hasSummary && !summary)
  )
    return null
  const sourceSet = new Set(
    (sources as RiskSourceReadiness[]).map((item) => item.source)
  )
  const ruleSet = new Set(
    (rules as RiskRuleReadiness[]).map((item) => item.ruleId)
  )
  const findings = (users as RiskAssessmentUser[]).flatMap(
    (user) => user.findings
  )
  if (
    findings.length > 200 ||
    (rules as RiskRuleReadiness[]).some(
      (rule) =>
        rule.selectedSource !== null && !sourceSet.has(rule.selectedSource)
    ) ||
    findings.some(
      (finding) =>
        !ruleSet.has(finding.ruleId) || !sourceSet.has(finding.selectedSource)
    ) ||
    new Set(findings.map((finding) => finding.id)).size !== findings.length
  )
    return null
  // Never let an optimistic aggregate override individual source/rule coverage.
  // INAPPLICABLE is excluded deliberately: a check that cannot run on this
  // tenant's evidence is not incomplete collection, and treating it as such
  // would make an exact count unreachable on every audit-log-fallback tenant.
  // What it does instead is bound the claim, which travels with the count as
  // scope rather than as a coverage gap.
  const complete = (rules as RiskRuleReadiness[]).every(
    (rule) =>
      rule.status === 'INAPPLICABLE' ||
      (rule.status === 'READY' &&
        !rule.countsCapped &&
        rule.evaluatedAt !== null &&
        rule.window.start !== null &&
        rule.window.end !== null &&
        (sources as RiskSourceReadiness[]).some(
          (item) =>
            item.source === rule.selectedSource &&
            item.status === 'READY' &&
            item.freshness === 'CURRENT' &&
            item.lastSuccessfulCollectionAt !== null
        ))
  )
  if (meta.capability === 'FULL' && !complete) {
    meta.capability = 'PARTIAL'
    meta.freshness = 'UNKNOWN'
    meta.limitation =
      'Some checks lack complete current evidence. Review individual source and rule readiness.'
  }
  const returnedCurrentUsers = new Set(
    (users as RiskAssessmentUser[])
      .filter(
        (user) =>
          user.subjectType === 'USER' &&
          user.findings.some((finding) => finding.activityState === 'CURRENT')
      )
      .map((user) => user.id)
  ).size
  if (
    summary &&
    (summary.asOf !== meta.evaluatedAt ||
      (summary.currentUsers.value !== null &&
        summary.currentUsers.value < returnedCurrentUsers) ||
      (summary.currentUsers.accuracy === 'EXACT' &&
        (meta.status !== 'AVAILABLE' ||
          meta.capability !== 'FULL' ||
          meta.freshness !== 'CURRENT')) ||
      (summary.currentUsers.accuracy === 'AT_LEAST' &&
        (meta.status !== 'AVAILABLE' || meta.capability !== 'PARTIAL')))
  ) {
    return null
  }
  return {
    version: 1,
    schemaVersion: assessmentSchema,
    meta,
    sources: sources as RiskSourceReadiness[],
    rules: rules as RiskRuleReadiness[],
    users: users as RiskAssessmentUser[],
    page,
    summary,
  }
}

function adaptAssessmentSummary(
  value: unknown,
  trustedCurrentTimeMs: number
): RiskAssessmentSummary | null {
  const source = record(value)
  if (!source || !hasKeys(source, ['scope', 'asOf', 'currentUsers'])) {
    return null
  }
  const currentUsers = record(source.currentUsers)
  if (
    source.scope !== 'TENANT' ||
    !currentUsers ||
    !hasKeys(currentUsers, ['value', 'accuracy'])
  ) {
    return null
  }
  const asOf = nullableDateTime(source.asOf, trustedCurrentTimeMs)
  const count = nullableCount(currentUsers.value)
  const accuracy = enumValue(currentUsers.accuracy, [
    'EXACT',
    'AT_LEAST',
    'UNKNOWN',
  ] as const)
  // Optional and additive, and accepted in either form: a single `reason` from
  // the older shape, or a `reasons` array. Both normalise to a list, because
  // more than one cause can hold at once and the UI must be able to show all of
  // them rather than the first.
  const rawReasons =
    currentUsers.reasons !== undefined
      ? currentUsers.reasons
      : currentUsers.reason === undefined || currentUsers.reason === null
        ? []
        : [currentUsers.reason]
  const reasons =
    Array.isArray(rawReasons) &&
    rawReasons.length <= assessmentCountReasons.length
      ? rawReasons.map((item) => enumValue(item, assessmentCountReasons))
      : null
  if (
    asOf === undefined ||
    count === undefined ||
    !accuracy ||
    !reasons ||
    reasons.some((item) => item === null) ||
    new Set(reasons).size !== reasons.length ||
    // A reason explains a withheld or bounded total. Attaching one to an exact
    // count would be a contradiction.
    (accuracy === 'EXACT' && reasons.length > 0) ||
    (accuracy === 'UNKNOWN' && count !== null) ||
    (accuracy !== 'UNKNOWN' && (count === null || asOf === null)) ||
    (accuracy === 'AT_LEAST' && count === 0)
  ) {
    return null
  }
  return {
    scope: 'TENANT',
    asOf,
    currentUsers: {
      value: count,
      accuracy,
      reasons: reasons as RiskAssessmentCountReason[],
    },
  }
}

function adaptAssessmentMeta(
  value: RecordValue,
  now: number
): IdentityRiskChannelMeta | null {
  const capability = enumValue(value.capability, capabilities)
  const status = enumValue(value.status, statuses)
  const freshness = enumValue(value.freshness, freshnessValues)
  const evaluatedAt = nullableDateTime(value.evaluatedAt, now)
  const observedAt = nullableDateTime(value.observedAt, now)
  const limitation =
    value.limitation === null ? null : boundedString(value.limitation, 600)
  const reasonCode =
    value.reasonCode === undefined || value.reasonCode === null
      ? null
      : enumValue(value.reasonCode, channelReasons)
  if (
    !capability ||
    !status ||
    !freshness ||
    evaluatedAt === undefined ||
    observedAt === undefined ||
    value.sourceLabel !== 'HawkView independent identity evidence' ||
    value.engineVersion !== hawkViewEngineVersion ||
    value.catalogVersion !== hawkViewCatalogVersion ||
    (value.limitation !== null && !limitation) ||
    (value.reasonCode !== undefined &&
      value.reasonCode !== null &&
      !reasonCode) ||
    (status === 'AVAILABLE' &&
      (!evaluatedAt || capability === 'UNAVAILABLE')) ||
    (capability === 'FULL' &&
      (status !== 'AVAILABLE' || freshness !== 'CURRENT'))
  )
    return null
  return {
    capability,
    status,
    freshness,
    sourceLabel: value.sourceLabel,
    engineVersion: hawkViewEngineVersion,
    catalogVersion: hawkViewCatalogVersion,
    evaluatedAt,
    observedAt,
    limitation,
    reasonCode,
  }
}

export function adaptMicrosoftRiskyUsersResponse(value: unknown) {
  return adaptIdentityRiskResponses({
    hawkViewSummary: null,
    hawkViewFindings: null,
    microsoftRiskyUsers: value,
  }).microsoft
}
