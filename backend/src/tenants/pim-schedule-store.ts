import { randomUUID } from 'node:crypto'
import { captureManagedAuthority, withManagedAuthority, type AuthorityDatabase, type AuthorityTransaction,
  type ManagedAuthority } from '../microsoft/managed-connector-authority.js'
import { copyPimAttempt, copyPimContext, copyPimLimits, copyPimTenant, PIM_ENDPOINTS, PIM_PROJECTION,
  pimLifetime, pimPlane, pimRejected, pimVersion, type PimAttempt, type PimContext, type PimFailure,
  type PimIdentity, type PimLimits, type PimPlane, type PimReceipt, type PimRejection, type PimTenant,
  type PreparedPimCollection, type ParsedEnvelope } from './pim-schedule-contract.js'
import { copyPimFailure, copyPreparedPim } from './pim-schedule-preparation.js'

export interface PimScopeRecord {
  id: string; organization_id: string; customer_tenant_id: string; microsoft_tenant_id: string; plane: PimPlane
  scope_incarnation: string; scope_version: string; endpoint_descriptor: string; projection_identity: string
}
export interface PimAttemptRecord extends Omit<PimScopeRecord, 'id'> {
  id: string; scope_id: string; configuration_revision: string; connection_incarnation: string
  started_at: Date; expires_at: Date; committed_at: Date | null; terminal_at: Date | null
  content_changed_at: Date | null; outcome: 'COMMITTED' | 'FAILED' | 'ABANDONED' | null
  failure_kind: string | null; content_digest: string | null; observed_row_count: number | null
  traversal_outcome: string; is_current: boolean
}
class Rollback extends Error { constructor(readonly rejection: PimRejection) { super(rejection.reason) } }

