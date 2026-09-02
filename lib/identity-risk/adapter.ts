import type {
  HawkViewIdentityFinding,
  HawkViewIdentitySignalsView,
  IdentityRiskCapability,
  IdentityRiskChannelMeta,
  IdentityRiskChannelStatus,
  IdentityRiskFreshness,
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

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null
}

function boundedString(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) {
    return null
  }
  return normalized
}

function dateTime(value: unknown): string | null {
  const candidate = boundedString(value, 100)
  if (!candidate) return null
  const parsed = new Date(candidate)
  return Number.isFinite(parsed.getTime()) ? candidate : null
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T
): T[number] | null {
  return typeof value === 'string' && allowed.includes(value)
    ? (value as T[number])
    : null
}

function boundedStringList(value: unknown, maxItems = 20): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null
  const values = value.map((item) => boundedString(item, 200))
  return values.every((item): item is string => item !== null) ? values : null
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

function adaptMeta(value: RecordValue): IdentityRiskChannelMeta | null {
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
    (value.observedAt !== null && !observedAt) ||
    (value.limitation !== null && !limitation)
  ) {
    return null
  }

  return {
    capability,
    status,
    freshness,
    sourceLabel,
    observedAt,
    limitation,
  }
}

function adaptFinding(value: unknown): HawkViewIdentityFinding | null {
  const source = record(value)
  if (!source) return null
  const id = boundedString(source.id, 200)
  const state = enumValue(source.state, ['OPEN', 'UPDATED', 'RESOLVED', 'EXPIRED'] as const)
  const severity = enumValue(source.severity, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const)
  const confidence = enumValue(source.confidence, ['LOW', 'MEDIUM', 'HIGH'] as const)
  const coverage = enumValue(source.coverage, capabilities)
  const title = boundedString(source.title, 200)
  const explanation = boundedString(source.explanation, 1_000)
  const affectedIdentitySource = record(source.affectedIdentity)
  const affectedIdentityId = boundedString(affectedIdentitySource?.id, 200)
  const affectedIdentityLabel = boundedString(affectedIdentitySource?.label, 200)
  const affectedIdentityType = enumValue(affectedIdentitySource?.type, [
    'USER',
    'MAILBOX',
    'APPLICATION',
    'UNKNOWN',
  ] as const)
  const observedAt = dateTime(source.observedAt)
  const ruleIds = boundedStringList(source.ruleIds, 10)
  const sourceLabels = boundedStringList(source.sourceLabels, 10)
  const missingEvidenceLabels = boundedStringList(source.missingEvidenceLabels, 20)
  const benignAlternativeCodes = boundedStringList(source.benignAlternativeCodes, 10)
  const investigationGuidanceCode = boundedString(source.investigationGuidanceCode, 120)
  const investigationGuidance = boundedString(source.investigationGuidance, 500)

  if (
    !id ||
    !state ||
    !severity ||
    !confidence ||
    !coverage ||
    !title ||
    !explanation ||
    !affectedIdentityId ||
    !affectedIdentityLabel ||
    !affectedIdentityType ||
    !observedAt ||
    !ruleIds ||
    ruleIds.length === 0 ||
    !sourceLabels ||
    sourceLabels.length === 0 ||
    !missingEvidenceLabels ||
    !benignAlternativeCodes ||
    !investigationGuidanceCode ||
    !investigationGuidance
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
    benignAlternativeCodes,
    investigationGuidanceCode,
    investigationGuidance,
  }
}

function adaptMicrosoftUser(value: unknown): MicrosoftEntraRiskyUser | null {
  const source = record(value)
  if (!source) return null
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
    !identityLabel ||
    !riskLevel ||
    !riskState ||
    (source.riskDetail !== null && source.riskDetail !== undefined && !riskDetail) ||
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
    findingEnvelope?.version === 1 &&
    findingEnvelope.channel === 'HAWKVIEW_IDENTITY_SIGNALS'
  ) {
    const meta = adaptMeta(summary)
    const findingMeta = adaptMeta(findingEnvelope)
    const rawFindings = findingEnvelope.findings
    const findings = Array.isArray(rawFindings)
      ? rawFindings.map(adaptFinding)
      : null
    if (
      meta &&
      findingMeta &&
      meta.status === findingMeta.status &&
      meta.capability === findingMeta.capability &&
      findings &&
      findings.every((finding): finding is HawkViewIdentityFinding => finding !== null)
    ) {
      hawkView = {
        channel: 'HAWKVIEW_IDENTITY_SIGNALS',
        meta,
        findings,
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
    microsoftEnvelope.channel === 'MICROSOFT_ENTRA_RISKY_USERS'
  ) {
    const meta = adaptMeta(microsoftEnvelope)
    const rawUsers = microsoftEnvelope.users
    const users = Array.isArray(rawUsers) ? rawUsers.map(adaptMicrosoftUser) : null
    if (
      meta &&
      users &&
      users.every((user): user is MicrosoftEntraRiskyUser => user !== null)
    ) {
      microsoft = {
        channel: 'MICROSOFT_ENTRA_RISKY_USERS',
        meta,
        users,
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
