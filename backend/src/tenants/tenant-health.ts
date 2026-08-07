type Severity = 'critical' | 'high' | 'medium'

export type TenantAttention = {
  key: string
  label: string
  severity: Severity
  why: string
  detectedAt: string | null
  actionLabel: string
  actionUrl: string
}

type SyncState = {
  resourceType: string
  status: string
  lastAttemptAt: Date | null
  lastSuccessfulAt: Date | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
  consecutiveFailures: number
}

export type TenantAuditEvent = {
  microsoftAuditId: string
  eventDateTime: Date
  activityDisplayName: string
  category: string | null
  operationType: string | null
  result: string | null
  initiatedBy: unknown
  targetResources: unknown
}

type HealthInput = {
  tenantId: string
  effectiveStatus: string
  connectionStatus: string | null
  missingPermissions: string[]
  syncStates: SyncState[]
  authSnapshot: { payload: unknown; observedAt: Date } | null
  riskyIdentityCount: number
  auditEvents?: TenantAuditEvent[]
}

function mfaCoverage(payload: unknown) {
  if (!Array.isArray(payload)) return null
  const rows = payload.filter(
    (row): row is { isMfaRegistered: boolean } =>
      typeof row === 'object' && row !== null &&
      typeof (row as { isMfaRegistered?: unknown }).isMfaRegistered === 'boolean'
  )
  if (rows.length === 0) return null
  return Math.round((rows.filter((row) => row.isMfaRegistered).length / rows.length) * 100)
}

function latestDate(dates: Array<Date | null>) {
  return dates.filter((date): date is Date => Boolean(date))
    .sort((a, b) => b.getTime() - a.getTime())[0]?.toISOString() ?? null
}

function securityUrl(tenantId: string, view: string) {
  return `/tenants/${encodeURIComponent(tenantId)}?entraTab=security&securityView=${view}`
}

function syncAction(tenantId: string, resourceType: string) {
  const id = encodeURIComponent(tenantId)
  const actions: Record<string, { label: string; url: string }> = {
    AUTH_REGISTRATIONS: { label: 'Review authentication', url: securityUrl(tenantId, 'auth') },
    CONDITIONAL_ACCESS: { label: 'Review policies', url: securityUrl(tenantId, 'policies') },
    SIGN_INS: { label: 'Review sign-ins', url: securityUrl(tenantId, 'sign-ins') },
    GROUPS: { label: 'Review groups', url: `/tenants/${id}?entraTab=groups` },
  }
  return actions[resourceType] ?? { label: 'Investigate', url: `/tenants/${id}/settings` }
}

function objectValue(value: unknown, key: string) {
  if (typeof value !== 'object' || value === null) return null
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
}

function auditActor(value: unknown) {
  return objectValue(objectValueRaw(value, 'user'), 'userPrincipalName') ??
    objectValue(objectValueRaw(value, 'user'), 'displayName') ??
    objectValue(objectValueRaw(value, 'app'), 'displayName') ??
    objectValue(value, 'displayName')
}

function objectValueRaw(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return null
  return (value as Record<string, unknown>)[key]
}

function auditTarget(value: unknown) {
  if (!Array.isArray(value)) return null
  for (const target of value) {
    const name = objectValue(target, 'displayName') ?? objectValue(target, 'userPrincipalName')
    if (name) return name
  }
  return null
}

function auditPayloadText(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase()
  if (Array.isArray(value)) return value.map(auditPayloadText).join(' ')
  if (typeof value !== 'object' || value === null) return ''
  return Object.values(value as Record<string, unknown>).map(auditPayloadText).join(' ')
}

function auditFinding(tenantId: string, event: TenantAuditEvent): TenantAttention | null {
  if (event.result && !['success', 'succeeded'].includes(event.result.toLowerCase())) return null

  const text = `${event.activityDisplayName} ${event.category ?? ''} ${event.operationType ?? ''}`.toLowerCase()
  const payloadText = auditPayloadText(event.targetResources)
  const destructive = /disable|disabled|delete|deleted|remove|removed|turn off/.test(
    `${text} ${payloadText}`,
  )
  const actor = auditActor(event.initiatedBy)
  const target = auditTarget(event.targetResources)
  const context = [actor ? `By ${actor}.` : null, target ? `Affected: ${target}.` : null]
    .filter(Boolean).join(' ')
  const from = encodeURIComponent(event.eventDateTime.toISOString())
  const actionUrl = `/what-changed?tenantId=${encodeURIComponent(tenantId)}&from=${from}`
  const base = {
    detectedAt: event.eventDateTime.toISOString(),
    actionLabel: 'Investigate change',
    actionUrl,
  }

  if (/conditional access|named location/.test(text)) {
    return {
      ...base,
      key: `audit-ca-${event.microsoftAuditId}`,
      label: destructive ? 'Conditional Access policy was disabled or removed' : 'Conditional Access policy changed',
      severity: destructive ? 'critical' : 'high',
      why: context || event.activityDisplayName,
    }
  }
  if (/authentication method|security info|strong authentication|mfa/.test(text)) {
    return {
      ...base,
      key: `audit-auth-${event.microsoftAuditId}`,
      label: destructive
        ? `MFA or authentication method was removed${target ? ` for ${target}` : ''}`
        : `Authentication methods changed${target ? ` for ${target}` : ''}`,
      severity: destructive ? 'critical' : 'high',
      why: context || event.activityDisplayName,
    }
  }
  if (/application|service principal|app registration|credential/.test(text)) {
    return {
      ...base,
      key: `audit-app-${event.microsoftAuditId}`,
      label: 'Application access changed',
      severity: destructive ? 'critical' : 'high',
      why: context || event.activityDisplayName,
    }
  }
  if (/role|administrator/.test(text)) {
    return {
      ...base,
      key: `audit-role-${event.microsoftAuditId}`,
      label: 'Administrative role changed',
      severity: 'high',
      why: context || event.activityDisplayName,
    }
  }
  return null
}

