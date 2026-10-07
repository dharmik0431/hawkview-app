import { randomUUID } from 'node:crypto'
import { captureManagedAuthority, type AuthorityDatabase, type AuthorityTransaction,
  type ManagedAuthority } from '../microsoft/managed-connector-authority.js'

interface TenantRow { id: string; organizationId: string; microsoftTenantId: string; status: string; revision: string }
interface ConnectionRow {
  id: string; incarnation: string | null; mode: string; clientId: string | null
  credentialReference: string | null; permissions: string[]; status: string; revision: string
}
export interface CapturedConnectionVerification {
  readonly tenant: Readonly<TenantRow>
  readonly connection: Readonly<Omit<ConnectionRow, 'permissions'> & { permissions: readonly string[] }>
  readonly authority: Readonly<ManagedAuthority>
  readonly directoryScope?: Readonly<{ incarnation: string | null; version: string | null }>
}
type Refused = { status: 'unavailable' | 'superseded'; reason: string }
export type VerificationPublication =
  | { outcome: 'verified'; displayName: string; primaryDomain: string | null; grantedPermissions: readonly string[]; missingRequiredPermissions: readonly string[]; consented?: boolean }
  | { outcome: 'failed'; message: string; authenticationFailure?: boolean }

// Hold the existing nullable G lock through T/C, including bootstrap absence.
async function lockContext(tx: AuthorityTransaction, who: { customerTenantId: string; organizationId: string; microsoftTenantId: string }) {
  const authority = await captureManagedAuthority({ $transaction: work => work(tx) })
  const tenants = await tx.$queryRawUnsafe<TenantRow[]>(`/* verification:tenant */ SELECT id, organization_id AS "organizationId",
    microsoft_tenant_id AS "microsoftTenantId", status, updated_at::text AS revision FROM customer_tenants
    WHERE id=$1::uuid AND organization_id=$2::uuid AND microsoft_tenant_id=$3::uuid FOR NO KEY UPDATE`,
  who.customerTenantId, who.organizationId, who.microsoftTenantId)
  if (tenants.length !== 1 || tenants[0].status === 'DISCONNECTED') return null
  const connections = await tx.$queryRawUnsafe<ConnectionRow[]>(`/* verification:connection */ SELECT id,
    collection_incarnation::text AS incarnation, connection_mode AS mode, client_id AS "clientId",
    credential_reference AS "credentialReference", consented_permissions AS permissions, status, updated_at::text AS revision
    FROM tenant_connections WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid FOR NO KEY UPDATE`,
  who.customerTenantId, who.organizationId)
  if (connections.length !== 1 || connections[0].status === 'REVOKED') return null
  return { tenant: tenants[0], connection: connections[0], authority }
}

export async function captureConnectionVerification(db: AuthorityDatabase,
  input: { customerTenantId: string; organizationId: string; microsoftTenantId: string }, includeDirectoryScope = false
): Promise<Refused | { status: 'captured'; context: CapturedConnectionVerification }> {
  const who = { ...input }
  return db.$transaction(async tx => {
    const locked = await lockContext(tx, who)
    if (!locked) return { status: 'unavailable', reason: 'CONNECTION_UNAVAILABLE' }
    if (locked.connection.mode !== 'HAWKVIEW_MANAGED') {
      // No versioned tenant-secret capture/CAS exists. Never adopt a mutable secret.
      return { status: 'unavailable', reason: 'CUSTOMER_CREDENTIAL_CAPTURE_UNAVAILABLE' }
    }
    const a = locked.authority
    if (!a || !a.configurationRevision || a.credentialReference !== `encrypted-secret:${a.configurationRevision}`) {
      return { status: 'unavailable', reason: 'MANAGED_CREDENTIAL_CAPTURE_UNAVAILABLE' }
    }
    return { status: 'captured', context: Object.freeze({
      tenant: Object.freeze({ ...locked.tenant }),
      connection: Object.freeze({ ...locked.connection, permissions: Object.freeze([...locked.connection.permissions]) }),
      authority: Object.freeze({ ...a }),
      ...(includeDirectoryScope ? { directoryScope: Object.freeze(await readDirectoryScope(tx, who)) } : {}),
    }) }
  }, { isolationLevel: 'ReadCommitted' })
}

