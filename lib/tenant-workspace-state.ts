import type { TenantBundle, TenantSyncStatus } from '@/types/tenant-data'

export type TenantWorkspaceState =
  | 'healthy'
  | 'syncing'
  | 'needs-attention'
  | 'disconnected'
  | 'pending-setup'
  | 'partially-synchronized'
  | 'stale'

export type TenantConnectionState =
  | 'connected'
  | 'disconnected'
  | 'pending'
  | 'unknown'

export type TenantIssue = {
  id: string
  service: string
  title: string
  detail: string
  action?: string
}

export type TenantWorkspaceDisplay = {
  state: TenantWorkspaceState
  stateLabel: string
  connection: TenantConnectionState
  connectionLabel: string
  lastSuccessfulSync: string | null
  issueCount: number
  issues: TenantIssue[]
  isInitialSync: boolean
  isStale: boolean
}

const STATE_LABELS: Record<TenantWorkspaceState, string> = {
  healthy: 'Healthy',
  syncing: 'Syncing',
  'needs-attention': 'Needs Attention',
  disconnected: 'Disconnected',
  'pending-setup': 'Pending Setup',
  'partially-synchronized': 'Partially Synchronized',
  stale: 'Stale',
}

function normalized(value: unknown) {
  return String(value ?? '').trim().toLowerCase()
}

function syncEntries(bundle: TenantBundle | null | undefined) {
  if (!bundle?.sync) return [] as Array<[string, TenantSyncStatus]>
  return Object.entries(bundle.sync).filter(
    (entry): entry is [string, TenantSyncStatus] =>
      Boolean(entry[1] && typeof entry[1] === 'object' && 'status' in entry[1])
  )
}

function newestSuccessfulSync(bundle: TenantBundle | null | undefined) {
  const values = syncEntries(bundle)
    .map(([, sync]) => sync.lastSuccessfulAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())
  return values[0] ?? (bundle?.tenant as any)?.lastSync ?? null
}

function connectionState(tenant: any): TenantConnectionState {
  const raw = normalized(
    tenant?.connectionStatus ?? tenant?.status ?? tenant?.connection?.status
  )
  if (['active', 'healthy', 'connected', 'ready'].includes(raw)) return 'connected'
  if (['pending', 'pending_setup', 'pending setup', 'authorizing'].includes(raw))
    return 'pending'
  if (['disconnected', 'revoked', 'invalid', 'expired', 'failed'].includes(raw))
    return 'disconnected'
  return 'unknown'
}

export function deriveTenantWorkspaceDisplay(
  bundle: TenantBundle | null | undefined,
  manualSyncing = false
): TenantWorkspaceDisplay {
  const tenant = bundle?.tenant as any
  const connection = connectionState(tenant)
  const entries = syncEntries(bundle)
  const issues: TenantIssue[] = []

  for (const [service, sync] of entries) {
    const status = normalized(sync.status)
    if (sync.lastError || ['failed', 'error', 'partial'].includes(status)) {
      issues.push({
        id: `sync-${service}`,
        service,
        title: `${service} synchronization ${status === 'partial' ? 'is partial' : 'failed'}`,
        detail: sync.lastError || 'The latest synchronization did not complete.',
        action: 'Review synchronization',
      })
    }
  }

  const missingPermissions = Array.isArray(tenant?.missingPermissions)
    ? tenant.missingPermissions
    : Array.isArray((bundle as any)?.missingPermissions)
      ? (bundle as any).missingPermissions
      : []
  if (missingPermissions.length) {
    issues.push({
      id: 'missing-permissions',
      service: 'Microsoft connection',
      title: `${missingPermissions.length} permission${missingPermissions.length === 1 ? '' : 's'} required`,
      detail: missingPermissions.join(', '),
      action: 'Review and authorize',
    })
  }

  const lastSuccessfulSync = newestSuccessfulSync(bundle)
  const isInitialSync =
    connection === 'connected' &&
    !lastSuccessfulSync &&
    (manualSyncing || entries.some(([, s]) => ['pending', 'queued', 'running', 'syncing'].includes(normalized(s.status))))
  const isSyncing =
    manualSyncing ||
    entries.some(([, s]) => ['pending', 'queued', 'running', 'syncing'].includes(normalized(s.status)))

  const explicitStale = Boolean(
    tenant?.isStale ||
      tenant?.stale ||
      entries.some(([, s]) => normalized(s.status) === 'stale')
  )
  const successful = entries.filter(([, s]) => Boolean(s.lastSuccessfulAt)).length
  const partial = entries.length > 0 && successful > 0 && successful < entries.length

  let state: TenantWorkspaceState = 'healthy'
  if (connection === 'disconnected') state = 'disconnected'
  else if (connection === 'pending') state = 'pending-setup'
  else if (isSyncing) state = 'syncing'
  else if (issues.length) state = partial ? 'partially-synchronized' : 'needs-attention'
  else if (explicitStale) state = 'stale'
  else if (partial) state = 'partially-synchronized'
  else if (connection === 'unknown' && !lastSuccessfulSync) state = 'pending-setup'

  return {
    state,
    stateLabel: STATE_LABELS[state],
    connection,
    connectionLabel:
      connection === 'connected'
        ? 'Microsoft connected'
        : connection === 'disconnected'
          ? 'Microsoft disconnected'
          : connection === 'pending'
            ? 'Connection pending'
            : 'Connection not verified',
    lastSuccessfulSync,
    issueCount: issues.length,
    issues,
    isInitialSync,
    isStale: explicitStale,
  }
}

export function formatTenantTimestamp(value?: string | null) {
  if (!value) return 'Awaiting first successful sync'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unavailable'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

export function statusTone(state: TenantWorkspaceState) {
  if (state === 'healthy') return 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
  if (state === 'syncing') return 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300'
  if (state === 'disconnected') return 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300'
  if (state === 'pending-setup') return 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
  return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
}