export function deriveTenantHealth(input: HealthInput) {
  const attention: TenantAttention[] = []
  const settingsUrl = `/tenants/${encodeURIComponent(input.tenantId)}/settings`
  const disconnected = input.effectiveStatus === 'disconnected' ||
    input.connectionStatus === 'ERROR' || input.connectionStatus === 'REVOKED'

  if (disconnected) {
    attention.push({
      key: 'connection-unavailable',
      label: 'Tenant is no longer connected to HawkView',
      severity: 'critical',
      why: 'HawkView cannot verify or synchronize Microsoft 365 until the connection is restored.',
      detectedAt: latestDate(input.syncStates.map((state) => state.lastAttemptAt)),
      actionLabel: 'Reconnect tenant',
      actionUrl: settingsUrl,
    })
  } else if (input.effectiveStatus === 'pending' || input.connectionStatus === 'PENDING_CONSENT' || input.missingPermissions.length > 0) {
    attention.push({
      key: 'authorization-required',
      label: input.missingPermissions.length > 0 ? 'Required Microsoft permissions are missing' : 'Microsoft authorization is required',
      severity: 'high',
      why: input.missingPermissions.length > 0
        ? `Missing: ${input.missingPermissions.join(', ')}.`
        : 'A Microsoft 365 administrator must complete consent.',
      detectedAt: latestDate(input.syncStates.map((state) => state.lastAttemptAt)),
      actionLabel: 'Review permissions',
      actionUrl: settingsUrl,
    })
  }

  const authorizationProblem = disconnected || input.missingPermissions.length > 0
  const failedStates = input.syncStates.filter((state) => {
    if (state.status !== 'FAILED' && state.status !== 'PARTIAL') return false
    if (disconnected && state.resourceType === 'CONNECTION') return false
    const authFailure = state.lastErrorCode === '401' || state.lastErrorCode === '403' ||
      /unauthorized|forbidden|permission|consent/i.test(state.lastErrorMessage ?? '')
    return !(authorizationProblem && authFailure)
  })
  for (const state of failedStates.slice(0, 3)) {
    const action = syncAction(input.tenantId, state.resourceType)
    const resource = state.resourceType.replaceAll('_', ' ').toLowerCase()
    attention.push({
      key: `sync-${state.resourceType.toLowerCase()}`,
      label: `${resource.charAt(0).toUpperCase()}${resource.slice(1)} synchronization needs attention`,
      severity: state.consecutiveFailures >= 3 ? 'critical' : 'high',
      why: state.lastErrorMessage ?? state.lastErrorCode ?? 'The latest synchronization was incomplete.',
      detectedAt: state.lastAttemptAt?.toISOString() ?? null,
      actionLabel: action.label,
      actionUrl: action.url,
    })
  }

  if (input.riskyIdentityCount > 0) {
    attention.push({
      key: 'risky-identities',
      label: `${input.riskyIdentityCount} risky ${input.riskyIdentityCount === 1 ? 'identity' : 'identities'} detected`,
      severity: input.riskyIdentityCount >= 5 ? 'critical' : 'high',
      why: 'Recent Microsoft sign-in telemetry contains risk indicators.',
      detectedAt: null,
      actionLabel: 'Review sign-ins',
      actionUrl: securityUrl(input.tenantId, 'sign-ins'),
    })
  }

  const coverage = mfaCoverage(input.authSnapshot?.payload)
  if (coverage !== null && coverage < 85) {
    attention.push({
      key: 'mfa-coverage',
      label: `This organization has ${coverage}% MFA coverage`,
      severity: coverage < 50 ? 'high' : 'medium',
      why: `HawkView recommends at least 85% coverage. ${100 - coverage}% of synchronized users are not registered for MFA.`,
      detectedAt: input.authSnapshot?.observedAt.toISOString() ?? null,
      actionLabel: 'Review MFA coverage',
      actionUrl: securityUrl(input.tenantId, 'auth'),
    })
  }

  for (const event of input.auditEvents ?? []) {
    const finding = auditFinding(input.tenantId, event)
    if (finding && !attention.some((item) => item.label === finding.label)) attention.push(finding)
    if (attention.filter((item) => item.key.startsWith('audit-')).length >= 3) break
  }

  const penalty = attention.reduce((total, item) => total + (item.severity === 'critical' ? 30 : item.severity === 'high' ? 20 : 10), 0)
  return { healthScore: Math.max(0, 100 - penalty), mfaCoverage: coverage, riskyIdentityCount: input.riskyIdentityCount, attention }
}
