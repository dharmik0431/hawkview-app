import type { AccessDatasetReadiness, CollectionReadinessView } from './collection-readiness.ts'

export type MicrosoftAccessPermissionView = {
  key: string
  name: string
  service: 'Microsoft Graph' | 'Office 365 Management API' | 'Exchange Online'
  type: 'Application'
  requirement: 'Connection required' | 'Core dataset' | 'Optional enrichment' | 'Fallback path' | 'Alternative source'
  status: 'Granted' | 'Missing' | 'Not verified'
  consentMode: 'Default consent' | 'Separate opt-in'
  purpose: string
  documentationUrl: string
  affectedDatasets: string[]
}

export type MicrosoftAccessSummary = {
  contractAvailable: boolean
  connectionRequired: number
  core: number
  optional: number
  fallback: number
  alternative: number
  granted: number
  missingConnectionRequired: number
  missingCore: number
  missingOptional: number
  unverified: number
  permissions: MicrosoftAccessPermissionView[]
}

export type MicrosoftConsentReview = {
  consentUrl: string
  requiredPermissions: Array<{
    name: string
    description: string
    resource: 'MICROSOFT_GRAPH' | 'OFFICE_365_MANAGEMENT_API' | 'EXCHANGE_ONLINE'
    type: 'APPLICATION'
    consentMode: 'DEFAULT' | 'SEPARATE_OPT_IN'
    tier: 'CORE' | 'CAPABILITY_OPTIONAL'
    connectionRequired: boolean
    purpose: string[]
  }>
}

export type MicrosoftAccessCatalog = {
  version: 1
  requestedPermissions: MicrosoftConsentReview['requiredPermissions']
  connectionRequiredPermissions: string[]
  capabilities: MicrosoftAccessCapability[]
}

export type MicrosoftAccessCapability = {
  key: string
  workloadKey: string
  label: string
  tier: AccessDatasetReadiness['tier']
  applicationPermissions: Array<{
    resource: AccessDatasetReadiness['permissions'][number]['resource']
    name: string
  }>
  permissionMatch: AccessDatasetReadiness['permissionMatch']
  evidenceMode: AccessDatasetReadiness['evidenceMode']
  sourceAlternatives: Array<{
    key: string
    applicationPermissions: Array<{
      resource: AccessDatasetReadiness['permissions'][number]['resource']
      name: string
    }>
    licensePrerequisite: AccessDatasetReadiness['licensePrerequisite']['kind']
    endpointPatterns: string[]
    documentationUrl: string
  }>
  licensePrerequisite: AccessDatasetReadiness['licensePrerequisite']['kind']
  fallbackCapabilityKey: string | null
  failureScope: AccessDatasetReadiness['failureScope']
  resourceTypes: string[]
  endpointPatterns: string[]
  documentationUrl: string
}

const TIER_ORDER = { CORE: 0, CAPABILITY_OPTIONAL: 1, FALLBACK: 2 } as const
const STATUS_ORDER = { MISSING: 0, UNVERIFIED: 1, CONFIRMED: 2 } as const

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}

function boundedText(value: unknown, max: number) {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return normalized && normalized.length <= max ? normalized : null
}

export function normalizeMicrosoftVerificationTimestamp(value: unknown, now = new Date()): string | null {
  if (typeof value === 'string' && /[\u0000-\u001f\u007f]/.test(value)) return null
  const candidate = boundedText(value, 64)
  if (!candidate) return null
  const parsed = new Date(candidate)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== candidate) return null
  if (parsed.getTime() > now.getTime() + 5 * 60 * 1000) return null
  return candidate
}

function microsoftConsentUrl(value: unknown) {
  const candidate = boundedText(value, 2_000)
  if (!candidate) return null
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'login.microsoftonline.com' || parsed.username || parsed.password || parsed.port || parsed.hash) return null
    return parsed.toString()
  } catch {
    return null
  }
}

function microsoftDocumentationUrl(value: unknown) {
  const candidate = boundedText(value, 500)
  if (!candidate) return null
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'learn.microsoft.com' || parsed.username || parsed.password || parsed.port || parsed.hash) return null
    return parsed.toString()
  } catch {
    return null
  }
}

function boundedStringArray(value: unknown, count: number, max: number) {
  if (!Array.isArray(value) || value.length > count) return null
  const normalized = value.map((item) => boundedText(item, max)).filter((item): item is string => Boolean(item))
  return normalized.length === value.length ? normalized : null
}

