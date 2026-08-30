export const READINESS_STATES = [
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

type ReadinessState = (typeof READINESS_STATES)[number]
const stateSet = new Set<string>(READINESS_STATES)
const permissionStatuses = new Set(['CONFIRMED', 'MISSING', 'UNVERIFIED', 'NOT_APPLICABLE'])
const freshStates = new Set(['CURRENT', 'AGING', 'STALE', 'NEVER_SUCCEEDED', 'UNKNOWN'])
const capabilityStatuses = new Set(['CONFIGURED', 'UNVERIFIED', 'NOT_CONFIGURED'])
const datasetTiers = new Set(['CORE', 'CAPABILITY_OPTIONAL', 'FALLBACK'])
const datasetPermissionStatuses = new Set(['CONFIRMED', 'MISSING', 'UNVERIFIED', 'NOT_APPLICABLE'])
const permissionResources = new Set(['MICROSOFT_GRAPH', 'OFFICE_365_MANAGEMENT_API', 'EXCHANGE_ONLINE'])
const permissionConsentModes = new Set(['DEFAULT', 'SEPARATE_OPT_IN'])
const licenseKinds = new Set(['NONE', 'ENTRA_ID_P1_OR_P2', 'ENTRA_ID_P2', 'SHAREPOINT_SERVICE_PLAN', 'EXCHANGE_SERVICE_PLAN', 'UNIFIED_AUDIT_ENABLED'])
const licenseStates = new Set(['NOT_REQUIRED', 'SATISFIED', 'NOT_LICENSED', 'UNVERIFIED'])
const failureScopes = new Set(['DATASET_ONLY', 'WORKLOAD'])
const CLOSED_UNKNOWN_STATE: ReadinessState = 'UNSUPPORTED'
const READINESS_ORDER: Record<ReadinessState, number> = {
  BLOCKED_PERMISSION: 0, BLOCKED_TENANT_CONFIGURATION: 1, NOT_LICENSED: 3,
  UNSUPPORTED: 2, FAILED_TRANSIENT: 4, STALE: 5, BACKLOGGED: 6, PARTIAL: 7,
  UNVERIFIED: 8, INITIALIZING: 9, NEVER_SUCCEEDED: 10, READY: 11,
}

export type CollectionReadinessView = {
  accessContractVersion: 1 | null
  overallState: ReadinessState
  evaluatedAt: string | null
  permissionVerifiedAt: string | null
  reasonCode: string | null
  reason: string | null
  remediation: string | null
  evidence: PilotEvidenceView
  workloads: Array<{
    key: string
    workload: string
    state: ReadinessState
    configuredCapability: 'CONFIGURED' | 'UNVERIFIED' | 'NOT_CONFIGURED'
    permissionStatus: 'CONFIRMED' | 'MISSING' | 'UNVERIFIED' | 'NOT_APPLICABLE'
    requiredPermissions: string[]
    lastAttemptAt: string | null
    lastSuccessfulAt: string | null
    freshness: 'CURRENT' | 'AGING' | 'STALE' | 'NEVER_SUCCEEDED' | 'UNKNOWN'
    reasonCode: string | null
    reason: string | null
    lastVerifiedAt: string | null
    remediation: string
    datasets: AccessDatasetReadiness[]
    capabilities: Array<{
      key: string
      label: string
      state: 'NOT_COLLECTED_LEAST_PRIVILEGE'
      reasonCode: 'NOT_COLLECTED_LEAST_PRIVILEGE'
      source: string
      message: string
    }>
    components: Array<{
      key: string
      label: string
      state: ReadinessState
      lastAttemptAt: string | null
      lastSuccessfulAt: string | null
      reasonCode: string | null
      reason: string | null
      lastVerifiedAt: string | null
    }>
    exchangeRbac: { status: string; state: ReadinessState; reason: string } | null
  }>
}

export type PilotEvidenceView = {
  version: 1
  signIns: {
    availability: ReadinessState | 'CURRENT_LIMITED'
    coverage: 'FULL' | 'LIMITED' | 'NONE'
    selectedSource: 'MICROSOFT_GRAPH' | 'OFFICE_365_ACTIVITY_FEED' | null
    observedAt: string | null
    reasonCode: string | null
    reason: string | null
  }
  riskyIdentities: {
    availability: ReadinessState
    count: number | null
    selectedSource: 'MICROSOFT_IDENTITY_PROTECTION'
    observedAt: string | null
    reasonCode: string | null
    reason: string | null
  }
  conditionalAccess: {
    availability: ReadinessState
    count: number | null
    selectedSource: 'MICROSOFT_GRAPH'
    observedAt: string | null
    reasonCode: string | null
    reason: string | null
  }
  securityDefaults: {
    availability: ReadinessState
    enabled: boolean | null
    selectedSource: 'MICROSOFT_GRAPH'
    observedAt: string | null
    reasonCode: string | null
    reason: string | null
  }
}

export type AccessDatasetReadiness = {
  key: string
  label: string
  tier: 'CORE' | 'CAPABILITY_OPTIONAL' | 'FALLBACK'
  state: ReadinessState
  permissionStatus: 'CONFIRMED' | 'MISSING' | 'UNVERIFIED' | 'NOT_APPLICABLE'
  permissions: Array<{
    resource: 'MICROSOFT_GRAPH' | 'OFFICE_365_MANAGEMENT_API' | 'EXCHANGE_ONLINE'
    name: string
    type: 'APPLICATION'
    consentMode: 'DEFAULT' | 'SEPARATE_OPT_IN'
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
  freshness: 'CURRENT' | 'AGING' | 'STALE' | 'NEVER_SUCCEEDED' | 'UNKNOWN'
  reasonCode: string | null
  reason: string | null
  remediation: string
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}

function text(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim()
  return normalized ? normalized.slice(0, max) : null
}

function timestamp(value: unknown) {
  const candidate = text(value, 64)
  return candidate && Number.isFinite(new Date(candidate).getTime()) ? candidate : null
}

function httpsUrl(value: unknown): string | null {
  const candidate = text(value, 500)
  if (!candidate) return null
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'learn.microsoft.com' || parsed.username || parsed.password || parsed.port || parsed.hash) return null
    return parsed.toString()
  } catch {
    return null
  }
}