async function readDirectoryScope(tx: AuthorityTransaction, who: { customerTenantId: string; organizationId: string }) {
  const rows = await tx.$queryRawUnsafe<{ incarnation: string | null; version: string | null }[]>(
    `/* verification:scope */ SELECT role_scope_incarnation::text AS incarnation,role_scope_version AS version FROM sync_states
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND resource_type='DIRECTORY_ROLES' FOR UPDATE`,
    who.customerTenantId,who.organizationId)
  return rows[0] ?? { incarnation: null, version: null }
}
function sameCapturedContext(locked: NonNullable<Awaited<ReturnType<typeof lockContext>>>, expected: CapturedConnectionVerification) {
  const t = expected.tenant, c = expected.connection
  return (Object.keys(t) as (keyof TenantRow)[]).every(key => locked.tenant[key] === t[key])
    && (Object.keys(c) as (keyof ConnectionRow)[]).every(key => key === 'permissions'
      ? JSON.stringify(locked.connection.permissions) === JSON.stringify(c.permissions) : locked.connection[key] === c[key])
    && locked.authority !== null && (Object.keys(expected.authority) as (keyof ManagedAuthority)[])
      .every(key => locked.authority![key] === expected.authority[key])
}
async function sameCapturedScope(tx: AuthorityTransaction, expected: CapturedConnectionVerification) {
  if (!expected.directoryScope) return true
  const current = await readDirectoryScope(tx, { customerTenantId: expected.tenant.id, organizationId: expected.tenant.organizationId })
  return current.incarnation === expected.directoryScope.incarnation && current.version === expected.directoryScope.version
}

export async function publishConnectionVerification(db: AuthorityDatabase, captured: CapturedConnectionVerification,
  input: VerificationPublication
): Promise<Refused | { status: 'applied'; connected: boolean }> {
  const expected = { tenant: { ...captured.tenant }, connection: { ...captured.connection, permissions: [...captured.connection.permissions] }, authority: { ...captured.authority },
    ...(captured.directoryScope ? { directoryScope: { ...captured.directoryScope } } : {}) }
  const result = input.outcome === 'failed' ? { ...input, message: input.message.slice(0, 2000) }
    : { ...input, grantedPermissions: [...input.grantedPermissions], missingRequiredPermissions: [...input.missingRequiredPermissions] }
  return db.$transaction(async tx => {
    const t = expected.tenant, c = expected.connection
    const locked = await lockContext(tx, { customerTenantId: t.id, organizationId: t.organizationId, microsoftTenantId: t.microsoftTenantId })
    if (!locked) return { status: 'superseded', reason: 'CONNECTION_CHANGED' }
    if (!sameCapturedContext(locked, expected) || !await sameCapturedScope(tx, expected)) {
      return { status: 'superseded', reason: 'CONNECTION_CHANGED' }
    }
    // G -> T -> C -> DIRECTORY_ROLES; no provider work or other resource locks.
    await tx.$queryRawUnsafe(`/* verification:roles */ SELECT id FROM sync_states WHERE customer_tenant_id=$1::uuid
      AND organization_id=$2::uuid AND resource_type='DIRECTORY_ROLES' FOR UPDATE`, t.id, t.organizationId)
    const connected = result.outcome === 'verified' && result.missingRequiredPermissions.length === 0
    const permissions = result.outcome === 'verified'
      ? [...new Set([...result.grantedPermissions, ...c.permissions.filter(p => p === 'Exchange.ManageAsAppV2')])]
      : result.authenticationFailure ? [...c.permissions] : []
    const code = result.outcome === 'failed'
      ? result.authenticationFailure ? 'MICROSOFT_AUTHENTICATION_REQUIRED' : 'connection-verification-failed'
      : connected ? null : 'missing-permissions'
    const message = result.outcome === 'failed' ? result.message : connected ? null
      : `Missing connection-required permissions: ${result.missingRequiredPermissions.join(', ')}`
    const tenantWrites = await tx.$executeRawUnsafe(`/* verification:publish-tenant */ UPDATE customer_tenants
      SET status=$4::"CustomerTenantStatus", display_name=CASE WHEN $5::boolean THEN $6 ELSE display_name END,
      primary_domain=CASE WHEN $5::boolean THEN $7 ELSE primary_domain END, updated_at=clock_timestamp()
      WHERE id=$1::uuid AND organization_id=$2::uuid AND microsoft_tenant_id=$3::uuid`,
    t.id, t.organizationId, t.microsoftTenantId, connected ? 'ACTIVE' : 'SUSPENDED', result.outcome === 'verified',
    result.outcome === 'verified' ? result.displayName : null, result.outcome === 'verified' ? result.primaryDomain : null)
    const connectionWrites = await tx.$executeRawUnsafe(`/* verification:publish-connection */ UPDATE tenant_connections
      SET collection_incarnation=$5::uuid,status=$6::"TenantConnectionStatus",consented_permissions=$7::text[],
      last_verified_at=clock_timestamp(),last_error_code=$8,last_error_message=$9,updated_at=clock_timestamp(),
      consented_at=CASE WHEN $10::boolean THEN clock_timestamp() ELSE consented_at END
      WHERE id=$1::uuid AND customer_tenant_id=$2::uuid AND organization_id=$3::uuid
      AND collection_incarnation IS NOT DISTINCT FROM $4::uuid`,
    c.id, t.id, t.organizationId, c.incarnation, randomUUID(), connected ? 'CONNECTED' : 'ERROR', permissions, code, message,
    result.outcome === 'verified' && result.consented === true)
    if (tenantWrites !== 1 || connectionWrites !== 1) throw new Error('CONNECTION_VERIFICATION_PUBLICATION_CONFLICT')
    // Clear only the in-flight attempt. Durable scope opt-in and all completed
    // receipt/snapshot evidence remain untouched, including any denial metadata.
    await tx.$executeRawUnsafe(`/* verification:invalidate-roles */ UPDATE sync_states SET
      role_attempt_id=NULL,role_attempt_connection=NULL,role_attempt_configuration=NULL,role_attempt_scope=NULL,
      role_attempt_started_at=NULL,role_attempt_expires_at=NULL,role_attempt_outcome=NULL,role_attempt_terminal_at=NULL,
      status='IDLE',updated_at=clock_timestamp()
      WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND resource_type='DIRECTORY_ROLES'`, t.id, t.organizationId)
    return { status: 'applied', connected }
  }, { isolationLevel: 'ReadCommitted' })
}