function accessCapability(value: unknown): MicrosoftAccessCapability | null {
  const candidate = plainRecord(value)
  const key = boundedText(candidate?.key, 120)
  const workloadKey = boundedText(candidate?.workloadKey, 120)
  const label = boundedText(candidate?.label, 180)
  const tier = typeof candidate?.tier === 'string' && ['CORE', 'CAPABILITY_OPTIONAL', 'FALLBACK'].includes(candidate.tier)
    ? candidate.tier as MicrosoftAccessCapability['tier']
    : null
  const licensePrerequisite = typeof candidate?.licensePrerequisite === 'string' && ['NONE', 'ENTRA_ID_P1_OR_P2', 'ENTRA_ID_P2', 'SHAREPOINT_SERVICE_PLAN', 'EXCHANGE_SERVICE_PLAN', 'UNIFIED_AUDIT_ENABLED'].includes(candidate.licensePrerequisite)
    ? candidate.licensePrerequisite as MicrosoftAccessCapability['licensePrerequisite']
    : null
  const failureScope = typeof candidate?.failureScope === 'string' && ['DATASET_ONLY', 'WORKLOAD'].includes(candidate.failureScope)
    ? candidate.failureScope as MicrosoftAccessCapability['failureScope']
    : null
  const permissionMatch = candidate?.permissionMatch === undefined || candidate.permissionMatch === 'ALL'
    ? 'ALL' as const
    : candidate.permissionMatch === 'ANY' ? 'ANY' as const : null
  const evidenceMode = candidate?.evidenceMode === undefined || candidate.evidenceMode === 'RESOURCE_STATE'
    ? 'RESOURCE_STATE' as const
    : typeof candidate.evidenceMode === 'string' && ['COMPOSITE_RESOURCE_STATE', 'NOT_DURABLY_OBSERVED'].includes(candidate.evidenceMode)
      ? candidate.evidenceMode as MicrosoftAccessCapability['evidenceMode']
      : null
  const fallbackCapabilityKey = candidate?.fallbackCapabilityKey === null ? null : boundedText(candidate?.fallbackCapabilityKey, 120)
  const resourceTypes = boundedStringArray(candidate?.resourceTypes, 32, 120)
  const endpointPatterns = boundedStringArray(candidate?.endpointPatterns, 32, 500)
  const documentationUrl = microsoftDocumentationUrl(candidate?.documentationUrl)
  if (!candidate || !key || !workloadKey || !label || !tier || !permissionMatch || !evidenceMode || !licensePrerequisite || !failureScope || !resourceTypes || !endpointPatterns || !documentationUrl || !Array.isArray(candidate.applicationPermissions) || candidate.applicationPermissions.length > 32) return null
  if (candidate.fallbackCapabilityKey !== null && !fallbackCapabilityKey) return null
  const applicationPermissions: MicrosoftAccessCapability['applicationPermissions'] = []
  for (const rawPermission of candidate.applicationPermissions) {
    const permission = plainRecord(rawPermission)
    const name = boundedText(permission?.name, 160)
    const resource = typeof permission?.resource === 'string' && ['MICROSOFT_GRAPH', 'OFFICE_365_MANAGEMENT_API', 'EXCHANGE_ONLINE'].includes(permission.resource)
      ? permission.resource as MicrosoftAccessCapability['applicationPermissions'][number]['resource']
      : null
    if (!permission || !name || !resource) return null
    applicationPermissions.push({ resource, name })
  }
  const rawAlternatives = candidate.sourceAlternatives === undefined ? [] : candidate.sourceAlternatives
  if (!Array.isArray(rawAlternatives) || rawAlternatives.length > 16) return null
  const sourceAlternatives: MicrosoftAccessCapability['sourceAlternatives'] = []
  for (const rawAlternative of rawAlternatives) {
    const alternative = plainRecord(rawAlternative)
    const alternativeKey = boundedText(alternative?.key, 120)
    const alternativeLicense = typeof alternative?.licensePrerequisite === 'string' && ['NONE', 'ENTRA_ID_P1_OR_P2', 'ENTRA_ID_P2', 'SHAREPOINT_SERVICE_PLAN', 'EXCHANGE_SERVICE_PLAN', 'UNIFIED_AUDIT_ENABLED'].includes(alternative.licensePrerequisite)
      ? alternative.licensePrerequisite as MicrosoftAccessCapability['licensePrerequisite']
      : null
    const alternativeEndpoints = boundedStringArray(alternative?.endpointPatterns, 32, 500)
    const alternativeDocs = microsoftDocumentationUrl(alternative?.documentationUrl)
    if (!alternative || !alternativeKey || !alternativeLicense || !alternativeEndpoints || !alternativeDocs || !Array.isArray(alternative.applicationPermissions) || alternative.applicationPermissions.length > 16) return null
    const alternativePermissions: MicrosoftAccessCapability['applicationPermissions'] = []
    for (const rawPermission of alternative.applicationPermissions) {
      const permission = plainRecord(rawPermission)
      const name = boundedText(permission?.name, 160)
      const resource = typeof permission?.resource === 'string' && ['MICROSOFT_GRAPH', 'OFFICE_365_MANAGEMENT_API', 'EXCHANGE_ONLINE'].includes(permission.resource)
        ? permission.resource as MicrosoftAccessCapability['applicationPermissions'][number]['resource']
        : null
      if (!permission || !name || !resource) return null
      alternativePermissions.push({ resource, name })
    }
    sourceAlternatives.push({ key: alternativeKey, applicationPermissions: alternativePermissions, licensePrerequisite: alternativeLicense, endpointPatterns: alternativeEndpoints, documentationUrl: alternativeDocs })
  }
  return { key, workloadKey, label, tier, applicationPermissions, permissionMatch, evidenceMode, sourceAlternatives, licensePrerequisite, fallbackCapabilityKey, failureScope, resourceTypes, endpointPatterns, documentationUrl }
}

