import { sanitizeHealthMessage } from './sanitize-health-message.js'
import { deriveSignInEntitlement } from './sign-in-entitlement.js'
import {
  capabilitiesForWorkload,
  MICROSOFT_ACCESS_CONTRACT_VERSION,
  type MicrosoftAccessCapability,
} from '../microsoft/microsoft-access-contract.js'
import type { MicrosoftUsageSourceProjectionEvidence } from './sharepoint-data-contract.js'

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
  /** Dataset-level access truth. This is authoritative for capability/permission UI. */
  datasets?: AccessDatasetReadiness[]
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

export type AccessDatasetReadiness = {
  key: string
  label: string
  tier: 'CORE' | 'CAPABILITY_OPTIONAL' | 'FALLBACK'
  state: CollectionReadinessState
  permissionStatus: Exclude<PermissionGrantStatus, 'NOT_APPLICABLE'> | 'NOT_APPLICABLE'
  permissions: Array<{
    resource: 'MICROSOFT_GRAPH' | 'OFFICE_365_MANAGEMENT_API' | 'EXCHANGE_ONLINE'
    name: string
    type: 'APPLICATION'
    consentMode: 'DEFAULT' | 'SEPARATE_OPT_IN'
    /** Resource-specific verified status for this exact application role. */
    grantStatus: 'CONFIRMED' | 'MISSING' | 'UNVERIFIED'
  }>
  permissionMatch: 'ALL' | 'ANY'
  evidenceMode: 'RESOURCE_STATE' | 'COMPOSITE_RESOURCE_STATE' | 'NOT_DURABLY_OBSERVED'
  licensePrerequisite: {
    kind: 'NONE' | 'ENTRA_ID_P1_OR_P2' | 'ENTRA_ID_P2' | 'SHAREPOINT_SERVICE_PLAN' | 'EXCHANGE_SERVICE_PLAN' | 'UNIFIED_AUDIT_ENABLED'
    state: 'NOT_REQUIRED' | 'SATISFIED' | 'NOT_LICENSED' | 'UNVERIFIED'
  }
  fallbackDatasetKey: string | null
  failureScope: 'DATASET_ONLY' | 'WORKLOAD'
  resourceTypes: string[]
  endpointPatterns: string[]
  documentationUrl: string
  lastAttemptAt: string | null
  lastSuccessfulAt: string | null
  freshness: CollectionReadinessRow['freshness']
  reasonCode: string | null
  reason: string | null
  remediation: string
}

export type CollectionReadiness = {
  version: 1
  accessContractVersion: 1
  overallState: CollectionReadinessState
  /** Diagnostics always belong to the same selected worst workload as overallState. */
  reasonCode: string | null
  reason: string | null
  lastAttemptAt: string | null
  lastSuccessfulAt: string | null
  /** Last persisted resource-specific consent verification, never API evaluation time. */
  permissionVerifiedAt: string | null
  evaluatedAt: string
  workloads: CollectionReadinessRow[]
  evidence: PilotEvidenceProjection
}

export type PilotEvidenceProjection = {
  version: 1
  signIns: {
    availability: CollectionReadinessState | 'CURRENT_LIMITED'
    coverage: 'FULL' | 'LIMITED' | 'NONE'
    selectedSource: 'MICROSOFT_GRAPH' | 'OFFICE_365_ACTIVITY_FEED' | null
    observedAt: string | null
    reasonCode: string | null
    reason: string | null
  }
  riskyIdentities: {
    availability: CollectionReadinessState
    count: number | null
    selectedSource: 'MICROSOFT_IDENTITY_PROTECTION'
    observedAt: string | null
    reasonCode: string | null
    reason: string | null
  }
  conditionalAccess: {
    availability: CollectionReadinessState
    count: number | null
    selectedSource: 'MICROSOFT_GRAPH'
    observedAt: string | null
    reasonCode: string | null
    reason: string | null
  }
  securityDefaults: {
    availability: CollectionReadinessState
    enabled: boolean | null
    selectedSource: 'MICROSOFT_GRAPH'
    observedAt: string | null
    reasonCode: string | null
    reason: string | null
  }
}

