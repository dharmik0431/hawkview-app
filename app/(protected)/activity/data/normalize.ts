import type { AuditEvent, SignInEvent } from './types'

type RecordValue = Record<string, any>

function reportedText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 2_000)
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function reportedTimestamp(...values: unknown[]): string {
  const value = reportedText(...values)
  if (!value) return ''
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? value : ''
}

function deterministicEventId(
  kind: 'signin' | 'audit',
  tenantId: string | undefined,
  index: number,
  ...parts: unknown[]
) {
  const seed = [kind, tenantId ?? 'tenant-not-reported', index, ...parts]
    .map((part) => reportedText(part) ?? 'not-reported')
    .join('|')

  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${kind}-unreported-id-${(hash >>> 0).toString(16)}`
}

function normalizeSignInResult(value: unknown): SignInEvent['status'] {
  const normalized = reportedText(value)?.toLowerCase()
  if (!normalized) return 'Not reported'
  if (['success', 'succeeded', 'ok', '0'].includes(normalized)) return 'Success'
  if (['failure', 'failed', 'error'].includes(normalized)) return 'Failure'
  return 'Not reported'
}

function normalizeConditionalAccess(
  event: RecordValue,
): SignInEvent['conditionalAccess'] {
  const raw = reportedText(
    event.conditionalAccess,
    event.condAccess,
    event.appliedConditionalAccess,
  )?.toLowerCase()
  if (Array.isArray(event.appliedConditionalAccessPolicies)) {
    if (event.appliedConditionalAccessPolicies.length > 0) return 'Applied'
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

export function normalizeSignInEvent(
  source: RecordValue,
  context: { tenantId?: string; tenantName?: string; index: number },
): SignInEvent {
  const createdAt = reportedTimestamp(source.createdAt, source.ts, source.time)
  const userPrincipalName = reportedText(
    source.userPrincipalName,
    source.upn,
    source.userPrincipal,
  )
  const city = reportedText(source.city, source.location?.city)
  const country = reportedText(source.country, source.location?.country)
  const location =
    reportedText(typeof source.location === 'string' ? source.location : undefined) ??
    (city && country ? `${city}, ${country}` : city ?? country)
  const reportedId = reportedText(source.id)

  return {
    id:
      reportedId ??
      deterministicEventId(
        'signin',
        context.tenantId,
        context.index,
        createdAt,
        userPrincipalName,
        source.appId,
      ),
    createdAt,
    userDisplayName:
      reportedText(source.userDisplayName, source.user, source.displayName) ??
      'Not reported',
    userPrincipalName: userPrincipalName ?? 'Not reported',
    userId: reportedText(source.userId),
    appDisplayName:
      reportedText(source.appDisplayName, source.app) ?? 'Not reported',
    appId: reportedText(source.appId, source.appIdGuid),
    status: normalizeSignInResult(source.status ?? source.result),
    failureReason: reportedText(
      source.failureReason,
      source.errorDetail,
      source.statusReason,
    ),
    errorCode: reportedText(source.errorCode, source.errorNumber),
    additionalDetails: reportedText(source.additionalDetails),
    conditionalAccess: normalizeConditionalAccess(source),
    appliedCaPolicies: Array.isArray(source.appliedConditionalAccessPolicies)
      ? source.appliedConditionalAccessPolicies.slice(0, 50)
          .map((policy: any) =>
            typeof policy === 'string'
              ? reportedText(policy)
              : reportedText(policy?.displayName, policy?.name),
          )
          .filter((policy): policy is string => Boolean(policy))
      : undefined,
    authMethod: reportedText(
      source.authMethod,
      source.authenticationRequirement,
    ),
    ipAddress: reportedText(source.ipAddress, source.ip),
    location,
    country,
    city,
    clientAppUsed: reportedText(
      source.clientAppUsed,
      source.client,
      source.clientApp,
    ),
    device: reportedText(
      source.device,
      source.deviceName,
      source.deviceDetail?.displayName,
    ),
    os: reportedText(
      source.os,
      source.operatingSystem,
      source.deviceDetail?.operatingSystem,
    ),
    browser: reportedText(source.browser, source.deviceDetail?.browser),
    managedState:
      reportedText(source.managedState) ??
      (source.deviceDetail?.isCompliant === true
        ? 'Compliant'
        : source.deviceDetail?.isManaged === true
          ? 'Managed'
          : undefined),
    userAgent: reportedText(source.userAgent),
    tenantName: context.tenantName,
    tenantId: context.tenantId,
    correlationId: reportedText(source.correlationId),
    requestId: reportedText(source.requestId),
    riskLevel: reportedText(source.riskLevel, source.riskState, source.risk),
    raw: source,
  }
}

export function normalizeAuditEvent(
  source: RecordValue,
  context: { tenantId?: string; tenantName?: string; index: number },
): AuditEvent {
  const initiatedBy = source.initiatedBy ?? {}
  const actorName = reportedText(
    initiatedBy?.user?.displayName,
    source.actorDisplayName,
    typeof source.actor === 'string' && !source.actor.includes('@')
      ? source.actor
      : undefined,
    source.user,
    initiatedBy?.app?.displayName,
  )
  const actorPrincipalName = reportedText(
    initiatedBy?.user?.userPrincipalName,
    initiatedBy?.app?.servicePrincipalName,
    typeof source.actor === 'string' && source.actor.includes('@')
      ? source.actor
      : undefined,
  )
  const actorType = initiatedBy?.user
    ? 'User'
    : initiatedBy?.app
      ? 'Application'
      : reportedText(source.actorType) ?? 'Not reported'
  const actorId = reportedText(
    initiatedBy?.user?.id,
    initiatedBy?.app?.id,
    source.actorId,
  )
  const targets = Array.isArray(source.targetResources)
    ? source.targetResources.slice(0, 50)
    : []
  const primaryTarget = targets[0]
  const target =
    targets.length > 0
      ? targets
          .map((item: any) =>
            reportedText(item?.displayName, item?.userPrincipalName, item?.id),
          )
          .filter(Boolean)
          .join(', ') || undefined
      : reportedText(source.target)
  const createdAt = reportedTimestamp(source.createdAt, source.time, source.ts)
  const activity =
    reportedText(
      source.activity,
      source.activityDisplayName,
      source.action,
    ) ?? 'Not reported'
  const reportedId = reportedText(source.id)

  return {
    id:
      reportedId ??
      deterministicEventId(
        'audit',
        context.tenantId,
        context.index,
        createdAt,
        activity,
        actorPrincipalName,
      ),
    createdAt,
    activity,
    category: reportedText(source.category),
    operationType: reportedText(source.operationType),
    result: reportedText(source.result, source.status) ?? 'Not reported',
    resultReason: reportedText(source.resultReason, source.statusReason),
    correlationId: reportedText(source.correlationId),
    service: reportedText(source.service, source.loggedByService),
    actor: actorName ?? actorPrincipalName ?? 'Not reported',
    actorPrincipalName,
    actorType,
    actorId,
    target,
    targetType: reportedText(primaryTarget?.type, primaryTarget?.groupType),
    targetId: reportedText(primaryTarget?.id),
    targetResources: targets,
    modifiedProperties: Array.isArray(primaryTarget?.modifiedProperties)
      ? primaryTarget.modifiedProperties.slice(0, 100)
      : Array.isArray(source.modifiedProperties)
        ? source.modifiedProperties.slice(0, 100)
        : undefined,
    tenantName: context.tenantName,
    tenantId: context.tenantId,
    raw: source,
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
