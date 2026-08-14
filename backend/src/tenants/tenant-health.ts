/**
 * Backend-owned tenant health model.  This deliberately keeps connection,
 * collection, security, and operational evidence separate: a working OAuth
 * connection must never be reported as a fully healthy tenant by itself.
 */
export const TENANT_HEALTH_MODEL_VERSION = 2

type Severity = 'critical' | 'high' | 'medium' | 'low'
export type OverallStatus = 'HEALTHY' | 'ATTENTION' | 'DEGRADED' | 'CRITICAL' | 'DISCONNECTED' | 'PENDING' | 'UNKNOWN'
type ConnectionStatus = 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'PENDING' | 'UNKNOWN'
type DataStatus = 'COMPLETE' | 'PARTIAL' | 'STALE' | 'FAILED' | 'PENDING' | 'NOT_COLLECTED' | 'UNKNOWN'
type FreshnessStatus = 'CURRENT' | 'AGING' | 'STALE' | 'NEVER_SYNCED' | 'UNKNOWN'
type SecurityStatus = 'HEALTHY' | 'NEEDS_REVIEW' | 'AT_RISK' | 'CRITICAL' | 'UNKNOWN'
type OperationsStatus = 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'SYNCING' | 'UNKNOWN'
export type ResourceClassification = 'SUCCESS' | 'EMPTY' | 'PENDING' | 'FAILED' | 'STALE' | 'UNSUPPORTED' | 'NOT_LICENSED' | 'PERMISSION_REQUIRED' | 'NOT_CONFIGURED'

export type TenantAttention = { key: string; label: string; severity: Severity; why: string; detectedAt: string | null; actionLabel: string; actionUrl: string }
type SyncState = { resourceType: string; status: string; lastAttemptAt: Date | null; lastSuccessfulAt: Date | null; lastErrorCode: string | null; lastErrorMessage: string | null; consecutiveFailures: number }
export type TenantAuditEvent = { microsoftAuditId: string; eventDateTime: Date; activityDisplayName: string; category: string | null; operationType: string | null; result: string | null; initiatedBy: unknown; targetResources: unknown }

export type ResourceHealth = { resourceType: string; required: boolean; classification: ResourceClassification; reasonCode: string | null; message: string | null; lastAttemptAt: string | null; lastSuccessfulAt: string | null }
type HealthInput = { tenantId: string; effectiveStatus: string; connectionStatus: string | null; connectionLastVerifiedAt?: Date | null; missingPermissions: string[]; syncStates: SyncState[]; authSnapshot: { payload: unknown; observedAt: Date } | null; riskyIdentityCount: number; auditEvents?: TenantAuditEvent[]; now?: Date }

/** Central policy.  Optional collectors affect completeness but are never used
 * to claim that a tenant is disconnected or that required telemetry succeeded. */
export const TENANT_HEALTH_RESOURCE_REGISTRY: ReadonlyArray<{ resourceType: string; required: boolean }> = [
  { resourceType: 'USERS', required: true }, { resourceType: 'LICENSES', required: true }, { resourceType: 'DOMAINS', required: true },
  { resourceType: 'GROUPS', required: true }, { resourceType: 'AUTH_REGISTRATIONS', required: true }, { resourceType: 'CONDITIONAL_ACCESS', required: true },
  { resourceType: 'APPLICATIONS', required: true }, { resourceType: 'SERVICE_PRINCIPALS', required: true }, { resourceType: 'AUDIT_LOGS', required: true },
  { resourceType: 'SIGN_INS', required: false }, { resourceType: 'SECURE_SCORES', required: false }, { resourceType: 'DEVICES', required: false },
  { resourceType: 'DIRECTORY_ROLES', required: false }, { resourceType: 'EXCHANGE_MAILBOXES', required: false }, { resourceType: 'EXCHANGE_ACCEPTED_DOMAINS', required: false },
  { resourceType: 'EXCHANGE_MAILBOX_RULES', required: false }, { resourceType: 'SHAREPOINT_SITES', required: false }, { resourceType: 'SHAREPOINT_SETTINGS', required: false },
  { resourceType: 'SHAREPOINT_USAGE', required: false },
]

/**
 * These legacy collectors need privileged service-specific administration and
 * are deliberately outside the normal Microsoft Graph consent experience.
 * Their historic SyncState rows must not keep an otherwise Graph-connected
 * tenant in an operationally failed state.
 */
const OPTIONAL_ADMIN_COLLECTORS = new Set(['EXCHANGE_MAILBOX_CONFIGURATION'])

export const TENANT_HEALTH_FRESHNESS = { currentMs: 15 * 60 * 1000, agingMs: 2 * 60 * 60 * 1000 } as const

