import type {
  HawkViewIdentityFinding,
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
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000
const hawkViewSourceLabel = 'HawkView Identity Signals'
const microsoftSourceLabel = 'Microsoft Entra Risky Users'

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
const guidanceCodes = new Set([
  'REVIEW_ACTIVITY',
  'REVIEW_ACCESS',
  'REVIEW_MAILBOX_RULE',
  'REVIEW_CONFIGURATION',
])
const benignAlternativeCodes = new Set([
  'APPROVED_ACCOUNT_PROVISIONING',
  'APPROVED_SHARED_CONTEXT',
])
const sourceLabelCatalog = new Set([
  'Microsoft Entra directory audit',
  'Microsoft Entra sign-in activity',
  'Microsoft 365 Unified Audit',
  'Exchange Online mailbox audit',
])
const missingEvidenceCatalog = new Set([
  'ACCOUNT_CLASS_COVERAGE_INCOMPLETE',
  'ACCOUNT_CLASS_UNSUPPORTED',
  'ACCOUNT_CLASS_UNVERIFIED',
  'INSUFFICIENT_INDEPENDENT_CONTEXT',
  'MAILBOX_RULE_PROJECTION_INCOMPLETE',
  'RULE_CONFIG_UNAPPROVED',
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
  return (
    /\b(?:password|passwd|pwd|secret|token|access[-_ ]?token|refresh[-_ ]?token|api[-_ ]?key|client[-_ ]?secret|authorization|bearer|private[-_ ]?key|session[-_ ]?id)\s*[:=]/i.test(value) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value) ||
    /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/i.test(value) ||
    /[?&](?:access_token|refresh_token|token|code|key|sig|password|secret)=/i.test(value)
  )
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
  if (!candidate) return null
  const parsed = new Date(candidate)
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.getTime() > Date.now() + MAX_FUTURE_SKEW_MS
  ) {
    return null
  }
  return candidate
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
    observedAt: null,
    limitation,
  }
}

function adaptMeta(
  value: RecordValue,
  expectedSourceLabel: typeof hawkViewSourceLabel | typeof microsoftSourceLabel
): IdentityRiskChannelMeta | null {
  const capability = enumValue(value.capability, capabilities)
  const status = enumValue(value.status, statuses)
  const freshness = enumValue(value.freshness, freshnessValues)
  const sourceLabel = boundedString(value.sourceLabel, 160)
  const observedAt = value.observedAt === null ? null : dateTime(value.observedAt)
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
    (value.observedAt !== null && !observedAt) ||
    (value.limitation !== null && !limitation)
  ) {
    return null
  }

  const coherentState =
    (status === 'AVAILABLE' &&
      capability !== 'UNAVAILABLE' &&
      freshness === 'CURRENT' &&
      observedAt !== null) ||
    (status === 'STALE' &&
      capability !== 'UNAVAILABLE' &&
      freshness === 'STALE' &&
      observedAt !== null) ||
    (status === 'LEARNING' &&
      capability !== 'UNAVAILABLE' &&
      freshness === 'UNKNOWN') ||
    ((status === 'NOT_EVALUATED' || status === 'UNAVAILABLE' || status === 'ERROR') &&
      capability === 'UNAVAILABLE' &&
      freshness === 'UNKNOWN')

  if (!coherentState) return null

  return {
    capability,
    status,
    freshness,
    sourceLabel,
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
      (!nextCursor || !/^[A-Za-z0-9._~+\/=:-]+$/.test(nextCursor))) ||
    (source.hasMore && nextCursor === null) ||
    (!source.hasMore && nextCursor !== null)
  ) {
    return null
  }
  return { hasMore: source.hasMore, nextCursor }
}

function adaptFinding(value: unknown): HawkViewIdentityFinding | null {
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
  const observedAt = dateTime(source.observedAt)
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
    !guidanceCodes.has(investigationGuidanceCode) ||
    !investigationGuidance ||
    !/^(?:Review|Confirm|Compare|Investigate)\b/.test(investigationGuidance) ||
    /\b(?:disable|reset|revoke|delete|remove|block|suspend|terminate|quarantine)\b/i.test(
      investigationGuidance
    )
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
    investigationGuidance,
  }
}

function adaptMicrosoftUser(value: unknown): MicrosoftEntraRiskyUser | null {
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
  const observedAt = dateTime(source.observedAt)

  if (
    !id ||
    !/^[A-Za-z0-9._:-]+$/.test(id) ||
    !identityLabel ||
    /[<>\[\]{}\\]/.test(identityLabel) ||
    !riskLevel ||
    !riskState ||
    (source.riskDetail !== null && source.riskDetail !== undefined &&
      (!riskDetail || !/^[A-Za-z][A-Za-z0-9]*$/.test(riskDetail))) ||
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
      'capability',
      'status',
      'sourceLabel',
      'observedAt',
      'freshness',
      'limitation',
      'findings',
    ]) &&
    Number.isSafeInteger(summary.findings) &&
    (summary.findings as number) >= 0 &&
    findingEnvelope?.version === 1 &&
    findingEnvelope.channel === 'HAWKVIEW_IDENTITY_SIGNALS' &&
    exactKeys(findingEnvelope, [
      'version',
      'channel',
      'capability',
      'status',
      'sourceLabel',
      'observedAt',
      'freshness',
      'limitation',
      'findings',
      'pageInfo',
    ])
  ) {
    const meta = adaptMeta(summary, hawkViewSourceLabel)
    const findingMeta = adaptMeta(findingEnvelope, hawkViewSourceLabel)
    const rawFindings = findingEnvelope.findings
    const findings = Array.isArray(rawFindings) && rawFindings.length <= MAX_PAGE_SIZE
      ? rawFindings.map(adaptFinding)
      : null
    const pageInfo = adaptPageInfo(findingEnvelope.pageInfo)
    if (
      meta &&
      findingMeta &&
      sameMeta(meta, findingMeta) &&
      findings &&
      findings.every((finding): finding is HawkViewIdentityFinding => finding !== null) &&
      new Set(findings.map((finding) => finding.id)).size === findings.length &&
      pageInfo &&
      (pageInfo.hasMore
        ? (summary.findings as number) > findings.length
        : summary.findings === findings.length)
    ) {
      hawkView = {
        channel: 'HAWKVIEW_IDENTITY_SIGNALS',
        meta,
        findings,
        pageInfo,
      }
    } else {
      hawkView = unavailableHawkViewIdentitySignals(
        'ERROR',
        'HawkView identity signal data did not match the supported frontend contract.'
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
      'capability',
      'status',
      'sourceLabel',
      'observedAt',
      'freshness',
      'limitation',
      'users',
      'pageInfo',
    ])
  ) {
    const meta = adaptMeta(microsoftEnvelope, microsoftSourceLabel)
    const rawUsers = microsoftEnvelope.users
    const users = Array.isArray(rawUsers) && rawUsers.length <= MAX_PAGE_SIZE
      ? rawUsers.map(adaptMicrosoftUser)
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
      microsoft = unavailableMicrosoftEntraRiskyUsers(
        'ERROR',
        'Microsoft Entra risky-user data did not match the supported frontend contract.'
      )
    }
  }

  return { hawkView, microsoft }
}
