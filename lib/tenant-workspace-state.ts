import { customerAttention, customerStatus, customerTarget, type CustomerAttention } from './attention/customer-attention.ts'
import type { TenantBundle, TenantSyncStatus, SyncOutcomeProjection, ServiceSyncFreshness } from '@/types/tenant-data'
import type {
  AttentionItem,
} from '@/types/attention'
import {
  type TenantActionableHealthProjection,
} from './attention/computeTenantAttention.ts'
import type { PilotEvidenceView } from './tenants/collection-readiness'

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
  customer?: CustomerAttention
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

function workspaceIssueFromAttention(item: AttentionItem): TenantIssue {
  const severity = item.severity === 'critical'
    ? 'Critical' as const
    : item.severity === 'high'
      ? 'Error' as const
      : 'Warning' as const
  return {
    id: item.key,
    service: item.provenance?.origin === 'ACCESS_CONFIGURATION' ? 'Access setup' : 'Tenant finding',
    severity,
    title: item.label,
    detail: item.why,
    explanation: item.why,
    action: item.actionLabel ?? 'Review issue',
    actionUrl: item.actionUrl,
    lastDetectedAt: item.detectedAt ?? null,
    targetModule: customerTarget(item.provenance),
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
): TenantWorkspaceDisplay {
  const source = actionableHealth?.customer ?? customerAttention(bundle)
  const hasRecordedGap = syncEntries(bundle).some(([resource, sync]) =>
    !(resourceTypeForSyncEntry(resource) === 'SIGN_INS' && signInEvidence?.selectedSource) &&
    (Boolean(sync.lastError) || ['failed', 'error', 'partial', 'stale'].includes(normalized(sync.status))))
  const customer = { ...source, incomplete: source.incomplete || hasRecordedGap ||
    Boolean(signInEvidence && !['READY'].includes(signInEvidence.availability)) }
  const issues = [...customer.findings, ...customer.accessActions].map(workspaceIssueFromAttention)
  const connection = connectionState(bundle?.tenant)
  const state: TenantWorkspaceState = customer.findings.length ? 'needs-attention'
    : customer.accessActions.length ? 'pending-setup' : customer.incomplete ? 'unverified' : 'healthy'
  return {
    customer, state, stateLabel: customerStatus(customer), connection,
    connectionLabel: connection === 'connected' ? 'Microsoft connected' : 'Connection not verified',
    lastSuccessfulSync: null, issueCount: issues.length, issues,
    isInitialSync: false, isStale: signInEvidence?.availability === 'STALE',
    attentionVerified: !customer.incomplete, syncRequestPending: manualSyncing,
    // Retained as data only; no operator destination has been established.
    syncObservations: syncEntries(bundle).map(([resource, sync]) => ({
      resource, detail: recordedSyncOutcome(sync, resource), diagnostic: sync.lastError ?? null,
    })),
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