function mfaCoverage(payload: unknown) { if (!Array.isArray(payload)) return null; const rows = payload.filter((row): row is { isMfaRegistered: boolean } => typeof row === 'object' && row !== null && typeof (row as { isMfaRegistered?: unknown }).isMfaRegistered === 'boolean'); return rows.length ? Math.round((rows.filter((row) => row.isMfaRegistered).length / rows.length) * 100) : null }
function latestDate(dates: Array<Date | null>) { return dates.filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0]?.toISOString() ?? null }
function securityUrl(tenantId: string, view: string) { return `/tenants/${encodeURIComponent(tenantId)}?entraTab=security&securityView=${view}` }
function syncAction(tenantId: string, resourceType: string) { const id = encodeURIComponent(tenantId); const actions: Record<string, { label: string; url: string }> = { AUTH_REGISTRATIONS: { label: 'Review authentication', url: securityUrl(tenantId, 'auth') }, CONDITIONAL_ACCESS: { label: 'Review policies', url: securityUrl(tenantId, 'policies') }, SIGN_INS: { label: 'Review sign-ins', url: securityUrl(tenantId, 'sign-ins') }, GROUPS: { label: 'Review groups', url: `/tenants/${id}?entraTab=groups` } }; return actions[resourceType] ?? { label: 'Investigate', url: `/tenants/${id}/settings` } }
function objectValueRaw(value: unknown, key: string): unknown { return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : null }
function objectValue(value: unknown, key: string) { const item = objectValueRaw(value, key); return typeof item === 'string' && item.trim() ? item.trim() : null }
function auditActor(value: unknown) { return objectValue(objectValueRaw(value, 'user'), 'userPrincipalName') ?? objectValue(objectValueRaw(value, 'user'), 'displayName') ?? objectValue(objectValueRaw(value, 'app'), 'displayName') ?? objectValue(value, 'displayName') }
function auditTarget(value: unknown) { if (!Array.isArray(value)) return null; for (const target of value) { const name = objectValue(target, 'displayName') ?? objectValue(target, 'userPrincipalName'); if (name) return name }; return null }
function auditPayloadText(value: unknown): string { if (typeof value === 'string') return value.toLowerCase(); if (Array.isArray(value)) return value.map(auditPayloadText).join(' '); return typeof value === 'object' && value !== null ? Object.values(value as Record<string, unknown>).map(auditPayloadText).join(' ') : '' }

function auditFinding(tenantId: string, event: TenantAuditEvent): TenantAttention | null {
  if (event.result && !['success', 'succeeded'].includes(event.result.toLowerCase())) return null
  const text = `${event.activityDisplayName} ${event.category ?? ''} ${event.operationType ?? ''}`.toLowerCase(); const payloadText = auditPayloadText(event.targetResources)
  const destructive = /disable|disabled|delete|deleted|remove|removed|turn off/.test(`${text} ${payloadText}`); const actor = auditActor(event.initiatedBy); const target = auditTarget(event.targetResources)
  const context = [actor ? `By ${actor}.` : null, target ? `Affected: ${target}.` : null].filter(Boolean).join(' '); const base = { detectedAt: event.eventDateTime.toISOString(), actionLabel: 'Investigate change', actionUrl: `/what-changed?tenantId=${encodeURIComponent(tenantId)}&from=${encodeURIComponent(event.eventDateTime.toISOString())}` }
  if (/conditional access|named location/.test(text)) return { ...base, key: `audit-ca-${event.microsoftAuditId}`, label: destructive ? 'Conditional Access policy was disabled or removed' : 'Conditional Access policy changed', severity: destructive ? 'critical' : 'high', why: context || event.activityDisplayName }
  if (/authentication method|security info|strong authentication|mfa/.test(text)) return { ...base, key: `audit-auth-${event.microsoftAuditId}`, label: destructive ? `MFA or authentication method was removed${target ? ` for ${target}` : ''}` : `Authentication methods changed${target ? ` for ${target}` : ''}`, severity: destructive ? 'critical' : 'high', why: context || event.activityDisplayName }
  if (/application|service principal|app registration|credential/.test(text)) return { ...base, key: `audit-app-${event.microsoftAuditId}`, label: 'Application access changed', severity: destructive ? 'critical' : 'high', why: context || event.activityDisplayName }
  if (/role|administrator/.test(text)) return { ...base, key: `audit-role-${event.microsoftAuditId}`, label: 'Administrative role changed', severity: 'high', why: context || event.activityDisplayName }
  return null
}