/** Strict API-boundary projection for the Microsoft consent preview. */
export function normalizeMicrosoftConsentReview(value: unknown): MicrosoftConsentReview | null {
  const candidate = plainRecord(value)
  const consentUrl = microsoftConsentUrl(candidate?.consentUrl)
  if (!candidate || !consentUrl || !Array.isArray(candidate.requiredPermissions) || candidate.requiredPermissions.length === 0 || candidate.requiredPermissions.length > 64) return null
  const requiredPermissions: MicrosoftConsentReview['requiredPermissions'] = []
  for (const rawPermission of candidate.requiredPermissions) {
    const permission = plainRecord(rawPermission)
    const name = boundedText(permission?.name, 160)
    const description = boundedText(permission?.description, 500)
    const resource = typeof permission?.resource === 'string' && ['MICROSOFT_GRAPH', 'OFFICE_365_MANAGEMENT_API', 'EXCHANGE_ONLINE'].includes(permission.resource)
      ? permission.resource as MicrosoftConsentReview['requiredPermissions'][number]['resource']
      : null
    const consentMode = typeof permission?.consentMode === 'string' && ['DEFAULT', 'SEPARATE_OPT_IN'].includes(permission.consentMode)
      ? permission.consentMode as MicrosoftConsentReview['requiredPermissions'][number]['consentMode']
      : null
    const tier = typeof permission?.tier === 'string' && ['CORE', 'CAPABILITY_OPTIONAL'].includes(permission.tier)
      ? permission.tier as MicrosoftConsentReview['requiredPermissions'][number]['tier']
      : null
    const rawPurpose = Array.isArray(permission?.purpose) ? permission.purpose : []
    const purpose = rawPurpose.slice(0, 32).map((item) => boundedText(item, 160)).filter((item): item is string => Boolean(item))
    if (!permission || permission.type !== 'APPLICATION' || typeof permission.connectionRequired !== 'boolean' || !name || !description || !resource || !consentMode || !tier || rawPurpose.length > 32 || purpose.length !== rawPurpose.length) return null
    requiredPermissions.push({ name, description, resource, type: 'APPLICATION', consentMode, tier, connectionRequired: permission.connectionRequired, purpose })
  }
  return { consentUrl, requiredPermissions }
}