async function guarded<T>(db: AuthorityDatabase, identity: PimIdentity,
  work: (tx: AuthorityTransaction, authority: ManagedAuthority) => Promise<T>): Promise<T | PimRejection> {
  try {
    const result = await withManagedAuthority(db, identity.configurationRevision, work)
    return result.status === 'current' ? result.value : pimRejected('SUPERSEDED')
  } catch (e) {
    if (e instanceof Rollback) return e.rejection
    // Unknown transaction/commit failures propagate; never perform a second terminal mutation.
    throw e
  }
}
async function parents(tx: AuthorityTransaction, who: PimTenant): Promise<string | PimRejection> {
  const tenant = await tx.$queryRawUnsafe<{ id: string }[]>(`/* pim:tenant */ SELECT id FROM customer_tenants
    WHERE id=$1::uuid AND organization_id=$2::uuid AND microsoft_tenant_id=$3::uuid AND status='ACTIVE'
    FOR NO KEY UPDATE`, who.customerTenantId, who.organizationId, who.microsoftTenantId)
  if (tenant.length !== 1) return pimRejected('TENANT_MISMATCH')
  const connections = await tx.$queryRawUnsafe<{ id: string; incarnation: string | null }[]>(`/* pim:connection */
    SELECT id, collection_incarnation::text AS incarnation FROM tenant_connections
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND status='CONNECTED'
      AND connection_mode='HAWKVIEW_MANAGED' FOR NO KEY UPDATE`, who.customerTenantId, who.organizationId)
  return connections.length === 1 && connections[0].incarnation ? connections[0].incarnation : pimRejected('INCARNATION_CHANGED')
}
async function currentScope(tx: AuthorityTransaction, who: PimIdentity): Promise<PimScopeRecord | null> {
  const rows = await tx.$queryRawUnsafe<PimScopeRecord[]>(`/* pim:scope */ SELECT * FROM pim_schedule_scopes
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND microsoft_tenant_id=$3::uuid
      AND plane=$4::pim_schedule_plane AND is_current FOR UPDATE`,
  who.customerTenantId, who.organizationId, who.microsoftTenantId, who.plane)
  return rows[0] ?? null
}
async function insertScope(tx: AuthorityTransaction, who: PimIdentity, version: string) {
  await tx.$executeRawUnsafe(`/* pim:insert-scope */ INSERT INTO pim_schedule_scopes
    (id,organization_id,customer_tenant_id,microsoft_tenant_id,plane,scope_incarnation,scope_version,
      endpoint_descriptor,projection_identity,is_current)
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::pim_schedule_plane,$6::uuid,$7,$8,$9,true)
    ON CONFLICT DO NOTHING`, randomUUID(), who.organizationId, who.customerTenantId, who.microsoftTenantId,
  who.plane, randomUUID(), version, PIM_ENDPOINTS[who.plane], PIM_PROJECTION)
}
function scopeContext(who: PimIdentity, connection: string, scope: PimScopeRecord): PimContext {
  return { ...who, connectionIncarnation: connection, scopeId: scope.id, scopeIncarnation: scope.scope_incarnation,
    scopeVersion: scope.scope_version, endpointDescriptor: scope.endpoint_descriptor, projectionIdentity: scope.projection_identity }
}
function matchesScope(scope: PimScopeRecord | null, ctx: PimContext): PimRejection | null {
  if (!scope || scope.id !== ctx.scopeId || scope.scope_incarnation !== ctx.scopeIncarnation || scope.scope_version !== ctx.scopeVersion) return pimRejected('SCOPE_REPLACED')
  if (scope.endpoint_descriptor !== ctx.endpointDescriptor || scope.projection_identity !== ctx.projectionIdentity) return pimRejected('PROJECTION_CHANGED')
  if (scope.microsoft_tenant_id !== ctx.microsoftTenantId || scope.organization_id !== ctx.organizationId || scope.customer_tenant_id !== ctx.customerTenantId) return pimRejected('TENANT_MISMATCH')
  if (scope.plane !== ctx.plane) return pimRejected('PLANE_MISMATCH')
  return null
}
export function attemptFromRecord(r: PimAttemptRecord): PimAttempt {
  return { organizationId: r.organization_id, customerTenantId: r.customer_tenant_id, microsoftTenantId: r.microsoft_tenant_id,
    plane: r.plane, configurationRevision: r.configuration_revision, connectionIncarnation: r.connection_incarnation,
    scopeId: r.scope_id, scopeIncarnation: r.scope_incarnation, scopeVersion: r.scope_version,
    endpointDescriptor: r.endpoint_descriptor, projectionIdentity: r.projection_identity,
    attemptId: r.id, startedAt: new Date(r.started_at), expiresAt: new Date(r.expires_at) }
}
export function receiptFromRecord(r: PimAttemptRecord): PimReceipt {
  if (r.outcome !== 'COMMITTED' || r.traversal_outcome !== 'EXHAUSTED' || !r.committed_at
    || !r.content_changed_at || !r.content_digest || r.observed_row_count === null) throw new Error('INVALID_PIM_RECEIPT')
  return { ...attemptFromRecord(r), committedAt: new Date(r.committed_at), contentChangedAt: new Date(r.content_changed_at),
    contentDigest: r.content_digest, observedRowCount: r.observed_row_count,
    traversalOutcome: 'EXHAUSTED', assurance: 'UNKNOWN', coverage: 'NOT_ESTABLISHED' }
}
function immutableBinding(row: PimAttemptRecord, a: PimAttempt): PimRejection | null {
  const saved = attemptFromRecord(row)
  if (saved.organizationId !== a.organizationId || saved.customerTenantId !== a.customerTenantId || saved.microsoftTenantId !== a.microsoftTenantId) return pimRejected('TENANT_MISMATCH')
  if (saved.plane !== a.plane) return pimRejected('PLANE_MISMATCH')
  if (saved.configurationRevision !== a.configurationRevision || saved.connectionIncarnation !== a.connectionIncarnation) return pimRejected('INCARNATION_CHANGED')
  if (saved.scopeId !== a.scopeId || saved.scopeIncarnation !== a.scopeIncarnation || saved.scopeVersion !== a.scopeVersion) return pimRejected('SCOPE_REPLACED')
  if (saved.endpointDescriptor !== a.endpointDescriptor || saved.projectionIdentity !== a.projectionIdentity) return pimRejected('PROJECTION_CHANGED')
  if (saved.attemptId !== a.attemptId || saved.startedAt.getTime() !== a.startedAt.getTime() || saved.expiresAt.getTime() !== a.expiresAt.getTime()) return pimRejected('CONFLICT')
  return null
}
async function start(tx: AuthorityTransaction, ctx: PimContext, lifetimeMs: number): Promise<PimAttempt | PimRejection> {
  // G/T/C/S are already held; T serializes absent attempts and both planes of one tenant.
  await tx.$executeRawUnsafe(`/* pim:retire-expired */ WITH sampled AS MATERIALIZED (SELECT clock_timestamp() AS at)
    UPDATE pim_schedule_attempts SET outcome='ABANDONED',terminal_at=sampled.at,
      traversal_outcome='TRUNCATED_DEADLINE',failure_kind='DEADLINE'
    FROM sampled WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid
      AND plane=$3::pim_schedule_plane AND terminal_at IS NULL AND expires_at<=sampled.at`,
  ctx.customerTenantId, ctx.organizationId, ctx.plane)
  const live = await tx.$queryRawUnsafe<{ id: string }[]>(`/* pim:inflight */ SELECT id FROM pim_schedule_attempts
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND plane=$3::pim_schedule_plane
      AND terminal_at IS NULL FOR UPDATE`, ctx.customerTenantId, ctx.organizationId, ctx.plane)
  if (live.length) return pimRejected('BUSY')
  const rows = await tx.$queryRawUnsafe<PimAttemptRecord[]>(`/* pim:begin */
    WITH sampled AS MATERIALIZED (SELECT clock_timestamp() AS at)
    INSERT INTO pim_schedule_attempts (id,organization_id,customer_tenant_id,microsoft_tenant_id,plane,
      configuration_revision,connection_incarnation,scope_id,scope_incarnation,scope_version,
      endpoint_descriptor,projection_identity,started_at,expires_at,traversal_outcome,assurance_state,coverage_state)
    SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::pim_schedule_plane,$6::uuid,$7::uuid,$8::uuid,$9::uuid,$10,
      $11,$12,sampled.at,sampled.at+($13::double precision * interval '1 millisecond'),'IN_FLIGHT','UNKNOWN','NOT_ESTABLISHED'
    FROM sampled RETURNING *`, randomUUID(), ctx.organizationId, ctx.customerTenantId, ctx.microsoftTenantId, ctx.plane,
  ctx.configurationRevision, ctx.connectionIncarnation, ctx.scopeId, ctx.scopeIncarnation, ctx.scopeVersion,
  ctx.endpointDescriptor, ctx.projectionIdentity, lifetimeMs)
  if (rows.length !== 1) throw new Error('PIM_BEGIN_FAILED')
  return attemptFromRecord(rows[0])
}