function classify(state: SyncState | undefined, now: Date): Omit<ResourceHealth, 'resourceType' | 'required'> {
  if (!state) return { classification: 'NOT_CONFIGURED', reasonCode: 'collector-not-configured', message: 'No collector state has been recorded.', lastAttemptAt: null, lastSuccessfulAt: null }
  const base = { lastAttemptAt: state.lastAttemptAt?.toISOString() ?? null, lastSuccessfulAt: state.lastSuccessfulAt?.toISOString() ?? null }
  const authFailure = state.lastErrorCode === '401' || state.lastErrorCode === '403' || /unauthorized|forbidden|permission|consent/i.test(state.lastErrorMessage ?? '')
  if (state.status === 'FAILED') return { ...base, classification: authFailure ? 'PERMISSION_REQUIRED' : 'FAILED', reasonCode: state.lastErrorCode ?? 'collector-failed', message: state.lastErrorMessage ?? 'The latest collection failed.' }
  if (state.status === 'RUNNING') return { ...base, classification: 'PENDING', reasonCode: 'collector-running', message: 'Collection is in progress.' }
  if (!state.lastSuccessfulAt) return { ...base, classification: 'NOT_CONFIGURED', reasonCode: 'never-succeeded', message: 'The collector has not completed successfully.' }
  const age = now.getTime() - state.lastSuccessfulAt.getTime()
  if (age > TENANT_HEALTH_FRESHNESS.agingMs) return { ...base, classification: 'STALE', reasonCode: 'stale-success', message: 'The last successful collection is outside the acceptable window.' }
  return { ...base, classification: 'SUCCESS', reasonCode: null, message: null }
}

function freshness(resources: ResourceHealth[], now: Date): FreshnessStatus {
  const applicable = resources.filter((r) => r.classification !== 'UNSUPPORTED' && r.classification !== 'NOT_LICENSED')
  const dates = applicable.map((r) => r.lastSuccessfulAt ? new Date(r.lastSuccessfulAt) : null).filter((d): d is Date => Boolean(d))
  if (!dates.length) return applicable.length ? 'NEVER_SYNCED' : 'UNKNOWN'
  const oldest = Math.min(...dates.map((d) => d.getTime())); const age = now.getTime() - oldest
  if (age <= TENANT_HEALTH_FRESHNESS.currentMs) return 'CURRENT'
  return age <= TENANT_HEALTH_FRESHNESS.agingMs ? 'AGING' : 'STALE'
}

