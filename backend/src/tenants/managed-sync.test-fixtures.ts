import assert from 'node:assert/strict'
import { utcTestDatabase } from '../identity-risk/risk-utc.test-fixtures.js'
import type { ManagedAuthority } from '../microsoft/managed-connector-authority.js'

interface ManagedSyncTenant {
  id: string; organizationId: string; microsoftTenantId: string; status: string
  connection: { status: string; connectionMode: string }
}
const authority: ManagedAuthority = {
  configurationRevision: '11111111-1111-4111-8111-111111111111',
  clientId: '22222222-2222-4222-8222-222222222222',
  homeTenantId: '33333333-3333-4333-8333-333333333333',
  credentialReference: 'encrypted-secret:11111111-1111-4111-8111-111111111111',
}
const connectionId = '44444444-4444-4444-8444-444444444444'
const incarnation = '55555555-5555-4555-8555-555555555555'
const normalize = (sql: string) => sql.trim().replace(/\s+/g, ' ')
const queries = {
  lock: 'SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(hashtextextended($1, 0))',
  authority: `SELECT configuration_revision::text AS "configurationRevision", client_id::text AS "clientId",
    home_tenant_id::text AS "homeTenantId", credential_reference AS "credentialReference",
    configuration_operation_id::text AS "operationId", publication_fingerprint AS fingerprint
    FROM platform_microsoft_connectors WHERE id = 'default' FOR SHARE`,
  tenant: `/* verification:tenant */ SELECT id, organization_id AS "organizationId",
    microsoft_tenant_id AS "microsoftTenantId", status, updated_at::text AS revision FROM customer_tenants
    WHERE id=$1::uuid AND organization_id=$2::uuid AND microsoft_tenant_id=$3::uuid FOR NO KEY UPDATE`,
  connection: `/* verification:connection */ SELECT id,
    collection_incarnation::text AS incarnation, connection_mode AS mode, client_id AS "clientId",
    credential_reference AS "credentialReference", consented_permissions AS permissions, status, updated_at::text AS revision
    FROM tenant_connections WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid FOR NO KEY UPDATE`,
  scope: `/* verification:scope */ SELECT role_scope_incarnation::text AS incarnation,role_scope_version AS version FROM sync_states
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND resource_type='DIRECTORY_ROLES' FOR UPDATE`,
  refresh: `/* verification:refresh */ UPDATE tenant_connections
    SET last_verified_at=clock_timestamp(),updated_at=clock_timestamp(),
    consented_at=CASE WHEN $5::boolean THEN clock_timestamp() ELSE consented_at END,
    consented_permissions=$6::text[],collection_incarnation=$7::uuid
    WHERE id=$1::uuid AND customer_tenant_id=$2::uuid AND organization_id=$3::uuid
    AND collection_incarnation IS NOT DISTINCT FROM $4::uuid RETURNING updated_at::text AS revision`,
}

/** Only the managed capture and timestamp-refresh SQL used by collector tests.
 * This is an in-memory adapter, not evidence of database locking/CAS behavior.
 * All other SQL still hits the strict UTC fixture; no production path is replaced.
 */
export function managedSyncTestDatabase<T extends object & {
  tenantConnection?: { update: (args: any) => Promise<unknown> }
}>(database: T, tenant: ManagedSyncTenant) {
  assert.equal(tenant.connection.connectionMode, 'HAWKVIEW_MANAGED')
  const db = utcTestDatabase(database)
  const utcQuery = db.$queryRawUnsafe
  let connectionRevision = 0
  return Object.assign(db, {
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
      switch (normalize(sql)) {
        case queries.lock:
          assert.deepEqual(values, ['hawkview:managed-connector:default:authority:v1'])
          return [{ locked: 1 }]
        case normalize(queries.authority):
          assert.deepEqual(values, [])
          return [{ ...authority, operationId: null, fingerprint: null }]
        case normalize(queries.tenant):
          assert.deepEqual(values, [tenant.id, tenant.organizationId, tenant.microsoftTenantId])
          return [{ id: tenant.id, organizationId: tenant.organizationId, microsoftTenantId: tenant.microsoftTenantId,
            status: tenant.status, revision: 'tenant-revision' }]
        case normalize(queries.connection):
          assert.deepEqual(values, [tenant.id, tenant.organizationId])
          return [{ id: connectionId, incarnation, mode: tenant.connection.connectionMode, clientId: null,
            credentialReference: null, permissions: [], status: tenant.connection.status, revision: String(connectionRevision) }]
        case normalize(queries.scope):
          assert.deepEqual(values, [tenant.id, tenant.organizationId])
          return [] // These collector fixtures have no directory-role opt-in.
        case normalize(queries.refresh):
          assert.deepEqual(values, [connectionId, tenant.id, tenant.organizationId, incarnation, false, [], incarnation])
          assert.ok(database.tenantConnection, 'The collector fixture must observe connection refresh writes')
          // Feed the SQL write into the existing fixture's write spy. Its tenant
          // assertions and event ordering remain observable after the API change.
          await database.tenantConnection.update({
            where: { customerTenantId_organizationId: { customerTenantId: tenant.id, organizationId: tenant.organizationId } },
            data: { lastVerifiedAt: new Date() },
          })
          return [{ revision: String(++connectionRevision) }]
        default:
          assert.deepEqual(values, [])
          return utcQuery(sql)
      }
    },
  })
}

export function managedSyncTestToken(tenant: Pick<ManagedSyncTenant, 'microsoftTenantId'>, token = 'token') {
  return async (captured: ManagedAuthority, microsoftTenantId: string) => {
    assert.deepEqual(captured, authority)
    assert.equal(microsoftTenantId, tenant.microsoftTenantId)
    return token
  }
}
