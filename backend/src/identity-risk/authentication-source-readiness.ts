import { normalizeAuthenticationRecord, type AuthEvaluationInput, type AuthScope, type AuthSource } from '../risky-users-auth/index.js'
import { canonicalAddress } from '../risky-users-auth/normalize.js'
import { assessmentReason, AUTH_COLLECTION_MAX_AGE_MS } from './risk-assessment-projection.js'
import type { RiskAssessmentReason, RiskSourceReadinessDto } from './identity-risk-assessment.contract.js'
export const AUTH_WINDOW_SCHEMA = 'hawkview-authentication-window/v1'
export type AuthenticationWindow = { schemaVersion: typeof AUTH_WINDOW_SCHEMA; source: AuthSource; start: string; end: string; paginationComplete: boolean }
export type AuthenticationProof = { status: string; lastSuccessfulAt: Date | null; lastAttemptAt: Date | null; lastErrorCode: string | null }
export type AuthenticationRow = { organizationId: string; customerTenantId: string; raw: unknown; ingestedAt: Date }
export type AuthenticationDirectoryUser = { organizationId: string; customerTenantId: string; microsoftUserId: string; userPrincipalName: string; userType: string | null }
export type AuthenticationReference = (kind: 'subject' | 'application' | 'evidence' | 'context', identifiers: readonly string[]) => Promise<string>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FALLBACK = /^sign-ins-(non-premium|premium-graph|entitlement-unverified)-fallback-active(?:-geolocation-partial)?$/
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every(key => typeof key === 'string' && !['__proto__','prototype','constructor'].includes(key) && 'value' in Object.getOwnPropertyDescriptor(value,key)!)
const date = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime())
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
export function authenticationWindow(value: unknown): AuthenticationWindow | null {
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'end,paginationComplete,schemaVersion,source,start' || value.schemaVersion !== AUTH_WINDOW_SCHEMA ||
    !['M365_AUDIT_STS', 'GRAPH_SIGN_INS'].includes(value.source as string) || typeof value.paginationComplete !== 'boolean' || !iso(value.start) || !iso(value.end) || value.start > value.end ||
    Date.parse(value.end) - Date.parse(value.start) > 24 * 60 * 60_000) return null
  return value as AuthenticationWindow
}
export function mergeAuthenticationWindow(previous: unknown, source: AuthSource, start: Date, end: Date, completedPageChain: boolean): AuthenticationWindow {
  if (completedPageChain !== true || !date(start) || !date(end) || start > end) throw new Error('IDENTITY_AUTH_WINDOW_INVALID')
  const prior = authenticationWindow(previous)
  if (prior && Date.parse(prior.end) > end.getTime()) throw new Error('IDENTITY_AUTH_WINDOW_SUPERSEDED')
  const from = prior?.paginationComplete === true && prior.source === source && Date.parse(prior.end) >= start.getTime() && Date.parse(prior.end) <= end.getTime()
    ? Math.min(Date.parse(prior.start), start.getTime()) : start.getTime()
  return { schemaVersion: AUTH_WINDOW_SCHEMA, source, start: new Date(Math.max(from, end.getTime() - 24 * 60 * 60_000)).toISOString(), end: end.toISOString(), paginationComplete: true }
}
export function selectedAuthenticationSource(proof: AuthenticationProof | null): AuthSource | null {
  if (proof?.status === 'SUCCEEDED' && proof.lastErrorCode === null) return 'GRAPH_SIGN_INS'
  if (proof?.status === 'RUNNING' && FALLBACK.test(proof.lastErrorCode ?? '')) return 'M365_AUDIT_STS'
  return null
}
export function unavailableAuthenticationSource(source: AuthSource, reason: RiskAssessmentReason = 'WAITING_FOR_COLLECTION'): RiskSourceReadinessDto {
  const status = reason === 'MISSING_PERMISSION' ? 'MISSING_PERMISSION' : reason === 'LICENSE_REQUIRED' ? 'LICENSE_REQUIRED'
    : reason === 'COLLECTION_STALE' ? 'STALE' : reason === 'COLLECTION_FAILED' || reason === 'EVALUATION_FAILED' || reason === 'KEY_UNAVAILABLE' ? 'FAILED'
    : reason === 'EVALUATION_DISABLED' ? 'DISABLED'
    : reason === 'CAPACITY_LIMIT' || reason === 'INCOMPLETE_WINDOW' ? 'PARTIAL' : reason === 'USER_BINDING_UNRESOLVED' ? 'INSUFFICIENT_FIELDS' : 'WAITING'
  return { source, status, reasonCode: reason, explanation: assessmentReason(reason), window: { start: null, end: null },
    lastSuccessfulCollectionAt: null, latestEventAt: null, latestIngestionAt: null, freshness: 'UNKNOWN' }
}
export async function prepareAuthenticationEvaluation(scope: AuthScope, rows: readonly AuthenticationRow[], directory: readonly AuthenticationDirectoryUser[], proof: AuthenticationProof | null,
  window: AuthenticationWindow | null, directoryReady: boolean, asOf: Date, reference: AuthenticationReference) {
  const selected = selectedAuthenticationSource(proof)
  const disputedEventIds: string[] = []
  const sources = (['GRAPH_SIGN_INS', 'M365_AUDIT_STS'] as const).map(source => unavailableAuthenticationSource(source))
  const fail = (reason: RiskAssessmentReason) => ({ input: null as AuthEvaluationInput | null,
    sources: sources.map(source => unavailableAuthenticationSource(source.source as AuthSource, reason)), resolvedSubjects: [] as { subjectRef: string; microsoftUserId: string }[], disputedEventIds })
  if (proof?.lastErrorCode === 'MICROSOFT_PERMISSION_REQUIRED') return fail('MISSING_PERMISSION')
  if (proof?.lastErrorCode === 'MICROSOFT_LICENSE_REQUIRED') return fail('LICENSE_REQUIRED')
  if (!date(asOf) || !date(proof?.lastSuccessfulAt)) return fail(proof?.status === 'FAILED' ? 'COLLECTION_FAILED' : 'WAITING_FOR_COLLECTION')
  if (!selected || (proof?.lastAttemptAt && (!date(proof.lastAttemptAt) || proof.lastAttemptAt > proof.lastSuccessfulAt))) return fail('COLLECTION_FAILED')
  if (proof.lastSuccessfulAt > asOf || asOf.getTime() - proof.lastSuccessfulAt.getTime() > AUTH_COLLECTION_MAX_AGE_MS) return fail('COLLECTION_STALE')
  if (!directoryReady) return fail('USER_BINDING_UNRESOLVED')
  if (rows.length > 10_000 || directory.length > 5000) return fail('CAPACITY_LIMIT')
  if (!window || window.source !== selected || Date.parse(window.end) > proof.lastSuccessfulAt.getTime()) return fail('INCOMPLETE_WINDOW')
  if (asOf.getTime() - Date.parse(window.end) > AUTH_COLLECTION_MAX_AGE_MS) return fail('COLLECTION_STALE')
  const usersById = new Map<string, AuthenticationDirectoryUser[]>()
  const usersByUpn = new Map<string, AuthenticationDirectoryUser[]>()
  for (const user of directory) {
    if (user.organizationId !== scope.organizationId || user.customerTenantId !== scope.customerTenantId) throw new Error('IDENTITY_AUTH_SCOPE_INVALID')
    if (!UUID.test(user.microsoftUserId) || typeof user.userPrincipalName !== 'string' || user.userPrincipalName.length > 320 ||
      !['Member', 'Guest'].includes(user.userType ?? '')) continue
    usersById.set(user.microsoftUserId.toLowerCase(), [...usersById.get(user.microsoftUserId.toLowerCase()) ?? [], user])
    const upn = user.userPrincipalName.trim().toLowerCase()
    usersByUpn.set(upn, [...usersByUpn.get(upn) ?? [], user])
  }
  const events: AuthEvaluationInput['events'][number][] = []
  const resolved = new Map<string, string>()
  let gaps = 0
  let latestEvent: string | null = null
  let latestIngestion: string | null = null
  const refCache = new Map<string, string>()
  const managed = async (kind: 'subject' | 'application', id: string) => {
    const key = `${kind}:${id.toLowerCase()}`
    const prior = refCache.get(key); if (prior) return prior
    const value = await reference(kind, [scope.organizationId, scope.customerTenantId, scope.microsoftTenantId, id.toLowerCase()])
    if (!new RegExp(`^hvr1_${kind}_[a-f0-9]{64}$`).test(value)) throw new Error('IDENTITY_AUTH_REFERENCE_INVALID')
    refCache.set(key, value); return value
  }
  for (const row of rows) {
    if (row.organizationId !== scope.organizationId || row.customerTenantId !== scope.customerTenantId) throw new Error('IDENTITY_AUTH_SCOPE_INVALID')
    if (!plain(row.raw) || !date(row.ingestedAt) || row.ingestedAt > asOf) { gaps++; continue }
    const source = row.raw.hawkviewSource === 'MICROSOFT_365_MANAGEMENT_ACTIVITY' ? 'M365_AUDIT_STS'
      : row.raw.hawkviewSource === undefined ? 'GRAPH_SIGN_INS' : null
    if (source === null) { gaps++; continue }
    if (source !== selected) continue // Never pool independent feeds.
    const raw = selected === 'M365_AUDIT_STS' ? row.raw.managementActivityRecord : row.raw
    if (!plain(raw)) { gaps++; continue }
    if (row.raw.hawkviewAuthenticationIntegrity !== undefined) {
      const id = raw[selected === 'M365_AUDIT_STS' ? 'Id' : 'id']
      if (typeof id === 'string' && id.length > 0 && id.length <= 512 && !/[\p{Cc}\p{Cf}]/u.test(id)) disputedEventIds.push(id)
      gaps++; continue
    }
    const rawUser = raw[selected === 'M365_AUDIT_STS' ? 'UserId' : 'userId']
    const appId = raw[selected === 'M365_AUDIT_STS' ? 'ApplicationId' : 'appId']
    const match = typeof rawUser === 'string' ? (selected === 'M365_AUDIT_STS' ? usersByUpn.get(rawUser.trim().toLowerCase()) : usersById.get(rawUser.toLowerCase())) : undefined
    if (!match || match.length !== 1 || typeof rawUser !== 'string' || typeof appId !== 'string' || !UUID.test(appId)) { gaps++; continue }
    if (selected === 'GRAPH_SIGN_INS' && Array.isArray(raw.signInEventTypes) && raw.signInEventTypes.some(type => type === 'servicePrincipal' || type === 'managedIdentity')) { gaps++; continue }
    const user = match[0]!
    const newReferences = Number(!refCache.has(`subject:${user.microsoftUserId.toLowerCase()}`)) + Number(!refCache.has(`application:${appId.toLowerCase()}`))
    if (refCache.size + newReferences > 4000) return fail('CAPACITY_LIMIT')
    const subjectRef = await managed('subject', user.microsoftUserId)
    const applicationRef = await managed('application', appId)
    const addressField = selected === 'M365_AUDIT_STS' ? 'ActorIpAddress' : 'ipAddress'
    const address = canonicalAddress(raw[addressField])
    const normalized = normalizeAuthenticationRecord(raw, { ...scope, source: selected, ingestedAt: row.ingestedAt.toISOString(),
      subject: { resolvedSubjectRef: subjectRef, sourceUserId: rawUser, principalClass: 'HUMAN', sourceField: selected === 'M365_AUDIT_STS' ? 'UserId' : 'userId',
        ...(selected === 'M365_AUDIT_STS' ? { matchedBy: 'EXACT_NORMALIZED_UPN' as const, uniqueMatch: true as const } : {}) },
      application: { applicationRef, sourceValue: appId, field: selected === 'M365_AUDIT_STS' ? 'ApplicationId' : 'appId', qualified: true },
      clientSource: { qualification: address ? 'QUALIFIED' : 'MISSING', field: addressField },
    })
    if (normalized.status !== 'ACCEPTED') { gaps++; continue }
    if (normalized.event.eventAt < window.start || normalized.event.eventAt > window.end || normalized.event.eventAt > asOf.toISOString()) { gaps++; continue }
    events.push(normalized.event); resolved.set(subjectRef, user.microsoftUserId)
    if (latestEvent === null || normalized.event.eventAt > latestEvent) latestEvent = normalized.event.eventAt
    if (latestIngestion === null || normalized.event.ingestedAt > latestIngestion) latestIngestion = normalized.event.ingestedAt
  }
  const partial = gaps > 0 || !window.paginationComplete
  const reasonCode = disputedEventIds.length ? 'CONFLICTING_EVIDENCE' as const : partial ? 'INCOMPLETE_WINDOW' as const : 'READY' as const
  const sourceDto: RiskSourceReadinessDto = { source: selected, status: partial ? 'PARTIAL' : 'READY', reasonCode, explanation: assessmentReason(reasonCode),
    window: { start: window.start, end: window.end }, lastSuccessfulCollectionAt: proof.lastSuccessfulAt.toISOString(), latestEventAt: latestEvent, latestIngestionAt: latestIngestion, freshness: 'CURRENT' }
  // Evaluate an explicitly bounded subset of the attested collection window.
  // Normal ingestion-to-evaluation delay must not turn every full 24h source
  // into LOOKBACK_CAPPED. The DTO reports this exact shorter assessed window.
  const authorizedFrom = new Date(Math.max(Date.parse(window.start), asOf.getTime()-24*60*60_000)).toISOString()
  const input: AuthEvaluationInput = { ...scope, source: selected, asOf: asOf.toISOString(), authorizedFrom, events,
    readiness: { state: partial ? 'PARTIAL' : 'READY', paginationComplete: window.paginationComplete, gapCount: gaps, capped: false } }
  return { input, sources: sources.map(source => source.source === selected ? sourceDto : source),
    resolvedSubjects: [...resolved].map(([subjectRef, microsoftUserId]) => ({ subjectRef, microsoftUserId })), disputedEventIds }
}
