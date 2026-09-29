import type { TenantBundle, TenantSyncStatus, SyncOutcomeProjection, ServiceSyncFreshness } from '@/types/tenant-data'
import type {
  AttentionItem,
} from '@/types/attention'
import {
  tenantActionableHealthProjection,
  type TenantActionableHealthProjection,
} from './attention/computeTenantAttention.ts'
import type { CollectionReadinessView, PilotEvidenceView } from './tenants/collection-readiness'

export type TenantWorkspaceState =
  | 'healthy'
  | 'syncing'
  | 'needs-attention'
  | 'disconnected'
  | 'pending-setup'
  | 'partially-synchronized'
  | 'stale'
  | 'unverified'

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
  actionUrl?: string
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
  attentionVerified: boolean
  syncRequestPending: boolean
  syncObservations: Array<{ resource: string; detail: string; diagnostic: string | null }>
}

const STATE_LABELS: Record<TenantWorkspaceState, string> = {
  healthy: 'Healthy',
  syncing: 'Syncing',
  'needs-attention': 'Needs Attention',
  disconnected: 'Disconnected',
  'pending-setup': 'Pending Setup',
  'partially-synchronized': 'Partially Synchronized',
  stale: 'Stale',
  unverified: 'Health Not Verified',
}

function attentionService(item: AttentionItem) {
  const key = item.key.toLowerCase()
  if (key.includes('risky') || key.includes('identity')) return 'Identity Protection'
  if (key.includes('sign')) return 'Sign-ins'
  if (key.includes('conditional')) return 'Conditional Access'
  if (key.includes('mfa') || key.includes('auth')) return 'Authentication'
  if (key.includes('audit')) return 'Microsoft 365 audit'
  if (key.includes('sharepoint')) return 'SharePoint / OneDrive'
  if (key.includes('exchange')) return 'Exchange'
  return 'Microsoft 365'
}

function attentionTargetModule(item: AttentionItem) {
  const key = item.key.toLowerCase()
  if (key.includes('risky')) return 'risky-users'
  if (
    key.includes('authorization') ||
    key.includes('permission') ||
    key.includes('connection') ||
    key.startsWith('sync-')
  ) return 'settings'
  if (
    key.includes('identity') ||
    key.includes('mfa') ||
    key.includes('auth') ||
    key.includes('conditional')
  ) return 'entra'
  return 'settings'
}

function workspaceIssueFromAttention(item: AttentionItem): TenantIssue {
  const severity = item.severity === 'critical'
    ? 'Critical' as const
    : item.severity === 'high'
      ? 'Error' as const
      : 'Warning' as const
  return {
    id: item.key,
    service: attentionService(item),
    severity,
    title: item.label,
    detail: item.why,
    explanation: item.why,
    action: item.actionLabel ?? 'Review issue',
    actionUrl: item.actionUrl,
    lastDetectedAt: item.detectedAt ?? null,
    targetModule: attentionTargetModule(item),
  }
}

function normalized(value: unknown) {
  return String(value ?? '').trim().toLowerCase()
}

function syncEntries(bundle: TenantBundle | null | undefined) {
  const entries = Object.entries(bundle?.sync ?? {}).filter(
    (entry): entry is [string, TenantSyncStatus] =>
      Boolean(entry[1] && typeof entry[1] === 'object' && 'status' in entry[1])
  )
  const resources = new Set(entries.map(([service]) => resourceTypeForSyncEntry(service)).filter(Boolean))
  for (const [service, value] of Object.entries(bundle?.exchange?.sync ?? {})) {
    if (!value || typeof value !== 'object' || !('status' in value)) continue
    const sync = value as TenantSyncStatus
    const key = `exchange.${service}`
    const resource = resourceTypeForSyncEntry(key)
    if (!resource || !resources.has(resource)) {
      entries.push([key, sync])
      if (resource) resources.add(resource)
    }
  }
  return entries
}

