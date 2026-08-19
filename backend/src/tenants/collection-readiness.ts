import { sanitizeHealthMessage } from './sanitize-health-message.js'

/**
 * A customer-facing view of persisted collection evidence.  It deliberately
 * does not make Microsoft requests: OAuth verification and a process exit code
 * are not evidence that an individual workload is usable.
 */
export const COLLECTION_READINESS_STATES = [
  'READY',
  'INITIALIZING',
  'PARTIAL',
  'UNVERIFIED',
  'NOT_LICENSED',
  'BLOCKED_PERMISSION',
  'BLOCKED_TENANT_CONFIGURATION',
  'UNSUPPORTED',
  'STALE',
  'BACKLOGGED',
  'FAILED_TRANSIENT',
  'NEVER_SUCCEEDED',
] as const

export type CollectionReadinessState = (typeof COLLECTION_READINESS_STATES)[number]
export type PermissionGrantStatus = 'CONFIRMED' | 'MISSING' | 'UNVERIFIED' | 'NOT_APPLICABLE'

export type ReadinessSyncState = {
  resourceType: string
  status: string
  lastAttemptAt: Date | null
  lastSuccessfulAt: Date | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
}

export type M365ActivitySubscriptionState = {
  contentType: string
  status: string
  lastStartRequestedAt: Date | null
  lastVerifiedAt: Date | null
  lastSuccessfulPollAt: Date | null
  lastError: string | null
}

export type CollectionReadinessRow = {
  key: string
  workload: string
  state: CollectionReadinessState
  configuredCapability: 'CONFIGURED' | 'UNVERIFIED' | 'NOT_CONFIGURED'
  permissionStatus: PermissionGrantStatus
  requiredPermissions: string[]
  lastAttemptAt: string | null
  lastSuccessfulAt: string | null
  freshness: 'CURRENT' | 'AGING' | 'STALE' | 'NEVER_SUCCEEDED' | 'UNKNOWN'
  reasonCode: string | null
  reason: string | null
  lastVerifiedAt?: string | null
  remediation: string
  /** Informational capability boundaries do not degrade supported workload readiness. */
  capabilities?: Array<{
    key: string
    label: string
    state: 'NOT_COLLECTED_LEAST_PRIVILEGE'
    reasonCode: 'NOT_COLLECTED_LEAST_PRIVILEGE'
    source: string
    message: string
  }>
  components?: Array<{
    key: string
    label: string
    state: CollectionReadinessState
    lastAttemptAt: string | null
    lastSuccessfulAt: string | null
    freshness: CollectionReadinessRow['freshness']
    reasonCode: string | null
    reason: string | null
    lastVerifiedAt?: string | null
  }>
  exchangeRbac?: {
    status: PermissionGrantStatus
    state: CollectionReadinessState
    reason: string
  }
}

export type CollectionReadiness = {
  version: 1
  overallState: CollectionReadinessState
  /** Diagnostics always belong to the same selected worst workload as overallState. */
  reasonCode: string | null
  reason: string | null
  lastAttemptAt: string | null
  lastSuccessfulAt: string | null
  evaluatedAt: string
  workloads: CollectionReadinessRow[]
}

type ReadinessInput = {
  connectionStatus: string | null | undefined
  connectionVerifiedAt?: Date | null
  consentedPermissions: string[]
  syncStates: ReadinessSyncState[]
  subscriptions?: M365ActivitySubscriptionState[]
  /** null means the durable license inventory is absent, stale, or not authoritative. */
  licenseServicePlans?: Array<{ servicePlanId?: string; servicePlanName: string; provisioningStatus: string }> | null
  now?: Date
}

const SERVICE_PLAN_APPLICABILITY = {
  sharepoint: new Set(['SHAREPOINTENTERPRISE', 'SHAREPOINTSTANDARD', 'ONEDRIVESTANDARD', 'ONEDRIVEENTERPRISE']),
  exchange: new Set(['EXCHANGE_S_ENTERPRISE', 'EXCHANGE_S_STANDARD', 'EXCHANGE_S_DESKLESS', 'EXCHANGEARCHIVE']),
}