export interface PimCaptureRequest extends PimTenant { plane: PimPlane; scopeVersion: string; attemptLifetimeMs: number }
/** Captures a real G revision, then rechecks it under G/T/C/S in the begin transaction.
 * Returned credential authority is copied; provider work occurs only after transaction exit. */
export async function capturePimAttempt(db: AuthorityDatabase, input: PimCaptureRequest): Promise<
  PimRejection | { status: 'captured'; attempt: PimAttempt; authority: Readonly<ManagedAuthority> }> {
  const tenant = copyPimTenant(input), plane = pimPlane(input.plane), version = pimVersion(input.scopeVersion)
  const lifetimeMs = pimLifetime(input.attemptLifetimeMs)
  const authority = await captureManagedAuthority(db)
  if (!authority) return pimRejected('UNAVAILABLE')
  const who = { ...tenant, plane, configurationRevision: authority.configurationRevision }
  return guarded(db, who, async (tx, lockedAuthority) => {
    const connection = await parents(tx, who)
    if (typeof connection !== 'string') return connection
    let scope = await currentScope(tx, who)
    if (!scope) { await insertScope(tx, who, version); scope = await currentScope(tx, who) }
    if (!scope || scope.scope_version !== version) return pimRejected('SCOPE_REPLACED')
    const ctx = scopeContext(who, connection, scope)
    if (ctx.endpointDescriptor !== PIM_ENDPOINTS[plane] || ctx.projectionIdentity !== PIM_PROJECTION) return pimRejected('PROJECTION_CHANGED')
    const attempt = await start(tx, ctx, lifetimeMs)
    if ('status' in attempt) return attempt
    return { status: 'captured' as const, attempt, authority: Object.freeze({ ...lockedAuthority }) }
  })
}
/** Begin for an already captured immutable context. */
export async function beginPimAttempt(db: AuthorityDatabase, input: PimContext, attemptLifetimeMs: number) {
  const ctx = copyPimContext(input), lifetimeMs = pimLifetime(attemptLifetimeMs)
  return guarded(db, ctx, async tx => {
    const connection = await parents(tx, ctx)
    if (typeof connection !== 'string') return connection
    if (connection !== ctx.connectionIncarnation) return pimRejected('INCARNATION_CHANGED')
    const mismatch = matchesScope(await currentScope(tx, ctx), ctx)
    return mismatch ?? start(tx, ctx, lifetimeMs)
  })
}
/** Administrative source API only; no automatic rotation on capture or claim. */
export async function rotatePimScope(db: AuthorityDatabase, input: PimContext, nextVersion: string) {
  const ctx = copyPimContext(input), version = pimVersion(nextVersion)
  return guarded(db, ctx, async tx => {
    const connection = await parents(tx, ctx)
    if (typeof connection !== 'string') return connection
    if (connection !== ctx.connectionIncarnation) return pimRejected('INCARNATION_CHANGED')
    const mismatch = matchesScope(await currentScope(tx, ctx), ctx)
    if (mismatch) return mismatch
    await tx.$executeRawUnsafe(`/* pim:rotate */ UPDATE pim_schedule_scopes SET is_current=false,retired_at=clock_timestamp()
      WHERE id=$1::uuid AND is_current`, ctx.scopeId)
    await insertScope(tx, ctx, version)
    const next = await currentScope(tx, ctx)
    if (!next) throw new Error('PIM_SCOPE_ROTATION_FAILED')
    return { status: 'rotated' as const, context: scopeContext(ctx, connection, next) }
  })
}
async function lockAttempt(tx: AuthorityTransaction, a: PimAttempt): Promise<PimAttemptRecord | PimRejection> {
  const connection = await parents(tx, a)
  if (typeof connection !== 'string') return connection
  if (connection !== a.connectionIncarnation) return pimRejected('INCARNATION_CHANGED')
  const mismatch = matchesScope(await currentScope(tx, a), a)
  if (mismatch) return mismatch
  const rows = await tx.$queryRawUnsafe<PimAttemptRecord[]>(`/* pim:attempt */ SELECT * FROM pim_schedule_attempts
    WHERE id=$1::uuid AND customer_tenant_id=$2::uuid AND organization_id=$3::uuid FOR UPDATE`,
  a.attemptId, a.customerTenantId, a.organizationId)
  if (rows.length !== 1) return pimRejected('SUPERSEDED')
  return immutableBinding(rows[0], a) ?? rows[0]
}
async function owned(tx: AuthorityTransaction, row: PimAttemptRecord, a: PimAttempt): Promise<PimRejection | null> {
  if (row.outcome === 'ABANDONED') return pimRejected('SUPERSEDED')
  if (row.terminal_at || row.outcome) return pimRejected('CONFLICT')
  const live = await tx.$queryRawUnsafe<{ id: string }[]>(`/* pim:inflight */ SELECT id FROM pim_schedule_attempts
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND plane=$3::pim_schedule_plane
      AND terminal_at IS NULL FOR UPDATE`, a.customerTenantId, a.organizationId, a.plane)
  return live.length === 1 && live[0].id === a.attemptId ? null : pimRejected('SUPERSEDED')
}
async function insertEnvelopes(tx: AuthorityTransaction, attemptId: string, pages: readonly ParsedEnvelope[]) {
  for (const page of pages) await tx.$executeRawUnsafe(`/* pim:envelope */ INSERT INTO pim_schedule_envelopes
    (id,attempt_id,page_index,requested_token,envelope,byte_length) VALUES ($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6)`,
  randomUUID(), attemptId, page.pageIndex, page.requestedToken, JSON.stringify(page.envelope), page.byteLength)
}

