import { createHash } from 'node:crypto'
import { PIM_SCHEDULE_ACCESS_CAPABILITIES } from '../microsoft/microsoft-access-contract.js'
import type { EntraCollectionLimits } from './microsoft-collection-budget.js'
import type { JsonValue, PimPlane } from './pim-schedule-observation.js'

export type { JsonValue, PimPlane }
// Source entry points only. No route, worker, scheduler or production caller is registered.
export const PIM_PRODUCTION_ACTIVATION = false
export const PIM_PROJECTION = 'bare-get:v1:no-select:no-expand:no-top'
export const PIM_ENDPOINTS = {
  ACTIVE: PIM_SCHEDULE_ACCESS_CAPABILITIES.ACTIVE.endpoint,
  ELIGIBLE: PIM_SCHEDULE_ACCESS_CAPABILITIES.ELIGIBLE.endpoint,
} as const

/** Required caller policy, never populated from fixtures or production defaults. */
export interface PimLimits extends EntraCollectionLimits {
  wireBytes: number
  requests: number
  retryAttempts: number
  retryDelayMs: number
  maxConflictVersions: number
  maxConflictEvidenceBytes: number
}
export function copyPimLimits(input: PimLimits): Readonly<PimLimits> {
  const positive = ['pages', 'pageBytes', 'materializedBytes', 'requestTimeoutMs', 'collectorDeadlineMs',
    'wireBytes', 'requests', 'retryDelayMs', 'maxConflictVersions'] as const
  const zeroAllowed = ['rows', 'retryAttempts', 'maxConflictEvidenceBytes'] as const
  if (!input || [...positive, ...zeroAllowed].some(k => !Number.isSafeInteger(input[k]) || input[k] < 0)
    || positive.some(k => input[k] === 0)
    || input.requestTimeoutMs > 2_147_483_647 || input.collectorDeadlineMs > 2_147_483_647
    || input.retryDelayMs > 2_147_483_647) throw new Error('INVALID_PIM_LIMITS')
  return Object.freeze(Object.fromEntries([...positive, ...zeroAllowed].map(k => [k, input[k]])) as unknown as PimLimits)
}
export function pimLifetime(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 2_147_483_647) throw new Error('INVALID_PIM_ATTEMPT_LIFETIME')
  return ms
}
export function pimUuid(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('INVALID_PIM_ID')
  }
  return value.toLowerCase()
}
export function pimPlane(plane: PimPlane): PimPlane {
  if (plane !== 'ACTIVE' && plane !== 'ELIGIBLE') throw new Error('INVALID_PIM_PLANE')
  return plane
}
export function pimVersion(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('INVALID_PIM_SCOPE_VERSION')
  return value
}
export interface PimTenant { organizationId: string; customerTenantId: string; microsoftTenantId: string }
export interface PimIdentity extends PimTenant { configurationRevision: string; plane: PimPlane }
export interface PimContext extends PimIdentity {
  connectionIncarnation: string
  scopeId: string
  scopeIncarnation: string
  scopeVersion: string
  endpointDescriptor: string
  projectionIdentity: string
}
export interface PimAttempt extends PimContext { attemptId: string; startedAt: Date; expiresAt: Date }
export function copyPimTenant(v: PimTenant): PimTenant {
  return { organizationId: pimUuid(v.organizationId), customerTenantId: pimUuid(v.customerTenantId),
    microsoftTenantId: pimUuid(v.microsoftTenantId) }
}
export function copyPimContext(v: PimContext): PimContext {
  const plane = pimPlane(v.plane)
  if (v.endpointDescriptor !== PIM_ENDPOINTS[plane] || v.projectionIdentity !== PIM_PROJECTION) throw new Error('INVALID_PIM_PROJECTION')
  return Object.freeze({ ...copyPimTenant(v), configurationRevision: pimUuid(v.configurationRevision), plane,
    connectionIncarnation: pimUuid(v.connectionIncarnation), scopeId: pimUuid(v.scopeId),
    scopeIncarnation: pimUuid(v.scopeIncarnation), scopeVersion: pimVersion(v.scopeVersion),
    endpointDescriptor: v.endpointDescriptor, projectionIdentity: v.projectionIdentity })
}
export function copyPimAttempt(v: PimAttempt): PimAttempt {
  const startedAt = new Date(v.startedAt), expiresAt = new Date(v.expiresAt)
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || expiresAt <= startedAt) throw new Error('INVALID_PIM_CLOCK')
  return { ...copyPimContext(v), attemptId: pimUuid(v.attemptId), startedAt, expiresAt }
}
export type PimRejection = { status: 'rejected'; reason: 'SUPERSEDED' | 'INCARNATION_CHANGED' |
  'SCOPE_REPLACED' | 'TENANT_MISMATCH' | 'PLANE_MISMATCH' | 'PROJECTION_CHANGED' |
  'EXPIRED' | 'BUSY' | 'UNAVAILABLE' | 'CONFLICT' }