function state(value: unknown): ReadinessState | null {
  return typeof value === 'string' && stateSet.has(value) ? value as ReadinessState : null
}

function closedState(value: unknown): ReadinessState {
  return state(value) ?? CLOSED_UNKNOWN_STATE
}

function component(value: unknown) {
  const candidate = record(value)
  const componentState = closedState(candidate?.state)
  const key = text(candidate?.key, 80)
  const label = text(candidate?.label, 120)
  if (!candidate || !key || !label) return null
  return {
    key,
    label,
    state: componentState,
    lastAttemptAt: timestamp(candidate.lastAttemptAt),
    lastSuccessfulAt: timestamp(candidate.lastSuccessfulAt),
    reasonCode: text(candidate.reasonCode, 120),
    reason: text(candidate.reason),
    lastVerifiedAt: timestamp(candidate.lastVerifiedAt),
  }
}

function capability(value: unknown) {
  const candidate = record(value)
  if (!candidate || candidate.state !== 'NOT_COLLECTED_LEAST_PRIVILEGE' || candidate.reasonCode !== 'NOT_COLLECTED_LEAST_PRIVILEGE') return null
  const key = text(candidate.key, 80)
  const label = text(candidate.label, 120)
  const source = text(candidate.source, 160)
  const message = text(candidate.message, 500)
  return key && label && source && message
    ? { key, label, state: 'NOT_COLLECTED_LEAST_PRIVILEGE' as const, reasonCode: 'NOT_COLLECTED_LEAST_PRIVILEGE' as const, source, message }
    : null
}

