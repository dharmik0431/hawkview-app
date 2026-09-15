import { normalizeAuthenticationRecord, type AuthEvaluationInput, type AuthScope, type AuthSource } from '../risky-users-auth/index.js'
import { canonicalAddress } from '../risky-users-auth/normalize.js'
import { assessmentReason, AUTH_COLLECTION_MAX_AGE_MS } from './risk-assessment-projection.js'
import type { RiskAssessmentReason, RiskSourceReadinessDto } from './identity-risk-assessment.contract.js'
/** The shape every window in production carried before observation was recorded. */
export const AUTH_WINDOW_SCHEMA_V1 = 'hawkview-authentication-window/v1'
/** v2 adds what the collection OBSERVED, beside what it asked for. */
export const AUTH_WINDOW_SCHEMA = 'hawkview-authentication-window/v2'
export type AuthWindowSchema = typeof AUTH_WINDOW_SCHEMA_V1 | typeof AUTH_WINDOW_SCHEMA
export type AuthenticationWindow = { schemaVersion: AuthWindowSchema; source: AuthSource; start: string; end: string; paginationComplete: boolean
  /** Events persisted by the MOST RECENT collection pass. Absent on v1. */
  observedEvents?: number
  /** Newest event ever observed for this source, carried across merges so it
   * survives the window rolling forward. `null` means nothing has ever been
   * observed; absent means this window predates the field. */
  latestObservedEventAt?: string | null }

/**
 * What a collection SAW, as three states rather than two.
 *
 * `lastSuccessfulCollectionAt` answers *when did we last look*. Nothing
 * answered *when did we last see anything*, so a tenant silent for two weeks
 * and one busy a minute ago reported identically. This is that missing fact,
 * and `NOT RECORDED` is kept distinct from `observed nothing` because a
 * window written before this change genuinely does not know — collapsing the
 * two would be the defect this removes, reintroduced by its own migration.
 */
export type AuthenticationObservation =
  | { recorded: false }
  | { recorded: true; events: number; latestEventAt: string | null }

