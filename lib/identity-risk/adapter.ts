import type {
  HawkViewIdentityFinding,
  HawkViewIdentityRiskCounts,
  HawkViewIdentitySignalsView,
  IdentityRiskCapability,
  IdentityRiskChannelMeta,
  IdentityRiskChannelStatus,
  IdentityRiskFreshness,
  IdentityRiskPageInfo,
  IdentityRiskViewModel,
  MicrosoftEntraRiskyUser,
  MicrosoftEntraRiskyUsersView,
} from './types'

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
const MAX_PAGE_SIZE = 100
const MAX_SUMMARY_COUNT = 10_000
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000
const hawkViewSourceLabel = 'HawkView Identity Signals'
const microsoftSourceLabel = 'Microsoft Entra Risky Users'
const hawkViewEngineVersion = 'hawkview-identity-engine/1'
const hawkViewCatalogVersion = 'hawkview-identity-signals/v1'
const microsoftCatalogVersion = 'microsoft-entra-risky-users/v1'

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

function record(value: unknown): RecordValue | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? (value as RecordValue)
    : null
}

function exactKeys(value: RecordValue, keys: readonly string[]) {
  const actual = Object.keys(value)
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
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
      /\b(?:password|passwd|pwd|secret|token|access[-_ ]?token|refresh[-_ ]?token|api[-_ ]?key|client[-_ ]?secret|authorization|authorization[-_ ]?code|private[-_ ]?key|session[-_ ]?id|oauth[-_ ]?code|account[-_ ]?key|signature|sig|code|credential|cookie)\b[\s"'\[\]{}:,=%]+\S+/i.test(candidate) ||
      /\bbearer\s+[A-Za-z0-9._~+\/=:-]{8,}/i.test(candidate) ||
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(candidate) ||
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,})\b/.test(candidate) ||
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(candidate) ||
      /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/i.test(candidate) ||
      /[?&](?:access_token|refresh_token|token|code|key|sig|password|secret)=/i.test(candidate)
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
  return candidateTime <= new Date(evaluatedAt).getTime() + MAX_FUTURE_SKEW_MS &&
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
  limitation: string
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
  const evaluatedAt = value.evaluatedAt === null ? null : dateTime(value.evaluatedAt)
  const observedAt =
    value.observedAt === null || !evaluatedAt
      ? null
      : observedDateTime(
          value.observedAt,
          evaluatedAt,
          trustedCurrentTimeMs
        )
  const limitation =
    value.limitation === null
      ? null
      : boundedString(value.limitation, 500)

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
    (value.limitation !== null && !limitation)
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
  }
}

function sameMeta(left: IdentityRiskChannelMeta, right: IdentityRiskChannelMeta) {
  return (
    left.capability === right.capability &&
    left.status === right.status &&
    left.freshness === right.freshness &&
    left.sourceLabel === right.sourceLabel &&
    left.engineVersion === right.engineVersion &&
    left.catalogVersion === right.catalogVersion &&
    left.evaluatedAt === right.evaluatedAt &&
    left.observedAt === right.observedAt &&
    left.limitation === right.limitation
  )
}

function adaptPageInfo(value: unknown): IdentityRiskPageInfo | null {
  const source = record(value)
  if (!source || !exactKeys(source, ['hasMore', 'nextCursor'])) return null
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
  if (!source || !exactKeys(source, ['value', 'exact', 'capped'])) return null
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
  if (!source || !exactKeys(source, keys)) return null

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
    !exactKeys(source, [
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
  const state = enumValue(source.state, ['OPEN', 'UPDATED', 'RESOLVED', 'EXPIRED'] as const)
  const severity = enumValue(source.severity, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const)
  const confidence = enumValue(source.confidence, ['LOW', 'MEDIUM', 'HIGH'] as const)
  const coverage = enumValue(source.coverage, capabilities)
  const title = boundedString(source.title, 160)
  const explanation = boundedString(source.explanation, 1_000)
  const affectedIdentitySource = record(source.affectedIdentity)
  if (
    !affectedIdentitySource ||
    !exactKeys(affectedIdentitySource, ['id', 'label', 'type'])
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
  const sourceLabels = catalogList(source.sourceLabels, sourceLabelCatalog, 10, 120)
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
  const investigationGuidanceCode = boundedString(source.investigationGuidanceCode, 120)
  const investigationGuidance = boundedString(source.investigationGuidance, 300)
  const catalogGuidance = investigationGuidanceCode
    ? guidanceCatalog[
        investigationGuidanceCode as keyof typeof guidanceCatalog
      ]
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
    !exactKeys(source, [
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
    (source.riskDetail !== null && source.riskDetail !== undefined &&
      (!riskDetail || !microsoftRiskDetailCatalog.has(riskDetail))) ||
    !observedAt
  ) {
    return null
  }

  return { id, identityLabel, riskLevel, riskState, riskDetail, observedAt }
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
  limitation: string
): MicrosoftEntraRiskyUsersView {
  return {
    channel: 'MICROSOFT_ENTRA_RISKY_USERS',
    meta: fallbackMeta(status, limitation),
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
    exactKeys(summary, [
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
    exactKeys(findingEnvelope, [
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
      findings.every((finding): finding is HawkViewIdentityFinding => finding !== null) &&
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
    exactKeys(microsoftEnvelope, [
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