export async function publishPimObservations(db: AuthorityDatabase, input: PimAttempt, value: PreparedPimCollection,
  requestedLimits: PimLimits): Promise<PimRejection | { status: 'committed' | 'replayed'; receipt: PimReceipt }> {
  const a = copyPimAttempt(input), limits = copyPimLimits(requestedLimits)
  if (Array.isArray(value.rows) && value.rows.some(r => r.plane !== a.plane)) return pimRejected('PLANE_MISMATCH')
  let payload: PreparedPimCollection
  try { payload = copyPreparedPim(a, value, limits) } catch { return pimRejected('CONFLICT') }
  return guarded(db, a, async tx => {
    const row = await lockAttempt(tx, a)
    if ('status' in row) return row
    // All live and persisted G/T/C/S/request bindings precede replay. Ownership/expiry do not.
    if (row.outcome === 'COMMITTED') return row.content_digest === payload.contentDigest
      && row.observed_row_count === payload.rows.length
      ? { status: 'replayed' as const, receipt: receiptFromRecord(row) } : pimRejected('CONFLICT')
    const refusal = await owned(tx, row, a)
    if (refusal) return refusal
    const time = await tx.$queryRawUnsafe<{ live: boolean }[]>(`/* pim:deadline */ SELECT clock_timestamp()<expires_at AS live
      FROM pim_schedule_attempts WHERE id=$1::uuid`, a.attemptId)
    if (!time[0]?.live) return pimRejected('EXPIRED')
    const previous = await tx.$queryRawUnsafe<PimAttemptRecord[]>(`/* pim:previous */ SELECT * FROM pim_schedule_attempts
      WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND plane=$3::pim_schedule_plane AND is_current FOR UPDATE`,
    a.customerTenantId, a.organizationId, a.plane)
    await insertEnvelopes(tx, a.attemptId, payload.envelopes)
    for (const r of payload.rows) await tx.$executeRawUnsafe(`/* pim:observation */ INSERT INTO pim_schedule_observation_rows
      (id,attempt_id,plane,occurrence_ordinal,instance_id,raw,observations,diagnostics,provider_start_date_time,provider_end_date_time)
      VALUES ($1::uuid,$2::uuid,$3::pim_schedule_plane,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)`,
    randomUUID(), a.attemptId, a.plane, r.occurrenceOrdinal, r.instanceId, JSON.stringify(r.raw), JSON.stringify(r.observations),
    JSON.stringify(r.diagnostics), r.providerStartDateTime, r.providerEndDateTime)
    await tx.$executeRawUnsafe(`/* pim:clear-current */ UPDATE pim_schedule_attempts SET is_current=false
      WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND plane=$3::pim_schedule_plane AND is_current`,
    a.customerTenantId, a.organizationId, a.plane)
    const unchangedAt = previous[0]?.content_digest === payload.contentDigest ? previous[0].content_changed_at : null
    const committed = await tx.$queryRawUnsafe<PimAttemptRecord[]>(`/* pim:commit */
      WITH sampled AS MATERIALIZED (SELECT clock_timestamp() AS at)
      UPDATE pim_schedule_attempts SET outcome='COMMITTED',traversal_outcome='EXHAUSTED',
        committed_at=sampled.at,terminal_at=sampled.at,content_changed_at=COALESCE($4::timestamptz,sampled.at),
        content_digest=$2,observed_row_count=$3,is_current=true
      FROM sampled WHERE id=$1::uuid AND terminal_at IS NULL AND sampled.at<expires_at RETURNING pim_schedule_attempts.*`,
    a.attemptId, payload.contentDigest, payload.rows.length, unchangedAt)
    if (committed.length !== 1) throw new Rollback(pimRejected('EXPIRED'))
    return { status: 'committed' as const, receipt: receiptFromRecord(committed[0]) }
  })
}
export async function recordPimTerminalFailure(db: AuthorityDatabase, input: PimAttempt, value: PimFailure,
  requestedLimits: PimLimits): Promise<PimRejection | { status: 'recorded'; attemptId: string }> {
  const a = copyPimAttempt(input), limits = copyPimLimits(requestedLimits), payload = copyPimFailure(value, limits)
  return guarded(db, a, async tx => {
    const row = await lockAttempt(tx, a)
    if ('status' in row) return row
    const refusal = await owned(tx, row, a)
    if (refusal) return refusal
    // Owned nonterminal failure is permitted after expiry. Retired A cannot touch successor B.
    await insertEnvelopes(tx, a.attemptId, payload.envelopes)
    for (const w of payload.wireFailures) await tx.$executeRawUnsafe(`/* pim:wire-failure */ INSERT INTO pim_schedule_wire_failures
      (id,attempt_id,page_index,byte_length,failure_kind) VALUES ($1::uuid,$2::uuid,$3,$4,$5)`,
    randomUUID(), a.attemptId, w.pageIndex, w.byteLength, w.failureKind)
    const changed = await tx.$executeRawUnsafe(`/* pim:fail */ UPDATE pim_schedule_attempts SET outcome='FAILED',
      terminal_at=clock_timestamp(),failure_kind=$2,traversal_outcome=$3 WHERE id=$1::uuid AND terminal_at IS NULL`,
    a.attemptId, payload.failureKind, payload.traversalOutcome)
    if (changed !== 1) throw new Error('PIM_FAILURE_OWNERSHIP_CHANGED')
    return { status: 'recorded' as const, attemptId: a.attemptId }
  })
}