function servicePlanApplicability(plans: ReadinessInput['licenseServicePlans'], workload: keyof typeof SERVICE_PLAN_APPLICABILITY) {
  if (!plans) return 'UNVERIFIED' as const
  const recognized = plans.filter((plan) => typeof plan.servicePlanName === 'string' && SERVICE_PLAN_APPLICABILITY[workload].has(plan.servicePlanName.toUpperCase()))
  if (!recognized.length) return 'UNVERIFIED' as const
  // Microsoft documents SUCCESS as provisioned.  Pending/unknown states are
  // neither proof of entitlement nor proof that the workload is unlicensed.
  if (recognized.some((plan) => plan.provisioningStatus.toUpperCase() === 'SUCCESS')) return 'APPLICABLE' as const
  return recognized.every((plan) => plan.provisioningStatus.toUpperCase() === 'DISABLED')
    ? 'NOT_LICENSED' as const
    : 'UNVERIFIED' as const
}

const CURRENT_MS = 15 * 60 * 1000
const AGING_MS = 2 * 60 * 60 * 1000
const DAILY_CURRENT_MS = 24 * 60 * 60 * 1000
const DAILY_AGING_MS = 26 * 60 * 60 * 1000

export const M365_ACTIVITY_CONTENT_TYPES = [
  'Audit.Exchange',
  'Audit.AzureActiveDirectory',
  'Audit.SharePoint',
  'Audit.General',
] as const

const READINESS_ORDER: Record<CollectionReadinessState, number> = {
  BLOCKED_PERMISSION: 0,
  BLOCKED_TENANT_CONFIGURATION: 1,
  UNSUPPORTED: 2,
  NOT_LICENSED: 3,
  FAILED_TRANSIENT: 4,
  STALE: 5,
  BACKLOGGED: 6,
  PARTIAL: 7,
  UNVERIFIED: 8,
  INITIALIZING: 9,
  NEVER_SUCCEEDED: 10,
  READY: 11,
}

const permissionStatus = (
  requiredPermissions: string[],
  consented: Set<string>,
  verificationKnown: boolean,
): PermissionGrantStatus => {
  if (requiredPermissions.length === 0) return 'NOT_APPLICABLE'
  if (!verificationKnown) return 'UNVERIFIED'
  return requiredPermissions.every((permission) => consented.has(permission.toLowerCase()))
    ? 'CONFIRMED'
    : 'MISSING'
}

function validDate(value: Date | null | undefined) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null
}

function iso(value: Date | null | undefined) {
  return validDate(value)?.toISOString() ?? null
}

function safeReason(value: string | null | undefined) {
  return sanitizeHealthMessage(value) ?? null
}

function isPermissionFailure(state: ReadinessSyncState) {
  return state.lastErrorCode === '401' || state.lastErrorCode === '403' || /unauthori[sz]ed|forbidden|permission|consent|exchange rbac|recipient management/i.test(state.lastErrorMessage ?? '')
}

function isLicensingFailure(state: ReadinessSyncState) {
  return /premium.*license|license.*required|subscription.*required|not licensed|license.*not.*available/i.test(`${state.lastErrorCode ?? ''} ${state.lastErrorMessage ?? ''}`)
}

function isTenantConfigurationFailure(state: ReadinessSyncState) {
  return /unified audit|audit.*not.*enabled|tenant does not exist|not a b2c tenant/i.test(`${state.lastErrorCode ?? ''} ${state.lastErrorMessage ?? ''}`)
}

function isUnsupportedFailure(state: ReadinessSyncState) {
  return /not supported|does not expose|api.*not available/i.test(`${state.lastErrorCode ?? ''} ${state.lastErrorMessage ?? ''}`)
}

function freshness(
  lastSuccessfulAt: Date | null,
  now: Date,
  cadence: 'incremental' | 'daily',
): CollectionReadinessRow['freshness'] {
  const validSuccess = validDate(lastSuccessfulAt)
  if (!validSuccess) return lastSuccessfulAt ? 'UNKNOWN' : 'NEVER_SUCCEEDED'
  const age = now.getTime() - validSuccess.getTime()
  if (age < 0) return 'UNKNOWN'
  const current = cadence === 'incremental' ? CURRENT_MS : DAILY_CURRENT_MS
  const aging = cadence === 'incremental' ? AGING_MS : DAILY_AGING_MS
  if (age <= current) return 'CURRENT'
  if (age <= aging) return 'AGING'
  return 'STALE'
}

