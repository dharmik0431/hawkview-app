import type { AuthorityDatabase, AuthorityTransaction } from '../microsoft/managed-connector-authority.js'

interface TenantRow {
  id: string; organizationId: string; microsoftTenantId: string; status: string; revision: string
}
interface ConnectionRow {
  id: string; incarnation: string | null; mode: string; clientId: string | null
  credentialReference: string | null; permissions: readonly string[]; status: string; revision: string
}
export interface CapturedCustomerVerification {
  readonly tenant: Readonly<TenantRow>
  readonly connection: Readonly<ConnectionRow>
}
export type CustomerVerificationPublication =
  | { outcome: 'verified'; displayName: string; primaryDomain: string | null;
      grantedPermissions: readonly string[]; missingRequiredPermissions: readonly string[] }
  | { outcome: 'failed'; message: string }

/** Thrown inside publication so even a matched connection write rolls back. */
export class CustomerConnectionVerificationSuperseded extends Error {
  constructor() { super('CONNECTION_VERIFICATION_SUPERSEDED') }
}

async function lockCustomerContext(tx: AuthorityTransaction,
  who: { customerTenantId: string; organizationId: string; microsoftTenantId: string },
): Promise<CapturedCustomerVerification | null> {
  const tenants = await tx.$queryRawUnsafe<TenantRow[]>(`/* customer-fence:tenant-lock */
    SELECT id, organization_id AS "organizationId", microsoft_tenant_id AS "microsoftTenantId",
      status, updated_at::text AS revision FROM customer_tenants
    WHERE id=$1::uuid AND organization_id=$2::uuid AND microsoft_tenant_id=$3::uuid FOR NO KEY UPDATE`,
  who.customerTenantId, who.organizationId, who.microsoftTenantId)
  if (tenants.length !== 1 || tenants[0].status === 'DISCONNECTED') return null
  const connections = await tx.$queryRawUnsafe<ConnectionRow[]>(`/* customer-fence:connection-lock */
    SELECT id, collection_incarnation::text AS incarnation, connection_mode AS mode,
      client_id AS "clientId", credential_reference AS "credentialReference",
      consented_permissions AS permissions, status, updated_at::text AS revision FROM tenant_connections
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid FOR NO KEY UPDATE`,
  who.customerTenantId, who.organizationId)
  if (connections.length !== 1 || connections[0].mode !== 'CUSTOMER_MANAGED'
    || connections[0].status === 'REVOKED') return null
  return { tenant: tenants[0], connection: connections[0] }
}

/** Captures only T -> C. Secret resolution and provider work belong outside this transaction.
 * This fences connection-row identity, not value replacement behind an unchanged secret reference. */
export async function captureCustomerConnectionVerification(db: AuthorityDatabase,
  input: { customerTenantId: string; organizationId: string; microsoftTenantId: string },
): Promise<CapturedCustomerVerification | null> {
  const who = { ...input }
  return db.$transaction(async tx => {
    const locked = await lockCustomerContext(tx, who)
    return locked && Object.freeze({
      tenant: Object.freeze({ ...locked.tenant }),
      connection: Object.freeze({ ...locked.connection, permissions: Object.freeze([...locked.connection.permissions]) }),
    })
  }, { isolationLevel: 'ReadCommitted' })
}

function sameNonRevisionKeys(current: CapturedCustomerVerification, expected: CapturedCustomerVerification) {
  const t = expected.tenant, c = expected.connection
  return current.tenant.id === t.id && current.tenant.organizationId === t.organizationId
    && current.tenant.microsoftTenantId === t.microsoftTenantId && current.tenant.status === t.status
    && current.connection.id === c.id && current.connection.incarnation === c.incarnation
    && current.connection.mode === c.mode && current.connection.clientId === c.clientId
    && current.connection.credentialReference === c.credentialReference && current.connection.status === c.status
    && JSON.stringify(current.connection.permissions) === JSON.stringify(c.permissions)
}

export async function publishCustomerConnectionVerification(db: AuthorityDatabase,
  captured: CapturedCustomerVerification, input: CustomerVerificationPublication,
): Promise<{ connected: boolean }> {
  const expected = {
    tenant: { ...captured.tenant },
    connection: { ...captured.connection, permissions: [...captured.connection.permissions] },
  }
  const result = input.outcome === 'failed' ? { ...input, message: input.message.slice(0, 2000) }
    : { ...input, grantedPermissions: [...input.grantedPermissions], missingRequiredPermissions: [...input.missingRequiredPermissions] }
  return db.$transaction(async tx => {
    const t = expected.tenant, c = expected.connection
    const current = await lockCustomerContext(tx, {
      customerTenantId: t.id, organizationId: t.organizationId, microsoftTenantId: t.microsoftTenantId,
    })
    if (!current || !sameNonRevisionKeys(current, expected)) throw new CustomerConnectionVerificationSuperseded()
    const connected = result.outcome === 'verified' && result.missingRequiredPermissions.length === 0
    const permissions = result.outcome === 'verified'
      ? [...new Set([...result.grantedPermissions, ...c.permissions.filter(permission => permission === 'Exchange.ManageAsAppV2')])]
      : []
    const code = result.outcome === 'failed' ? 'connection-verification-failed' : connected ? null : 'missing-permissions'
    const message = result.outcome === 'failed' ? result.message : connected ? null
      : `Missing connection-required permissions: ${result.missingRequiredPermissions.join(', ')}`
    // SQL is the sole revision guard. Exact text preserves microseconds; differing session
    // timestamp rendering can conservatively conflict. No managed authority or roles locks.
    const connectionWrites = await tx.$executeRawUnsafe(`/* customer-fence:publish-connection */
      UPDATE tenant_connections SET status=$5::"TenantConnectionStatus", consented_permissions=$6::text[],
        last_verified_at=clock_timestamp(), last_error_code=$7, last_error_message=$8, updated_at=clock_timestamp()
      WHERE id=$1::uuid AND customer_tenant_id=$2::uuid AND organization_id=$3::uuid
        AND updated_at::text = $4`,
    c.id, t.id, t.organizationId, c.revision, connected ? 'CONNECTED' : 'ERROR', permissions, code, message)
    if (connectionWrites !== 1) throw new CustomerConnectionVerificationSuperseded()
    const tenantWrites = await tx.$executeRawUnsafe(`/* customer-fence:publish-tenant */
      UPDATE customer_tenants SET status=$5::"CustomerTenantStatus",
        display_name=CASE WHEN $6::boolean THEN $7 ELSE display_name END,
        primary_domain=CASE WHEN $6::boolean THEN $8 ELSE primary_domain END, updated_at=clock_timestamp()
      WHERE id=$1::uuid AND organization_id=$2::uuid AND microsoft_tenant_id=$3::uuid
        AND updated_at::text = $4`,
    t.id, t.organizationId, t.microsoftTenantId, t.revision, connected ? 'ACTIVE' : 'SUSPENDED', result.outcome === 'verified',
    result.outcome === 'verified' ? result.displayName : null, result.outcome === 'verified' ? result.primaryDomain : null)
    if (tenantWrites !== 1) throw new CustomerConnectionVerificationSuperseded()
    return { connected }
  }, { isolationLevel: 'ReadCommitted' })
}
