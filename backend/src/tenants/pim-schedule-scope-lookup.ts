import type { AuthorityDatabase } from '../microsoft/managed-connector-authority.js'
import { pimPlane, pimUuid, pimRejected, type PimPlane, type PimRejection } from './pim-schedule-contract.js'
import { authorizePimRead, type PimReadAuthorization } from './pim-schedule-reader.js'

/** Scope identity a caller needs to make the next existing capture call. Deliberately carries no
 * managed credential: capturePimAttempt captures its own authority. `observedAt` marks this as a
 * snapshot — a later rotation is still expected to make the captured version stale. */
export interface PimCurrentScope {
  readonly organizationId: string
  readonly customerTenantId: string
  readonly microsoftTenantId: string
  readonly plane: PimPlane
  readonly scopeId: string
  readonly scopeIncarnation: string
  readonly scopeVersion: string
  readonly endpointDescriptor: string
  readonly projectionIdentity: string
  readonly connectionIncarnation: string
  readonly observedAt: Date
}
export type PimCurrentScopeResult =
  | { status: 'current'; scope: PimCurrentScope }
  | { status: 'no-current-scope'; plane: PimPlane }
  | PimRejection

type ScopeRow = { id: string; organization_id: string; customer_tenant_id: string; microsoft_tenant_id: string
  plane: PimPlane; scope_incarnation: string; scope_version: string
  endpoint_descriptor: string; projection_identity: string }

/** Discovers the current scope for one tenant and plane for a caller that did not perform the rotation
 * and therefore does not know the live version.
 *
 * Read-only by construction: one statement, no row locks, no scope initialization, no attempt
 * allocation, no provider call. An absent scope is reported as absent and never invented.
 *
 * This returns a snapshot, not a guarantee. capturePimAttempt remains the sole enforcement point for
 * version currency: if a rotation lands between this lookup and that capture, capture still rejects
 * SCOPE_REPLACED. Nothing here weakens that comparison, and no automatic re-lookup loop is provided —
 * a caller may deliberately request a fresh snapshot after a refusal.
 *
 * Supplying PimReadAuthorization from the real authenticated boundary remains an activation
 * dependency, exactly as it does for readPimSchedulePlane. */
export async function readCurrentPimScope(db: AuthorityDatabase, authorization: PimReadAuthorization,
  request: { customerTenantId: string; plane: PimPlane }): Promise<PimCurrentScopeResult> {
  const tenantId = pimUuid(request.customerTenantId), plane = pimPlane(request.plane)
  // Throws PIM_FORBIDDEN before any database access.
  const auth = authorizePimRead(authorization, tenantId)
  return db.$transaction(async tx => {
    // Organization, tenant, Microsoft-tenant and plane isolation are enforced by this statement's
    // predicates, not by a post-check: a row that fails any of them is never returned, so a
    // subsequent comparison on the same fields could not fire.
    const results = await tx.$queryRawUnsafe<{ observedAt: Date; microsoftTenantId: string
      connections: (string | null)[] | null; scope: ScopeRow | null }[]>(`/* pim:scope-lookup */
      SELECT clock_timestamp() AS "observedAt",
        t.microsoft_tenant_id AS "microsoftTenantId",
        (SELECT jsonb_agg(c.collection_incarnation::text) FROM tenant_connections c
          WHERE c.customer_tenant_id=t.id AND c.organization_id=t.organization_id
            AND c.status='CONNECTED' AND c.connection_mode='HAWKVIEW_MANAGED') AS connections,
        (SELECT to_jsonb(s) FROM pim_schedule_scopes s
          WHERE s.customer_tenant_id=t.id AND s.organization_id=t.organization_id
            AND s.microsoft_tenant_id=t.microsoft_tenant_id
            AND s.plane=$3::pim_schedule_plane AND s.is_current) AS scope
      FROM customer_tenants t
      WHERE t.id=$1::uuid AND t.organization_id=$2::uuid AND t.status='ACTIVE'`,
    tenantId, auth.organizationId, plane)
    const data = results[0]
    if (!data) return pimRejected('TENANT_MISMATCH')
    // Exactly one connected managed connection, matching the existing capture prelude's requirement.
    const connections = data.connections ?? []
    const connectionIncarnation = connections.length === 1 ? connections[0] : null
    if (!connectionIncarnation) return pimRejected('INCARNATION_CHANGED')
    if (!data.scope) return { status: 'no-current-scope' as const, plane }
    const s = data.scope
    return {
      status: 'current' as const,
      scope: Object.freeze({
        organizationId: s.organization_id, customerTenantId: s.customer_tenant_id,
        microsoftTenantId: s.microsoft_tenant_id, plane: s.plane,
        scopeId: s.id, scopeIncarnation: s.scope_incarnation, scopeVersion: s.scope_version,
        endpointDescriptor: s.endpoint_descriptor, projectionIdentity: s.projection_identity,
        connectionIncarnation, observedAt: new Date(data.observedAt),
      }),
    }
  }, { isolationLevel: 'ReadCommitted' })
}