function fromSyncState(
  state: ReadinessSyncState | undefined,
  now: Date,
  cadence: 'incremental' | 'daily',
): Pick<CollectionReadinessRow, 'state' | 'lastAttemptAt' | 'lastSuccessfulAt' | 'freshness' | 'reasonCode' | 'reason'> {
  if (!state) {
    return {
      state: 'NEVER_SUCCEEDED',
      lastAttemptAt: null,
      lastSuccessfulAt: null,
      freshness: 'NEVER_SUCCEEDED',
      reasonCode: 'COLLECTOR_NOT_STARTED',
      reason: 'HawkView has not recorded a collection attempt for this workload.',
    }
  }

  const base = {
    lastAttemptAt: iso(state.lastAttemptAt),
    lastSuccessfulAt: iso(state.lastSuccessfulAt),
    freshness: freshness(state.lastSuccessfulAt, now, cadence),
    reasonCode: state.lastErrorCode ?? null,
    reason: safeReason(state.lastErrorMessage),
  } as const

  if (state.status === 'FAILED') {
    if (isPermissionFailure(state)) return { ...base, state: 'BLOCKED_PERMISSION' }
    if (isLicensingFailure(state)) return { ...base, state: 'NOT_LICENSED' }
    if (isTenantConfigurationFailure(state)) return { ...base, state: 'BLOCKED_TENANT_CONFIGURATION' }
    if (isUnsupportedFailure(state)) return { ...base, state: 'UNSUPPORTED' }
    return { ...base, state: 'FAILED_TRANSIENT' }
  }
  if (state.status === 'RUNNING') {
    const isBacklogged = /backlog|continuation|daily budget|rate limit/i.test(`${state.lastErrorCode ?? ''} ${state.lastErrorMessage ?? ''}`)
    return {
      ...base,
      state: isBacklogged ? 'BACKLOGGED' : state.lastSuccessfulAt ? 'PARTIAL' : 'INITIALIZING',
      reasonCode: state.lastErrorCode ?? (isBacklogged ? 'COLLECTION_BACKLOGGED' : 'COLLECTION_IN_PROGRESS'),
      reason: safeReason(state.lastErrorMessage) ?? (isBacklogged ? 'Collection has a bounded backlog and will continue during scheduled processing.' : 'Collection is in progress.'),
    }
  }
  if (state.status === 'SUCCEEDED') {
    return {
      ...base,
      state: base.freshness === 'STALE' ? 'STALE' : base.freshness === 'UNKNOWN' ? 'UNVERIFIED' : 'READY',
      reasonCode: base.freshness === 'STALE' ? 'STALE_COLLECTION' : base.freshness === 'UNKNOWN' ? 'INVALID_COLLECTION_TIMESTAMP' : null,
      reason: base.freshness === 'STALE' ? 'The last successful collection is outside its scheduled freshness window.' : base.freshness === 'UNKNOWN' ? 'HawkView cannot safely verify the collection timestamp.' : null,
    }
  }
  return { ...base, state: 'NEVER_SUCCEEDED', freshness: 'NEVER_SUCCEEDED', reasonCode: 'COLLECTOR_NOT_STARTED', reason: 'The collector has not completed successfully.' }
}

function selectedWorst<T extends { state: CollectionReadinessState }>(rows: T[]): T | undefined {
  return rows.reduce<T | undefined>((selected, candidate) => {
    if (!selected || READINESS_ORDER[candidate.state] < READINESS_ORDER[selected.state]) return candidate
    return selected
  }, undefined)
}

function worstState(rows: Array<{ state: CollectionReadinessState }>) {
  return selectedWorst(rows)?.state ?? 'NEVER_SUCCEEDED'
}

