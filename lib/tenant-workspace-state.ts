import type { TenantBundle, TenantSyncStatus } from '@/types/tenant-data'
import type { PilotEvidenceView } from './tenants/collection-readiness'

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
  severity: 'Warning' | 'Error' | 'Critical'
  title: string
  detail: string
  explanation?: string
  impact?: string
  technicalDetails?: string
  recommendedSteps?: string[]
  action?: string
  lastDetectedAt?: string | null
  targetModule?: string
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

function newestSuccessfulSync(
  bundle: TenantBundle | null | undefined,
  notBefore?: string | null
) {
  const minimum = notBefore ? new Date(notBefore).getTime() : null
  const values = syncEntries(bundle)
    .map(([, sync]) => sync.lastSuccessfulAt)
    .filter((value): value is string => Boolean(value))
    .filter(
      (value) =>
        minimum === null ||
        Number.isNaN(minimum) ||
        new Date(value).getTime() >= minimum
    )
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())
  if (values[0]) return values[0]

  const tenantLastSync = (bundle?.tenant as any)?.lastSync ?? null
  if (!tenantLastSync || minimum === null || Number.isNaN(minimum)) {
    return tenantLastSync
  }
  return new Date(tenantLastSync).getTime() >= minimum ? tenantLastSync : null
}