export const pimRejected = (reason: PimRejection['reason']): PimRejection => ({ status: 'rejected', reason })
export const PIM_FAILURES = ['INVALID_JSON', 'INVALID_ENVELOPE', 'INVALID_CONTINUATION', 'CONTEXT_CHANGED',
  'CAPACITY', 'DEADLINE', 'PROVIDER_FAILED', 'THROTTLED', 'INVALID_OBSERVATIONS'] as const
export type PimFailureKind = typeof PIM_FAILURES[number]
export type PimTerminalTraversal = 'TRUNCATED_BUDGET' | 'TRUNCATED_DEADLINE' | 'ERRORED'
export interface ParsedEnvelope { pageIndex: number; requestedToken: string; envelope: JsonValue; byteLength: number }
export interface WireFailure { pageIndex: number; byteLength: number; failureKind: 'INVALID_JSON' }
export interface ParsedObservationRow {
  occurrenceOrdinal: number; instanceId: string | null; plane: PimPlane; raw: JsonValue
  observations: JsonValue; diagnostics: JsonValue
  providerStartDateTime: Date | null; providerEndDateTime: Date | null
}
export interface PreparedPimCollection {
  envelopes: readonly ParsedEnvelope[]; rows: readonly ParsedObservationRow[]
  traversalOutcome: 'EXHAUSTED'; contentDigest: string
}
export interface PimFailure {
  failureKind: PimFailureKind; traversalOutcome: PimTerminalTraversal
  envelopes: readonly ParsedEnvelope[]; wireFailures: readonly WireFailure[]
}
export interface PimReceipt extends PimAttempt {
  committedAt: Date; contentChangedAt: Date; contentDigest: string; observedRowCount: number
  traversalOutcome: 'EXHAUSTED'; assurance: 'UNKNOWN'; coverage: 'NOT_ESTABLISHED'
}

/** Canonical parsed JSON, not a wire archive. Iterative validation never calls toJSON/getters.
 * Like the existing normalizer, this boundary accepts ordinary data, not proxies. */
export function pimJsonText(value: unknown, maximumBytes: number): string {
  type Task = { value: unknown } | { text: string } | { leave: object }
  const tasks: Task[] = [{ value }], ancestors = new Set<object>(), chunks: string[] = []
  let bytes = 0
  while (tasks.length) {
    const t = tasks.pop()!
    if ('leave' in t) { ancestors.delete(t.leave); continue }
    if ('text' in t) {
      bytes += Buffer.byteLength(t.text)
      if (bytes > maximumBytes) throw new Error('PIM_PAYLOAD_LIMIT')
      chunks.push(t.text); continue
    }
    const v = t.value
    if (v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) {
      if (typeof v === 'string' && v.length > maximumBytes - bytes) throw new Error('PIM_PAYLOAD_LIMIT')
      tasks.push({ text: Object.is(v, -0) ? '-0' : JSON.stringify(v) }); continue
    }
    if (typeof v !== 'object' || ancestors.has(v)) throw new Error('INVALID_PIM_JSON')
    const array = Array.isArray(v), descriptors = Object.getOwnPropertyDescriptors(v)
    if (!array && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('INVALID_PIM_JSON')
    const keys = Reflect.ownKeys(v).filter(k => !array || k !== 'length')
    if (keys.some(k => typeof k !== 'string') || (array && (keys.length !== v.length || keys.some((k, i) => k !== String(i))))) throw new Error('INVALID_PIM_JSON')
    const names = keys as string[]
    if (names.some(k => !descriptors[k].enumerable || !Object.hasOwn(descriptors[k], 'value'))) throw new Error('INVALID_PIM_JSON')
    if (!array) names.sort()
    ancestors.add(v); tasks.push({ leave: v }, { text: array ? ']' : '}' })
    for (let i = names.length - 1; i >= 0; i--) {
      const k = names[i]; tasks.push({ value: descriptors[k].value })
      if (!array) tasks.push({ text: JSON.stringify(k) + ':' })
      if (i > 0) tasks.push({ text: ',' })
    }
    tasks.push({ text: array ? '[' : '{' })
  }
  return chunks.join('')
}
export function pimDigest(plane: PimPlane, rows: readonly ParsedObservationRow[], maximumBytes: number): string {
  return createHash('sha256').update(pimJsonText({ plane, records: rows.map(r => r.raw) }, maximumBytes)).digest('hex')
}
