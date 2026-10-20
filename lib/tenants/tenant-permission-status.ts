import type { Tenant } from '../../types/api.ts'
import { normalizeCollectionReadiness } from './collection-readiness.ts'

export type TenantPermissionStatus = {
  label: string
  detail: string
  tone: 'ok' | 'attention' | 'neutral'
  missing: string[]
  optional: string[]
}

const unavailable = (detail: string): TenantPermissionStatus => ({
  label: 'Permission check unavailable',
  detail,
  tone: 'neutral',
  missing: [],
  optional: [],
})

/** Only verified, required grants become directory-level permission alerts.
 * Optional capabilities, licensing, and collector freshness have their own
 * evidence paths and must not be translated into a broken permission. */
export function tenantPermissionStatus(tenant: Pick<Tenant,
  'status' | 'connectionStatus' | 'connectionErrorCode' | 'missingRequiredPermissions' | 'collectionReadiness'
>): TenantPermissionStatus {
  const verifiedMissingConnectionGrant = tenant.connectionStatus === 'error' &&
    tenant.connectionErrorCode === 'missing-permissions' &&
    Array.isArray(tenant.missingRequiredPermissions) && tenant.missingRequiredPermissions.length > 0
  if (!verifiedMissingConnectionGrant && (tenant.status !== 'active' || tenant.connectionStatus !== 'connected')) {
    return unavailable('Tenant access is not currently connected, so the required permission check cannot be treated as current. Review tenant settings for the connection cause.')
  }

  const readiness = normalizeCollectionReadiness(tenant.collectionReadiness)
  if (readiness?.accessContractVersion !== 1 || !readiness.permissionVerifiedAt ||
      !Array.isArray(tenant.missingRequiredPermissions)) {
    return unavailable('The tenant list has no verified, versioned permission result. This is not evidence that grants are present or missing.')
  }

  const missing = new Map<string, string>()
  const optional = new Map<string, string>()
  const addName = (target: Map<string, string>, name: unknown) => {
    if (typeof name !== 'string') return
    const trimmed = name.trim()
    if (trimmed) target.set(trimmed.toLowerCase(), trimmed)
  }
  tenant.missingRequiredPermissions.forEach((name) => addName(missing, name))

  let coreUnverified = false
  let applicableCoreCount = 0
  let unnamedCoreGap = false
  const blockedRequired = new Set<string>()
  for (const workload of readiness.workloads) {
    const byKey = new Map(workload.datasets.map((dataset) => [dataset.key, dataset]))
    for (const dataset of workload.datasets) {
      if (dataset.licensePrerequisite.state === 'NOT_LICENSED') continue
      if (dataset.tier === 'CAPABILITY_OPTIONAL' && dataset.permissionStatus === 'MISSING') {
        dataset.permissions.filter((permission) => permission.grantStatus === 'MISSING')
          .forEach((permission) => addName(optional, permission.name))
      }
      if (dataset.tier !== 'CORE') continue
      applicableCoreCount += 1
      const fallback = dataset.fallbackDatasetKey ? byKey.get(dataset.fallbackDatasetKey) : null
      const effective = dataset.state !== 'READY' && fallback?.state === 'READY' ? fallback : dataset
      if (effective.permissionStatus === 'UNVERIFIED') coreUnverified = true
      // A collector can receive an access-denied response even when a prior
      // grant check found the application permission. Do not name a missing
      // grant from that response; show the affected required dataset instead.
      if (effective.state === 'BLOCKED_PERMISSION' && effective.permissionStatus !== 'MISSING') {
        blockedRequired.add(effective.label)
      }
      if (effective.permissionStatus !== 'MISSING') continue
      const names = effective.permissions.filter((permission) => permission.grantStatus === 'MISSING')
      if (names.length === 0) unnamedCoreGap = true
      names.forEach((permission) => addName(missing, permission.name))
    }
  }

  const names = Array.from(missing.values()).sort((a, b) => a.localeCompare(b))
  const optionalNames = Array.from(optional.values()).sort((a, b) => a.localeCompare(b))
  if (names.length || unnamedCoreGap) {
    const count = names.length
    return {
      label: count ? `${count} required permission${count === 1 ? '' : 's'} missing` : 'Required permission gap',
      detail: `${count ? `Missing: ${names.join(', ')}.` : 'A required dataset reports a permission gap without a named grant.'} Last permission verification: ${readiness.permissionVerifiedAt}. Optional grants, collection failures and licensing are assessed separately.`,
      tone: 'attention',
      missing: names,
      optional: optionalNames,
    }
  }
  if (blockedRequired.size) {
    const labels = Array.from(blockedRequired).sort((a, b) => a.localeCompare(b))
    return {
      label: 'Required access blocked',
      detail: `Microsoft access was denied for: ${labels.join(', ')}. The last grant check did not identify a specific missing permission; review the dataset cause before changing consent. Collection freshness and licensing are separate.`,
      tone: 'attention',
      missing: [],
      optional: optionalNames,
    }
  }
  if (coreUnverified) {
    return unavailable('One or more required datasets lack verified permission evidence. No missing grant is confirmed; collection freshness and licensing are separate.')
  }
  if (!applicableCoreCount) {
    return unavailable('No applicable required dataset supplied a permission result. Optional capability grants alone do not establish required access.')
  }
  return {
    label: 'No required permission gap',
    detail: `No required Microsoft permission gap was reported at the last verification (${readiness.permissionVerifiedAt}). Optional grants and current collector outcomes are separate; this is not a complete-data or tenant-health claim.`,
    tone: 'ok',
    missing: [],
    optional: optionalNames,
  }
}