type ReadinessInput = {
  connectionStatus: string | null | undefined
  connectionVerifiedAt?: Date | null
  consentedPermissions: string[]
  syncStates: ReadinessSyncState[]
  subscriptions?: M365ActivitySubscriptionState[]
  /** null means the durable license inventory is absent, stale, or not authoritative. */
  licenseServicePlans?: Array<{ servicePlanId?: string; servicePlanName: string; provisioningStatus: string }> | null
  /** Compact field-state proofs; tenant-list reads never load the report-row snapshot. */
  sharePointUsageProjectionEvidence?: MicrosoftUsageSourceProjectionEvidence | null
  oneDriveUsageProjectionEvidence?: MicrosoftUsageSourceProjectionEvidence | null
  evidenceSnapshots?: Array<{ resourceType: string; payload: unknown; observedAt: Date }>
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

function entraP2Applicability(plans: ReadinessInput['licenseServicePlans']) {
  if (!plans) return 'UNVERIFIED' as const
  const p2 = plans.filter((plan) => plan.servicePlanName.toUpperCase() === 'AAD_PREMIUM_P2')
  if (!p2.length) return 'NOT_LICENSED' as const
  if (p2.some((plan) => plan.provisioningStatus.toUpperCase() === 'SUCCESS')) return 'APPLICABLE' as const
  return p2.every((plan) => plan.provisioningStatus.toUpperCase() === 'DISABLED')
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
  match: 'ALL' | 'ANY' = 'ALL',
): PermissionGrantStatus => {
  if (requiredPermissions.length === 0) return 'NOT_APPLICABLE'
  if (!verificationKnown) return 'UNVERIFIED'
  const matched = match === 'ANY'
    ? requiredPermissions.some((permission) => consented.has(permission.toLowerCase()))
    : requiredPermissions.every((permission) => consented.has(permission.toLowerCase()))
  return matched
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
  licensingFailureDisposition?: 'NOT_LICENSED' | 'FAILED_TRANSIENT' | 'UNVERIFIED',
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
    if (isLicensingFailure(state)) {
      if (licensingFailureDisposition === 'FAILED_TRANSIENT') {
        return {
          ...base,
          state: 'FAILED_TRANSIENT',
          reasonCode: 'SIGN_IN_LICENSE_RESPONSE_CONTRADICTED',
          reason:
            'Microsoft Graph rejected full sign-in access, but HawkView’s current service-plan evidence confirms Microsoft Entra ID P1/P2.',
        }
      }
      if (licensingFailureDisposition === 'UNVERIFIED') {
        return {
          ...base,
          state: 'UNVERIFIED',
          reasonCode: 'SIGN_IN_ENTITLEMENT_UNVERIFIED',
          reason:
            'Microsoft Graph rejected full sign-in access, but HawkView does not yet have current service-plan evidence to verify the tenant entitlement.',
        }
      }
      if (licensingFailureDisposition === 'NOT_LICENSED') {
        return {
          ...base,
          state: 'NOT_LICENSED',
          reasonCode: 'SIGN_IN_ENTITLEMENT_NOT_LICENSED',
          reason:
            'HawkView’s current service-plan evidence does not include Microsoft Entra ID P1/P2, so full Microsoft Graph sign-in details are unavailable.',
        }
      }
      return { ...base, state: 'NOT_LICENSED' }
    }
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
    licensingFailureDisposition?: 'NOT_LICENSED' | 'FAILED_TRANSIENT' | 'UNVERIFIED'
  },
  states: Map<string, ReadinessSyncState>,
  consented: Set<string>,
  verificationKnown: boolean,
  now: Date,
): CollectionReadinessRow {
  const components = input.resourceTypes.map((resourceType) => {
    const status = fromSyncState(
      states.get(resourceType),
      now,
      input.cadence,
      input.licensingFailureDisposition,
    )
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

function datasetReadiness(
  capability: MicrosoftAccessCapability,
  states: Map<string, ReadinessSyncState>,
  consented: Set<string>,
  verificationKnown: boolean,
  now: Date,
  applicability: {
    sharepoint: 'APPLICABLE' | 'NOT_LICENSED' | 'UNVERIFIED'
    exchange: 'APPLICABLE' | 'NOT_LICENSED' | 'UNVERIFIED'
    signIn: 'PREMIUM' | 'NON_PREMIUM' | 'UNVERIFIED'
    identityProtection: 'APPLICABLE' | 'NOT_LICENSED' | 'UNVERIFIED'
  },
  usageProjectionEvidence?: MicrosoftUsageSourceProjectionEvidence | null,
): AccessDatasetReadiness {
  const permissionNames = capability.applicationPermissions.map((permission) => permission.name)
  const permissionMatch = capability.permissionMatch ?? 'ALL'
  const evidenceMode = capability.evidenceMode ?? 'RESOURCE_STATE'
  const grants = permissionStatus(permissionNames, consented, verificationKnown, permissionMatch)
  const signInLicensingDisposition = capability.workloadKey === 'sign_ins'
    ? applicability.signIn === 'PREMIUM' ? 'FAILED_TRANSIENT' as const : applicability.signIn === 'NON_PREMIUM' ? 'NOT_LICENSED' as const : 'UNVERIFIED' as const
    : undefined
  const resourceRows = capability.resourceTypes.map((resourceType) =>
    fromSyncState(states.get(resourceType), now, resourceType === 'AUDIT_LOGS' || resourceType === 'SIGN_INS' || resourceType === 'M365_AUDIT' ? 'incremental' : 'daily', signInLicensingDisposition),
  )
  let dynamic = selectedWorst(resourceRows) ?? {
    state: 'NEVER_SUCCEEDED' as const,
    lastAttemptAt: null,
    lastSuccessfulAt: null,
    freshness: 'NEVER_SUCCEEDED' as const,
    reasonCode: 'COLLECTOR_NOT_STARTED',
    reason: 'HawkView has not recorded a collection attempt for this dataset.',
  }
  let licenseState: AccessDatasetReadiness['licensePrerequisite']['state'] = 'NOT_REQUIRED'
  if (capability.licensePrerequisite === 'SHAREPOINT_SERVICE_PLAN') {
    licenseState = applicability.sharepoint === 'APPLICABLE' ? 'SATISFIED' : applicability.sharepoint
  } else if (capability.licensePrerequisite === 'EXCHANGE_SERVICE_PLAN') {
    licenseState = applicability.exchange === 'APPLICABLE' ? 'SATISFIED' : applicability.exchange
  } else if (capability.licensePrerequisite === 'ENTRA_ID_P1_OR_P2') {
    licenseState = applicability.signIn === 'PREMIUM' ? 'SATISFIED' : applicability.signIn === 'NON_PREMIUM' ? 'NOT_LICENSED' : 'UNVERIFIED'
  } else if (capability.licensePrerequisite === 'ENTRA_ID_P2') {
    licenseState = applicability.identityProtection === 'APPLICABLE'
      ? 'SATISFIED'
      : applicability.identityProtection
  } else if (capability.licensePrerequisite === 'UNIFIED_AUDIT_ENABLED') {
    licenseState = dynamic.state === 'READY' ? 'SATISFIED' : 'UNVERIFIED'
  }
  if (licenseState === 'NOT_LICENSED') {
    dynamic = { ...dynamic, state: 'NOT_LICENSED', reasonCode: 'SERVICE_PLAN_NOT_ENABLED', reason: 'Current authoritative service-plan evidence does not enable this dataset.' }
  } else if (licenseState === 'UNVERIFIED' && capability.licensePrerequisite !== 'UNIFIED_AUDIT_ENABLED') {
    dynamic = {
      ...dynamic,
      state: 'UNVERIFIED',
      reasonCode: capability.workloadKey === 'sign_ins' ? 'SIGN_IN_ENTITLEMENT_UNVERIFIED' : 'SERVICE_PLAN_UNVERIFIED',
      reason: capability.workloadKey === 'sign_ins'
        ? 'HawkView does not yet have current service-plan evidence to select the licensed Graph source or limited audit-feed fallback.'
        : 'Current authoritative service-plan evidence does not yet establish this dataset entitlement.',
    }
  } else if (grants === 'MISSING') {
    dynamic = { ...dynamic, state: 'BLOCKED_PERMISSION', reasonCode: 'MICROSOFT_PERMISSION_NOT_CONFIRMED', reason: `HawkView verified that this dataset is missing: ${permissionNames.filter((permission) => !consented.has(permission.toLowerCase())).join(', ')}.` }
  } else if (grants === 'UNVERIFIED') {
    dynamic = { ...dynamic, state: 'UNVERIFIED', reasonCode: 'MICROSOFT_PERMISSION_UNVERIFIED', reason: 'HawkView has not completed resource-specific permission verification for this dataset.' }
  } else if (evidenceMode === 'NOT_DURABLY_OBSERVED') {
    dynamic = {
      ...dynamic,
      state: 'UNVERIFIED',
      lastAttemptAt: null,
      lastSuccessfulAt: null,
      freshness: 'UNKNOWN',
      reasonCode: 'SOURCE_AVAILABILITY_NOT_DURABLY_OBSERVED',
      reason: 'The shared collection state does not durably prove that this optional Microsoft enrichment succeeded.',
    }
  }
  if (
    ['sharepoint_usage_reports', 'onedrive_usage_reports'].includes(capability.key) &&
    dynamic.state === 'READY' &&
    usageProjectionEvidence &&
    usageProjectionEvidence.state !== 'AUTHORITATIVE_COMPLETE'
  ) {
    dynamic = usageProjectionEvidence.state === 'UNVERIFIED_LEGACY'
      ? {
          ...dynamic,
          state: 'UNVERIFIED',
          reasonCode: usageProjectionEvidence.reasonCode,
          reason: 'The stored Microsoft usage report predates HawkView projection evidence. A normal collection will verify it without reconnecting.',
        }
      : {
          ...dynamic,
          state: 'PARTIAL',
          reasonCode: usageProjectionEvidence.reasonCode,
          reason: 'The Microsoft usage report collection succeeded, but its stored projection evidence is invalid or incomplete.',
        }
  }
  return {
    key: capability.key,
    label: capability.label,
    tier: capability.tier,
    state: dynamic.state,
    permissionStatus: grants,
    permissions: capability.applicationPermissions.map((permission) => ({
      ...permission,
      type: 'APPLICATION' as const,
      consentMode: permission.resource === 'EXCHANGE_ONLINE' ? 'SEPARATE_OPT_IN' as const : 'DEFAULT' as const,
      grantStatus: !verificationKnown
        ? 'UNVERIFIED' as const
        : consented.has(permission.name.toLowerCase())
          ? 'CONFIRMED' as const
          : 'MISSING' as const,
    })),
    permissionMatch,
    evidenceMode,
    licensePrerequisite: { kind: capability.licensePrerequisite, state: licenseState },
    fallbackDatasetKey: capability.fallbackCapabilityKey,
    failureScope: capability.failureScope,
    resourceTypes: [...capability.resourceTypes],
    endpointPatterns: [...capability.endpointPatterns],
    documentationUrl: capability.documentationUrl,
    lastAttemptAt: dynamic.lastAttemptAt,
    lastSuccessfulAt: dynamic.lastSuccessfulAt,
    freshness: dynamic.freshness,
    reasonCode: dynamic.reasonCode,
    reason: dynamic.reason,
    remediation: grants === 'MISSING' ? `Grant ${permissionNames.join(' and ')} for this dataset; unrelated datasets continue independently.` : 'HawkView will re-evaluate this dataset during its normal scheduled collection.',
  }
}

function applyDatasetContract(
  row: CollectionReadinessRow,
  datasets: AccessDatasetReadiness[],
  selectedDatasetKeys?: Set<string>,
) {
  row.datasets = datasets
  const coreDatasets = datasets.filter((dataset) => dataset.tier === 'CORE')
  // A workload made entirely of optional capability datasets (currently
  // Identity Protection) still needs its dataset-level entitlement truth.
  // Otherwise the earlier workload-wide permission check can incorrectly
  // report BLOCKED_PERMISSION for a tenant that is authoritatively not
  // licensed, or whose P2 entitlement is not yet known.
  const selected = selectedDatasetKeys
    ? datasets.filter((dataset) => selectedDatasetKeys.has(dataset.key))
    : coreDatasets.length > 0
      ? coreDatasets
      : datasets
  const byKey = new Map(datasets.map((dataset) => [dataset.key, dataset]))
  const contributing = selected.map((dataset) => {
    if (selectedDatasetKeys || dataset.state === 'READY' || !dataset.fallbackDatasetKey) return dataset
    const fallback = byKey.get(dataset.fallbackDatasetKey)
    return fallback?.state === 'READY' ? fallback : dataset
  })
  if (!contributing.length) return
  const usable = contributing.filter((dataset) => dataset.state === 'READY')
  const selectedWorstRow = selectedWorst(contributing)!
  // One unavailable dataset is visible as PARTIAL and cannot erase healthy
  // sibling datasets. Optional/fallback datasets never degrade the parent.
  row.state = usable.length > 0 && usable.length < contributing.length ? 'PARTIAL' : selectedWorstRow.state
  row.reasonCode = row.state === 'PARTIAL' ? 'DATASET_PARTIALLY_AVAILABLE' : selectedWorstRow.reasonCode
  row.reason = row.state === 'PARTIAL'
    ? `${usable.length} of ${contributing.length} required datasets are currently available. Review dataset status for the exact boundary.`
    : selectedWorstRow.reason
  row.lastAttemptAt = selectedWorstRow.lastAttemptAt
  row.lastSuccessfulAt = selectedWorstRow.lastSuccessfulAt
  row.freshness = selectedWorstRow.freshness
  const required = [...new Set(contributing.flatMap((dataset) => dataset.permissions.map((permission) => permission.name)))]
  row.permissionStatus = contributing.some((dataset) => dataset.permissionStatus === 'UNVERIFIED')
    ? 'UNVERIFIED'
    : contributing.some((dataset) => dataset.permissionStatus === 'MISSING')
      ? 'MISSING'
      : required.length ? 'CONFIRMED' : 'NOT_APPLICABLE'
  row.configuredCapability = row.permissionStatus === 'CONFIRMED' ? 'CONFIGURED' : row.permissionStatus === 'MISSING' ? 'NOT_CONFIGURED' : 'UNVERIFIED'
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
  const identityProtectionApplicability = licensesCurrent
    ? entraP2Applicability(input.licenseServicePlans)
    : 'UNVERIFIED'
  const signInEntitlement = deriveSignInEntitlement({
    licenses: [{ servicePlans: input.licenseServicePlans }],
    licenseSync: states.get('LICENSES'),
    now,
  })
  const signInPermissions =
    signInEntitlement === 'PREMIUM'
      ? ['AuditLog.Read.All', 'Directory.Read.All']
      : signInEntitlement === 'NON_PREMIUM'
        ? ['ActivityFeed.Read']
        : ['AuditLog.Read.All', 'Directory.Read.All', 'ActivityFeed.Read']
  const signInRemediation =
    signInEntitlement === 'PREMIUM'
      ? 'Confirm AuditLog.Read.All and Directory.Read.All have tenant-wide admin consent. HawkView will use the full Microsoft Graph sign-in source.'
      : signInEntitlement === 'NON_PREMIUM'
        ? 'Confirm ActivityFeed.Read has tenant-wide admin consent. HawkView will use the limited Microsoft 365 audit-feed source because the collected service plans do not include Entra ID P1/P2.'
        : 'Confirm AuditLog.Read.All, Directory.Read.All, and ActivityFeed.Read while HawkView verifies the tenant entitlement and selects the best available sign-in source.'
  const rows = [
    workload({ key: 'entra_directory_audit', workload: 'Entra directory audit', resourceTypes: ['AUDIT_LOGS'], requiredPermissions: ['AuditLog.Read.All', 'Directory.Read.All'], cadence: 'incremental', remediation: 'Confirm AuditLog.Read.All and Directory.Read.All have tenant-wide admin consent, then allow the scheduled collector to recheck.' }, states, consented, verificationKnown, now),
    workload({ key: 'sign_ins', workload: 'Entra sign-ins', resourceTypes: ['SIGN_INS'], requiredPermissions: signInPermissions, cadence: 'incremental', remediation: signInRemediation, licensingFailureDisposition: signInEntitlement === 'PREMIUM' ? 'FAILED_TRANSIENT' : signInEntitlement === 'NON_PREMIUM' ? 'NOT_LICENSED' : 'UNVERIFIED' }, states, consented, verificationKnown, now),
    workload({ key: 'entra_directory', workload: 'Entra directory inventory', resourceTypes: ['USERS', 'GROUPS', 'DEVICES', 'DIRECTORY_ROLES'], requiredPermissions: ['User.Read.All', 'GroupMember.Read.All', 'Member.Read.Hidden', 'Device.Read.All', 'RoleManagement.Read.Directory'], cadence: 'daily', remediation: 'Confirm the required directory, hidden-membership, device, and role-management application permissions. HawkView rechecks during normal collection.' }, states, consented, verificationKnown, now),
    workload({ key: 'entra_security_configuration', workload: 'Entra security configuration', resourceTypes: ['AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES', 'CONDITIONAL_ACCESS', 'AUTHENTICATION_STRENGTHS', 'NAMED_LOCATIONS', 'APPLICATIONS', 'SERVICE_PRINCIPALS', 'SECURITY_DEFAULTS', 'SECURE_SCORES'], requiredPermissions: ['UserAuthenticationMethod.Read.All', 'Policy.Read.AuthenticationMethod', 'Policy.Read.All', 'Application.Read.All', 'SecurityEvents.Read.All'], cadence: 'daily', remediation: 'Confirm the required authentication-method, policy, application, and Secure Score permissions. A successful OAuth connection alone does not verify every collector.' }, states, consented, verificationKnown, now),
    workload({ key: 'entra_identity_protection', workload: 'Microsoft Identity Protection risk', resourceTypes: ['RISKY_USERS'], requiredPermissions: ['IdentityRiskyUser.Read.All'], cadence: 'daily', remediation: 'Confirm the read-only IdentityRiskyUser.Read.All application permission and tenant-wide admin consent. Missing risk evidence remains unknown and never changes MFA enforcement truth.' }, states, consented, verificationKnown, now),
    workload({ key: 'office_365_tenant_configuration', workload: 'Microsoft 365 tenant configuration', resourceTypes: ['ORGANIZATION_CONFIGURATION', 'DOMAINS', 'LICENSES', 'DOMAIN_DNS_HEALTH'], requiredPermissions: ['Organization.Read.All'], cadence: 'daily', remediation: 'Confirm Organization.Read.All and review the exact collector result. Domain DNS readiness is collected independently and does not imply a tenant setting change.' }, states, consented, verificationKnown, now),
    workload({ key: 'sharepoint_onedrive', workload: 'SharePoint and OneDrive', resourceTypes: ['SHAREPOINT_SITES', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE'], requiredPermissions: ['Sites.Read.All', 'SharePointTenantSettings.Read.All', 'Reports.Read.All'], cadence: 'daily', remediation: 'Confirm the listed SharePoint and Reports permissions, then wait for the next scheduled inventory collection.', capabilities: [{ key: 'sharepoint_site_access_metadata', label: 'Site access metadata', state: 'NOT_COLLECTED_LEAST_PRIVILEGE', reasonCode: 'NOT_COLLECTED_LEAST_PRIVILEGE', source: 'HawkView standard least-privilege mode', message: 'Standard mode does not collect current site-user, site collection administrator, sharing-member, or per-site permission metadata. SharePoint and OneDrive administrative events remain available when Microsoft audit evidence is available.' }] }, states, consented, verificationKnown, now),
    workload({ key: 'exchange', workload: 'Exchange mailbox visibility', resourceTypes: ['EXCHANGE_MAILBOXES', 'EXCHANGE_MAILBOX_SETTINGS', 'EXCHANGE_MAILBOX_USAGE', 'EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOX_RULES'], requiredPermissions: ['User.Read.All', 'MailboxSettings.Read', 'Reports.Read.All', 'Organization.Read.All'], cadence: 'daily', remediation: 'Confirm the listed Microsoft Graph application permissions, then allow the next scheduled collection to verify mailbox inventory, usage, rules, and tenant-associated domains.', capabilities: [
      { key: 'exchange_mailbox_delegation', label: 'Mailbox delegation', state: 'NOT_COLLECTED_LEAST_PRIVILEGE', reasonCode: 'NOT_COLLECTED_LEAST_PRIVILEGE', source: 'HawkView standard least-privilege mode', message: 'Microsoft Graph does not expose tenant-wide Full Access, Send As, or Send on Behalf mailbox assignments. HawkView does not request Exchange administrator access for this unsupported field.' },
      { key: 'exchange_mailbox_retention_assignment', label: 'Mailbox retention-policy assignment', state: 'NOT_COLLECTED_LEAST_PRIVILEGE', reasonCode: 'NOT_COLLECTED_LEAST_PRIVILEGE', source: 'HawkView standard least-privilege mode', message: 'Microsoft Graph does not expose tenant-wide mailbox retention-policy assignments in the current standard collector.' },
      { key: 'exchange_accepted_domain_type', label: 'Exchange accepted-domain type', state: 'NOT_COLLECTED_LEAST_PRIVILEGE', reasonCode: 'NOT_COLLECTED_LEAST_PRIVILEGE', source: 'Microsoft Graph organization verifiedDomains', message: 'HawkView reports tenant-associated Microsoft 365 domains. Microsoft Graph organization data does not establish Exchange Authoritative or Internal Relay accepted-domain type.' },
    ] }, states, consented, verificationKnown, now),
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
  applyApplicability('sharepoint_onedrive', sharePointApplicability)
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

  const applicability = {
    sharepoint: sharePointApplicability,
    exchange: exchangeApplicability,
    signIn: signInEntitlement,
    identityProtection: identityProtectionApplicability,
  }
  for (const row of rows) {
    const datasets = capabilitiesForWorkload(row.key).map((capability) =>
      datasetReadiness(
        capability,
        states,
        consented,
        verificationKnown,
        now,
        applicability,
        capability.key === 'sharepoint_usage_reports'
          ? input.sharePointUsageProjectionEvidence
          : capability.key === 'onedrive_usage_reports'
            ? input.oneDriveUsageProjectionEvidence
            : null,
      ),
    )
    if (row.key === 'm365_unified_audit' && datasets[0]) {
      datasets[0] = {
        ...datasets[0],
        state: row.state,
        lastAttemptAt: row.lastAttemptAt,
        lastSuccessfulAt: row.lastSuccessfulAt,
        freshness: row.freshness,
        reasonCode: row.reasonCode,
        reason: row.reason,
      }
    }
    const selected = row.key === 'sign_ins'
      ? new Set(signInEntitlement === 'NON_PREMIUM' ? ['entra_sign_ins_activity_feed'] : signInEntitlement === 'PREMIUM' ? ['entra_sign_ins_graph'] : ['entra_sign_ins_graph', 'entra_sign_ins_activity_feed'])
      : undefined
    applyDatasetContract(row, datasets, selected)
  }

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
      row.datasets = row.datasets?.map((dataset) => ({
        ...dataset,
        state: 'BLOCKED_PERMISSION',
        permissionStatus: 'UNVERIFIED',
        reasonCode: 'MICROSOFT_CONNECTION_NOT_READY',
        reason: 'Microsoft connection consent is pending, revoked, or unavailable.',
        remediation: 'Reconnect or complete Microsoft administrator consent, then HawkView will recheck automatically.',
      }))
    }
  }

  const snapshotByResource = new Map<string, NonNullable<ReadinessInput['evidenceSnapshots']>[number]>()
  for (const snapshot of input.evidenceSnapshots ?? []) {
    const selected = snapshotByResource.get(snapshot.resourceType)
    if (!selected || snapshot.observedAt.getTime() > selected.observedAt.getTime()) {
      snapshotByResource.set(snapshot.resourceType, snapshot)
    }
  }
  const dataset = (workloadKey: string, datasetKey: string) =>
    rows.find((row) => row.key === workloadKey)?.datasets?.find((candidate) => candidate.key === datasetKey)
  const signInDataset = dataset('sign_ins', signInEntitlement === 'NON_PREMIUM' ? 'entra_sign_ins_activity_feed' : 'entra_sign_ins_graph')
  const signInSync = states.get('SIGN_INS')
  const fallbackSelected = /sign-ins-.*fallback-active/.test(signInSync?.lastErrorCode ?? '') && Boolean(signInSync?.lastSuccessfulAt)
  const fallbackRunning = fallbackSelected && signInSync?.status === 'RUNNING'
  const fallbackCurrent = fallbackRunning && signInSync?.lastSuccessfulAt
    ? now.getTime() - signInSync.lastSuccessfulAt.getTime() <= 2 * 60 * 60 * 1000
    : false
  const riskyDataset = dataset('entra_identity_protection', 'entra_identity_protection_risky_users')
  const conditionalAccessDataset = dataset('entra_security_configuration', 'entra_conditional_access')
  const securityDefaultsDataset = dataset('entra_security_configuration', 'entra_security_defaults')
  const riskySnapshot = snapshotByResource.get('RISKY_USERS')
  const conditionalAccessSnapshot = snapshotByResource.get('CONDITIONAL_ACCESS')
  const securityDefaultsSnapshot = snapshotByResource.get('SECURITY_DEFAULTS')
  const riskyRows = Array.isArray(riskySnapshot?.payload) ? riskySnapshot.payload : null
  const conditionalAccessRows = Array.isArray(conditionalAccessSnapshot?.payload) ? conditionalAccessSnapshot.payload : null
  const securityDefaultsRows = Array.isArray(securityDefaultsSnapshot?.payload) ? securityDefaultsSnapshot.payload : null
  const securityDefaultsValue = securityDefaultsRows?.[0]
  const riskyEvidenceReady = riskyDataset?.state === 'READY' && riskyRows !== null && Boolean(riskySnapshot?.observedAt)
  const conditionalAccessEvidenceReady = conditionalAccessDataset?.state === 'READY' && conditionalAccessRows !== null && Boolean(conditionalAccessSnapshot?.observedAt)
  const securityDefaultsEnabled = securityDefaultsValue && typeof securityDefaultsValue === 'object' && typeof (securityDefaultsValue as { isEnabled?: unknown }).isEnabled === 'boolean'
    ? (securityDefaultsValue as { isEnabled: boolean }).isEnabled
    : null
  const securityDefaultsEvidenceReady = securityDefaultsDataset?.state === 'READY' && securityDefaultsEnabled !== null && Boolean(securityDefaultsSnapshot?.observedAt)
  const evidenceUnavailable = (state: CollectionReadinessState | undefined, ready: boolean) =>
    state === 'READY' && !ready
  const evidence: PilotEvidenceProjection = {
    version: 1,
    signIns: {
      availability: fallbackCurrent ? 'CURRENT_LIMITED' : fallbackRunning ? 'STALE' : signInDataset?.state ?? 'UNVERIFIED',
      coverage: fallbackSelected || signInEntitlement === 'NON_PREMIUM' ? 'LIMITED' : signInDataset?.state === 'READY' ? 'FULL' : 'NONE',
      selectedSource: fallbackSelected || signInEntitlement === 'NON_PREMIUM' ? 'OFFICE_365_ACTIVITY_FEED' : signInEntitlement === 'PREMIUM' ? 'MICROSOFT_GRAPH' : null,
      observedAt: fallbackSelected ? iso(signInSync?.lastSuccessfulAt) : signInDataset?.lastSuccessfulAt ?? null,
      reasonCode: fallbackCurrent ? signInSync?.lastErrorCode ?? 'SIGN_IN_FALLBACK_ACTIVE' : fallbackRunning ? 'SIGN_IN_FALLBACK_STALE' : signInDataset?.reasonCode ?? null,
      reason: fallbackCurrent ? safeReason(signInSync?.lastErrorMessage) ?? 'Current limited sign-in evidence is available from the Microsoft 365 audit feed.' : fallbackRunning ? 'Limited sign-in evidence from the Microsoft 365 audit feed is no longer current.' : signInDataset?.reason ?? null,
    },
    riskyIdentities: {
      availability: evidenceUnavailable(riskyDataset?.state, riskyEvidenceReady) ? 'UNVERIFIED' : riskyDataset?.state ?? 'UNVERIFIED',
      count: riskyEvidenceReady ? riskyRows.length : null,
      selectedSource: 'MICROSOFT_IDENTITY_PROTECTION',
      observedAt: riskyEvidenceReady ? iso(riskySnapshot?.observedAt) : null,
      reasonCode: evidenceUnavailable(riskyDataset?.state, riskyEvidenceReady) ? 'EVIDENCE_SNAPSHOT_UNAVAILABLE' : riskyDataset?.reasonCode ?? null,
      reason: evidenceUnavailable(riskyDataset?.state, riskyEvidenceReady) ? 'Current Microsoft Identity Protection evidence is unavailable.' : riskyDataset?.reason ?? null,
    },
    conditionalAccess: {
      availability: evidenceUnavailable(conditionalAccessDataset?.state, conditionalAccessEvidenceReady) ? 'UNVERIFIED' : conditionalAccessDataset?.state ?? 'UNVERIFIED',
      count: conditionalAccessEvidenceReady ? conditionalAccessRows.length : null,
      selectedSource: 'MICROSOFT_GRAPH',
      observedAt: conditionalAccessEvidenceReady ? iso(conditionalAccessSnapshot?.observedAt) : null,
      reasonCode: evidenceUnavailable(conditionalAccessDataset?.state, conditionalAccessEvidenceReady) ? 'EVIDENCE_SNAPSHOT_UNAVAILABLE' : conditionalAccessDataset?.reasonCode ?? null,
      reason: evidenceUnavailable(conditionalAccessDataset?.state, conditionalAccessEvidenceReady) ? 'Current Conditional Access evidence is unavailable.' : conditionalAccessDataset?.reason ?? null,
    },
    securityDefaults: {
      availability: evidenceUnavailable(securityDefaultsDataset?.state, securityDefaultsEvidenceReady) ? 'UNVERIFIED' : securityDefaultsDataset?.state ?? 'UNVERIFIED',
      enabled: securityDefaultsEvidenceReady ? securityDefaultsEnabled : null,
      selectedSource: 'MICROSOFT_GRAPH',
      observedAt: securityDefaultsEvidenceReady ? iso(securityDefaultsSnapshot?.observedAt) : null,
      reasonCode: evidenceUnavailable(securityDefaultsDataset?.state, securityDefaultsEvidenceReady) ? 'EVIDENCE_SNAPSHOT_UNAVAILABLE' : securityDefaultsDataset?.reasonCode ?? null,
      reason: evidenceUnavailable(securityDefaultsDataset?.state, securityDefaultsEvidenceReady) ? 'Current Security Defaults evidence is unavailable.' : securityDefaultsDataset?.reason ?? null,
    },
  }

  const overall = selectedWorst(rows)!
  return {
    version: 1,
    accessContractVersion: MICROSOFT_ACCESS_CONTRACT_VERSION,
    overallState: overall.state,
    reasonCode: overall.reasonCode,
    reason: overall.reason,
    lastAttemptAt: overall.lastAttemptAt,
    lastSuccessfulAt: overall.lastSuccessfulAt,
    permissionVerifiedAt: iso(input.connectionVerifiedAt),
    evaluatedAt: now.toISOString(),
    workloads: rows,
    evidence,
  }
}