function datasetPermission(value: unknown): AccessDatasetReadiness['permissions'][number] | null {
  const candidate = record(value)
  if (!candidate || candidate.type !== 'APPLICATION') return null
  const resource = typeof candidate.resource === 'string' && permissionResources.has(candidate.resource)
    ? candidate.resource as AccessDatasetReadiness['permissions'][number]['resource']
    : null
  const consentMode = typeof candidate.consentMode === 'string' && permissionConsentModes.has(candidate.consentMode)
    ? candidate.consentMode as AccessDatasetReadiness['permissions'][number]['consentMode']
    : null
  const name = text(candidate.name, 160)
  const grantStatus = typeof candidate.grantStatus === 'string' && ['CONFIRMED', 'MISSING', 'UNVERIFIED'].includes(candidate.grantStatus)
    ? candidate.grantStatus as AccessDatasetReadiness['permissions'][number]['grantStatus']
    : null
  return resource && consentMode && name && grantStatus ? { resource, name, type: 'APPLICATION', consentMode, grantStatus } : null
}

function permissionProjection(
  permissions: AccessDatasetReadiness['permissions'],
  match: AccessDatasetReadiness['permissionMatch'],
): AccessDatasetReadiness['permissionStatus'] {
  if (permissions.length === 0) return 'NOT_APPLICABLE'
  if (match === 'ANY') {
    if (permissions.some((permission) => permission.grantStatus === 'CONFIRMED')) return 'CONFIRMED'
    if (permissions.some((permission) => permission.grantStatus === 'UNVERIFIED')) return 'UNVERIFIED'
    return 'MISSING'
  }
  if (permissions.some((permission) => permission.grantStatus === 'MISSING')) return 'MISSING'
  if (permissions.some((permission) => permission.grantStatus === 'UNVERIFIED')) return 'UNVERIFIED'
  return 'CONFIRMED'
}

function workloadPermissionProjection(datasets: AccessDatasetReadiness[]) {
  const byKey = new Map(datasets.map((dataset) => [dataset.key, dataset]))
  const core = datasets.filter((dataset) => dataset.tier === 'CORE')
  const contributing = core.map((dataset) => {
    const fallback = dataset.fallbackDatasetKey ? byKey.get(dataset.fallbackDatasetKey) : null
    return dataset.state !== 'READY' && fallback?.state === 'READY' ? fallback : dataset
  })
  if (contributing.length === 0) return 'NOT_APPLICABLE' as const
  if (contributing.some((dataset) => dataset.permissionStatus === 'MISSING')) return 'MISSING' as const
  if (contributing.some((dataset) => dataset.permissionStatus === 'UNVERIFIED')) return 'UNVERIFIED' as const
  return contributing.some((dataset) => dataset.permissionStatus === 'CONFIRMED') ? 'CONFIRMED' as const : 'NOT_APPLICABLE' as const
}