function resourceTypeForSyncEntry(service: string, sync: TenantSyncStatus) {
  if (sync.resourceType) return sync.resourceType.toUpperCase()
  return service
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toUpperCase()
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
  manualSyncing = false,
  signInEvidence: PilotEvidenceView['signIns'] | null = null,
): TenantWorkspaceDisplay {
  const tenant = bundle?.tenant as any
  const connection = connectionState(tenant)
  const entries = syncEntries(bundle)
  const issues: TenantIssue[] = []
  const initialSync = tenant?.initialSync as
    | {
        status?: string
        startedAt?: string | null
        pendingResources?: string[]
        retryingResources?: string[]
        actionRequiredResources?: string[]
      }
    | undefined
  const initialSyncStatus = normalized(initialSync?.status).replaceAll('-', '_')
  const backendInitialSyncInProgress = initialSyncStatus === 'in_progress'
  const backendInitialSyncDelayed = initialSyncStatus === 'delayed'
  const deferredInitialSyncResources = new Set(
    [
      ...(initialSync?.pendingResources ?? []),
      ...(initialSync?.retryingResources ?? []),
    ].map((resource) => resource.toUpperCase())
  )

  for (const [service, sync] of entries) {
    const resourceType = resourceTypeForSyncEntry(service, sync)
    // Once readiness has selected an evidence source, its state is authoritative.
    // A failed non-selected Graph attempt must not override current audit-feed
    // evidence or create a duplicate retry action.
    if (resourceType === 'SIGN_INS' && signInEvidence?.selectedSource) continue
    const status = normalized(sync.status)
    if (sync.lastError || ['failed', 'error', 'partial'].includes(status)) {
      if (
        (backendInitialSyncInProgress || backendInitialSyncDelayed) &&
        deferredInitialSyncResources.has(resourceType)
      ) {
        continue
      }
      const sLower = service.toLowerCase()
      const rawError = String(sync.lastError || '')
      const isForbidden = rawError.includes('403') || rawError.toLowerCase().includes('forbidden') || rawError.toLowerCase().includes('access denied')
      const isUnauthorized = rawError.includes('401') || rawError.toLowerCase().includes('unauthorized') || rawError.toLowerCase().includes('token')

      const moduleKey = isForbidden || isUnauthorized
        ? 'settings'
        : sLower.includes('entra') || sLower.includes('user') || sLower.includes('group') ? 'entra'
        : sLower.includes('exchange') || sLower.includes('mailbox') ? 'exchange'
        : sLower.includes('sharepoint') || sLower.includes('site') || sLower.includes('onedrive') ? 'sharepoint'
        : sLower.includes('team') ? 'teams'
        : sLower.includes('license') ? 'license-activity'
        : 'settings'

      const serviceName = sLower.includes('m365audit') ? 'Microsoft 365 audit'
        : sLower.includes('signin') ? 'Sign-ins'
        : sLower.includes('group') ? 'Entra Groups'
        : sLower.includes('user') ? 'Entra Users'
        : sLower.includes('entra') ? 'Entra ID'
        : sLower.includes('exchange') || sLower.includes('mailbox') ? 'Exchange'
        : sLower.includes('sharepoint') || sLower.includes('site') || sLower.includes('onedrive') ? 'SharePoint / OneDrive'
        : sLower.includes('team') ? 'Teams'
        : sLower.includes('license') ? 'License Activity'
        : service.charAt(0).toUpperCase() + service.slice(1)

      const severity = status === 'failed' || status === 'error' || isForbidden || isUnauthorized ? 'Error' : 'Warning'
      const timestamp = (sync as any).lastAttemptAt || (sync as any).updatedAt || (sync as any).lastFailedAt || null

      let plainTitle = `${serviceName} data could not be synchronized`
      let explanation = `The most recent attempt to pull data for ${serviceName} encountered an error.`
      let impact = `${serviceName} records and state may be incomplete or out of date.`
      let technicalDetails = sync.lastError ? `Microsoft Graph returned: ${sync.lastError}` : `Synchronization failed with status "${sync.status}"`
      let recommendedSteps = [
        `Click "Retry synchronization" to attempt pulling fresh data.`,
        `Verify Microsoft 365 service health if the issue persists.`
      ]
      let actionLabel = `Retry synchronization`

      if (isForbidden) {
        plainTitle = `${serviceName} access denied`
        explanation = `HawkView was denied access while requesting Microsoft ${serviceName} data. Group membership, ownership, or service configuration information may be incomplete.`
        impact = `Service inspection and audit reports for ${serviceName} will remain restricted until access permissions are granted.`
        technicalDetails = `Microsoft Graph returned HTTP 403 (Forbidden): ${sync.lastError}`
        recommendedSteps = [
          `Navigate to Tenant Settings to review Microsoft Graph API permissions.`,
          `Ensure the enterprise app registration has required Graph reader scopes.`,
          `Grant admin consent in Microsoft Entra admin center.`
        ]
        actionLabel = `Review permissions`
      } else if (isUnauthorized) {
        plainTitle = `${serviceName} authentication failed`
        explanation = `The authentication token or credentials for Microsoft 365 expired or are invalid.`
        impact = `HawkView is unable to authenticate requests to fetch ${serviceName} data.`
        technicalDetails = `Microsoft Authentication returned HTTP 401 (Unauthorized): ${sync.lastError}`
        recommendedSteps = [
          `Navigate to Tenant Settings.`,
          `Re-authorize or re-link Microsoft 365 tenant credentials.`
        ]
        actionLabel = `Review permissions`
      }

      issues.push({
        id: `sync-${service}`,
        service: serviceName,
        severity,
        title: plainTitle,
        detail: explanation,
        explanation,
        impact,
        technicalDetails,
        recommendedSteps,
        action: actionLabel,
        lastDetectedAt: timestamp,
        targetModule: moduleKey,
      })
    }
  }

  if (
    signInEvidence?.selectedSource &&
    ['STALE', 'FAILED_TRANSIENT', 'BLOCKED_PERMISSION', 'BLOCKED_TENANT_CONFIGURATION'].includes(signInEvidence.availability)
  ) {
    const blocked = signInEvidence.availability === 'BLOCKED_PERMISSION' ||
      signInEvidence.availability === 'BLOCKED_TENANT_CONFIGURATION'
    const stale = signInEvidence.availability === 'STALE'
    issues.push({
      id: 'sync-signIns',
      service: 'Sign-ins',
      severity: blocked || signInEvidence.availability === 'FAILED_TRANSIENT' ? 'Error' : 'Warning',
      title: blocked
        ? 'Selected sign-in source is blocked'
        : stale
          ? 'Selected sign-in evidence is stale'
          : 'Selected sign-in collection failed',
      detail: signInEvidence.reason ?? 'The selected Microsoft sign-in evidence source needs attention.',
      explanation: signInEvidence.reason ?? 'The selected Microsoft sign-in evidence source needs attention.',
      impact: stale
        ? 'Retained sign-in evidence remains available but is outside the current freshness window.'
        : 'Current sign-in evidence is unavailable from the selected source.',
      technicalDetails: signInEvidence.reasonCode
        ? `Selected evidence state: ${signInEvidence.availability} (${signInEvidence.reasonCode})`
        : `Selected evidence state: ${signInEvidence.availability}`,
      recommendedSteps: blocked
        ? ['Review the selected sign-in source permissions in Tenant Settings.']
        : ['Retry synchronization for the selected sign-in source.', 'Review Microsoft service health if the issue persists.'],
      action: blocked ? 'Review permissions' : 'Retry synchronization',
      lastDetectedAt: signInEvidence.observedAt,
      targetModule: blocked ? 'settings' : 'entra',
    })
  }

  if (connection === 'disconnected') {
    issues.push({
      id: 'connection-disconnected',
      service: 'Microsoft 365',
      severity: 'Critical',
      title: 'Microsoft 365 tenant is disconnected',
      detail: 'Connection to the Microsoft tenant is currently inactive or revoked.',
      explanation: 'HawkView cannot establish an active connection to fetch tenant data.',
      impact: 'No automated data synchronization or security checks can take place.',
      technicalDetails: 'Tenant connection status is set to disconnected.',
      recommendedSteps: [
        'Navigate to Tenant Settings.',
        'Click "Authorize Tenant" or re-link Microsoft 365 connection.'
      ],
      action: 'Review permissions',
      targetModule: 'settings',
    })
  }

  const missingPermissions = Array.isArray(tenant?.missingPermissions)
    ? tenant.missingPermissions
    : Array.isArray((bundle as any)?.missingPermissions)
      ? (bundle as any).missingPermissions
      : []
  if (missingPermissions.length) {
    issues.push({
      id: 'missing-permissions',
      service: 'Entra ID',
      severity: 'Critical',
      title: `${missingPermissions.length} required permission${missingPermissions.length === 1 ? '' : 's'} missing`,
      detail: `Missing permissions: ${missingPermissions.join(', ')}`,
      explanation: 'The connected Microsoft tenant has not consented to all required administrative API scopes.',
      impact: 'Data inspection across affected tenant modules will be restricted.',
      technicalDetails: `Missing OAuth Scopes: ${missingPermissions.join(', ')}`,
      recommendedSteps: [
        'Open Tenant Settings.',
        'Grant missing admin consent scopes for Microsoft Graph API.'
      ],
      action: 'Review in Tenant Settings',
      targetModule: 'settings',
    })
  }

  if (backendInitialSyncDelayed) {
    issues.push({
      id: 'initial-sync-delayed',
      service: 'Microsoft 365',
      severity: 'Warning',
      title: 'Initial synchronization is taking longer than expected',
      detail:
        'HawkView is still collecting Microsoft 365 data and will continue retrying automatically.',
      explanation:
        'HawkView is still collecting Microsoft 365 data and will continue retrying automatically.',
      impact:
        'Some tenant pages may remain incomplete until the initial collection finishes.',
      recommendedSteps: [
        'Allow HawkView to continue retrying automatically.',
        'Use Retry synchronization if you want to request another collection now.',
      ],
      action: 'Retry synchronization',
      targetModule: 'settings',
    })
  }

  const lastSuccessfulSync = newestSuccessfulSync(
    bundle,
    initialSync?.startedAt ?? null
  )
  const legacyInitialSync =
    connection === 'connected' &&
    !lastSuccessfulSync &&
    (manualSyncing || entries.some(([, s]) => ['pending', 'queued', 'running', 'syncing'].includes(normalized(s.status))))
  const isInitialSync =
    backendInitialSyncInProgress || backendInitialSyncDelayed || legacyInitialSync
  const isSyncing =
    manualSyncing ||
    backendInitialSyncInProgress ||
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