function workload(
  input: {
    key: string
    workload: string
    resourceTypes: string[]
    requiredPermissions: string[]
    cadence: 'incremental' | 'daily'
    remediation: string
    capabilities?: CollectionReadinessRow['capabilities']
  },
  states: Map<string, ReadinessSyncState>,
  consented: Set<string>,
  verificationKnown: boolean,
  now: Date,
): CollectionReadinessRow {
  const components = input.resourceTypes.map((resourceType) => {
    const status = fromSyncState(states.get(resourceType), now, input.cadence)
    return { key: resourceType, label: resourceType.replaceAll('_', ' ').toLowerCase(), ...status }
  })
  const grants = permissionStatus(input.requiredPermissions, consented, verificationKnown)
  const permissionComponent = grants !== 'CONFIRMED' && grants !== 'NOT_APPLICABLE' ? {
    key: 'PERMISSION_GRANT', label: 'Microsoft permissions', state: grants === 'MISSING' ? 'BLOCKED_PERMISSION' as const : 'UNVERIFIED' as const,
    lastAttemptAt: null, lastSuccessfulAt: null, freshness: 'UNKNOWN' as const,
    reasonCode: grants === 'MISSING' ? 'MICROSOFT_PERMISSION_NOT_CONFIRMED' : 'MICROSOFT_PERMISSION_UNVERIFIED',
    reason: grants === 'MISSING' ? `HawkView verified that required Microsoft permissions are absent: ${input.requiredPermissions.filter((permission) => !consented.has(permission.toLowerCase())).join(', ')}.` : 'HawkView has not completed a Microsoft permission verification for this workload.',
  } : null
  const primary = selectedWorst(permissionComponent ? [permissionComponent, ...components] : components)!
  return {
    key: input.key,
    workload: input.workload,
    state: primary.state,
    configuredCapability: grants === 'MISSING' ? 'NOT_CONFIGURED' : grants === 'UNVERIFIED' ? 'UNVERIFIED' : 'CONFIGURED',
    permissionStatus: grants,
    requiredPermissions: input.requiredPermissions,
    lastAttemptAt: primary.lastAttemptAt,
    lastSuccessfulAt: primary.lastSuccessfulAt,
    freshness: primary.freshness,
    reasonCode: primary.reasonCode,
    reason: primary.reason,
    remediation: input.remediation,
    capabilities: input.capabilities,
    components: permissionComponent ? [permissionComponent, ...components] : components,
  }
}

function m365SubscriptionReadiness(subscription: M365ActivitySubscriptionState | undefined, now: Date) {
  if (!subscription) {
    return {
      state: 'INITIALIZING' as const,
      lastAttemptAt: null,
      lastSuccessfulAt: null,
      freshness: 'NEVER_SUCCEEDED' as const,
      reasonCode: 'SUBSCRIPTION_NOT_DISCOVERED',
      reason: 'HawkView has not yet discovered this Microsoft 365 audit subscription.',
    }
  }
  const status = subscription.status.toUpperCase()
  const base = {
    lastAttemptAt: iso(subscription.lastStartRequestedAt),
    lastSuccessfulAt: iso(subscription.lastSuccessfulPollAt),
    lastVerifiedAt: iso(subscription.lastVerifiedAt),
    freshness: subscription.lastSuccessfulPollAt ? freshness(subscription.lastSuccessfulPollAt, now, 'incremental') : 'NEVER_SUCCEEDED' as const,
    reasonCode: null as string | null,
    reason: safeReason(subscription.lastError),
  }
  if (status === 'ENABLED') {
    return { ...base, state: subscription.lastSuccessfulPollAt ? (base.freshness === 'STALE' ? 'STALE' as const : 'READY' as const) : 'INITIALIZING' as const, reason: subscription.lastSuccessfulPollAt ? (base.freshness === 'STALE' ? 'The last successful poll is outside its freshness window.' : null) : 'Microsoft has enabled the subscription; HawkView is waiting for the first successful poll.' }
  }
  if (status === 'FAILED') {
    const text = subscription.lastError ?? ''
    return {
      ...base,
      state: /401|403|permission|consent|publisheridentifier/i.test(text) ? 'BLOCKED_PERMISSION' as const : /audit.*enabled|unified audit|tenant.*config/i.test(text) ? 'BLOCKED_TENANT_CONFIGURATION' as const : 'FAILED_TRANSIENT' as const,
      reasonCode: 'SUBSCRIPTION_FAILED',
    }
  }
  return { ...base, state: 'INITIALIZING' as const, reasonCode: 'SUBSCRIPTION_PROVISIONING', reason: safeReason(subscription.lastError) ?? 'Microsoft subscription provisioning is pending.' }
}