export function normalizeMicrosoftAccessCatalog(value: unknown): MicrosoftAccessCatalog | null {
  const candidate = plainRecord(value)
  if (!candidate || candidate.version !== 1 || !Array.isArray(candidate.requestedPermissions) || !Array.isArray(candidate.connectionRequiredPermissions) || !Array.isArray(candidate.capabilities) || candidate.capabilities.length === 0 || candidate.capabilities.length > 128) return null
  const review = normalizeMicrosoftConsentReview({ consentUrl: 'https://login.microsoftonline.com/organizations/v2.0/adminconsent', requiredPermissions: candidate.requestedPermissions })
  const required = candidate.connectionRequiredPermissions.slice(0, 64).map((item) => boundedText(item, 160)).filter((item): item is string => Boolean(item))
  if (!review || candidate.connectionRequiredPermissions.length > 64 || required.length !== candidate.connectionRequiredPermissions.length) return null
  const requestedNames = new Set(review.requiredPermissions.map((permission) => permission.name))
  if (required.some((permission) => !requestedNames.has(permission))) return null
  const requiredSet = new Set(required)
  if (review.requiredPermissions.some((permission) => permission.connectionRequired !== requiredSet.has(permission.name))) return null
  const capabilities = candidate.capabilities.map(accessCapability).filter((item): item is MicrosoftAccessCapability => Boolean(item))
  if (capabilities.length !== candidate.capabilities.length || new Set(capabilities.map((item) => item.key)).size !== capabilities.length) return null
  const knownPermissions = new Set(review.requiredPermissions.map((permission) => `${permission.resource}:${permission.name}`))
  for (const capability of capabilities) {
    for (const permission of capability.applicationPermissions) {
      // Exchange Admin is intentionally a separate opt-in and not part of the
      // one-click default permission registry.
      if (permission.resource === 'EXCHANGE_ONLINE' && permission.name === 'Exchange.ManageAsAppV2') continue
      if (!knownPermissions.has(`${permission.resource}:${permission.name}`)) return null
    }
  }
  return { version: 1, requestedPermissions: review.requiredPermissions, connectionRequiredPermissions: required, capabilities }
}

/**
 * Joins dynamic dataset evidence to the exact static capability catalog key.
 * Static labels and requirements are never inferred from a missing join.
 */
export function microsoftAccessDatasetView(dataset: AccessDatasetReadiness, catalog: MicrosoftAccessCatalog | null): AccessDatasetReadiness | null {
  const capability = catalog?.capabilities.find((entry) => entry.key === dataset.key)
  if (!capability) return null
  const datasetPermissions = new Map(dataset.permissions.map((permission) => [`${permission.resource}:${permission.name}`, permission]))
  const permissions: AccessDatasetReadiness['permissions'] = []
  for (const permission of capability.applicationPermissions) {
    const dynamic = datasetPermissions.get(`${permission.resource}:${permission.name}`)
    if (!dynamic) return null
    permissions.push({ ...permission, type: 'APPLICATION', consentMode: dynamic.consentMode, grantStatus: dynamic.grantStatus })
  }
  return {
    ...dataset,
    label: capability.label,
    tier: capability.tier,
    permissions,
    permissionMatch: capability.permissionMatch,
    evidenceMode: capability.evidenceMode,
    licensePrerequisite: { kind: capability.licensePrerequisite, state: dataset.licensePrerequisite.state },
    fallbackDatasetKey: capability.fallbackCapabilityKey,
    failureScope: capability.failureScope,
    resourceTypes: [...capability.resourceTypes],
    endpointPatterns: [...capability.endpointPatterns],
    documentationUrl: capability.documentationUrl,
  }
}

function requirement(tier: AccessDatasetReadiness['tier']): MicrosoftAccessPermissionView['requirement'] {
  if (tier === 'CORE') return 'Core dataset'
  if (tier === 'CAPABILITY_OPTIONAL') return 'Optional enrichment'
  return 'Fallback path'
}

function service(resource: AccessDatasetReadiness['permissions'][number]['resource']): MicrosoftAccessPermissionView['service'] {
  if (resource === 'OFFICE_365_MANAGEMENT_API') return 'Office 365 Management API'
  if (resource === 'EXCHANGE_ONLINE') return 'Exchange Online'
  return 'Microsoft Graph'
}

function status(value: AccessDatasetReadiness['permissionStatus']): MicrosoftAccessPermissionView['status'] {
  if (value === 'CONFIRMED') return 'Granted'
  if (value === 'MISSING') return 'Missing'
  return 'Not verified'
}

/**
 * Projects the server-owned access contract into one deterministic permission
 * table. It never falls back to the legacy tenant permission arrays because
 * those arrays cannot describe dataset requirement tiers or fallback paths.
 */
