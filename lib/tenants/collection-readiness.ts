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
const CLOSED_UNKNOWN_STATE: ReadinessState = 'UNSUPPORTED'
const READINESS_ORDER: Record<ReadinessState, number> = {
  BLOCKED_PERMISSION: 0, BLOCKED_TENANT_CONFIGURATION: 1, NOT_LICENSED: 3,
  UNSUPPORTED: 2, FAILED_TRANSIENT: 4, STALE: 5, BACKLOGGED: 6, PARTIAL: 7,
  UNVERIFIED: 8, INITIALIZING: 9, NEVER_SUCCEEDED: 10, READY: 11,
}

export type CollectionReadinessView = {
  overallState: ReadinessState
  evaluatedAt: string | null
  reasonCode: string | null
  reason: string | null
  remediation: string | null
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

export function normalizeCollectionReadiness(value: unknown): CollectionReadinessView | null {
  const candidate = record(value)
  if (!candidate || !Array.isArray(candidate.workloads)) return null
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
        remediation: 'Refresh the tenant data after the service reports a valid readiness response.', components: [], exchangeRbac: null,
      })
      continue
    }
    const requiredPermissions = Array.isArray(row.requiredPermissions)
      ? row.requiredPermissions.slice(0, 16).map((permission) => text(permission, 160)).filter((permission): permission is string => Boolean(permission))
      : []
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
    const rowCandidate = { state: rowState, reasonCode: text(row.reasonCode, 120), reason: text(row.reason), remediation }
    const selected = components.reduce<typeof rowCandidate | CollectionReadinessView['workloads'][number]['components'][number]>((worst, candidate) => {
      return READINESS_ORDER[candidate.state] < READINESS_ORDER[worst.state] ? candidate : worst
    }, rowCandidate)
    const selectedComponent = 'label' in selected ? selected : null
    workloads.push({
      key,
      workload,
      state: selected.state,
      configuredCapability,
      permissionStatus,
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
      components,
      exchangeRbac: rbacState && rbacStatus && rbacReason ? { status: rbacStatus, state: rbacState, reason: rbacReason } : null,
    })
  }
  if (rawWorkloads.length > 64) {
    workloads.push({
      key: 'invalid_readiness_data', workload: 'Readiness data validation', state: 'UNSUPPORTED',
      configuredCapability: 'UNVERIFIED', permissionStatus: 'UNVERIFIED', requiredPermissions: [],
      lastAttemptAt: null, lastSuccessfulAt: null, freshness: 'UNKNOWN', reasonCode: 'READINESS_ROW_LIMIT_EXCEEDED', reason: 'HawkView received more readiness rows than this bounded contract permits.', lastVerifiedAt: null,
      remediation: 'Refresh the tenant data after the service reports a valid readiness response.', components: [], exchangeRbac: null,
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
  return { overallState: overall?.state ?? 'UNSUPPORTED', evaluatedAt: timestamp(candidate.evaluatedAt), reasonCode: overall?.reasonCode ?? null, reason: overall?.reason ?? null, remediation: overall?.remediation ?? null, workloads: normalizedWorkloads }
}

export function readinessLabel(value: string) {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase())
}