export function deriveCollectionReadiness(input: ReadinessInput): CollectionReadiness {
  const now = input.now ?? new Date()
  const states = new Map(input.syncStates.map((state) => [state.resourceType, state]))
  const consented = new Set(input.consentedPermissions.map((permission) => permission.toLowerCase()))
  const verificationKnown = Boolean(validDate(input.connectionVerifiedAt))
  const connectionUnavailable = ['ERROR', 'REVOKED', 'PENDING_CONSENT', 'EXPIRED', 'INVALID'].includes(input.connectionStatus?.toUpperCase() ?? '')
  // Entitlement is authoritative only when the matching LICENSES collector is
  // currently successful.  An old/null inventory must not turn a collector
  // failure into a licensing assertion.
  const licensesCurrent = fromSyncState(states.get('LICENSES'), now, 'daily').state === 'READY'
  const sharePointApplicability = licensesCurrent ? servicePlanApplicability(input.licenseServicePlans, 'sharepoint') : 'UNVERIFIED'
  const exchangeApplicability = licensesCurrent ? servicePlanApplicability(input.licenseServicePlans, 'exchange') : 'UNVERIFIED'
  const rows = [
    workload({ key: 'entra_directory_audit', workload: 'Entra directory audit', resourceTypes: ['AUDIT_LOGS'], requiredPermissions: ['AuditLog.Read.All'], cadence: 'incremental', remediation: 'Confirm AuditLog.Read.All has tenant-wide admin consent, then allow the scheduled collector to recheck.' }, states, consented, verificationKnown, now),
    workload({ key: 'sign_ins', workload: 'Entra sign-ins', resourceTypes: ['SIGN_INS'], requiredPermissions: ['AuditLog.Read.All'], cadence: 'incremental', remediation: 'Confirm AuditLog.Read.All and the tenant’s sign-in log entitlement. HawkView will recheck during normal collection.' }, states, consented, verificationKnown, now),
    workload({ key: 'entra_directory', workload: 'Entra directory inventory', resourceTypes: ['USERS', 'GROUPS', 'DEVICES', 'DIRECTORY_ROLES'], requiredPermissions: ['User.Read.All', 'GroupMember.Read.All', 'Member.Read.Hidden', 'Device.Read.All', 'RoleManagement.Read.Directory'], cadence: 'daily', remediation: 'Confirm the required directory, hidden-membership, device, and role-management application permissions. HawkView rechecks during normal collection.' }, states, consented, verificationKnown, now),
    workload({ key: 'entra_security_configuration', workload: 'Entra security configuration', resourceTypes: ['AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES', 'CONDITIONAL_ACCESS', 'NAMED_LOCATIONS', 'APPLICATIONS', 'SERVICE_PRINCIPALS', 'SECURITY_DEFAULTS', 'SECURE_SCORES'], requiredPermissions: ['UserAuthenticationMethod.Read.All', 'Policy.Read.AuthenticationMethod', 'Policy.Read.All', 'Application.Read.All', 'SecurityEvents.Read.All'], cadence: 'daily', remediation: 'Confirm the required authentication-method, policy, application, and Secure Score permissions. A successful OAuth connection alone does not verify every collector.' }, states, consented, verificationKnown, now),
    workload({ key: 'office_365_tenant_configuration', workload: 'Microsoft 365 tenant configuration', resourceTypes: ['ORGANIZATION_CONFIGURATION', 'DOMAINS', 'LICENSES', 'DOMAIN_DNS_HEALTH'], requiredPermissions: ['Organization.Read.All'], cadence: 'daily', remediation: 'Confirm Organization.Read.All and review the exact collector result. Domain DNS readiness is collected independently and does not imply a tenant setting change.' }, states, consented, verificationKnown, now),
    workload({ key: 'sharepoint_onedrive', workload: 'SharePoint and OneDrive', resourceTypes: ['SHAREPOINT_SITES', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE'], requiredPermissions: ['Sites.Read.All', 'SharePointTenantSettings.Read.All', 'Reports.Read.All'], cadence: 'daily', remediation: 'Confirm the listed SharePoint and Reports permissions, then wait for the next scheduled inventory collection.', capabilities: [{ key: 'sharepoint_site_access_metadata', label: 'Site access metadata', state: 'NOT_COLLECTED_LEAST_PRIVILEGE', reasonCode: 'NOT_COLLECTED_LEAST_PRIVILEGE', source: 'HawkView standard least-privilege mode', message: 'Standard mode does not collect current site-user, site collection administrator, sharing-member, or per-site permission metadata. SharePoint and OneDrive administrative events remain available when Microsoft audit evidence is available.' }] }, states, consented, verificationKnown, now),
    workload({ key: 'exchange', workload: 'Exchange mailbox and configuration', resourceTypes: ['EXCHANGE_MAILBOXES', 'EXCHANGE_MAILBOX_SETTINGS', 'EXCHANGE_MAILBOX_USAGE', 'EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOX_RULES'], requiredPermissions: ['User.Read.All', 'MailboxSettings.Read', 'Reports.Read.All', 'Organization.Read.All'], cadence: 'daily', remediation: 'Graph mailbox data requires the listed Graph permissions. Exchange Admin configuration also requires Exchange.ManageAsAppV2 and a Recipient Management RBAC role; HawkView does not infer that RBAC is granted.' }, states, consented, verificationKnown, now),
  ]

  const applyApplicability = (key: 'sharepoint_onedrive' | 'exchange', applicability: 'APPLICABLE' | 'NOT_LICENSED' | 'UNVERIFIED') => {
    const row = rows.find((candidate) => candidate.key === key)!
    if (applicability === 'NOT_LICENSED') {
      row.state = 'NOT_LICENSED'; row.configuredCapability = 'NOT_CONFIGURED'; row.reasonCode = 'SERVICE_PLAN_NOT_ENABLED'; row.reason = 'The collected subscription plans explicitly show this workload is not enabled.'
    } else if (applicability === 'UNVERIFIED') {
      row.components = [...(row.components ?? []), { key: 'LICENSE_APPLICABILITY', label: 'Subscription applicability', state: 'UNVERIFIED', lastAttemptAt: null, lastSuccessfulAt: null, freshness: 'UNKNOWN', reasonCode: 'SERVICE_PLAN_UNVERIFIED', reason: 'Collected subscription plans do not authoritatively establish this workload entitlement.' }]
      const selected = selectedWorst(row.components)!; row.state = selected.state; row.reasonCode = selected.reasonCode; row.reason = selected.reason
    }
  }
  // SharePoint has no second admin-RBAC aggregation below. Exchange is applied
  // after that aggregation so it cannot accidentally overwrite licensing truth.
  applyApplicability('sharepoint_onedrive', sharePointApplicability)

  const exchange = rows.find((row) => row.key === 'exchange')!
  const exchangeAdmin = fromSyncState(states.get('EXCHANGE_MAILBOX_CONFIGURATION'), now, 'daily')
  const exchangeAdminSuccessfulAt = validDate(states.get('EXCHANGE_MAILBOX_CONFIGURATION')?.lastSuccessfulAt)
  const exchangeAdminHasProvenSuccess = Boolean(exchangeAdminSuccessfulAt && exchangeAdminSuccessfulAt.getTime() <= now.getTime())
  const exchangeAdminComponent: NonNullable<CollectionReadinessRow['exchangeRbac']> = exchangeAdmin.state === 'BLOCKED_PERMISSION'
    ? { status: 'MISSING' as const, state: exchangeAdmin.state, reason: 'Exchange Admin API consent or Recipient Management RBAC is missing.' }
    : exchangeAdminHasProvenSuccess
      ? { status: 'CONFIRMED' as const, state: exchangeAdmin.state, reason: exchangeAdmin.state === 'STALE' ? 'Exchange Admin API access was previously confirmed, but the last successful collection is stale.' : exchangeAdmin.state === 'FAILED_TRANSIENT' ? 'Exchange Admin API access was previously confirmed, but the latest collection failed transiently.' : 'A successful Exchange Admin API collection confirmed the configured access.' }
      : { status: 'UNVERIFIED' as const, state: 'UNVERIFIED' as const, reason: 'HawkView has no successful Exchange Admin API collection that can verify RBAC.' }
  exchange.exchangeRbac = exchangeAdminComponent
  const adminComponent = { key: 'EXCHANGE_MAILBOX_CONFIGURATION', label: 'Exchange Admin RBAC', state: exchangeAdminComponent.state, lastAttemptAt: exchangeAdmin.lastAttemptAt, lastSuccessfulAt: exchangeAdminHasProvenSuccess ? iso(exchangeAdminSuccessfulAt) : null, freshness: exchangeAdmin.freshness, reasonCode: exchangeAdmin.reasonCode ?? (exchangeAdminComponent.state === 'READY' ? null : 'EXCHANGE_ADMIN_RBAC_UNVERIFIED'), reason: exchangeAdminComponent.state === 'READY' ? null : exchangeAdminComponent.reason }
  exchange.components = [...(exchange.components ?? []), adminComponent]
  const selectedExchange = selectedWorst(exchange.components)!
  exchange.state = selectedExchange.state
  exchange.configuredCapability = exchange.permissionStatus === 'MISSING' || exchangeAdminComponent.status === 'MISSING'
    ? 'NOT_CONFIGURED'
    : exchange.permissionStatus === 'UNVERIFIED' || exchangeAdminComponent.status === 'UNVERIFIED'
      ? 'UNVERIFIED'
      : 'CONFIGURED'
  exchange.lastAttemptAt = selectedExchange.lastAttemptAt
  exchange.lastSuccessfulAt = selectedExchange.lastSuccessfulAt
  exchange.freshness = selectedExchange.freshness
  exchange.reasonCode = selectedExchange.reasonCode
  exchange.reason = selectedExchange.reason
  applyApplicability('exchange', exchangeApplicability)

  const subscriptionByType = new Map((input.subscriptions ?? []).map((subscription) => [subscription.contentType, subscription]))
  const subscriptionComponents = M365_ACTIVITY_CONTENT_TYPES.map((contentType) => ({
    key: contentType,
    label: contentType,
    ...m365SubscriptionReadiness(subscriptionByType.get(contentType), now),
  }))
  const auditState = fromSyncState(states.get('M365_AUDIT'), now, 'incremental')
  const auditPermissions = permissionStatus(['ActivityFeed.Read'], consented, verificationKnown)
  const auditPermissionComponent = auditPermissions !== 'CONFIRMED' ? { key: 'ACTIVITY_FEED_PERMISSION', label: 'ActivityFeed.Read', state: auditPermissions === 'MISSING' ? 'BLOCKED_PERMISSION' as const : 'UNVERIFIED' as const, lastAttemptAt: null, lastSuccessfulAt: null, freshness: 'UNKNOWN' as const, reasonCode: auditPermissions === 'MISSING' ? 'MICROSOFT_PERMISSION_NOT_CONFIRMED' : 'MICROSOFT_PERMISSION_UNVERIFIED', reason: auditPermissions === 'MISSING' ? 'HawkView verified that ActivityFeed.Read is absent for the Office 365 Management Activity API.' : 'HawkView has not completed a Microsoft permission verification for the Office 365 Management Activity API.' } : null
  const m365Components = [auditState, ...subscriptionComponents, ...(auditPermissionComponent ? [auditPermissionComponent] : [])]
  const selectedAudit = selectedWorst(m365Components)!
  rows.push({
    key: 'm365_unified_audit',
    workload: 'Microsoft 365 Unified Audit',
    state: selectedAudit.state,
    configuredCapability: auditPermissions === 'MISSING' ? 'NOT_CONFIGURED' : auditPermissions === 'UNVERIFIED' ? 'UNVERIFIED' : 'CONFIGURED',
    permissionStatus: auditPermissions,
    requiredPermissions: ['ActivityFeed.Read'],
    lastAttemptAt: selectedAudit.lastAttemptAt,
    lastSuccessfulAt: selectedAudit.lastSuccessfulAt,
    freshness: selectedAudit.freshness,
    reasonCode: selectedAudit.reasonCode,
    reason: selectedAudit.reason,
    remediation: 'Review each content type below. Microsoft provisioning can take time; HawkView retries through the normal scheduler without requiring reconnection unless the reason identifies consent or tenant configuration.',
    components: subscriptionComponents,
  })

  if (connectionUnavailable) {
    for (const row of rows) {
      const preservedSuccessfulAt = (row.components ?? [])
        .map((component) => component.lastSuccessfulAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? row.lastSuccessfulAt
      row.state = 'BLOCKED_PERMISSION'
      row.reasonCode = 'MICROSOFT_CONNECTION_NOT_READY'
      row.reason = 'Microsoft connection consent is pending, revoked, or unavailable.'
      row.configuredCapability = 'NOT_CONFIGURED'
      row.permissionStatus = 'UNVERIFIED'
      row.lastSuccessfulAt = preservedSuccessfulAt
      row.remediation = 'Reconnect or complete Microsoft administrator consent, then HawkView will recheck automatically.'
    }
  }

  const overall = selectedWorst(rows)!
  return {
    version: 1,
    overallState: overall.state,
    reasonCode: overall.reasonCode,
    reason: overall.reason,
    lastAttemptAt: overall.lastAttemptAt,
    lastSuccessfulAt: overall.lastSuccessfulAt,
    evaluatedAt: now.toISOString(),
    workloads: rows,
  }
}