// Identity comes from the serialized container, never from the value being checked.
const SYNC_RESOURCES: Record<string, string> = {
  users: 'USERS', licenses: 'LICENSES', domains: 'DOMAINS', groups: 'GROUPS',
  signIns: 'SIGN_INS', auditLogs: 'AUDIT_LOGS', m365Audit: 'M365_AUDIT',
  sharePointSites: 'SHAREPOINT_SITES', sharePointSettings: 'SHAREPOINT_SETTINGS', sharePointUsage: 'SHAREPOINT_USAGE',
  applications: 'APPLICATIONS', servicePrincipals: 'SERVICE_PRINCIPALS', securityDefaults: 'SECURITY_DEFAULTS',
  mailboxes: 'EXCHANGE_MAILBOXES', rules: 'EXCHANGE_MAILBOX_RULES',
  'exchange.mailboxes': 'EXCHANGE_MAILBOXES', 'exchange.mailboxSettings': 'EXCHANGE_MAILBOX_SETTINGS',
  'exchange.mailboxUsage': 'EXCHANGE_MAILBOX_USAGE', 'exchange.acceptedDomains': 'EXCHANGE_ACCEPTED_DOMAINS',
  'exchange.inboxRules': 'EXCHANGE_MAILBOX_RULES', 'exchange.configuration': 'EXCHANGE_MAILBOX_CONFIGURATION',
}
const LIMITED_SIGN_IN_REASONS = new Set([
  'sign-ins-premium-graph-fallback-active', 'sign-ins-non-premium-fallback-active',
  'sign-ins-entitlement-unverified-fallback-active',
  'sign-ins-premium-graph-fallback-active-geolocation-partial',
  'sign-ins-non-premium-fallback-active-geolocation-partial',
  'sign-ins-entitlement-unverified-fallback-active-geolocation-partial',
])
const INITIALIZING_REASON = 'sign-ins-audit-subscription-initializing'
const DEFERRED_REASONS = new Set(['m365-audit-backlog', 'm365-audit-budget-exhausted'])

