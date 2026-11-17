import {
  captureInitialSyncTerminalOperation,
  classifyInitialSyncTerminalEvidence,
  type InitialSyncTerminalEvidence,
} from './initial-sync-terminal-evidence.js'

// Only fixed column expressions below reach this builder. Preserve true NULL
// separately from nonfinite/out-of-transport-range data: persisted-only permits
// a missing old success timestamp, but must never accept a malformed one.
const utcText = (column: string) => `CASE WHEN ${column} IS NULL THEN NULL
  WHEN isfinite(${column})
    AND ${column} >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
    AND ${column} < TIMESTAMPTZ '10000-01-01 00:00:00+00'
  THEN to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ELSE 'INVALID_TIMESTAMP' END`

/** Unused single-statement observation, never a lock or mutation certificate.
 * Query current scoped storage, not captured connection/E/A, so replacements
 * stay visible. Do not hide absent/failed/duplicate/legacy rows behind filters.
 */
export const INITIAL_SYNC_TERMINAL_READBACK_QUERY = `
WITH observation AS MATERIALIZED (
  SELECT statement_timestamp() AS observed_at
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
  ($3::public."SyncResourceType")::text AS "expectedResourceType",
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
  state.last_error_message AS "lastErrorMessage"
FROM public.customer_tenants AS tenant
CROSS JOIN observation
LEFT JOIN public.tenant_connections AS connection
  ON connection.organization_id = tenant.organization_id
  AND connection.customer_tenant_id = tenant.id
LEFT JOIN public.sync_states AS state
  ON state.organization_id = tenant.organization_id
  AND state.customer_tenant_id = tenant.id
  AND state.resource_type = $3::public."SyncResourceType"
WHERE tenant.organization_id = $1::uuid AND tenant.id = $2::uuid
`

export type InitialSyncTerminalReadback = InitialSyncTerminalEvidence |
  Readonly<{ kind: 'UNKNOWN'; reason: 'READ_UNAVAILABLE' }>

/** UNUSED adapter. The future executor must use a healthy authoritative,
 * read-only database path and enforce the existing remaining execution budget.
 * It must not use an aborted/original uncertain transaction or stale snapshot.
 * This injected callback cannot prove those properties. No new timeout, race,
 * retry, cancellation, provider call or ownership protocol is installed here.
 * Caller must retain the original operation error; read failure cannot replace
 * it with a collection failure, nor grant a state/notice effect. Physical SQL,
 * role visibility, transport and original-operation settlement remain unproved.
 */
export async function readInitialSyncTerminalEvidence(
  operation: unknown,
  query: (sql: string, values: readonly string[]) => Promise<unknown>,
): Promise<InitialSyncTerminalReadback> {
  const captured = captureInitialSyncTerminalOperation(operation)
  if (!captured) return Object.freeze({ kind: 'UNKNOWN', reason: 'INVALID_OPERATION' })
  const values = Object.freeze([captured.organizationId, captured.customerTenantId, captured.resourceType])
  let output: unknown
  try {
    output = await query(INITIAL_SYNC_TERMINAL_READBACK_QUERY, values)
  } catch {
    // Never reflect transport errors (which may contain secrets) into results,
    // fabricate an empty read, or retry an operation with unknown settlement.
    return Object.freeze({ kind: 'UNKNOWN', reason: 'READ_UNAVAILABLE' })
  }
  // Decode outside the transport catch: programming defects must not be hidden
  // as unavailable storage. The classifier's result is observational only.
  return classifyInitialSyncTerminalEvidence(captured, output)
}