export function windowObservation(window: AuthenticationWindow): AuthenticationObservation {
  return typeof window.observedEvents === 'number' && window.latestObservedEventAt !== undefined
    ? { recorded: true, events: window.observedEvents, latestEventAt: window.latestObservedEventAt }
    : { recorded: false }
}
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
const V1_KEYS = 'end,paginationComplete,schemaVersion,source,start'
const V2_KEYS = 'end,latestObservedEventAt,observedEvents,paginationComplete,schemaVersion,source,start'
export function authenticationWindow(value: unknown): AuthenticationWindow | null {
  if (!plain(value)) return null
  // THE KEY SET IS CHECKED PER VERSION, and v1 is still accepted. The exact-match
  // was deliberate strictness, so it is kept -- but adding a field to a single
  // shared key set would have invalidated every window already stored, dropping
  // every tenant to WAITING at once. v1 rows re-stamp to v2 on their next
  // successful collection, so the old shape drains within one cycle.
  const keys = Object.keys(value).sort().join(',')
  const version = value.schemaVersion
  if (version === AUTH_WINDOW_SCHEMA_V1) { if (keys !== V1_KEYS) return null }
  else if (version === AUTH_WINDOW_SCHEMA) {
    if (keys !== V2_KEYS) return null
    if (!Number.isSafeInteger(value.observedEvents) || (value.observedEvents as number) < 0) return null
    if (!(value.latestObservedEventAt === null || iso(value.latestObservedEventAt))) return null
  } else return null
  if (!['M365_AUDIT_STS', 'GRAPH_SIGN_INS'].includes(value.source as string) || typeof value.paginationComplete !== 'boolean' || !iso(value.start) || !iso(value.end) || value.start > value.end ||
    Date.parse(value.end) - Date.parse(value.start) > 24 * 60 * 60_000) return null
  return value as AuthenticationWindow
}
export function mergeAuthenticationWindow(previous: unknown, source: AuthSource, start: Date, end: Date, completedPageChain: boolean,
  observed: { events: number; latestEventAt: string | null } = { events: 0, latestEventAt: null }): AuthenticationWindow {
  if (completedPageChain !== true || !date(start) || !date(end) || start > end) throw new Error('IDENTITY_AUTH_WINDOW_INVALID')
  if (!Number.isSafeInteger(observed.events) || observed.events < 0 || !(observed.latestEventAt === null || iso(observed.latestEventAt))) throw new Error('IDENTITY_AUTH_OBSERVATION_INVALID')
  const prior = authenticationWindow(previous)
  if (prior && Date.parse(prior.end) > end.getTime()) throw new Error('IDENTITY_AUTH_WINDOW_SUPERSEDED')
  // ONE OWNER FOR "IS THIS THE SAME LANE". Both the start extension and the
  // observation carry-forward below need it, and when each tested it for
  // itself they drifted: the start was scoped to the source and the carry was
  // not, so a tenant moving between Graph sign-ins and the audit lane inherited
  // the abandoned source's newest event time. Worse than losing it -- the
  // stalled-tenant signature is defeated by a value describing a source we no
  // longer read, and the tenant reads as recently active.
  const priorForSource = prior !== null && prior.source === source ? prior : null
  const from = priorForSource?.paginationComplete === true && Date.parse(priorForSource.end) >= start.getTime() && Date.parse(priorForSource.end) <= end.getTime()
    ? Math.min(Date.parse(priorForSource.start), start.getTime()) : start.getTime()
  // CARRIED FORWARD, NOT RESET. `observedEvents` is this pass; the newest event
  // ever seen has to outlive an empty pass or the stalled-tenant signature --
  // collection current, nothing observed for days -- is destroyed by the first
  // empty collection, which is every collection for a silent tenant.
  //
  // A v1 prior contributes no history: it does not know what it observed, and
  // inventing one from its absence is exactly the collapse being fixed.
  // Contiguity is deliberately NOT required here, unlike the start extension
  // above: the whole purpose of this field is to outlive gaps in collection.
  // Same source is the only condition.
  const priorObservation = priorForSource ? windowObservation(priorForSource) : { recorded: false as const }
  const carried = priorObservation.recorded ? priorObservation.latestEventAt : null
  const latestObservedEventAt = observed.latestEventAt !== null && (carried === null || observed.latestEventAt > carried)
    ? observed.latestEventAt : carried
  return { schemaVersion: AUTH_WINDOW_SCHEMA, source, start: new Date(Math.max(from, end.getTime() - 24 * 60 * 60_000)).toISOString(), end: end.toISOString(), paginationComplete: true,
    observedEvents: observed.events, latestObservedEventAt }
}
export function selectedAuthenticationSource(proof: AuthenticationProof | null): AuthSource | null {
  if (proof?.status === 'SUCCEEDED' && proof.lastErrorCode === null) return 'GRAPH_SIGN_INS'
  if (proof?.status === 'RUNNING' && FALLBACK.test(proof.lastErrorCode ?? '')) return 'M365_AUDIT_STS'
  return null
}
/**
 * What we ESTABLISHED about freshness before giving up, as two states.
 *
 * STALE is a measurement: we read a collection time, compared it, and it was
 * outside the window -- so the DTO can carry the time and the screen can say
 * how stale rather than only that it is.
 *
 * UNKNOWN is the absence of a measurement, and it has to stay that way. A
 * tenant that has never collected, one whose clock is ahead of ours so its
 * collection cannot be placed in time at all, and a failure that happened
 * before any collection time was established are all genuinely unmeasured.
 * Reporting them as STALE would trade one conflation for another -- the whole
 * defect here is a determined fact recorded as an unknown, and the mirror of it
 * is just as wrong.
 */
export type AuthenticationFreshnessObservation =
  | { determined: 'UNKNOWN' }
  | { determined: 'STALE'; lastSuccessfulCollectionAt: string }