export function deriveTenantHealth(input: HealthInput) {
  const now = input.now ?? new Date(); const attention: TenantAttention[] = []; const settingsUrl = `/tenants/${encodeURIComponent(input.tenantId)}/settings`
  const connection: { status: ConnectionStatus; reasonCode: string | null; message: string; lastCheckedAt: string | null; lastSuccessfulAt: string | null } = input.connectionStatus === 'REVOKED' || input.connectionStatus === 'ERROR' || input.effectiveStatus === 'disconnected' ? { status: 'DISCONNECTED', reasonCode: input.connectionStatus?.toLowerCase() ?? 'disconnected', message: 'Microsoft connection cannot be used to synchronize this tenant.', lastCheckedAt: input.connectionLastVerifiedAt?.toISOString() ?? null, lastSuccessfulAt: null } : input.connectionStatus === 'PENDING_CONSENT' || input.effectiveStatus === 'pending' ? { status: 'PENDING', reasonCode: 'consent-pending', message: 'Microsoft administrator consent is still required.', lastCheckedAt: input.connectionLastVerifiedAt?.toISOString() ?? null, lastSuccessfulAt: null } : input.connectionStatus === 'CONNECTED' || input.connectionStatus === 'ACTIVE' ? { status: 'HEALTHY', reasonCode: null, message: 'Microsoft connection verified.', lastCheckedAt: input.connectionLastVerifiedAt?.toISOString() ?? null, lastSuccessfulAt: input.connectionLastVerifiedAt?.toISOString() ?? null } : { status: 'UNKNOWN', reasonCode: 'no-connection-evidence', message: 'No current Microsoft connection evidence is available.', lastCheckedAt: null, lastSuccessfulAt: null }
  if (connection.status === 'DISCONNECTED') attention.push({ key: 'connection-unavailable', label: 'Tenant is no longer connected to HawkView', severity: 'critical', why: connection.message, detectedAt: latestDate(input.syncStates.map((s) => s.lastAttemptAt)), actionLabel: 'Reconnect tenant', actionUrl: settingsUrl })
  else if (connection.status === 'PENDING' || input.missingPermissions.length > 0) attention.push({ key: 'authorization-required', label: input.missingPermissions.length ? 'Required Microsoft permissions are missing' : 'Microsoft authorization is required', severity: 'high', why: input.missingPermissions.length ? `Missing: ${input.missingPermissions.join(', ')}.` : connection.message, detectedAt: latestDate(input.syncStates.map((s) => s.lastAttemptAt)), actionLabel: 'Review permissions', actionUrl: settingsUrl })

  const states = new Map(input.syncStates.map((state) => [state.resourceType, state])); const resources: ResourceHealth[] = TENANT_HEALTH_RESOURCE_REGISTRY.map((item) => ({ resourceType: item.resourceType, required: item.required, ...classify(states.get(item.resourceType), now) }))
  const applicable = resources.filter((r) => r.classification !== 'UNSUPPORTED' && r.classification !== 'NOT_LICENSED'); const successful = applicable.filter((r) => r.classification === 'SUCCESS' || r.classification === 'EMPTY'); const failed = applicable.filter((r) => r.classification === 'FAILED' || r.classification === 'PERMISSION_REQUIRED'); const pending = applicable.filter((r) => r.classification === 'PENDING' || r.classification === 'NOT_CONFIGURED'); const stale = applicable.filter((r) => r.classification === 'STALE'); const unsupported = resources.filter((r) => r.classification === 'UNSUPPORTED' || r.classification === 'NOT_LICENSED'); const requiredProblems = resources.filter((r) => r.required && ['FAILED', 'PERMISSION_REQUIRED', 'STALE'].includes(r.classification))
  for (const resource of requiredProblems.slice(0, 3)) { const state = states.get(resource.resourceType); const action = syncAction(input.tenantId, resource.resourceType); attention.push({ key: `sync-${resource.resourceType.toLowerCase()}`, label: `${resource.resourceType.replaceAll('_', ' ').toLowerCase()} synchronization needs attention`, severity: state?.consecutiveFailures && state.consecutiveFailures >= 3 ? 'critical' : 'high', why: resource.message ?? 'Required collection is not current.', detectedAt: resource.lastAttemptAt, actionLabel: action.label, actionUrl: action.url }) }
  const currentFreshness = freshness(resources, now); const completenessPercent = applicable.length ? Math.round((successful.length / applicable.length) * 100) : null
  const dataStatus: DataStatus = requiredProblems.some((r) => r.classification === 'FAILED' || r.classification === 'PERMISSION_REQUIRED') ? 'FAILED' : requiredProblems.length || currentFreshness === 'STALE' ? 'STALE' : pending.length === applicable.length ? 'NOT_COLLECTED' : pending.length || unsupported.length || successful.length !== applicable.length ? 'PARTIAL' : 'COMPLETE'
  const data = { status: dataStatus, freshnessStatus: currentFreshness, completenessPercent, successfulResources: successful.length, expectedResources: applicable.length, pendingResources: pending.length, failedResources: failed.length, unsupportedResources: unsupported.length, staleResources: stale.length, lastSyncStartedAt: latestDate(input.syncStates.map((s) => s.lastAttemptAt)), lastSyncCompletedAt: latestDate(input.syncStates.map((s) => s.lastSuccessfulAt)), issues: resources.filter((r) => r.classification !== 'SUCCESS').map((r) => ({ resourceType: r.resourceType, classification: r.classification, reasonCode: r.reasonCode, message: r.message })) }

  const coverage = mfaCoverage(input.authSnapshot?.payload); if (input.riskyIdentityCount > 0) attention.push({ key: 'risky-identities', label: `${input.riskyIdentityCount} risky ${input.riskyIdentityCount === 1 ? 'identity' : 'identities'} detected`, severity: input.riskyIdentityCount >= 5 ? 'critical' : 'high', why: 'Recent Microsoft sign-in telemetry contains risk indicators.', detectedAt: null, actionLabel: 'Review sign-ins', actionUrl: securityUrl(input.tenantId, 'sign-ins') }); if (coverage !== null && coverage < 85) attention.push({ key: 'mfa-coverage', label: `This organization has ${coverage}% MFA coverage`, severity: coverage < 50 ? 'high' : 'medium', why: `HawkView recommends at least 85% coverage. ${100 - coverage}% of synchronized users are not registered for MFA.`, detectedAt: input.authSnapshot?.observedAt.toISOString() ?? null, actionLabel: 'Review MFA coverage', actionUrl: securityUrl(input.tenantId, 'auth') })
  for (const event of input.auditEvents ?? []) { const finding = auditFinding(input.tenantId, event); if (finding && !attention.some((item) => item.label === finding.label)) attention.push(finding); if (attention.filter((item) => item.key.startsWith('audit-')).length >= 3) break }
  const securityCollectorStates = ['AUTH_REGISTRATIONS', 'CONDITIONAL_ACCESS', 'AUDIT_LOGS'].map((name) => resources.find((r) => r.resourceType === name)).filter((r): r is ResourceHealth => Boolean(r)); const securityIncomplete = securityCollectorStates.some((r) => r.classification !== 'SUCCESS' && r.classification !== 'EMPTY'); const criticalFindings = attention.filter((a) => a.severity === 'critical' && !a.key.startsWith('connection') && !a.key.startsWith('sync-')).length; const highFindings = attention.filter((a) => a.severity === 'high' && !a.key.startsWith('connection') && !a.key.startsWith('sync-')).length; const mediumFindings = attention.filter((a) => a.severity === 'medium').length; const lowFindings = attention.filter((a) => a.severity === 'low').length
  const security = { status: criticalFindings > 0 ? 'CRITICAL' as SecurityStatus : highFindings > 0 ? 'AT_RISK' as SecurityStatus : securityIncomplete ? 'UNKNOWN' as SecurityStatus : mediumFindings + lowFindings > 0 ? 'NEEDS_REVIEW' as SecurityStatus : 'HEALTHY' as SecurityStatus, criticalFindings, highFindings, mediumFindings, lowFindings, recommendationCount: mediumFindings + lowFindings, lastEvaluatedAt: latestDate([input.authSnapshot?.observedAt ?? null, ...input.syncStates.filter((s) => ['AUTH_REGISTRATIONS', 'CONDITIONAL_ACCESS', 'AUDIT_LOGS'].includes(s.resourceType)).map((s) => s.lastSuccessfulAt)]) }
  const operationalStates = input.syncStates.filter((state) => !OPTIONAL_ADMIN_COLLECTORS.has(state.resourceType))
  const failedJobs = operationalStates.filter((s) => s.status === 'FAILED').length; const pendingJobs = operationalStates.filter((s) => s.status === 'RUNNING').length; const partialJobs = operationalStates.filter((s) => s.status === 'FAILED' && s.lastSuccessfulAt !== null).length; const operations = { status: failedJobs >= 3 ? 'FAILED' as OperationsStatus : failedJobs > 0 ? 'DEGRADED' as OperationsStatus : pendingJobs > 0 ? 'SYNCING' as OperationsStatus : operationalStates.length ? 'HEALTHY' as OperationsStatus : 'UNKNOWN' as OperationsStatus, activeIssues: failedJobs + requiredProblems.length, failedJobs, partialJobs, pendingJobs, lastSuccessfulJobAt: latestDate(operationalStates.map((s) => s.lastSuccessfulAt)), issues: operationalStates.filter((s) => s.status === 'FAILED').map((s) => ({ resourceType: s.resourceType, reasonCode: s.lastErrorCode, message: s.lastErrorMessage, consecutiveFailures: s.consecutiveFailures })) }
  // Apply the published precedence in order. Pending consent is informative,
  // but must never hide a critical finding or a failed synchronization job.
  const overallStatus: OverallStatus = connection.status === 'DISCONNECTED' ? 'DISCONNECTED' : security.status === 'CRITICAL' || operations.status === 'FAILED' ? 'CRITICAL' : requiredProblems.length > 0 || operations.status === 'DEGRADED' || security.highFindings >= 2 ? 'DEGRADED' : connection.status === 'PENDING' ? 'PENDING' : data.status === 'PARTIAL' || security.status === 'AT_RISK' || security.status === 'NEEDS_REVIEW' || unsupported.length > 0 ? 'ATTENTION' : connection.status === 'HEALTHY' && data.status === 'COMPLETE' && data.freshnessStatus === 'CURRENT' && security.status === 'HEALTHY' && operations.status === 'HEALTHY' ? 'HEALTHY' : 'UNKNOWN'
  const penalty = attention.reduce((total, item) => total + (item.severity === 'critical' ? 30 : item.severity === 'high' ? 20 : item.severity === 'medium' ? 10 : 5), 0)
  return { healthModelVersion: TENANT_HEALTH_MODEL_VERSION, overallStatus, connection, data, security, operations, resourceHealth: resources, evaluatedAt: now.toISOString(), legacyHealthStatus: overallStatus === 'HEALTHY' ? 'healthy' : overallStatus === 'PENDING' ? 'pending' : overallStatus === 'DISCONNECTED' ? 'disconnected' : 'attention', healthScore: Math.max(0, 100 - penalty), mfaCoverage: coverage, riskyIdentityCount: input.riskyIdentityCount, attention }
}
