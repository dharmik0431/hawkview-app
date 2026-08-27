import type {
  AuditEvent,
  AuditModifiedProperty,
  AuditTargetResource,
  SignInEvent,
} from './types'

type RecordValue = Record<string, unknown>

const MAX_EVIDENCE_LENGTH = 512
const MAX_DIAGNOSTIC_LENGTH = 2_000
const MAX_TARGETS = 25
const MAX_MODIFIED_PROPERTIES = 50
const MAX_POLICIES = 50

const SENSITIVE_KEY =
  /^(?:password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|authorization|authorization[_-]?code|oauth[_-]?(?:authorization[_-]?)?code|code|sig|signature|cookie|set-cookie|accountkey|private[_-]?key)$/i
const SENSITIVE_ASSIGNMENT =
  /(?:^|[\s"'`{[(,;])(?:password|passwd|pwd|secret|client[\s_-]*secret|token|access[\s_-]*token|refresh[\s_-]*token|id[\s_-]*token|api[\s_-]*key|apikey|authorization|authorization[\s_-]*code|oauth[\s_-]*(?:authorization[\s_-]*)?code|code|sig|signature|cookie|set-cookie|accountkey|private[\s_-]*key)\s*["']?\s*[:=]/i
const BEARER_OR_JWT =
  /\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/i
const EMBEDDED_STRUCTURE = /(?:^|\s)(?:\{|\[)\s*(?:"|'|\{|\[)/
const UNSAFE_OBJECT_KEY = /^(?:__proto__|prototype|constructor)$/i
const SAFE_PROPERTY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:/()[\]\-]{0,127}$/
const MALFORMED_PERCENT_ENCODING = /%(?![0-9A-Fa-f]{2})/

function isRecord(value: unknown): value is RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownValue(source: unknown, key: string): unknown {
  if (!isRecord(source) || UNSAFE_OBJECT_KEY.test(key)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function stripUrlCredentialsAndQuery(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, (candidate) => {
    try {
      const parsed = new URL(candidate)
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
    } catch {
      return '[Redacted URL]'
    }
  })
}

function containsUnsafeDiagnosticShape(value: string) {
  return (
    SENSITIVE_ASSIGNMENT.test(value) ||
    BEARER_OR_JWT.test(value) ||
    EMBEDDED_STRUCTURE.test(value)
  )
}

/**
 * Inspects the original scalar and no more than two percent-decoded forms.
 * Decoded content is used only for rejection and is never returned to callers.
 */
function passesBoundedEncodedInspection(value: string, maxLength: number) {
  let inspection = value
  for (let layer = 0; layer <= 2; layer += 1) {
    if (
      inspection.length > maxLength ||
      containsUnsafeDiagnosticShape(inspection)
    ) {
      return false
    }
    if (!inspection.includes('%')) return true
    if (MALFORMED_PERCENT_ENCODING.test(inspection)) return false
    if (layer === 2) return false

    try {
      const decoded = decodeURIComponent(inspection)
      if (decoded.length > maxLength) return false
      if (decoded === inspection) return true
      inspection = decoded
    } catch {
      return false
    }
  }
  return false
}

/** Bounded scalar evidence safe for UI and CSV. Objects are never serialized. */
export function sanitizeActivityText(
  value: unknown,
  maxLength = MAX_EVIDENCE_LENGTH,
): string | undefined {
  if (
    typeof value !== 'string' &&
    !(typeof value === 'number' && Number.isFinite(value))
  ) {
    return undefined
  }

  const original = String(value)
  if (
    original.length > maxLength ||
    !passesBoundedEncodedInspection(original, maxLength)
  ) {
    return '[Redacted]'
  }

  let text = original
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined

  // A credential marker invalidates the whole scalar. Partial replacement can
  // leave trailing words from whitespace-containing secrets.
  text = stripUrlCredentialsAndQuery(text)
  if (text.length > maxLength) return '[Redacted]'
  return text
}

function reportedText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const sanitized = sanitizeActivityText(value)
    if (sanitized) return sanitized
  }
  return undefined
}

function diagnosticText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const sanitized = sanitizeActivityText(value, MAX_DIAGNOSTIC_LENGTH)
    if (sanitized && sanitized !== '[Redacted]') return sanitized
  }
  return undefined
}

function reportedTimestamp(...values: unknown[]): string {
  const value = reportedText(...values)
  if (!value) return ''
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? value : ''
}

function internalRowKey(
  kind: 'signin' | 'audit',
  tenantId: string | undefined,
  index: number,
  ...parts: unknown[]
) {
  const seed = [kind, tenantId ?? 'tenant-not-reported', index, ...parts]
    .map((part) => reportedText(part) ?? 'not-reported')
    .join('|')

  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `row-${kind}-${(hash >>> 0).toString(16)}`
}

function normalizeSignInResult(value: unknown): SignInEvent['status'] {
  const normalized = reportedText(value)?.toLowerCase()
  if (!normalized) return 'Not reported'
  if (['success', 'succeeded', 'ok', '0'].includes(normalized)) return 'Success'
  if (['failure', 'failed', 'error'].includes(normalized)) return 'Failure'
  return 'Not reported'
}

function normalizeConditionalAccess(
  source: RecordValue,
): SignInEvent['conditionalAccess'] {
  const policies = ownValue(source, 'appliedConditionalAccessPolicies')
  const raw = reportedText(
    ownValue(source, 'conditionalAccess'),
    ownValue(source, 'condAccess'),
    ownValue(source, 'appliedConditionalAccess'),
  )?.toLowerCase()
  if (Array.isArray(policies)) {
    if (policies.length > 0) return 'Applied'
    if (raw) return 'Not Applied'
  }
  if (['success', 'failure', 'applied', 'true'].includes(raw ?? '')) {
    return 'Applied'
  }
  if (['notapplied', 'not applied', 'false', 'none'].includes(raw ?? '')) {
    return 'Not Applied'
  }
  return 'Not reported'
}

function normalizePolicies(source: RecordValue): string[] | undefined {
  const policies = ownValue(source, 'appliedConditionalAccessPolicies')
  if (!Array.isArray(policies)) return undefined

  const normalized = policies
    .slice(0, MAX_POLICIES)
    .map((policy) => {
      if (typeof policy === 'string') return reportedText(policy)
      return reportedText(ownValue(policy, 'displayName'), ownValue(policy, 'name'))
    })
    .filter((policy): policy is string => Boolean(policy))
  return normalized.length ? normalized : undefined
}

function normalizeTargetResources(value: unknown): AuditTargetResource[] | undefined {
  if (!Array.isArray(value)) return undefined

  const targets = value.slice(0, MAX_TARGETS).flatMap((target) => {
    if (!isRecord(target)) return []
    const normalized: AuditTargetResource = {
      displayName: reportedText(ownValue(target, 'displayName')),
      userPrincipalName: reportedText(ownValue(target, 'userPrincipalName')),
      id: reportedText(ownValue(target, 'id')),
      type: reportedText(ownValue(target, 'type'), ownValue(target, 'groupType')),
    }
    return Object.values(normalized).some(Boolean) ? [normalized] : []
  })
  return targets.length ? targets : undefined
}

function normalizeModifiedProperties(value: unknown): AuditModifiedProperty[] | undefined {
  if (!Array.isArray(value)) return undefined

  const properties = value.slice(0, MAX_MODIFIED_PROPERTIES).flatMap((property) => {
    if (!isRecord(property)) return []
    const name = reportedText(ownValue(property, 'name'))
    if (!name || UNSAFE_OBJECT_KEY.test(name) || !SAFE_PROPERTY_NAME.test(name)) {
      return []
    }
    const canonicalName = name.replace(/[ .:/()[\]-]/g, '_')
    if (SENSITIVE_KEY.test(canonicalName)) return []
    // Property names are useful investigation context. Values are arbitrary
    // Microsoft payloads and are not carried into the beta UI/CSV contract.
    return [{ name }]
  })
  return properties.length ? properties : undefined
}

export function normalizeSignInEvent(
  source: RecordValue,
  context: { tenantId?: string; tenantName?: string; index: number },
): SignInEvent {
  const locationObject = ownValue(source, 'location')
  const deviceDetail = ownValue(source, 'deviceDetail')
  const createdAt = reportedTimestamp(
    ownValue(source, 'createdAt'),
    ownValue(source, 'ts'),
    ownValue(source, 'time'),
  )
  const userPrincipalName = reportedText(
    ownValue(source, 'userPrincipalName'),
    ownValue(source, 'upn'),
    ownValue(source, 'userPrincipal'),
  )
  const city = reportedText(
    ownValue(source, 'city'),
    ownValue(locationObject, 'city'),
  )
  const country = reportedText(
    ownValue(source, 'country'),
    ownValue(locationObject, 'country'),
  )
  const location =
    reportedText(typeof locationObject === 'string' ? locationObject : undefined) ??
    (city && country ? `${city}, ${country}` : city ?? country)
  const eventId = reportedText(ownValue(source, 'id'), ownValue(source, 'eventId'))

  return {
    rowKey: internalRowKey(
      'signin', context.tenantId, context.index, eventId, createdAt, userPrincipalName,
    ),
    eventId,
    createdAt,
    userDisplayName:
      reportedText(
        ownValue(source, 'userDisplayName'),
        ownValue(source, 'user'),
        ownValue(source, 'displayName'),
      ) ?? 'Not reported',
    userPrincipalName: userPrincipalName ?? 'Not reported',
    userId: reportedText(ownValue(source, 'userId')),
    appDisplayName:
      reportedText(ownValue(source, 'appDisplayName'), ownValue(source, 'app')) ??
      'Not reported',
    appId: reportedText(ownValue(source, 'appId'), ownValue(source, 'appIdGuid')),
    status: normalizeSignInResult(
      ownValue(source, 'status') ?? ownValue(source, 'result'),
    ),
    failureReason: diagnosticText(
      ownValue(source, 'failureReason'),
      ownValue(source, 'errorDetail'),
      ownValue(source, 'statusReason'),
    ),
    errorCode: reportedText(
      ownValue(source, 'errorCode'), ownValue(source, 'errorNumber'),
    ),
    additionalDetails: diagnosticText(ownValue(source, 'additionalDetails')),
    conditionalAccess: normalizeConditionalAccess(source),
    appliedCaPolicies: normalizePolicies(source),
    authMethod: reportedText(
      ownValue(source, 'authMethod'), ownValue(source, 'authenticationRequirement'),
    ),
    ipAddress: reportedText(ownValue(source, 'ipAddress'), ownValue(source, 'ip')),
    location,
    country,
    city,
    clientAppUsed: reportedText(
      ownValue(source, 'clientAppUsed'), ownValue(source, 'client'), ownValue(source, 'clientApp'),
    ),
    device: reportedText(
      ownValue(source, 'device'), ownValue(source, 'deviceName'), ownValue(deviceDetail, 'displayName'),
    ),
    os: reportedText(
      ownValue(source, 'os'), ownValue(source, 'operatingSystem'), ownValue(deviceDetail, 'operatingSystem'),
    ),
    browser: reportedText(ownValue(source, 'browser'), ownValue(deviceDetail, 'browser')),
    managedState:
      reportedText(ownValue(source, 'managedState')) ??
      (ownValue(deviceDetail, 'isCompliant') === true
        ? 'Compliant'
        : ownValue(deviceDetail, 'isManaged') === true
          ? 'Managed'
          : undefined),
    userAgent: diagnosticText(ownValue(source, 'userAgent')),
    tenantName: reportedText(context.tenantName),
    tenantId: reportedText(context.tenantId),
    correlationId: reportedText(ownValue(source, 'correlationId')),
    requestId: reportedText(ownValue(source, 'requestId')),
    riskLevel: reportedText(
      ownValue(source, 'riskLevel'), ownValue(source, 'riskState'), ownValue(source, 'risk'),
    ),
  }
}

export function normalizeAuditEvent(
  source: RecordValue,
  context: { tenantId?: string; tenantName?: string; index: number },
): AuditEvent {
  const initiatedBy = ownValue(source, 'initiatedBy')
  const initiatedUser = ownValue(initiatedBy, 'user')
  const initiatedApp = ownValue(initiatedBy, 'app')
  const actorValue = ownValue(source, 'actor')
  const actorName = reportedText(
    ownValue(initiatedUser, 'displayName'),
    ownValue(source, 'actorDisplayName'),
    typeof actorValue === 'string' && !actorValue.includes('@') ? actorValue : undefined,
    ownValue(source, 'user'),
    ownValue(initiatedApp, 'displayName'),
  )
  const actorPrincipalName = reportedText(
    ownValue(initiatedUser, 'userPrincipalName'),
    ownValue(initiatedApp, 'servicePrincipalName'),
    typeof actorValue === 'string' && actorValue.includes('@') ? actorValue : undefined,
  )
  const actorType = isRecord(initiatedUser)
    ? 'User'
    : isRecord(initiatedApp)
      ? 'Application'
      : reportedText(ownValue(source, 'actorType')) ?? 'Not reported'
  const actorId = reportedText(
    ownValue(initiatedUser, 'id'), ownValue(initiatedApp, 'id'), ownValue(source, 'actorId'),
  )
  const originalTargets = ownValue(source, 'targetResources')
  const targetResources = normalizeTargetResources(originalTargets)
  const primaryTarget = targetResources?.[0]
  const target =
    targetResources
      ?.map((item) => item.displayName ?? item.userPrincipalName ?? item.id)
      .filter((item): item is string => Boolean(item))
      .join(', ') || reportedText(ownValue(source, 'target'))
  const createdAt = reportedTimestamp(
    ownValue(source, 'createdAt'), ownValue(source, 'time'), ownValue(source, 'ts'),
  )
  const activity =
    reportedText(
      ownValue(source, 'activity'), ownValue(source, 'activityDisplayName'), ownValue(source, 'action'),
    ) ?? 'Not reported'
  const eventId = reportedText(ownValue(source, 'id'), ownValue(source, 'eventId'))
  const originalPrimaryTarget = Array.isArray(originalTargets) ? originalTargets[0] : undefined

  return {
    rowKey: internalRowKey(
      'audit', context.tenantId, context.index, eventId, createdAt, activity, actorPrincipalName,
    ),
    eventId,
    createdAt,
    activity,
    category: reportedText(ownValue(source, 'category')),
    operationType: reportedText(ownValue(source, 'operationType')),
    result:
      reportedText(ownValue(source, 'result'), ownValue(source, 'status')) ?? 'Not reported',
    resultReason: diagnosticText(
      ownValue(source, 'resultReason'), ownValue(source, 'statusReason'),
    ),
    correlationId: reportedText(ownValue(source, 'correlationId')),
    service: reportedText(ownValue(source, 'service'), ownValue(source, 'loggedByService')),
    actor: actorName ?? actorPrincipalName ?? 'Not reported',
    actorPrincipalName,
    actorType,
    actorId,
    target,
    targetType: primaryTarget?.type,
    targetId: primaryTarget?.id,
    targetResources,
    modifiedProperties: normalizeModifiedProperties(
      ownValue(originalPrimaryTarget, 'modifiedProperties') ?? ownValue(source, 'modifiedProperties'),
    ),
    tenantName: reportedText(context.tenantName),
    tenantId: reportedText(context.tenantId),
  }
}

export function hasIncompleteActivityEvidence(
  signIns: SignInEvent[],
  auditEvents: AuditEvent[],
) {
  return (
    signIns.some(
      (event) =>
        !event.createdAt ||
        event.status === 'Not reported' ||
        event.userPrincipalName === 'Not reported',
    ) ||
    auditEvents.some(
      (event) =>
        !event.createdAt ||
        event.result === 'Not reported' ||
        event.actor === 'Not reported',
    )
  )
}