function outcomeProjection(service: string, sync: TenantSyncStatus): SyncOutcomeProjection | null {
  const p = sync.outcomeProjection
  const expectedResource = resourceTypeForSyncEntry(service)
  if (!expectedResource || p?.version !== 1 || p.resourceType !== expectedResource ||
    p.execution !== 'UNKNOWN' || !p.recordedOutcome) return null
  // Match the combinations emitted by projectSyncOutcome v1. Independent enum
  // membership cannot establish a coherent outcome for this record.
  const { kind, basis, relation } = p.recordedOutcome
  const raw = normalized(sync.status).toUpperCase()
  const limited = expectedResource === 'SIGN_INS' && LIMITED_SIGN_IN_REASONS.has(p.reasonCode ?? '')
  const initializing = expectedResource === 'SIGN_INS' && p.reasonCode === INITIALIZING_REASON
  const deferred = expectedResource === 'M365_AUDIT' && DEFERRED_REASONS.has(p.reasonCode ?? '')
  if (p.reasonCode !== null && !limited && !initializing && !deferred) return null
  if (p.lastAttemptAt !== null && (typeof p.lastAttemptAt !== 'string' ||
    !Number.isFinite(Date.parse(p.lastAttemptAt)) || Date.parse(p.lastAttemptAt) > Date.now() ||
    new Date(p.lastAttemptAt).toISOString() !== p.lastAttemptAt)) return null
  let valid = false
  if (raw === 'SUCCEEDED' || raw === 'FAILED') {
    valid = kind === raw && basis === 'STORED_STATUS' && relation === 'LATEST_RECORDED'
  } else if (raw === 'IDLE') {
    valid = kind === 'NOT_STARTED_OR_IDLE' && basis === 'STORED_STATUS' && relation === 'UNKNOWN'
  } else if (raw === 'PENDING' || raw === 'QUEUED') {
    valid = kind === 'AWAITING_EXECUTION' && basis === 'LEGACY_LABEL' && relation === 'UNKNOWN'
  } else if (raw === 'RUNNING' && (limited || initializing || deferred)) {
    const expectedKind = limited ? 'LIMITED_COLLECTION_RECORDED'
      : initializing ? 'INITIALIZATION_WAIT_RECORDED' : 'DEFERRED_WORK_RECORDED'
    const attempt = p.lastAttemptAt ? Date.parse(p.lastAttemptAt) : NaN
    const parsedSuccess = sync.lastSuccessfulAt ? Date.parse(sync.lastSuccessfulAt) : NaN
    const success = parsedSuccess <= Date.now() ? parsedSuccess : NaN
    const expectedRelation = deferred ? 'LATEST_RECORDED'
      : limited && Number.isFinite(attempt) && Number.isFinite(success) && attempt > success
        ? 'PREDATES_ATTEMPT' : 'RETAINED_OR_CURRENT'
    valid = kind === expectedKind && basis === 'RECOGNIZED_RETURN_PATH' && relation === expectedRelation
  } else {
    valid = kind === 'UNKNOWN' && basis === 'UNCLASSIFIED' && relation === 'UNKNOWN'
  }
  return valid ? p : null
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

function resourceTypeForSyncEntry(service: string): string | null {
  return Object.prototype.hasOwnProperty.call(SYNC_RESOURCES, service) ? SYNC_RESOURCES[service] : null
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
  actionableHealth: TenantActionableHealthProjection | null = null,
  collectionContext?: { readiness?: CollectionReadinessView | null; resourceHealth?: unknown },
): TenantWorkspaceDisplay {
  const tenant = bundle?.tenant as any
  const connection = connectionState(tenant)
  const entries = syncEntries(bundle)
  const acceptedHealth = actionableHealth?.status === 'VERIFIED'
    ? tenantActionableHealthProjection({ attention: actionableHealth.items })
    : { status: 'UNAVAILABLE' as const, items: [] }
  const attentionVerified = acceptedHealth.status === 'VERIFIED'
  const issues: TenantIssue[] = attentionVerified
    ? acceptedHealth.items.map(workspaceIssueFromAttention) : []
  const useLegacyIssueDerivation = !attentionVerified
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

  // Supplement silent health only with explicit failed/partial records. Unknown,
  // queued, retained diagnostics and capability-limited evidence are not incidents.
  const excludedResources = new Set<string>()
  for (const workload of collectionContext?.readiness?.workloads ?? []) {
    for (const dataset of workload.datasets) {
      if (['NOT_LICENSED', 'UNSUPPORTED'].includes(dataset.state) ||
        (dataset.tier === 'CAPABILITY_OPTIONAL' &&
          (dataset.state === 'BLOCKED_PERMISSION' || dataset.permissionStatus === 'MISSING'))) {
        dataset.resourceTypes.forEach(resource => excludedResources.add(resource))
      }
    }
  }
  if (Array.isArray(collectionContext?.resourceHealth)) {
    for (const row of collectionContext.resourceHealth) {
      if (row && typeof row.resourceType === 'string' &&
        (['NOT_LICENSED', 'UNSUPPORTED'].includes(row.classification) ||
          (row.required === false && ['PERMISSION_REQUIRED', 'NOT_CONFIGURED'].includes(row.classification)))) {
        excludedResources.add(row.resourceType)
      }
    }
  }
  const sourceNames: Record<string, string> = {
    USERS: 'User', LICENSES: 'License', DOMAINS: 'Domain', GROUPS: 'Group',
    SIGN_INS: 'Sign-ins', AUDIT_LOGS: 'Directory audit', M365_AUDIT: 'Microsoft 365 audit',
    SHAREPOINT_SITES: 'SharePoint site', SHAREPOINT_SETTINGS: 'SharePoint settings', SHAREPOINT_USAGE: 'SharePoint usage',
    APPLICATIONS: 'Application', SERVICE_PRINCIPALS: 'Enterprise application', SECURITY_DEFAULTS: 'Security defaults',
    EXCHANGE_MAILBOXES: 'Mailbox', EXCHANGE_MAILBOX_SETTINGS: 'Mailbox settings', EXCHANGE_MAILBOX_USAGE: 'Mailbox usage',
    EXCHANGE_ACCEPTED_DOMAINS: 'Accepted email domain', EXCHANGE_MAILBOX_RULES: 'Inbox rule', EXCHANGE_MAILBOX_CONFIGURATION: 'Exchange configuration',
  }
  const addCollectionIssue = (resource: string, service: string, issue: TenantIssue) => {
    const ids = new Set([`sync-${resource.toLowerCase()}`, `sync-${service}`])
    const existing = issues.find(item => ids.has(item.id))
    if (existing) {
      // Keep the backend-owned wording and action; attach the source diagnostic
      // to its existing details drawer instead of adding a duplicate issue.
      existing.technicalDetails = [existing.technicalDetails, issue.technicalDetails].filter(Boolean).join('\n')
    } else {
      issues.push(issue)
    }
  }
  for (const [service, sync] of entries) {
    const resource = resourceTypeForSyncEntry(service) ?? service
    if (excludedResources.has(resource) || (resource === 'SIGN_INS' && signInEvidence?.selectedSource)) continue
    const status = normalized(sync.status)
    if (!['failed', 'error', 'partial'].includes(status)) continue
    const name = sourceNames[resource] ?? 'Tenant data'
    const projection = outcomeProjection(service, sync)
    addCollectionIssue(resource, service, {
      id: `sync-${resource.toLowerCase()}`,
      service: name,
      severity: status === 'partial' ? 'Warning' : 'Error',
      title: `${name} collection needs review`,
      detail: status === 'partial' ? 'Some requested data was not collected.' : 'A collection attempt failed; the available data may be incomplete or out of date.',
      technicalDetails: [recordedSyncOutcome(sync, service), sync.lastError].filter(Boolean).join('\n'),
      lastDetectedAt: projection?.lastAttemptAt ?? null,
      // Reviewing existing settings is known; retrying or resolving is not implied.
      action: 'Review collection details',
      targetModule: 'settings',
    })
  }
  if (signInEvidence?.selectedSource && !excludedResources.has('SIGN_INS') &&
    ['STALE', 'FAILED_TRANSIENT', 'BLOCKED_PERMISSION', 'BLOCKED_TENANT_CONFIGURATION'].includes(signInEvidence.availability)) {
    addCollectionIssue('SIGN_INS', 'signIns', {
      id: 'sync-sign_ins', service: 'Sign-ins',
      severity: signInEvidence.availability === 'STALE' ? 'Warning' : 'Error',
      title: signInEvidence.availability === 'STALE' ? 'Selected sign-in evidence is stale' : 'Selected sign-in collection needs review',
      detail: signInEvidence.reason ?? 'Current evidence is unavailable from the selected sign-in source.',
      technicalDetails: `Selected source: ${signInEvidence.selectedSource}\nState: ${signInEvidence.availability}\n${signInEvidence.reasonCode ?? ''}\n${signInEvidence.reason ?? ''}`,
      lastDetectedAt: signInEvidence.observedAt,
      action: 'Review collection details', targetModule: 'settings',
    })
  }

  if (useLegacyIssueDerivation && connection === 'disconnected') {
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
  if (useLegacyIssueDerivation && missingPermissions.length) {
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

  if (useLegacyIssueDerivation && backendInitialSyncDelayed) {
    issues.push({
      id: 'initial-sync-delayed',
      service: 'Microsoft 365',
      severity: 'Warning',
      title: 'Initial synchronization is taking longer than expected',
      detail:
        'Initial collection is incomplete. Current collector activity is not verified.',
      explanation:
        'Initial collection is incomplete. Current collector activity is not verified.',
      impact:
        'Some tenant pages may remain incomplete until the initial collection finishes.',
      recommendedSteps: [
        'Review the recorded collection results and outstanding resources.',
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
  const relevantEntries = entries.filter(([service]) =>
    !excludedResources.has(resourceTypeForSyncEntry(service) ?? service) &&
    !(resourceTypeForSyncEntry(service) === 'SIGN_INS' && signInEvidence?.selectedSource))
  const legacyInitialSync =
    connection === 'connected' &&
    !lastSuccessfulSync &&
    (manualSyncing || relevantEntries.some(([, s]) => ['pending', 'queued', 'running', 'syncing'].includes(normalized(s.status))))
  const isInitialSync =
    backendInitialSyncInProgress || backendInitialSyncDelayed || legacyInitialSync
  // Read the additive projection without interpreting error messages or elapsed time.
  // A selected sign-in source remains authoritative over non-selected attempts.
  const syncObservations = relevantEntries.map(([resource, sync]) => ({
    resource,
    detail: recordedSyncOutcome(sync, resource),
    diagnostic: sync.lastError,
  }))
  if (signInEvidence?.selectedSource) {
    const availability = signInEvidence.availability
    const label = availability === 'READY' ? 'Current sign-in evidence available'
      : availability === 'CURRENT_LIMITED' ? 'Current limited sign-in evidence available'
      : availability === 'STALE' ? 'Selected sign-in evidence is stale'
      : ['FAILED_TRANSIENT', 'BLOCKED_PERMISSION', 'BLOCKED_TENANT_CONFIGURATION'].includes(availability)
        ? 'Selected sign-in source needs attention' : 'Selected sign-in evidence not verified'
    syncObservations.push({
      resource: 'Selected sign-in source',
      detail: `${label}. Source: ${signInEvidence.selectedSource === 'OFFICE_365_ACTIVITY_FEED' ? 'Office 365 activity feed' : 'Microsoft Graph'}. Current collector activity is not verified.`,
      diagnostic: signInEvidence.reason,
    })
  }
  const outcomes = relevantEntries.map(([service, sync]) => outcomeProjection(service, sync)?.recordedOutcome.kind)
  const uncertain = relevantEntries.some(([service, sync], index) =>
    outcomes[index] !== 'SUCCEEDED' || outcomeProjection(service, sync)?.recordedOutcome.relation !== 'LATEST_RECORDED')
    || backendInitialSyncInProgress || backendInitialSyncDelayed
    || (relevantEntries.length === 0 && !signInEvidence?.selectedSource)
    || Boolean(signInEvidence && !['READY', 'CURRENT_LIMITED'].includes(signInEvidence.availability))
  const recordedFailures = relevantEntries.some(([, sync], index) =>
    outcomes[index] === 'FAILED' || ['failed', 'error'].includes(normalized(sync.status))) ||
    Boolean(!excludedResources.has('SIGN_INS') && signInEvidence?.selectedSource && ['FAILED_TRANSIENT', 'BLOCKED_PERMISSION', 'BLOCKED_TENANT_CONFIGURATION'].includes(signInEvidence.availability))

  const serviceFreshness: ServiceSyncFreshness[] = Object.values(bundle?.syncFreshness?.services ?? tenant?.syncFreshness?.services ?? {})
  const explicitStale = Boolean(
    tenant?.isStale ||
      tenant?.stale ||
      relevantEntries.some(([, s]) => normalized(s.status) === 'stale') ||
      signInEvidence?.availability === 'STALE' ||
      serviceFreshness.some(s => s.freshnessStatus === 'STALE' || s.status === 'STALE')
  )
  const successful = relevantEntries.filter(([, s]) => Boolean(s.lastSuccessfulAt)).length
  const partial = (relevantEntries.length > 0 && successful > 0 && successful < relevantEntries.length) ||
    outcomes.includes('LIMITED_COLLECTION_RECORDED') ||
    relevantEntries.some(([, s]) => normalized(s.status) === 'partial') ||
    signInEvidence?.coverage === 'LIMITED' ||
    serviceFreshness.some(s => s.status === 'PARTIAL' || s.partialFailures?.length > 0)

  let state: TenantWorkspaceState = 'healthy'
  if (connection === 'disconnected') state = 'disconnected'
  else if (connection === 'pending') state = 'pending-setup'
  else if (issues.length) state = partial ? 'partially-synchronized' : 'needs-attention'
  else if (recordedFailures || serviceFreshness.some(s => s.status === 'FAILED')) state = partial ? 'partially-synchronized' : 'needs-attention'
  else if (explicitStale) state = 'stale'
  else if (partial) state = 'partially-synchronized'
  else if (!attentionVerified || uncertain) state = 'unverified'
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
    attentionVerified,
    syncRequestPending: manualSyncing,
    syncObservations,
  }
}

/** Deliberately describes a record, not the execution of a collector. */
export function recordedSyncOutcome(sync: TenantSyncStatus, service: string): string {
  const outcome = outcomeProjection(service, sync)?.recordedOutcome
  const labels: Record<string, string> = {
    SUCCEEDED: 'Successful collection recorded',
    FAILED: 'Collection failure recorded',
    NOT_STARTED_OR_IDLE: 'No collection started or collector idle',
    AWAITING_EXECUTION: 'Collection queued',
    LIMITED_COLLECTION_RECORDED: 'Limited collection recorded',
    INITIALIZATION_WAIT_RECORDED: 'Initialization wait recorded',
    DEFERRED_WORK_RECORDED: 'Deferred work recorded',
    UNKNOWN: 'Collection outcome unknown',
  }
  const label = outcome ? labels[outcome.kind] ?? labels.UNKNOWN
    : ['pending', 'queued'].includes(normalized(sync.status)) ? 'Collection pending or queued'
    : ['failed', 'error'].includes(normalized(sync.status)) ? labels.FAILED
    : 'Collection outcome not verified'
  const relation = outcome?.relation === 'PREDATES_ATTEMPT'
    ? '; this outcome predates a newer attempt'
    : outcome?.relation === 'RETAINED_OR_CURRENT'
      ? '; this may be a retained outcome'
      : outcome && outcome.relation !== 'LATEST_RECORDED' ? '; relation to the latest attempt is unknown' : ''
  return `${label}${relation}. Current collector activity is not verified.`
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

export function serviceFreshnessDescription(freshness?: ServiceSyncFreshness | null): string {
  if (!freshness) return 'Freshness unavailable'
  const parts: string[] = []
  if (freshness.status === 'FAILED') parts.push('Collection failed')
  if (freshness.status === 'PARTIAL' || freshness.partialFailures?.length > 0) {
    const count = freshness.partialFailures?.length ?? 0
    parts.push(count ? `Partial — ${count} collector${count === 1 ? '' : 's'} need attention` : 'Partial collection')
  }
  if (freshness.status === 'STALE' || freshness.freshnessStatus === 'STALE') parts.push('Stale data')
  if (freshness.freshnessStatus === 'AGING') parts.push('Aging data')
  if (freshness.status === 'RUNNING') parts.push('Collector activity not verified')
  if (freshness.status === 'PENDING') parts.push('Collection pending')
  if (freshness.status === 'NOT_COLLECTED' || freshness.freshnessStatus === 'NEVER_SYNCED') parts.push('Never synchronized')
  if (freshness.lastSuccessfulCollectionAt) parts.push(`Updated ${formatTenantTimestamp(freshness.lastSuccessfulCollectionAt)}`)
  return parts.join(' · ') || 'Freshness unavailable'
}

export function statusTone(state: TenantWorkspaceState) {
  if (state === 'healthy') return 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
  if (state === 'syncing') return 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300'
  if (state === 'disconnected') return 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300'
  if (state === 'pending-setup') return 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
  if (state === 'unverified') return 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
  return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
}
