import { INITIAL_SYNC_RESOURCE_TYPES } from './initial-sync-status.js'
import {
  validateInitialSyncCompletionProjection,
  type InitialSyncProjectionValidation,
} from './initial-sync-proof-projection.js'

export type InitialSyncProofScope = Readonly<{
  organizationId: string
  customerTenantId: string
}>

const resourceTypes = Object.freeze([...INITIAL_SYNC_RESOURCE_TYPES])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const validId = (value: unknown): value is string => typeof value === 'string' &&
  UUID.test(value) && value !== '00000000-0000-0000-0000-000000000000'

// These expressions receive only the fixed column names below, never caller
// input. Guard the AD transport range before formatting: YYYY alone aliases BC
// years to the same positive text and cannot certify the mapper's time range.
const transportTimeValid = (column: string) => `(${column} IS NOT NULL
    AND isfinite(${column})
    AND ${column} >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
    AND ${column} < TIMESTAMPTZ '10000-01-01 00:00:00+00')`
const utcText = (column: string) => `CASE WHEN ${transportTimeValid(column)} THEN
    to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ELSE NULL END`

/** Unused coherent snapshot query. Its thirteen expected slots preserve absent
 * or failed state instead of substituting historical success. No locks, writes
 * or ownership reservation occur here; a successful read cannot authorize a
 * later notice mutation. The injected executor must return raw row arrays.
 */
export const INITIAL_SYNC_PROOF_QUERY = `
WITH observation AS MATERIALIZED (
  SELECT statement_timestamp() AS observed_at
), expected(resource_type, ordinal) AS (
  VALUES ${resourceTypes.map((_, index) => `($${index + 3}::public."SyncResourceType", ${index + 1})`).join(',\n    ')}
)
SELECT
  tenant.organization_id::text AS "organizationId",
  tenant.id::text AS "customerTenantId",
  tenant.status::text AS "tenantStatus",
  connection.id::text AS "connectionId",
  connection.organization_id::text AS "connectionOrganizationId",
  connection.customer_tenant_id::text AS "connectionCustomerTenantId",
  connection.status::text AS "connectionStatus",
  connection.connection_mode::text AS "connectionMode",
  connection.initial_sync_epoch_id::text AS "initialSyncEpochId",
  ${utcText('connection.initial_sync_epoch_started_at')} AS "epochStartedAtUtc",
  ${utcText('observation.observed_at')} AS "observedAtUtc",
  (${transportTimeValid('connection.initial_sync_epoch_started_at')}
    AND ${transportTimeValid('observation.observed_at')}
    AND connection.initial_sync_epoch_started_at <= observation.observed_at) IS TRUE AS "contextTimeValid",
  expected.resource_type::text AS "expectedResourceType",
  state.id::text AS "stateId",
  state.organization_id::text AS "stateOrganizationId",
  state.customer_tenant_id::text AS "stateCustomerTenantId",
  state.resource_type::text AS "stateResourceType",
  state.initial_sync_attempt_epoch_id::text AS "initialSyncAttemptEpochId",
  state.initial_sync_attempt_id::text AS "initialSyncAttemptId",
  state.initial_sync_persisted_attempt_id::text AS "initialSyncPersistedAttemptId",
  state.initial_sync_completed_attempt_id::text AS "initialSyncCompletedAttemptId",
  state.initial_sync_persisted_kind AS "initialSyncPersistedKind",
  state.status::text AS "status",
  ${utcText('state.last_attempt_at')} AS "lastAttemptAtUtc",
  ${utcText('state.last_successful_at')} AS "lastSuccessfulAtUtc",
  state.last_error_code AS "lastErrorCode",
  state.last_error_message AS "lastErrorMessage",
  (state.id IS NOT NULL
    AND ${transportTimeValid('connection.initial_sync_epoch_started_at')}
    AND ${transportTimeValid('observation.observed_at')}
    AND ${transportTimeValid('state.last_attempt_at')}
    AND ${transportTimeValid('state.last_successful_at')}
    AND state.last_attempt_at >= connection.initial_sync_epoch_started_at
    AND state.last_successful_at >= state.last_attempt_at
    AND state.last_successful_at <= observation.observed_at) IS TRUE AS "proofTimeValid"
FROM public.customer_tenants AS tenant
CROSS JOIN expected
CROSS JOIN observation
LEFT JOIN public.tenant_connections AS connection
  ON connection.organization_id = tenant.organization_id
  AND connection.customer_tenant_id = tenant.id
LEFT JOIN public.sync_states AS state
  ON state.organization_id = tenant.organization_id
  AND state.customer_tenant_id = tenant.id
  AND state.resource_type = expected.resource_type
WHERE tenant.organization_id = $1::uuid AND tenant.id = $2::uuid
ORDER BY expected.ordinal
`

export async function readInitialSyncProof(
  scope: InitialSyncProofScope,
  query: (sql: string, values: readonly string[]) => Promise<unknown>,
): Promise<InitialSyncProjectionValidation> {
  // Read the caller's fields once before the asynchronous boundary. A caller
  // retaining a mutable scope object must not relabel a completed query result.
  const capturedScope = Object.freeze({
    organizationId: scope?.organizationId,
    customerTenantId: scope?.customerTenantId,
  })
  if (!validId(capturedScope.organizationId) || !validId(capturedScope.customerTenantId)) {
    return validateInitialSyncCompletionProjection(capturedScope, null)
  }
  const values = Object.freeze([
    capturedScope.organizationId, capturedScope.customerTenantId, ...resourceTypes,
  ])
  const output = await query(INITIAL_SYNC_PROOF_QUERY, values)
  return validateInitialSyncCompletionProjection(capturedScope, output)
}
