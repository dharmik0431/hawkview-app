import type {
  CollectionReadinessView,
  SynchronizationReadinessSummary,
} from './collection-readiness.ts'

export type SettingsSynchronizationRow = {
  key: string
  name: string
  status: CollectionReadinessView['workloads'][number]['state']
  lastAttempt: string | null
  lastSuccess: string | null
  freshness: CollectionReadinessView['workloads'][number]['freshness']
  reason: string | null
  reasonCode: string | null
  remediation: string
  components: CollectionReadinessView['workloads'][number]['components']
}

/**
 * The synchronization table is another view of the normalized readiness
 * contract. Never synthesize module rows or assume READY merely because a
 * tenant bundle exists.
 */
export function settingsSynchronizationRows(
  readiness: CollectionReadinessView | null,
): SettingsSynchronizationRow[] {
  if (!readiness) return []
  return readiness.workloads.map((workload) => ({
    key: workload.key,
    name: workload.workload,
    status: workload.state,
    lastAttempt: workload.lastAttemptAt,
    lastSuccess: workload.lastSuccessfulAt,
    freshness: workload.freshness,
    reason: workload.reason,
    reasonCode: workload.reasonCode,
    remediation: workload.remediation,
    components: workload.components,
  }))
}

export type SettingsOverallHealth = {
  state: 'HEALTHY' | 'NEEDS_ATTENTION' | 'UNVERIFIED'
  label: string
}

export type SettingsConnectionHealth = {
  state: 'CONNECTED' | 'PENDING' | 'DISCONNECTED' | 'UNKNOWN'
  label: string
}

export function settingsConnectionHealth(value: unknown): SettingsConnectionHealth {
  if (typeof value !== 'string') return { state: 'UNKNOWN', label: 'Unknown' }
  const status = value.trim().toLowerCase()
  if (['connected', 'healthy', 'active'].includes(status)) {
    return { state: 'CONNECTED', label: 'Connected' }
  }
  if (['pending-consent', 'pending', 'warning'].includes(status)) {
    return { state: 'PENDING', label: 'Pending consent' }
  }
  if (['error', 'critical', 'disconnected', 'revoked'].includes(status)) {
    return { state: 'DISCONNECTED', label: 'Disconnected' }
  }
  return { state: 'UNKNOWN', label: 'Unknown' }
}

/** Connection status and collection readiness are deliberately separate. */
export function settingsOverallHealth(
  summary: SynchronizationReadinessSummary | null,
): SettingsOverallHealth {
  if (!summary) return { state: 'UNVERIFIED', label: 'Collection unverified' }
  if (summary.overallState === 'READY') {
    return { state: 'HEALTHY', label: 'Collection healthy' }
  }
  return { state: 'NEEDS_ATTENTION', label: 'Collection needs attention' }
}
