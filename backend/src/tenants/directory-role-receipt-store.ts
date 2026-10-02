import { randomUUID } from 'node:crypto'
import { withManagedAuthority, type AuthorityDatabase, type AuthorityTransaction } from '../microsoft/managed-connector-authority.js'
import type { ChangeEvidenceService } from '../changes/change-evidence.service.js'

/** Unwired persistence primitive. It does not validate provider pages or enable reader trust.
 * All live authority writers must join this protocol before rollout/activation is trusted.
 * Current reporting later requires a COMPLETE within 1h; 26h is retained compatibility only.
 */
export const DIRECTORY_ROLE_RECEIPT_SCOPE = 'directory-role-assignments/v1'
export const ROLE_ATTEMPT_MS = 5 * 60 * 1000
// Shared by the actual clock query and precision tests: never round sampled_at for eligibility.
export const ROLE_DEADLINE_PREDICATE = 'sampled_at < role_attempt_expires_at'
export const ROLE_CLOCK_SQL = `WITH sample AS MATERIALIZED (SELECT clock_timestamp() AS sampled_at)
  SELECT date_trunc('milliseconds', sampled_at) AS "checkedAt",
    (${ROLE_DEADLINE_PREDICATE}) AS live
  FROM sample CROSS JOIN sync_states WHERE id = $1::uuid`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export interface RoleIdentity {
  organizationId: string; customerTenantId: string; microsoftTenantId: string
  configurationRevision: string
}
export interface RoleContext extends RoleIdentity {
  connectionIncarnation: string; scopeIncarnation: string; scopeVersion: string
}
export interface RoleAttempt extends RoleContext { attemptId: string }
export interface RoleReceipt extends RoleAttempt {
  contractVersion: 1; checkedAt: Date; snapshotObservedAt: Date; contentDigest: string; rowCount: number
}
export type RoleRejection = { status: 'rejected'; reason: 'SUPERSEDED' | 'INCARNATION_CHANGED' | 'UNAVAILABLE' | 'BUSY' | 'CONFLICT' }
export type RoleResult = RoleRejection | { status: 'committed' | 'replayed'; receipt: RoleReceipt }
  | { status: 'failed' | 'partial' | 'expired'; attemptId: string }