/** Only the shared timestamp and optional Exchange grant callers use this path.
 * No arbitrary effects/callbacks execute under the authority locks. */
export async function publishCapturedConnectionRefresh(db: AuthorityDatabase, captured: CapturedConnectionVerification,
  effect: 'sync-timestamp' | 'exchange-consent'): Promise<Refused | { status: 'applied'; context: CapturedConnectionVerification }> {
  const expected = structuredClone(captured)
  if (!expected.directoryScope || !['sync-timestamp','exchange-consent'].includes(effect)) throw new Error('INVALID_CAPTURED_REFRESH')
  return db.$transaction(async tx => {
    const t = expected.tenant, c = expected.connection
    const locked = await lockContext(tx, { customerTenantId: t.id, organizationId: t.organizationId, microsoftTenantId: t.microsoftTenantId })
    if (!locked || !sameCapturedContext(locked,expected) || !await sameCapturedScope(tx,expected)) {
      return { status: 'superseded', reason: 'CONNECTION_CHANGED' }
    }
    const changed = effect === 'exchange-consent' && !locked.connection.permissions.includes('Exchange.ManageAsAppV2')
    const incarnation = changed ? randomUUID() : c.incarnation
    const permissions = changed ? [...locked.connection.permissions,'Exchange.ManageAsAppV2'] : locked.connection.permissions
    const rows = await tx.$queryRawUnsafe<{ revision: string }[]>(`/* verification:refresh */ UPDATE tenant_connections
      SET last_verified_at=clock_timestamp(),updated_at=clock_timestamp(),
      consented_at=CASE WHEN $5::boolean THEN clock_timestamp() ELSE consented_at END,
      consented_permissions=$6::text[],collection_incarnation=$7::uuid
      WHERE id=$1::uuid AND customer_tenant_id=$2::uuid AND organization_id=$3::uuid
      AND collection_incarnation IS NOT DISTINCT FROM $4::uuid RETURNING updated_at::text AS revision`,c.id,t.id,t.organizationId,c.incarnation,
      effect === 'exchange-consent', permissions, incarnation)
    if (rows.length !== 1) throw new Error('CONNECTION_REFRESH_CONFLICT')
    if (changed) await tx.$executeRawUnsafe(`/* verification:invalidate-roles */ UPDATE sync_states SET
      role_attempt_id=NULL,role_attempt_connection=NULL,role_attempt_configuration=NULL,role_attempt_scope=NULL,
      role_attempt_started_at=NULL,role_attempt_expires_at=NULL,role_attempt_outcome=NULL,role_attempt_terminal_at=NULL,
      status='IDLE',updated_at=clock_timestamp()
      WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND resource_type='DIRECTORY_ROLES'`,t.id,t.organizationId)
    return { status: 'applied', context: { ...expected, connection: { ...c, incarnation, permissions, revision: rows[0].revision } } }
  }, { isolationLevel: 'ReadCommitted' })
}