function accessDataset(value: unknown, index: number): AccessDatasetReadiness {
  const candidate = record(value)
  const key = text(candidate?.key, 100)
  const label = text(candidate?.label, 160)
  const tier = typeof candidate?.tier === 'string' && datasetTiers.has(candidate.tier)
    ? candidate.tier as AccessDatasetReadiness['tier']
    : null
  const datasetState = state(candidate?.state)
  const permissionStatus = typeof candidate?.permissionStatus === 'string' && datasetPermissionStatuses.has(candidate.permissionStatus)
    ? candidate.permissionStatus as AccessDatasetReadiness['permissionStatus']
    : null
  const permissionMatch = typeof candidate?.permissionMatch === 'string' && ['ALL', 'ANY'].includes(candidate.permissionMatch)
    ? candidate.permissionMatch as AccessDatasetReadiness['permissionMatch']
    : null
  const evidenceMode = typeof candidate?.evidenceMode === 'string' && ['RESOURCE_STATE', 'COMPOSITE_RESOURCE_STATE', 'NOT_DURABLY_OBSERVED'].includes(candidate.evidenceMode)
    ? candidate.evidenceMode as AccessDatasetReadiness['evidenceMode']
    : null
  const license = record(candidate?.licensePrerequisite)
  const licenseKind = typeof license?.kind === 'string' && licenseKinds.has(license.kind)
    ? license.kind as AccessDatasetReadiness['licensePrerequisite']['kind']
    : null
  const licenseState = typeof license?.state === 'string' && licenseStates.has(license.state)
    ? license.state as AccessDatasetReadiness['licensePrerequisite']['state']
    : null
  const failureScope = typeof candidate?.failureScope === 'string' && failureScopes.has(candidate.failureScope)
    ? candidate.failureScope as AccessDatasetReadiness['failureScope']
    : null
  const freshness = typeof candidate?.freshness === 'string' && freshStates.has(candidate.freshness)
    ? candidate.freshness as AccessDatasetReadiness['freshness']
    : null
  const remediation = text(candidate?.remediation)
  const documentationUrl = httpsUrl(candidate?.documentationUrl)
  const rawPermissions = Array.isArray(candidate?.permissions) ? candidate.permissions : []
  const permissions = rawPermissions.slice(0, 16).map(datasetPermission).filter((item): item is NonNullable<ReturnType<typeof datasetPermission>> => Boolean(item))
  const rawResourceTypes = Array.isArray(candidate?.resourceTypes) ? candidate.resourceTypes : []
  const resourceTypes = rawResourceTypes.slice(0, 16).map((item) => text(item, 100)).filter((item): item is string => Boolean(item))
  const rawEndpointPatterns = Array.isArray(candidate?.endpointPatterns) ? candidate.endpointPatterns : []
  const endpointPatterns = rawEndpointPatterns.slice(0, 16).map((item) => text(item, 240)).filter((item): item is string => Boolean(item))
  const fallbackValid = candidate?.fallbackDatasetKey === null || typeof candidate?.fallbackDatasetKey === 'string'
  const permissionConsistent = permissionStatus !== null && permissionMatch !== null && permissionProjection(permissions, permissionMatch) === permissionStatus
  const invalid = !candidate || !key || !label || !tier || !datasetState || !permissionStatus || !permissionMatch || !permissionConsistent || !evidenceMode || !licenseKind || !licenseState || !failureScope || !freshness || !remediation || !documentationUrl || !fallbackValid || rawPermissions.length > 16 || permissions.length !== rawPermissions.length || rawResourceTypes.length > 16 || resourceTypes.length !== rawResourceTypes.length || rawEndpointPatterns.length > 16 || endpointPatterns.length !== rawEndpointPatterns.length
  if (invalid) {
    return {
      key: `invalid_access_dataset_${index}`,
      label: 'Access dataset validation',
      tier: 'CORE',
      state: 'UNSUPPORTED',
      permissionStatus: 'UNVERIFIED',
      permissions: [],
      permissionMatch: 'ALL',
      evidenceMode: 'NOT_DURABLY_OBSERVED',
      licensePrerequisite: { kind: 'NONE', state: 'UNVERIFIED' },
      fallbackDatasetKey: null,
      failureScope: 'WORKLOAD',
      resourceTypes: [],
      endpointPatterns: [],
      documentationUrl: 'https://learn.microsoft.com/',
      lastAttemptAt: null,
      lastSuccessfulAt: null,
      freshness: 'UNKNOWN',
      reasonCode: 'MALFORMED_ACCESS_DATASET',
      reason: 'HawkView received an unsupported access dataset contract.',
      remediation: 'Refresh after the service returns a supported Microsoft access contract.',
    }
  }
  return {
    key,
    label,
    tier,
    state: datasetState,
    permissionStatus,
    permissions,
    permissionMatch,
    evidenceMode,
    licensePrerequisite: { kind: licenseKind, state: licenseState },
    fallbackDatasetKey: text(candidate.fallbackDatasetKey, 100),
    failureScope,
    resourceTypes,
    endpointPatterns,
    documentationUrl,
    lastAttemptAt: timestamp(candidate.lastAttemptAt),
    lastSuccessfulAt: timestamp(candidate.lastSuccessfulAt),
    freshness,
    reasonCode: text(candidate.reasonCode, 120),
    reason: text(candidate.reason),
    remediation,
  }
}