export function microsoftAccessSummary(readiness: CollectionReadinessView | null, catalog: MicrosoftAccessCatalog | null = null): MicrosoftAccessSummary {
  const unavailable: MicrosoftAccessSummary = {
    contractAvailable: false,
    connectionRequired: 0,
    core: 0,
    optional: 0,
    fallback: 0,
    alternative: 0,
    granted: 0,
    missingConnectionRequired: 0,
    missingCore: 0,
    missingOptional: 0,
    unverified: 0,
    permissions: [],
  }
  if (!readiness || readiness.accessContractVersion !== 1) {
    return unavailable
  }

  type Working = {
    permission: AccessDatasetReadiness['permissions'][number]
    tier: AccessDatasetReadiness['tier']
    grantStatus: AccessDatasetReadiness['permissions'][number]['grantStatus']
    alternativeOnly: boolean
    datasetLabels: Set<string>
    documentationUrl: string
  }
  const byKey = new Map<string, Working>()
  let unjoinedDataset = false
  for (const workload of readiness.workloads) {
    for (const rawDataset of workload.datasets) {
      const dataset = catalog ? microsoftAccessDatasetView(rawDataset, catalog) : rawDataset
      if (!dataset) {
        unjoinedDataset = true
        continue
      }
      for (const permission of dataset.permissions) {
        const key = `${permission.resource}:${permission.name}:${permission.consentMode}`
        const existing = byKey.get(key)
        if (!existing) {
          byKey.set(key, {
            permission,
            tier: dataset.tier,
            grantStatus: permission.grantStatus,
            alternativeOnly: dataset.permissionMatch === 'ANY',
            datasetLabels: new Set([dataset.label]),
            documentationUrl: dataset.documentationUrl,
          })
          continue
        }
        existing.datasetLabels.add(dataset.label)
        if (dataset.permissionMatch !== 'ANY') existing.alternativeOnly = false
        if (TIER_ORDER[dataset.tier] < TIER_ORDER[existing.tier]) existing.tier = dataset.tier
        if (STATUS_ORDER[permission.grantStatus] < STATUS_ORDER[existing.grantStatus]) {
          existing.grantStatus = permission.grantStatus
        }
      }
    }
  }
  if (unjoinedDataset) return unavailable

  const catalogByKey = new Map((catalog?.requestedPermissions ?? []).map((permission) => [`${permission.resource}:${permission.name}:${permission.consentMode}`, permission]))
  const connectionRequired = new Set(catalog?.connectionRequiredPermissions ?? [])
  const permissions = Array.from(byKey.entries()).map(([key, item]) => {
    const affectedDatasets = Array.from(item.datasetLabels).sort().slice(0, 16)
    const catalogPermission = catalogByKey.get(key)
    return {
      key,
      name: item.permission.name,
      service: service(item.permission.resource),
      type: 'Application' as const,
      requirement: connectionRequired.has(item.permission.name) ? 'Connection required' as const : item.alternativeOnly ? 'Alternative source' as const : requirement(item.tier),
      status: status(item.grantStatus),
      consentMode: item.permission.consentMode === 'SEPARATE_OPT_IN' ? 'Separate opt-in' as const : 'Default consent' as const,
      purpose: catalogPermission?.description ?? `Used by: ${affectedDatasets.join(', ')}.`,
      documentationUrl: item.documentationUrl,
      affectedDatasets,
    }
  }).sort((left, right) => {
    const requirementDiff = ['Connection required', 'Core dataset', 'Optional enrichment', 'Alternative source', 'Fallback path'].indexOf(left.requirement)
      - ['Connection required', 'Core dataset', 'Optional enrichment', 'Alternative source', 'Fallback path'].indexOf(right.requirement)
    return requirementDiff || left.service.localeCompare(right.service) || left.name.localeCompare(right.name)
  })

  return {
    contractAvailable: true,
    connectionRequired: permissions.filter((item) => item.requirement === 'Connection required').length,
    core: permissions.filter((item) => item.requirement === 'Core dataset').length,
    optional: permissions.filter((item) => item.requirement === 'Optional enrichment').length,
    fallback: permissions.filter((item) => item.requirement === 'Fallback path').length,
    alternative: permissions.filter((item) => item.requirement === 'Alternative source').length,
    granted: permissions.filter((item) => item.status === 'Granted').length,
    missingConnectionRequired: permissions.filter((item) => item.requirement === 'Connection required' && item.status === 'Missing').length,
    missingCore: permissions.filter((item) => item.requirement === 'Core dataset' && item.status === 'Missing').length,
    missingOptional: permissions.filter((item) => item.requirement !== 'Connection required' && item.requirement !== 'Core dataset' && item.status === 'Missing').length,
    unverified: permissions.filter((item) => item.status === 'Not verified').length,
    permissions,
  }
}

export function datasetTierLabel(tier: AccessDatasetReadiness['tier']) {
  return requirement(tier)
}

export function datasetStateNeedsTenantAction(dataset: AccessDatasetReadiness) {
  return dataset.tier === 'CORE' && ['BLOCKED_PERMISSION', 'BLOCKED_TENANT_CONFIGURATION'].includes(dataset.state)
}