/** Only a future approved validator may prepare production input. Synthetic values test persistence only. */
export interface PreparedRoleCollection { rows: readonly unknown[]; contentDigest: string }
type DifferenceBuilder = ChangeEvidenceService['buildSnapshotDifferenceEvidence']
interface State {
  id: string; role_scope_version: string | null; role_scope_incarnation: string | null
  role_attempt_id: string | null; role_attempt_connection: string | null
  role_attempt_configuration: string | null; role_attempt_scope: string | null
  role_attempt_outcome: string | null
  role_complete_id: string | null; role_complete_connection: string | null
  role_complete_configuration: string | null; role_complete_scope: string | null
  role_complete_scope_version: string | null; role_complete_microsoft_tenant_id: string | null
  role_complete_checked_at: Date | null; role_complete_digest: string | null; role_complete_count: number | null
}
interface Locked { state: State | null; connectionId: string; incarnation: string | null }
interface Snapshot { payload: unknown; observedAt: Date; publicationId: string | null; samePayload: boolean }
const rejected = (reason: RoleRejection['reason']): RoleRejection => ({ status: 'rejected', reason })
function id(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('INVALID_ROLE_ID')
  return value.toLowerCase()
}
function identity(input: RoleIdentity): RoleIdentity {
  return { organizationId: id(input.organizationId), customerTenantId: id(input.customerTenantId),
    microsoftTenantId: id(input.microsoftTenantId), configurationRevision: id(input.configurationRevision) }
}
function context(input: RoleContext): RoleContext {
  if (input.scopeVersion !== DIRECTORY_ROLE_RECEIPT_SCOPE) throw new Error('UNSUPPORTED_ROLE_SCOPE')
  return { ...identity(input), connectionIncarnation: id(input.connectionIncarnation),
    scopeIncarnation: id(input.scopeIncarnation), scopeVersion: input.scopeVersion }
}
function attempt(input: RoleAttempt): RoleAttempt { return { ...context(input), attemptId: id(input.attemptId) } }
function prepared(input: PreparedRoleCollection): { json: string; rows: unknown[]; digest: string } {
  if (!Array.isArray(input.rows) || input.rows.length > 1000 || !/^[0-9a-f]{64}$/.test(input.contentDigest)) {
    throw new Error('INVALID_PREPARED_ROLE_COLLECTION')
  }
  const json = JSON.stringify(input.rows)
  if (Buffer.byteLength(json, 'utf8') > 180000) throw new Error('ROLE_COLLECTION_TOO_LARGE')
  return { json, rows: JSON.parse(json), digest: input.contentDigest }
}
async function underAuthority<T>(db: AuthorityDatabase, expected: RoleIdentity,
  work: (tx: AuthorityTransaction) => Promise<T>): Promise<T | RoleRejection> {
  const result = await withManagedAuthority(db, expected.configurationRevision, tx => work(tx))
  return result.status === 'current' ? result.value : rejected('SUPERSEDED')
}
/** G is already locked. Parent locks serialize absent R; NO KEY UPDATE avoids needless FK conflicts. */
async function lockScope(tx: AuthorityTransaction, who: RoleIdentity, create = false): Promise<Locked | null> {
  const tenants = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM customer_tenants
    WHERE id=$1::uuid AND organization_id=$2::uuid AND microsoft_tenant_id=$3::uuid AND status='ACTIVE'
    FOR NO KEY UPDATE`, who.customerTenantId, who.organizationId, who.microsoftTenantId)
  if (tenants.length !== 1) return null
  const connections = await tx.$queryRawUnsafe<{ id: string; incarnation: string | null }[]>(`SELECT id,
    collection_incarnation::text AS incarnation FROM tenant_connections
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND status='CONNECTED'
      AND connection_mode='HAWKVIEW_MANAGED' FOR NO KEY UPDATE`, who.customerTenantId, who.organizationId)
  if (connections.length !== 1) return null
  if (create) await tx.$executeRawUnsafe(`INSERT INTO sync_states
    (id,organization_id,customer_tenant_id,resource_type,updated_at)
    VALUES ($1::uuid,$2::uuid,$3::uuid,'DIRECTORY_ROLES',clock_timestamp()) ON CONFLICT DO NOTHING`,
    randomUUID(), who.organizationId, who.customerTenantId)
  const states = await tx.$queryRawUnsafe<State[]>(`SELECT * FROM sync_states
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND resource_type='DIRECTORY_ROLES' FOR UPDATE`,
    who.customerTenantId, who.organizationId)
  return { state: states[0] ?? null, connectionId: connections[0].id, incarnation: connections[0].incarnation }
}
function matches(locked: Locked, ctx: RoleContext): boolean {
  return locked.incarnation === ctx.connectionIncarnation && locked.state?.role_scope_incarnation === ctx.scopeIncarnation
    && locked.state.role_scope_version === ctx.scopeVersion
}
function owns(s: State, a: RoleAttempt): boolean {
  return s.role_attempt_id === a.attemptId && s.role_attempt_connection === a.connectionIncarnation
    && s.role_attempt_configuration === a.configurationRevision && s.role_attempt_scope === a.scopeIncarnation
    && s.role_attempt_outcome === 'RUNNING'
}
async function clock(tx: AuthorityTransaction, state: State) {
  const rows = await tx.$queryRawUnsafe<{ checkedAt: Date; live: boolean | null }[]>(ROLE_CLOCK_SQL, state.id)
  if (rows.length !== 1) throw new Error('ROLE_STATE_DISAPPEARED')
  return rows[0]
}
/** Administrative activation, not an automatic version switch on claim. IDs are minted internally.
 * Also supplies a bounded synthetic connection-rotation primitive; live consent/config wiring is separate.
 */
export async function activateRoleScope(db: AuthorityDatabase, input: RoleIdentity & {
  expectedConnectionIncarnation: string | null; expectedScopeIncarnation: string | null
  rotateConnection?: boolean
}): Promise<{ status: 'activated'; context: RoleContext } | RoleRejection> {
  const who = identity(input), conn = input.expectedConnectionIncarnation === null ? null : id(input.expectedConnectionIncarnation)
  const scope = input.expectedScopeIncarnation === null ? null : id(input.expectedScopeIncarnation)
  const rotate = input.rotateConnection === true
  return underAuthority(db, who, async tx => {
    // First inspect without creating: a losing activation must not leave a placeholder R.
    let locked = await lockScope(tx, who)
    if (!locked) return rejected('UNAVAILABLE')
    if (locked.incarnation !== conn || (locked.state?.role_scope_incarnation ?? null) !== scope) return rejected('SUPERSEDED')
    if (!locked.state) locked = (await lockScope(tx, who, true))!
    if (!locked.state) throw new Error('ROLE_STATE_SCOPE_CONFLICT')
    const incarnation = rotate || conn === null ? randomUUID() : conn
    const nextScope = randomUUID()
    await tx.$executeRawUnsafe(`UPDATE tenant_connections SET collection_incarnation=$1::uuid,updated_at=clock_timestamp()
      WHERE id=$2::uuid`, incarnation, locked.connectionId)
    await tx.$executeRawUnsafe(`UPDATE sync_states SET role_scope_version=$1,role_scope_incarnation=$2::uuid,
      role_attempt_id=NULL,role_attempt_connection=NULL,role_attempt_configuration=NULL,role_attempt_scope=NULL,
      role_attempt_started_at=NULL,role_attempt_expires_at=NULL,role_attempt_outcome=NULL,role_attempt_terminal_at=NULL,
      status='IDLE',updated_at=clock_timestamp() WHERE id=$3::uuid`, DIRECTORY_ROLE_RECEIPT_SCOPE, nextScope, locked.state.id)
    return { status: 'activated', context: { ...who, connectionIncarnation: incarnation,
      scopeIncarnation: nextScope, scopeVersion: DIRECTORY_ROLE_RECEIPT_SCOPE } }
  })
}
export async function claimRoleAttempt(db: AuthorityDatabase, input: RoleContext): Promise<
  { status: 'claimed'; attempt: RoleAttempt; startedAt: Date; expiresAt: Date } | RoleRejection> {
  const ctx = context(input)
  return underAuthority(db, ctx, async tx => {
    const locked = await lockScope(tx, ctx)
    if (!locked?.state) return rejected('UNAVAILABLE')
    if (!matches(locked, ctx)) return rejected('INCARNATION_CHANGED')
    const s = locked.state, time = await clock(tx, s)
    if (s.role_attempt_outcome === 'RUNNING' && s.role_attempt_configuration === ctx.configurationRevision && time.live) return rejected('BUSY')
    const attemptId = randomUUID(), expiresAt = new Date(time.checkedAt.getTime() + ROLE_ATTEMPT_MS)
    await tx.$executeRawUnsafe(`UPDATE sync_states SET role_attempt_id=$1::uuid,role_attempt_connection=$2::uuid,
      role_attempt_configuration=$3::uuid,role_attempt_scope=$4::uuid,role_attempt_started_at=$5::timestamptz,
      role_attempt_expires_at=$6::timestamptz,role_attempt_outcome='RUNNING',role_attempt_terminal_at=NULL,
      status='RUNNING',last_attempt_at=$5::timestamptz,updated_at=$5::timestamptz WHERE id=$7::uuid`,
      attemptId, ctx.connectionIncarnation, ctx.configurationRevision, ctx.scopeIncarnation, time.checkedAt, expiresAt, s.id)
    return { status: 'claimed', attempt: { ...ctx, attemptId }, startedAt: time.checkedAt, expiresAt }
  })
}
async function terminal(tx: AuthorityTransaction, s: State, a: RoleAttempt, time: Date, outcome: 'FAILED' | 'PARTIAL' | 'EXPIRED'): Promise<RoleResult> {
  const updated = await tx.$executeRawUnsafe(`UPDATE sync_states SET role_attempt_outcome=$1,role_attempt_terminal_at=$2::timestamptz,
    status='FAILED',last_error_code=$1,consecutive_failures=LEAST(consecutive_failures,2147483646)+1,
    updated_at=$2::timestamptz WHERE id=$3::uuid AND role_attempt_id=$4::uuid AND role_attempt_outcome='RUNNING'
    AND role_attempt_connection=$5::uuid AND role_attempt_configuration=$6::uuid AND role_attempt_scope=$7::uuid`,
    outcome, time, s.id, a.attemptId, a.connectionIncarnation, a.configurationRevision, a.scopeIncarnation)
  if (updated !== 1) throw new Error('ROLE_TERMINAL_CAS_LOST')
  return { status: outcome === 'FAILED' ? 'failed' : outcome === 'PARTIAL' ? 'partial' : 'expired', attemptId: a.attemptId }
}
export async function finishRoleAttempt(db: AuthorityDatabase, input: RoleAttempt, outcome: 'FAILED' | 'PARTIAL' | 'EXPIRED'): Promise<RoleResult> {
  const a = attempt(input)
  if (!['FAILED', 'PARTIAL', 'EXPIRED'].includes(outcome)) throw new Error('INVALID_ROLE_OUTCOME')
  return underAuthority(db, a, async tx => {
    const locked = await lockScope(tx, a)
    if (!locked?.state || !matches(locked, a)) return rejected('INCARNATION_CHANGED')
    if (!owns(locked.state, a)) return rejected('SUPERSEDED')
    const time = await clock(tx, locked.state)
    if (outcome === 'EXPIRED' && time.live) return rejected('CONFLICT')
    return terminal(tx, locked.state, a, time.checkedAt, time.live ? outcome : 'EXPIRED')
  })
}
async function lockSnapshot(tx: AuthorityTransaction, a: RoleAttempt, json: string): Promise<Snapshot | null> {
  // Same advisory key as existing saveSnapshot; never call that nested transaction owner.
  await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))',
    `hawkview:snapshot:${a.customerTenantId}:DIRECTORY_ROLES`)
  const rows = await tx.$queryRawUnsafe<(Snapshot & { organizationId: string })[]>(`SELECT payload,observed_at AS "observedAt",
    role_publication_attempt_id::text AS "publicationId",organization_id::text AS "organizationId",payload=$2::jsonb AS "samePayload"
    FROM tenant_entra_snapshots WHERE customer_tenant_id=$1::uuid AND resource_type='DIRECTORY_ROLES' FOR UPDATE`, a.customerTenantId, json)
  if (rows[0] && rows[0].organizationId !== a.organizationId) throw new Error('ROLE_SNAPSHOT_SCOPE_CONFLICT')
  return rows[0] ?? null
}
export async function completeRoleAttempt(db: AuthorityDatabase, input: RoleAttempt, collection: PreparedRoleCollection,
  buildDifference: DifferenceBuilder): Promise<RoleResult> {
  // Capture all mutable caller values before waiting for authority/row locks.
  const a = attempt(input), payload = prepared(collection)
  return underAuthority(db, a, async tx => {
    const locked = await lockScope(tx, a)
    if (!locked?.state || !matches(locked, a)) return rejected('INCARNATION_CHANGED')
    const s = locked.state, previous = await lockSnapshot(tx, a, payload.json)
    // Retained completion precedes newer-attempt ownership and expiry. Replay is read-only.
    if (s.role_complete_id === a.attemptId) {
      if (s.role_complete_connection !== a.connectionIncarnation || s.role_complete_configuration !== a.configurationRevision
        || s.role_complete_scope !== a.scopeIncarnation || s.role_complete_scope_version !== a.scopeVersion
        || s.role_complete_microsoft_tenant_id !== a.microsoftTenantId) return rejected('INCARNATION_CHANGED')
      if (s.role_complete_digest !== payload.digest || s.role_complete_count !== payload.rows.length
        || previous?.publicationId !== a.attemptId || !previous.samePayload
        || previous.observedAt.getTime() !== s.role_complete_checked_at?.getTime()) return rejected('CONFLICT')
      return { status: 'replayed', receipt: receipt(a, s.role_complete_checked_at, payload.digest, payload.rows.length) }
    }
    if (!owns(s, a)) return rejected('SUPERSEDED')
    const time = await clock(tx, s) // fresh AFTER S as well as G/T/C/R
    if (!time.live) return terminal(tx, s, a, time.checkedAt, 'EXPIRED')
    const expiresAt = new Date(time.checkedAt); expiresAt.setUTCMonth(expiresAt.getUTCMonth() + 6)
    const evidence = buildDifference({ tenant: { id: a.customerTenantId, organizationId: a.organizationId },
      resourceType: 'DIRECTORY_ROLES', previousPayload: previous?.payload, currentPayload: payload.rows,
      observedAt: time.checkedAt, baselineObservedAt: previous?.observedAt, expiresAt })
    if (evidence.length) {
      const records = evidence.map(event => Object.fromEntries(Object.entries({ id: randomUUID(), ...event })
        .map(([key, value]) => [key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()), value])))
      await tx.$executeRawUnsafe(`INSERT INTO change_evidence_events
        SELECT * FROM jsonb_populate_recordset(NULL::change_evidence_events,$1::jsonb)
        ON CONFLICT (customer_tenant_id,source,source_event_id) DO NOTHING`, JSON.stringify(records))
    }
    await tx.$executeRawUnsafe(`INSERT INTO tenant_entra_snapshots
      (id,organization_id,customer_tenant_id,resource_type,payload,observed_at,updated_at,role_publication_attempt_id)
      VALUES ($1::uuid,$2::uuid,$3::uuid,'DIRECTORY_ROLES',$4::jsonb,$5::timestamptz,$5::timestamptz,$6::uuid)
      ON CONFLICT (customer_tenant_id,resource_type) DO UPDATE SET payload=EXCLUDED.payload,observed_at=EXCLUDED.observed_at,
        updated_at=EXCLUDED.updated_at,role_publication_attempt_id=EXCLUDED.role_publication_attempt_id`,
      randomUUID(), a.organizationId, a.customerTenantId, payload.json, time.checkedAt, a.attemptId)
    const updated = await tx.$executeRawUnsafe(`UPDATE sync_states SET role_attempt_outcome='COMPLETE',role_attempt_terminal_at=$1::timestamptz,
      role_complete_id=$2::uuid,role_complete_connection=$3::uuid,role_complete_configuration=$4::uuid,
      role_complete_scope=$5::uuid,role_complete_scope_version=$6,role_complete_microsoft_tenant_id=$7::uuid,
      role_complete_checked_at=$1::timestamptz,role_complete_digest=$8,role_complete_count=$9,
      status='SUCCEEDED',last_successful_at=$1::timestamptz,last_error_code=NULL,last_error_message=NULL,
      consecutive_failures=0,updated_at=$1::timestamptz WHERE id=$10::uuid AND role_attempt_id=$2::uuid
      AND role_attempt_connection=$3::uuid AND role_attempt_configuration=$4::uuid AND role_attempt_scope=$5::uuid
      AND role_attempt_outcome='RUNNING'`, time.checkedAt,a.attemptId,a.connectionIncarnation,a.configurationRevision,
      a.scopeIncarnation,a.scopeVersion,a.microsoftTenantId,payload.digest,payload.rows.length,s.id)
    if (updated !== 1) throw new Error('ROLE_COMPLETE_CAS_LOST')
    return { status: 'committed', receipt: receipt(a, time.checkedAt, payload.digest, payload.rows.length) }
  })
}
function receipt(a: RoleAttempt, checkedAt: Date, digest: string, count: number): RoleReceipt {
  return { ...a, contractVersion: 1, checkedAt, snapshotObservedAt: new Date(checkedAt), contentDigest: digest, rowCount: count }
}
