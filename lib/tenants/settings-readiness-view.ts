import type {
  CollectionReadinessView,
  SynchronizationReadinessSummary,
} from './collection-readiness.ts'
import {
  isActionableReadinessState,
  readinessDiagnostic,
  readinessLabel,
} from './collection-readiness.ts'
import { auditSyncRequiresAction } from './audit-sync-health.ts'

export const M365_UNIFIED_AUDIT_WORKLOAD_KEY = 'm365_unified_audit' as const

export type SettingsPriorityAttentionItem = {
  id: string
  title: string
  status: string
  statusVariant: 'amber' | 'red' | 'blue'
  explanation: string
  timestamp: string | null
  actionLabel: string
  targetTab: string
  targetRowId?: string
  scope: 'CORE_COLLECTION' | 'OPTIONAL_CAPABILITY'
}

type SettingsAuditSyncEvidence = {
  classification?: unknown
  message?: string | null
  lastAttemptAt?: string | null
} | null

/** Build one priority item per canonical workload/resource identity. */
export function settingsPriorityAttentionItems(
  readiness: CollectionReadinessView | null,
  auditSync: SettingsAuditSyncEvidence,
): SettingsPriorityAttentionItem[] {
  const items = (readiness?.workloads ?? []).flatMap((workload) => {
    if (!isActionableReadinessState(workload.state)) return []
    const isRed = ['BLOCKED_PERMISSION', 'BLOCKED_TENANT_CONFIGURATION', 'FAILED_TRANSIENT'].includes(workload.state)
    const datasets = workload.datasets ?? []
    const optionalOnly = datasets.length > 0 && datasets.every((dataset) => dataset.tier !== 'CORE')
    return [{
      id: `collection-${workload.key}`,
      title: workload.workload,
      status: readinessLabel(workload.state),
      statusVariant: isRed ? 'red' as const : 'amber' as const,
      explanation: readinessDiagnostic(workload.reasonCode, workload.reason) || workload.remediation || 'Requires attention.',
      timestamp: workload.lastAttemptAt || workload.lastVerifiedAt,
      actionLabel: 'Investigate in Collection',
      targetTab: 'collection',
      targetRowId: `row-${workload.key}`,
      scope: optionalOnly ? 'OPTIONAL_CAPABILITY' as const : 'CORE_COLLECTION' as const,
    }]
  })

  const auditCollectionId = `collection-${M365_UNIFIED_AUDIT_WORKLOAD_KEY}`
  if (auditSyncRequiresAction(auditSync) && !items.some((item) => item.id === auditCollectionId)) {
    items.push({
      id: 'audit-sync',
      title: 'Microsoft 365 Unified Audit',
      status: readinessLabel(String(auditSync?.classification)),
      statusVariant: 'amber',
      explanation: auditSync?.message || 'Audit log synchronization requires attention.',
      timestamp: auditSync?.lastAttemptAt ?? null,
      actionLabel: 'Investigate in Sync',
      targetTab: 'synchronization',
      targetRowId: `row-${M365_UNIFIED_AUDIT_WORKLOAD_KEY}`,
      scope: 'CORE_COLLECTION',
    })
  }

  return items
}

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

export type SettingsSynchronizationAttention = {
  total: number
  failed: number
  blocked: number
  backlogged: number
  stale: number
  other: number
  label: string
}

export function settingsSynchronizationStateLabel(
  state: SettingsSynchronizationRow['status'],
) {
  const labels: Record<SettingsSynchronizationRow['status'], string> = {
    READY: 'Ready',
    FAILED_TRANSIENT: 'Temporary Collection Failure',
    BACKLOGGED: 'Processing Backlog',
    BLOCKED_PERMISSION: 'Permission Blocked',
    BLOCKED_TENANT_CONFIGURATION: 'Tenant Setup Blocked',
    STALE: 'Stale',
    PARTIAL: 'Partial',
    INITIALIZING: 'Initializing',
    UNVERIFIED: 'Unverified',
    NEVER_SUCCEEDED: 'Never Collected',
    NOT_LICENSED: 'Not Licensed',
    UNSUPPORTED: 'Unsupported',
  }
  return labels[state]
}

/**
 * Non-ready workloads are not all failures. Keep operational failures,
 * permission/configuration blocks, processing backlogs, and stale data
 * distinct so the Settings summary never overstates the incident count.
 */
export function settingsSynchronizationAttention(
  rows: SettingsSynchronizationRow[],
): SettingsSynchronizationAttention {
  const applicable = rows.filter((row) =>
    row.status !== 'NOT_LICENSED' && row.status !== 'UNSUPPORTED',
  )
  const failed = applicable.filter((row) => row.status === 'FAILED_TRANSIENT').length
  const blocked = applicable.filter((row) =>
    ['BLOCKED_PERMISSION', 'BLOCKED_TENANT_CONFIGURATION'].includes(row.status),
  ).length
  const backlogged = applicable.filter((row) => row.status === 'BACKLOGGED').length
  const stale = applicable.filter((row) => row.status === 'STALE').length
  const total = applicable.filter((row) => isActionableReadinessState(row.status)).length
  const other = Math.max(0, total - failed - blocked - backlogged - stale)
  const parts = [
    failed ? `${failed} temporary failure${failed === 1 ? '' : 's'}` : null,
    blocked ? `${blocked} blocked` : null,
    backlogged ? `${backlogged} processing backlog${backlogged === 1 ? '' : 's'}` : null,
    stale ? `${stale} stale` : null,
    other ? `${other} never collected` : null,
  ].filter((part): part is string => Boolean(part))

  return {
    total,
    failed,
    blocked,
    backlogged,
    stale,
    other,
    label: parts.join(' · ') || 'None',
  }
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
  if (summary.attentionWorkloads > 0) {
    return { state: 'NEEDS_ATTENTION', label: 'Collection needs attention' }
  }
  return { state: 'UNVERIFIED', label: 'Collection status informational' }
}