const UNKNOWN_EVIDENCE: PilotEvidenceView = {
  version: 1,
  signIns: { availability: 'UNVERIFIED', coverage: 'NONE', selectedSource: null, observedAt: null, reasonCode: 'EVIDENCE_UNAVAILABLE', reason: 'Current sign-in evidence is unavailable.' },
  riskyIdentities: { availability: 'UNVERIFIED', count: null, selectedSource: 'MICROSOFT_IDENTITY_PROTECTION', observedAt: null, reasonCode: 'EVIDENCE_UNAVAILABLE', reason: 'Current Microsoft Identity Protection evidence is unavailable.' },
  conditionalAccess: { availability: 'UNVERIFIED', count: null, selectedSource: 'MICROSOFT_GRAPH', observedAt: null, reasonCode: 'EVIDENCE_UNAVAILABLE', reason: 'Current Conditional Access evidence is unavailable.' },
  securityDefaults: { availability: 'UNVERIFIED', enabled: null, selectedSource: 'MICROSOFT_GRAPH', observedAt: null, reasonCode: 'EVIDENCE_UNAVAILABLE', reason: 'Current Security Defaults evidence is unavailable.' },
}

function nullableCount(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function pilotEvidence(value: unknown): PilotEvidenceView {
  const candidate = record(value)
  const signIns = record(candidate?.signIns)
  const risky = record(candidate?.riskyIdentities)
  const conditionalAccess = record(candidate?.conditionalAccess)
  const securityDefaults = record(candidate?.securityDefaults)
  const signInAvailability = signIns?.availability === 'CURRENT_LIMITED' ? 'CURRENT_LIMITED' : state(signIns?.availability)
  const riskAvailability = state(risky?.availability)
  const caAvailability = state(conditionalAccess?.availability)
  const securityDefaultsAvailability = state(securityDefaults?.availability)
  const coverage = typeof signIns?.coverage === 'string' && ['FULL', 'LIMITED', 'NONE'].includes(signIns.coverage) ? signIns.coverage as PilotEvidenceView['signIns']['coverage'] : null
  const signInSource = signIns?.selectedSource === null || ['MICROSOFT_GRAPH', 'OFFICE_365_ACTIVITY_FEED'].includes(String(signIns?.selectedSource)) ? signIns?.selectedSource as PilotEvidenceView['signIns']['selectedSource'] : undefined
  if (candidate?.version !== 1 || !signIns || !risky || !conditionalAccess || !securityDefaults || !signInAvailability || !riskAvailability || !caAvailability || !securityDefaultsAvailability || !coverage || signInSource === undefined || risky.selectedSource !== 'MICROSOFT_IDENTITY_PROTECTION' || conditionalAccess.selectedSource !== 'MICROSOFT_GRAPH' || securityDefaults.selectedSource !== 'MICROSOFT_GRAPH') return UNKNOWN_EVIDENCE
  const riskCount = nullableCount(risky.count)
  const caCount = nullableCount(conditionalAccess.count)
  const enabled = typeof securityDefaults.enabled === 'boolean' ? securityDefaults.enabled : null
  const riskObservedAt = timestamp(risky.observedAt)
  const caObservedAt = timestamp(conditionalAccess.observedAt)
  const securityDefaultsObservedAt = timestamp(securityDefaults.observedAt)
  const normalizedRiskAvailability = riskAvailability === 'READY' && (riskCount === null || !riskObservedAt) ? 'UNVERIFIED' : riskAvailability
  const normalizedCaAvailability = caAvailability === 'READY' && (caCount === null || !caObservedAt) ? 'UNVERIFIED' : caAvailability
  const normalizedSecurityDefaultsAvailability = securityDefaultsAvailability === 'READY' && (enabled === null || !securityDefaultsObservedAt) ? 'UNVERIFIED' : securityDefaultsAvailability
  return {
    version: 1,
    signIns: { availability: signInAvailability, coverage, selectedSource: signInSource, observedAt: timestamp(signIns.observedAt), reasonCode: text(signIns.reasonCode, 120), reason: text(signIns.reason) },
    riskyIdentities: { availability: normalizedRiskAvailability, count: normalizedRiskAvailability === 'READY' ? riskCount : null, selectedSource: 'MICROSOFT_IDENTITY_PROTECTION', observedAt: normalizedRiskAvailability === 'READY' ? riskObservedAt : null, reasonCode: normalizedRiskAvailability !== riskAvailability ? 'EVIDENCE_SNAPSHOT_UNAVAILABLE' : text(risky.reasonCode, 120), reason: normalizedRiskAvailability !== riskAvailability ? 'Current Microsoft Identity Protection evidence is unavailable.' : text(risky.reason) },
    conditionalAccess: { availability: normalizedCaAvailability, count: normalizedCaAvailability === 'READY' ? caCount : null, selectedSource: 'MICROSOFT_GRAPH', observedAt: normalizedCaAvailability === 'READY' ? caObservedAt : null, reasonCode: normalizedCaAvailability !== caAvailability ? 'EVIDENCE_SNAPSHOT_UNAVAILABLE' : text(conditionalAccess.reasonCode, 120), reason: normalizedCaAvailability !== caAvailability ? 'Current Conditional Access evidence is unavailable.' : text(conditionalAccess.reason) },
    securityDefaults: { availability: normalizedSecurityDefaultsAvailability, enabled: normalizedSecurityDefaultsAvailability === 'READY' ? enabled : null, selectedSource: 'MICROSOFT_GRAPH', observedAt: normalizedSecurityDefaultsAvailability === 'READY' ? securityDefaultsObservedAt : null, reasonCode: normalizedSecurityDefaultsAvailability !== securityDefaultsAvailability ? 'EVIDENCE_SNAPSHOT_UNAVAILABLE' : text(securityDefaults.reasonCode, 120), reason: normalizedSecurityDefaultsAvailability !== securityDefaultsAvailability ? 'Current Security Defaults evidence is unavailable.' : text(securityDefaults.reason) },
  }
}

export function normalizeCollectionReadiness(value: unknown): CollectionReadinessView | null {
  const candidate = record(value)
  if (!candidate || !Array.isArray(candidate.workloads)) return null
  const hasAccessContract = candidate.accessContractVersion === 1
  if (candidate.accessContractVersion !== undefined && !hasAccessContract) return null
  const workloads: CollectionReadinessView['workloads'] = []
  const rawWorkloads = candidate.workloads
  const boundedWorkloads = rawWorkloads.slice(0, 256)
  for (let index = 0; index < boundedWorkloads.length; index += 1) {
    const value = boundedWorkloads[index]
    const row = record(value)
    const rowState = closedState(row?.state)
    const key = text(row?.key, 80)
    const workload = text(row?.workload, 120)
    const permissionStatus = typeof row?.permissionStatus === 'string' && permissionStatuses.has(row.permissionStatus)
      ? row.permissionStatus as CollectionReadinessView['workloads'][number]['permissionStatus']
      : null
    const configuredCapability = typeof row?.configuredCapability === 'string' && capabilityStatuses.has(row.configuredCapability)
      ? row.configuredCapability as CollectionReadinessView['workloads'][number]['configuredCapability']
      : null
    const freshness = typeof row?.freshness === 'string' && freshStates.has(row.freshness)
      ? row.freshness as CollectionReadinessView['workloads'][number]['freshness']
      : null
    const remediation = text(row?.remediation)
    if (!row || !key || !workload || !configuredCapability || !permissionStatus || !freshness || !remediation) {
      workloads.push({
        key: `invalid_readiness_row_${index}`, workload: 'Readiness data validation', state: 'UNSUPPORTED',
        configuredCapability: 'UNVERIFIED', permissionStatus: 'UNVERIFIED', requiredPermissions: [],
        lastAttemptAt: null, lastSuccessfulAt: null, freshness: 'UNKNOWN', reasonCode: 'MALFORMED_READINESS_ROW', reason: 'HawkView received a malformed readiness row.', lastVerifiedAt: null,
        remediation: 'Refresh the tenant data after the service reports a valid readiness response.', capabilities: [], components: [], exchangeRbac: null,
        datasets: [],
      })
      continue
    }
    const requiredPermissions = Array.isArray(row.requiredPermissions)
      ? row.requiredPermissions.slice(0, 16).map((permission) => text(permission, 160)).filter((permission): permission is string => Boolean(permission))
      : []
    const capabilities = Array.isArray(row.capabilities)
      ? row.capabilities.slice(0, 8).map(capability).filter((item): item is NonNullable<ReturnType<typeof capability>> => Boolean(item))
      : []
    const datasets = hasAccessContract && Array.isArray(row.datasets)
      ? row.datasets.slice(0, 64).map(accessDataset)
      : []
    const accessContractInvalid = hasAccessContract && (!Array.isArray(row.datasets) || row.datasets.length === 0 || row.datasets.length > 64)
    if (accessContractInvalid) datasets.push(accessDataset(null, datasets.length))
    const rawComponents = Array.isArray(row.components) ? row.components : []
    const oversizedComponents = rawComponents.length > 16
    let malformedComponents = false
    const componentByKey = new Map<string, CollectionReadinessView['workloads'][number]['components'][number]>()
    for (const rawComponent of rawComponents.slice(0, 16)) {
      const normalized = component(rawComponent)
      if (!normalized) {
        malformedComponents = true
        continue
      }
      const existing = componentByKey.get(normalized.key)
      if (!existing || READINESS_ORDER[normalized.state] < READINESS_ORDER[existing.state]) componentByKey.set(normalized.key, normalized)
    }
    const components = Array.from(componentByKey.values())
    if (oversizedComponents || malformedComponents) {
      components.push({
        key: 'invalid_component_data', label: 'Readiness component data', state: 'UNSUPPORTED',
        lastAttemptAt: null, lastSuccessfulAt: null, lastVerifiedAt: null,
        reasonCode: 'READINESS_COMPONENT_LIMIT_EXCEEDED', reason: 'HawkView received more component rows than this bounded contract permits.',
      })
    }
    const rbac = record(row.exchangeRbac)
    const rbacState = state(rbac?.state)
    const rbacStatus = text(rbac?.status, 40)
    const rbacReason = text(rbac?.reason)
    const invalidAccessDataset = datasets.some((dataset) => dataset.key.startsWith('invalid_access_dataset_'))
    const projectedPermissionStatus = hasAccessContract ? workloadPermissionProjection(datasets) : permissionStatus
    const rowCandidate = invalidAccessDataset
      ? { state: 'UNSUPPORTED' as const, reasonCode: 'MALFORMED_ACCESS_DATASET', reason: 'HawkView received an unsupported access dataset contract.', remediation: 'Refresh after the service returns a supported Microsoft access contract.' }
      : { state: rowState, reasonCode: text(row.reasonCode, 120), reason: text(row.reason), remediation }
    const selected = hasAccessContract
      ? rowCandidate
      : components.reduce<typeof rowCandidate | CollectionReadinessView['workloads'][number]['components'][number]>((worst, candidate) => {
          return READINESS_ORDER[candidate.state] < READINESS_ORDER[worst.state] ? candidate : worst
        }, rowCandidate)
    const selectedComponent = 'label' in selected ? selected : null
    workloads.push({
      key,
      workload,
      state: selected.state,
      configuredCapability: projectedPermissionStatus === 'CONFIRMED' ? 'CONFIGURED' : projectedPermissionStatus === 'MISSING' ? 'NOT_CONFIGURED' : configuredCapability,
      permissionStatus: projectedPermissionStatus,
      requiredPermissions,
      lastAttemptAt: timestamp(row.lastAttemptAt),
      lastSuccessfulAt: timestamp(row.lastSuccessfulAt),
      freshness,
      reasonCode: selected.reasonCode,
      reason: selected.reason,
      lastVerifiedAt: timestamp(row.lastVerifiedAt),
      remediation: selectedComponent
        ? `Review ${selectedComponent.label}: ${selectedComponent.reason ?? 'this component could not be safely verified.'}`
        : remediation,
      capabilities,
      datasets,
      components,
      exchangeRbac: rbacState && rbacStatus && rbacReason ? { status: rbacStatus, state: rbacState, reason: rbacReason } : null,
    })
  }
  if (rawWorkloads.length > 64) {
    workloads.push({
      key: 'invalid_readiness_data', workload: 'Readiness data validation', state: 'UNSUPPORTED',
      configuredCapability: 'UNVERIFIED', permissionStatus: 'UNVERIFIED', requiredPermissions: [],
      lastAttemptAt: null, lastSuccessfulAt: null, freshness: 'UNKNOWN', reasonCode: 'READINESS_ROW_LIMIT_EXCEEDED', reason: 'HawkView received more readiness rows than this bounded contract permits.', lastVerifiedAt: null,
      remediation: 'Refresh the tenant data after the service reports a valid readiness response.', capabilities: [], components: [], exchangeRbac: null,
      datasets: [],
    })
  }
  if (!workloads.length) return null
  const unique = new Map<string, CollectionReadinessView['workloads'][number]>()
  for (const row of workloads) {
    const existing = unique.get(row.key)
    if (!existing || READINESS_ORDER[row.state] < READINESS_ORDER[existing.state]) unique.set(row.key, row)
  }
  const normalizedWorkloads = Array.from(unique.values())
  const overall = normalizedWorkloads.reduce<CollectionReadinessView['workloads'][number] | null>((selected, row) => !selected || READINESS_ORDER[row.state] < READINESS_ORDER[selected.state] ? row : selected, null)
  return { accessContractVersion: hasAccessContract ? 1 : null, overallState: overall?.state ?? 'UNSUPPORTED', evaluatedAt: timestamp(candidate.evaluatedAt), permissionVerifiedAt: timestamp(candidate.permissionVerifiedAt), reasonCode: overall?.reasonCode ?? null, reason: overall?.reason ?? null, remediation: overall?.remediation ?? null, evidence: pilotEvidence(candidate.evidence), workloads: normalizedWorkloads }
}

export function readinessLabel(value: string) {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase())
}

