import { createHash, randomUUID } from 'node:crypto'
import { withManagedAuthority, type AuthorityDatabase, type AuthorityTransaction } from './managed-connector-authority.js'

/** Existing-tenant managed consent transaction boundary. No provider, URL, token,
 * incident or scheduler calls. All authority writers must upgrade/drain before
 * trust activation. Legacy operations (version NULL) cannot become trusted. */
export const CONSENT_ENTRY_MS = 15 * 60 * 1000
export const CONSENT_FINAL_MS = 5 * 60 * 1000
// Prisma raw timestamptz conversion requires UTC; SET LOCAL never changes the pool.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH = /^[a-f0-9]{64}$/
type State = 'ISSUED' | 'CLAIMED' | 'SUCCEEDED' | 'FAILED' | 'SUPERSEDED' | 'EXPIRED'
type Failure = 'CONSENT_DENIED' | 'TENANT_MISMATCH' | 'VERIFICATION_FAILED' | 'MISSING_PERMISSIONS'
export interface ConsentScope { organizationId: string; customerTenantId: string; flow: 'EXISTING_TENANT' }
export interface ConsentOperationKey extends ConsentScope { operationId: string; stateHash: string }
export interface ClaimedConsent extends ConsentOperationKey {
  claimId: string; configurationRevision: string; connectionIncarnation: string
  microsoftTenantId: string; clientId: string; homeTenantId: string; credentialReference: string
  claimedAt: Date; finalDeadline: Date
}
export interface ConsentTerminal {
  state: 'SUCCEEDED' | 'FAILED' | 'SUPERSEDED' | 'EXPIRED'; resultCode: string
  resultingConnectionIncarnation: string | null
}
/** Semantic provider validation belongs to the future adapter. No arbitrary error
 * messages are persisted here. These bounds defend the persistence boundary only. */
export type PreparedConsentResult = { outcome: 'SUCCEEDED'; displayName: string; primaryDomain: string | null; grantedPermissions: readonly string[] }
  | { outcome: 'FAILED'; code: Failure }
type Rejected = { status: 'rejected'; reason: 'UNTRUSTED' | 'UNAVAILABLE' | 'SUPERSEDED' | 'BUSY' | 'CONFLICT' }
export type ClaimResult = Rejected | { status: 'claimed'; context: ClaimedConsent }
  | { status: 'terminal'; result: ConsentTerminal }
export type FinishResult = Rejected | { status: 'applied' | 'replayed' | 'superseded' | 'expired'; result: ConsentTerminal }
interface Operation {
  id: string; organization_id: string; customer_tenant_id: string; flow: string; state_hash: string
  operation_version: number | null; operation_state: State | null
  expected_configuration: string; expected_connection: string; expected_microsoft_tenant: string
  expected_client_id: string; expected_home_tenant_id: string; expected_credential_reference: string
  operation_claim_id: string | null; operation_claimed_at: Date; operation_final_deadline: Date
  operation_result_connection: string | null; operation_result_digest: string | null; result_code: string
}
const reject = (reason: Rejected['reason']): Rejected => ({ status: 'rejected', reason })
function id(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('INVALID_CONSENT_ID')
  return value.toLowerCase()
}
function scope(input: ConsentScope): ConsentScope {
  if (input.flow !== 'EXISTING_TENANT') throw new Error('UNSUPPORTED_CONSENT_FLOW')
  return { organizationId: id(input.organizationId), customerTenantId: id(input.customerTenantId), flow: input.flow }
}
function key(input: ConsentOperationKey): ConsentOperationKey {
  if (typeof input.stateHash !== 'string' || !HASH.test(input.stateHash)) throw new Error('INVALID_CONSENT_STATE_HASH')
  return { ...scope(input), operationId: id(input.operationId), stateHash: input.stateHash }
}
function prepared(input: PreparedConsentResult) {
  if (input.outcome === 'FAILED') {
    if (!['CONSENT_DENIED','TENANT_MISMATCH','VERIFICATION_FAILED','MISSING_PERMISSIONS'].includes(input.code)) throw new Error('INVALID_CONSENT_RESULT')
    return { outcome: 'FAILED', code: input.code } as const
  }
  if (input.outcome !== 'SUCCEEDED' || typeof input.displayName !== 'string' || input.displayName.length < 1 ||
      input.displayName.length > 200 || (input.primaryDomain !== null && (typeof input.primaryDomain !== 'string' || input.primaryDomain.length > 253)) ||
      !Array.isArray(input.grantedPermissions) || input.grantedPermissions.length > 200 ||
      !input.grantedPermissions.every(v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,199}$/.test(v))) throw new Error('INVALID_CONSENT_RESULT')
  return { outcome: 'SUCCEEDED', displayName: input.displayName, primaryDomain: input.primaryDomain,
    grantedPermissions: [...new Set(input.grantedPermissions)].sort() } as const
}
/** Called with G already held. Parent locks protect the absent ROLE row case.
 * Do not acquire USERS or any notification rows. */
