type Severity = 'critical' | 'high' | 'medium'

export type TenantAttention = {
  key: string
  label: string
  severity: Severity
  why: string
  detectedAt: string | null
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

type HealthInput = {
  effectiveStatus: string
  connectionStatus: string | null
  missingPermissions: string[]
  syncStates: SyncState[]
  authSnapshot: { payload: unknown; observedAt: Date } | null
  riskyIdentityCount: number
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

export function deriveTenantHealth(input: HealthInput) {
  const attention: TenantAttention[] = []
  const disconnected = input.effectiveStatus === 'disconnected' ||
    input.connectionStatus === 'ERROR' || input.connectionStatus === 'REVOKED'

  if (disconnected) {
    attention.push({ key: 'connection-unavailable', label: 'Microsoft connection unavailable', severity: 'critical', why: 'HawkView cannot currently verify or synchronize this tenant.', detectedAt: latestDate(input.syncStates.map((state) => state.lastAttemptAt)) })
  } else if (input.effectiveStatus === 'pending' || input.connectionStatus === 'PENDING_CONSENT' || input.missingPermissions.length > 0) {
    attention.push({ key: 'authorization-required', label: 'Microsoft authorization required', severity: 'high', why: input.missingPermissions.length > 0 ? `${input.missingPermissions.length} required permission${input.missingPermissions.length === 1 ? '' : 's'} missing.` : 'Administrator consent has not been completed.', detectedAt: latestDate(input.syncStates.map((state) => state.lastAttemptAt)) })
  }

  const failedStates = input.syncStates.filter((state) =>
    (state.status === 'FAILED' || state.status === 'PARTIAL') &&
    !(disconnected && state.resourceType === 'CONNECTION'))
  if (failedStates.length > 0) {
    const maxFailures = Math.max(...failedStates.map((state) => state.consecutiveFailures))
    attention.push({ key: 'sync-failures', label: 'Synchronization issues detected', severity: maxFailures >= 3 ? 'critical' : 'high', why: failedStates.slice(0, 3).map((state) => `${state.resourceType.replaceAll('_', ' ').toLowerCase()}: ${state.lastErrorMessage ?? state.lastErrorCode ?? state.status.toLowerCase()}`).join('; '), detectedAt: latestDate(failedStates.map((state) => state.lastAttemptAt)) })
  }

  if (input.riskyIdentityCount > 0) {
    attention.push({ key: 'risky-identities', label: `Risky identities detected (${input.riskyIdentityCount})`, severity: input.riskyIdentityCount >= 5 ? 'critical' : 'high', why: 'Recent sign-in telemetry contains identities with Microsoft risk indicators.', detectedAt: null })
  }

  const coverage = mfaCoverage(input.authSnapshot?.payload)
  if (coverage !== null && coverage < 85) {
    attention.push({ key: 'mfa-coverage', label: 'MFA coverage gap', severity: coverage < 50 ? 'high' : 'medium', why: `${coverage}% of synchronized users are registered for MFA.`, detectedAt: input.authSnapshot?.observedAt.toISOString() ?? null })
  }

  const penalty = attention.reduce((total, item) => total + (item.severity === 'critical' ? 30 : item.severity === 'high' ? 20 : 10), 0)
  return { healthScore: Math.max(0, 100 - penalty), mfaCoverage: coverage, riskyIdentityCount: input.riskyIdentityCount, attention }
}