/**
 * Old persisted sync rows can contain an internal snapshot-safety assertion.
 * Never surface that implementation detail as an administrator instruction.
 */
export function readinessDiagnostic(reasonCode: string | null, reason: string | null) {
  if (/^Refusing to advance SHAREPOINT_SITES snapshot baseline from a partial or unverified collection\.?$/i.test(reason ?? '')) {
    return 'SharePoint site access metadata could not be verified completely. HawkView retained the prior site inventory and will retry at the next eligible scheduled collection.'
  }
  if (reasonCode === 'sharepoint_sites-sync-failed' && /site access metadata/i.test(reason ?? '')) {
    return reason
  }
  return reason
}

export function readinessRemediation(state: ReadinessState, remediation: string) {
  if (state === 'READY') {
    return 'No action required. HawkView will continue normal scheduled collection.'
  }
  return remediation
}

/**
 * The legacy synchronization card is a summary of required collection
 * readiness, never a report that a scheduler invocation happened to finish.
 * NOT_LICENSED is intentionally shown as not applicable rather than counted
 * as a failed required workload. Every other non-READY workload keeps the
 * summary non-healthy and contributes its own observed status.
 */
export type SynchronizationReadinessSummary = {
  overallState: ReadinessState
  applicableWorkloads: number
  currentWorkloads: number
  attentionWorkloads: number
  primaryReason: string | null
  primaryReasonCode: string | null
  primaryLastAttemptAt: string | null
  primaryLastSuccessfulAt: string | null
}

export function synchronizationReadinessSummary(
  readiness: CollectionReadinessView | null,
): SynchronizationReadinessSummary | null {
  if (!readiness) return null
  const applicable = readiness.workloads.filter((workload) => workload.state !== 'NOT_LICENSED')
  const pool = applicable.length ? applicable : readiness.workloads
  const selected = pool.reduce<CollectionReadinessView['workloads'][number] | null>((worst, workload) => {
    return !worst || READINESS_ORDER[workload.state] < READINESS_ORDER[worst.state] ? workload : worst
  }, null)
  if (!selected) return null
  return {
    overallState: selected.state,
    applicableWorkloads: applicable.length,
    currentWorkloads: applicable.filter((workload) => workload.state === 'READY').length,
    attentionWorkloads: applicable.filter((workload) => workload.state !== 'READY').length,
    primaryReason: selected.reason,
    primaryReasonCode: selected.reasonCode,
    primaryLastAttemptAt: selected.lastAttemptAt,
    primaryLastSuccessfulAt: selected.lastSuccessfulAt,
  }
}