async function lockAuthority(tx: AuthorityTransaction, who: ConsentScope, microsoftTenantId: string) {
  const tenants = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM customer_tenants
    WHERE id=$1::uuid AND organization_id=$2::uuid AND microsoft_tenant_id=$3::uuid AND status<>'DISCONNECTED'
    FOR NO KEY UPDATE`, who.customerTenantId, who.organizationId, microsoftTenantId)
  if (tenants.length !== 1) return null
  const connections = await tx.$queryRawUnsafe<{ id: string; incarnation: string | null; status: string }[]>(`SELECT id,
    collection_incarnation::text AS incarnation,status FROM tenant_connections
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND connection_mode='HAWKVIEW_MANAGED'
      AND status<>'REVOKED' FOR NO KEY UPDATE`, who.customerTenantId, who.organizationId)
  if (connections.length !== 1) return null
  await tx.$queryRawUnsafe(`SELECT id FROM sync_states WHERE customer_tenant_id=$1::uuid
    AND organization_id=$2::uuid AND resource_type='DIRECTORY_ROLES' FOR UPDATE`, who.customerTenantId, who.organizationId)
  return connections[0]!
}
async function invalidateRoles(tx: AuthorityTransaction, who: ConsentScope) {
  // Retain old COMPLETE evidence with its old connection identity, never current.
  await tx.$executeRawUnsafe(`UPDATE sync_states SET role_attempt_id=NULL,role_attempt_connection=NULL,
    role_attempt_configuration=NULL,role_attempt_scope=NULL,role_attempt_started_at=NULL,role_attempt_expires_at=NULL,
    role_attempt_outcome=NULL,role_attempt_terminal_at=NULL,status='IDLE',updated_at=clock_timestamp()
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND resource_type='DIRECTORY_ROLES'`, who.customerTenantId, who.organizationId)
}
async function readOperation(tx: AuthorityTransaction, k: ConsentOperationKey, lock = true) {
  const rows = await tx.$queryRawUnsafe<Operation[]>(`SELECT * FROM microsoft_consent_attempts WHERE id=$1::uuid
    AND organization_id=$2::uuid AND customer_tenant_id=$3::uuid AND flow='EXISTING_TENANT' AND state_hash=$4 ${lock ? 'FOR UPDATE' : ''}`,
  k.operationId,k.organizationId,k.customerTenantId,k.stateHash)
  return rows[0] ?? null
}
function trusted(row: Operation | null): row is Operation { return row?.operation_version === 1 && row.operation_state !== null }
function terminal(row: Operation): ConsentTerminal | null {
  return row.operation_state && !['ISSUED','CLAIMED'].includes(row.operation_state)
    ? { state: row.operation_state as ConsentTerminal['state'], resultCode: row.result_code,
      resultingConnectionIncarnation: row.operation_result_connection } : null
}
// Eligibility compares unrounded clock_timestamp AFTER locks; storage uses milliseconds.
export const CONSENT_ENTRY_PREDICATE = 'sampled_at < expires_at'
export const CONSENT_FINAL_PREDICATE = 'sampled_at < operation_final_deadline'
export const CONSENT_CLOCK_SQL = `WITH sample AS MATERIALIZED (SELECT clock_timestamp() AS sampled_at)
  SELECT date_trunc('milliseconds',sampled_at) AS stamp,
    ${CONSENT_ENTRY_PREDICATE} AS entry_live,
    ${CONSENT_FINAL_PREDICATE} AS final_live
  FROM sample CROSS JOIN microsoft_consent_attempts WHERE id=$1::uuid`
async function clock(tx: AuthorityTransaction, operationId: string) {
  const [value] = await tx.$queryRawUnsafe<{ stamp: Date; entry_live: boolean; final_live: boolean | null }[]>(CONSENT_CLOCK_SQL, operationId)
  if (!value) throw new Error('CONSENT_OPERATION_DISAPPEARED')
  return value
}
async function endWithoutAuthority(tx: AuthorityTransaction, row: Operation, state: 'EXPIRED' | 'SUPERSEDED', at: Date): Promise<{ status: 'expired' | 'superseded'; result: ConsentTerminal }> {
  await tx.$executeRawUnsafe(`UPDATE microsoft_consent_attempts SET operation_state=$2,operation_terminal_at=$3::timestamptz,
    result_code=$2 WHERE id=$1::uuid`, row.id,state,at)
  return { status: state === 'EXPIRED' ? 'expired' : 'superseded', result: { state, resultCode: state, resultingConnectionIncarnation: null } }
}

export async function issueConsentOperation(db: AuthorityDatabase, input: ConsentScope & {
  microsoftTenantId: string; configurationRevision: string; expectedConnectionIncarnation: string | null; stateHash: string
  initiatedByUserId?: string | null
}): Promise<Rejected | { status: 'issued'; operation: ConsentOperationKey; connectionIncarnation: string; expiresAt: Date }> {
  const who = scope(input), microsoftTenantId = id(input.microsoftTenantId), configurationRevision = id(input.configurationRevision)
  const expectedConnection = input.expectedConnectionIncarnation === null ? null : id(input.expectedConnectionIncarnation)
  const stateHash = input.stateHash
  const actor = input.initiatedByUserId == null ? null : id(input.initiatedByUserId)
  if (typeof stateHash !== 'string' || !HASH.test(stateHash)) throw new Error('INVALID_CONSENT_STATE_HASH')
  const result = await withManagedAuthority(db, configurationRevision, async (tx, current) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
    // A legacy mutable credential cannot support an issuance-bound verification.
    if (current.credentialReference !== 'encrypted-secret:' + configurationRevision) return reject('UNTRUSTED')
    const connection = await lockAuthority(tx, who, microsoftTenantId)
    if (!connection) return reject('UNAVAILABLE')
    if (connection.incarnation !== expectedConnection) return reject('SUPERSEDED')
    const operationId = randomUUID(), incarnation = randomUUID()
    const [time] = await tx.$queryRawUnsafe<{ stamp: Date }[]>("SELECT date_trunc('milliseconds',clock_timestamp()) AS stamp")
    if (!time) throw new Error('CONSENT_CLOCK_UNAVAILABLE')
    const expiresAt = new Date(time.stamp.getTime() + CONSENT_ENTRY_MS)
    // Insert first so a nonce collision cannot leave authority changes behind.
    const inserted = await tx.$executeRawUnsafe(`INSERT INTO microsoft_consent_attempts
      (id,organization_id,customer_tenant_id,flow,state_hash,expires_at,created_at,operation_version,operation_state,
       expected_configuration,expected_connection,expected_microsoft_tenant,expected_client_id,expected_home_tenant_id,expected_credential_reference,initiated_by_user_id)
      VALUES($1::uuid,$2::uuid,$3::uuid,'EXISTING_TENANT',$4,$5::timestamptz,$6::timestamptz,1,'ISSUED',
        $7::uuid,$8::uuid,$9::uuid,$10::uuid,$11::uuid,$12,$13::uuid) ON CONFLICT (state_hash) DO NOTHING`,
      operationId,who.organizationId,who.customerTenantId,stateHash,expiresAt,time.stamp,configurationRevision,incarnation,
      microsoftTenantId,current.clientId,current.homeTenantId,current.credentialReference,actor)
    if (inserted !== 1) return reject('CONFLICT')
    await tx.$executeRawUnsafe(`UPDATE tenant_connections SET collection_incarnation=$2::uuid,status='PENDING_CONSENT',
      last_error_code=NULL,last_error_message=NULL,updated_at=$3::timestamptz WHERE id=$1::uuid`,connection.id,incarnation,time.stamp)
    await invalidateRoles(tx, who)
    return { status: 'issued' as const, operation: { ...who,operationId,stateHash }, connectionIncarnation: incarnation, expiresAt }
  })
  return result.status === 'current' ? result.value : reject('SUPERSEDED')
}

export async function claimConsentOperation(db: AuthorityDatabase, input: ConsentOperationKey): Promise<ClaimResult> {
  const k = key(input)
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
    const row = await readOperation(tx,k)
    if (!trusted(row)) return reject('UNTRUSTED')
    const prior = terminal(row)
    if (prior) return { status: 'terminal',result: prior }
    if (row.operation_state === 'CLAIMED') return reject('BUSY')
    const time = await clock(tx,row.id)
    if (!time.entry_live) {
      const expired = await endWithoutAuthority(tx,row,'EXPIRED',time.stamp)
      return { status: 'terminal',result: expired.result }
    }
    const claimId = randomUUID(), deadline = new Date(time.stamp.getTime() + CONSENT_FINAL_MS)
    await tx.$executeRawUnsafe(`UPDATE microsoft_consent_attempts SET operation_state='CLAIMED',operation_claim_id=$2::uuid,
      operation_claimed_at=$3::timestamptz,operation_final_deadline=$4::timestamptz,consumed_at=$3::timestamptz,
      result_code='CALLBACK_RECEIVED' WHERE id=$1::uuid`,row.id,claimId,time.stamp,deadline)
    return { status: 'claimed', context: { ...k, claimId,configurationRevision: row.expected_configuration,
      connectionIncarnation: row.expected_connection,microsoftTenantId: row.expected_microsoft_tenant,
      clientId: row.expected_client_id,homeTenantId: row.expected_home_tenant_id,credentialReference: row.expected_credential_reference,
      claimedAt: time.stamp, finalDeadline: deadline } }
  }, { isolationLevel: 'ReadCommitted' })
}

export async function finishConsentOperation(db: AuthorityDatabase, input: ConsentOperationKey & { claimId: string }, value: PreparedConsentResult): Promise<FinishResult> {
  const k = key(input), claimId = id(input.claimId), result = prepared(value)
  const digest = createHash('sha256').update(JSON.stringify(result)).digest('hex')
  // No O lock retained here: read the persisted context only to choose G first.
  const initial = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
    return readOperation(tx,k,false)
  }, { isolationLevel: 'ReadCommitted' })
  if (!trusted(initial) || initial.operation_claim_id !== claimId) return reject('UNTRUSTED')
  const replay = (row: Operation): FinishResult | null => {
    const prior = terminal(row)
    if (!prior) return null
    if (row.operation_result_digest && row.operation_result_digest !== digest) return reject('CONFLICT')
    return { status: 'replayed', result: prior }
  }
  const historical = replay(initial)
  if (historical) return historical // Historical operation result only, never new authority/effects.
  const finished = await withManagedAuthority(db, initial.expected_configuration, async (tx,current) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
    const connection = await lockAuthority(tx,k,initial.expected_microsoft_tenant)
    const row = await readOperation(tx,k)
    if (!trusted(row) || row.operation_claim_id !== claimId) return reject('UNTRUSTED')
    const prior = replay(row); if (prior) return prior
    if (row.operation_state !== 'CLAIMED') return reject('UNTRUSTED')
    const time = await clock(tx,row.id)
    if (!time.final_live) return endWithoutAuthority(tx,row,'EXPIRED',time.stamp)
    if (row.expected_microsoft_tenant !== initial.expected_microsoft_tenant || !connection || connection.incarnation !== row.expected_connection || connection.status !== 'PENDING_CONSENT' ||
        current.configurationRevision !== row.expected_configuration || current.clientId !== row.expected_client_id ||
        current.homeTenantId !== row.expected_home_tenant_id || current.credentialReference !== row.expected_credential_reference) {
      return endWithoutAuthority(tx,row,'SUPERSEDED',time.stamp)
    }
    const incarnation = randomUUID(), succeeded = result.outcome === 'SUCCEEDED'
    if (succeeded) await tx.$executeRawUnsafe(`UPDATE customer_tenants SET display_name=$2,primary_domain=$3,status='ACTIVE',updated_at=$4::timestamptz WHERE id=$1::uuid`,
      k.customerTenantId,result.displayName,result.primaryDomain,time.stamp)
    await tx.$executeRawUnsafe(`UPDATE tenant_connections SET collection_incarnation=$2::uuid,status=$3::"TenantConnectionStatus",
      consented_permissions=CASE WHEN $4::boolean THEN ARRAY(SELECT DISTINCT permission FROM unnest(
        $5::text[] || CASE WHEN 'Exchange.ManageAsAppV2'=ANY(consented_permissions)
          THEN ARRAY['Exchange.ManageAsAppV2']::text[] ELSE ARRAY[]::text[] END) permission ORDER BY permission)
        ELSE consented_permissions END,
      consented_at=CASE WHEN $4::boolean THEN $6::timestamptz ELSE consented_at END,last_verified_at=$6::timestamptz,
      last_error_code=$7,last_error_message=NULL,updated_at=$6::timestamptz WHERE id=$1::uuid`,
      connection.id,incarnation,succeeded?'CONNECTED':'ERROR',succeeded,succeeded?result.grantedPermissions:[],time.stamp,succeeded?null:result.code)
    await invalidateRoles(tx,k)
    const code = succeeded ? 'CONNECTED' : result.code
    // Capture notification occurrence identities in the terminal write's snapshot,
    // without notification locks or writes. Effects may fail/retry independently,
    // but can never adopt an occurrence first seen after terminalization.
    await tx.$executeRawUnsafe(`UPDATE microsoft_consent_attempts SET operation_state=$2,operation_terminal_at=$3::timestamptz,
      operation_result_connection=$4::uuid,operation_result_digest=$5,result_code=$6,
      operation_effects_snapshot=(SELECT jsonb_build_object('version',1,'rows',COALESCE(jsonb_agg(jsonb_build_object(
        'id',n.id,'key',n.dedupe_key,'tenant',n.customer_tenant_id,'count',n.occurrence_count,'at',n.last_occurred_at::text)
        ORDER BY n.dedupe_key),'[]'::jsonb)) FROM notifications n
        WHERE n.organization_id=$7::uuid AND n.dedupe_key IN ($8,$9)) WHERE id=$1::uuid`,
      row.id,result.outcome,time.stamp,incarnation,digest,code,k.organizationId,
      `tenant:${k.customerTenantId}:connection`,`tenant:${k.customerTenantId}:onboarding-authorized`)
    return { status: 'applied' as const, result: { state: result.outcome, resultCode: code, resultingConnectionIncarnation: incarnation } }
  })
  if (finished.status === 'current') return finished.value
  // G rejected the captured revision. O-only historical terminalization cannot
  // modify authority. No G is acquired after O, and revisions cannot be reused.
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
    const row = await readOperation(tx,k)
    if (!trusted(row) || row.operation_claim_id !== claimId) return reject('UNTRUSTED')
    const prior = replay(row); if (prior) return prior
    if (row.operation_state !== 'CLAIMED') return reject('UNTRUSTED')
    const time = await clock(tx,row.id)
    return endWithoutAuthority(tx,row,time.final_live?'SUPERSEDED':'EXPIRED',time.stamp)
  }, { isolationLevel: 'ReadCommitted' })
}