export function unavailableAuthenticationSource(source: AuthSource, reason: RiskAssessmentReason = 'WAITING_FOR_COLLECTION',
  observed: AuthenticationFreshnessObservation = { determined: 'UNKNOWN' }): RiskSourceReadinessDto {
  const status = reason === 'MISSING_PERMISSION' ? 'MISSING_PERMISSION' : reason === 'LICENSE_REQUIRED' ? 'LICENSE_REQUIRED'
    : reason === 'COLLECTION_STALE' ? 'STALE' : reason === 'COLLECTION_FAILED' || reason === 'EVALUATION_FAILED' || reason === 'KEY_UNAVAILABLE' ? 'FAILED'
    : reason === 'EVALUATION_DISABLED' ? 'DISABLED'
    : reason === 'CAPACITY_LIMIT' || reason === 'INCOMPLETE_WINDOW' ? 'PARTIAL' : reason === 'USER_BINDING_UNRESOLVED' ? 'INSUFFICIENT_FIELDS' : 'WAITING'
  return { source, status, reasonCode: reason, explanation: assessmentReason(reason), window: { start: null, end: null },
    // The collection time is carried ONLY where staleness was actually
    // determined. Everywhere else it stays null, because a timestamp beside an
    // UNKNOWN would be a measurement nobody took. latestEventAt stays null in
    // both: when we do not have a usable window we have not seen the events.
    lastSuccessfulCollectionAt: observed.determined === 'STALE' ? observed.lastSuccessfulCollectionAt : null,
    latestEventAt: null, latestIngestionAt: null,
    freshness: observed.determined === 'STALE' ? 'STALE' : 'UNKNOWN' }
}
export async function prepareAuthenticationEvaluation(scope: AuthScope, rows: readonly AuthenticationRow[], directory: readonly AuthenticationDirectoryUser[], proof: AuthenticationProof | null,
  window: AuthenticationWindow | null, directoryReady: boolean, asOf: Date, reference: AuthenticationReference) {
  const selected = selectedAuthenticationSource(proof)
  const disputedEventIds: string[] = []
  const sources = (['GRAPH_SIGN_INS', 'M365_AUDIT_STS'] as const).map(source => unavailableAuthenticationSource(source))
  // An observation belongs to the source it was taken from. The proof is the
  // SELECTED source's collection, so stamping its time onto the other lane
  // would invent a fact about a source we did not read -- the same
  // cross-source attribution that had to be scoped out of the window carry.
  const fail = (reason: RiskAssessmentReason, observed: AuthenticationFreshnessObservation = { determined: 'UNKNOWN' }, observedSource: AuthSource | null = null) => ({
    input: null as AuthEvaluationInput | null,
    sources: sources.map(source => unavailableAuthenticationSource(source.source as AuthSource, reason,
      observedSource !== null && source.source === observedSource ? observed : { determined: 'UNKNOWN' })),
    resolvedSubjects: [] as { subjectRef: string; microsoftUserId: string }[], disputedEventIds })
  if (proof?.lastErrorCode === 'MICROSOFT_PERMISSION_REQUIRED') return fail('MISSING_PERMISSION')
  if (proof?.lastErrorCode === 'MICROSOFT_LICENSE_REQUIRED') return fail('LICENSE_REQUIRED')
  if (!date(asOf) || !date(proof?.lastSuccessfulAt)) return fail(proof?.status === 'FAILED' ? 'COLLECTION_FAILED' : 'WAITING_FOR_COLLECTION')
  if (!selected || (proof?.lastAttemptAt && (!date(proof.lastAttemptAt) || proof.lastAttemptAt > proof.lastSuccessfulAt))) return fail('COLLECTION_FAILED')
  // A clock ahead of ours is NOT a measured staleness: the collection cannot be
  // placed in time at all, so it stays UNKNOWN and carries no timestamp.
  if (proof.lastSuccessfulAt > asOf) return fail('COLLECTION_STALE')
  if (asOf.getTime() - proof.lastSuccessfulAt.getTime() > AUTH_COLLECTION_MAX_AGE_MS)
    return fail('COLLECTION_STALE', { determined: 'STALE', lastSuccessfulCollectionAt: proof.lastSuccessfulAt.toISOString() }, selected)
  if (!directoryReady) return fail('USER_BINDING_UNRESOLVED')
  if (rows.length > 10_000 || directory.length > 5000) return fail('CAPACITY_LIMIT')
  if (!window || window.source !== selected || Date.parse(window.end) > proof.lastSuccessfulAt.getTime()) return fail('INCOMPLETE_WINDOW')
  if (asOf.getTime() - Date.parse(window.end) > AUTH_COLLECTION_MAX_AGE_MS)
    return fail('COLLECTION_STALE', { determined: 'STALE', lastSuccessfulCollectionAt: proof.lastSuccessfulAt.toISOString() }, selected)
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
