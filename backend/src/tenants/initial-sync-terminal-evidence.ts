import { INITIAL_SYNC_RESOURCE_TYPES } from './initial-sync-status.js'

const operationKeys = [
  'organizationId', 'customerTenantId', 'connectionId', 'epochId', 'attemptId',
  'resourceType', 'persistedKind',
] as const
export type InitialSyncTerminalOperation = Readonly<Record<typeof operationKeys[number], string>>
const rowKeys = [
  'organizationId', 'customerTenantId', 'tenantStatus', 'connectionId',
  'connectionOrganizationId', 'connectionCustomerTenantId', 'connectionStatus',
  'connectionMode', 'initialSyncEpochId', 'epochStartedAtUtc', 'observedAtUtc',
  'expectedResourceType', 'stateId', 'stateOrganizationId', 'stateCustomerTenantId',
  'stateResourceType', 'initialSyncAttemptEpochId', 'initialSyncAttemptId',
  'initialSyncPersistedAttemptId', 'initialSyncCompletedAttemptId',
  'initialSyncPersistedKind', 'status', 'lastAttemptAtUtc', 'lastSuccessfulAtUtc',
  'lastErrorCode', 'lastErrorMessage',
] as const
type Row = Record<typeof rowKeys[number], string | null>
type UnknownReason = 'INVALID_OPERATION' | 'UNAVAILABLE_OR_AMBIGUOUS' |
  'INVALID_PROJECTION' | 'INVALID_SCOPE' | 'INVALID_CONTEXT' | 'INVALID_RECEIPT' |
  'NO_COMPLETION_EVIDENCE'

export type InitialSyncTerminalEvidence = Readonly<{
  kind: 'UNKNOWN'
  reason: UnknownReason
}> | Readonly<{
  kind: 'MATCHING_COMPLETION' | 'PERSISTED_ONLY' | 'SUPERSEDED'
  operation: InitialSyncTerminalOperation
  observed: Readonly<{
    connectionId: string
    epochId: string
    attemptEpochId: string
    attemptId: string
    stateId: string
    status: string
    atUtc: string
  }>
}>

const resources = new Set<string>(INITIAL_SYNC_RESOURCE_TYPES)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const validId = (v: unknown): v is string => typeof v === 'string' &&
  UUID.test(v) && v !== '00000000-0000-0000-0000-000000000000'
const kindFor = (resource: string) => resource === 'SIGN_INS' ? 'GRAPH_SIGN_INS' : 'FULL_RESOURCE'
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const unknown = (reason: UnknownReason): InitialSyncTerminalEvidence => Object.freeze({ kind: 'UNKNOWN', reason })

/** Capture identity before an asynchronous boundary; this grants no authority. */
export function captureInitialSyncTerminalOperation(value: unknown): InitialSyncTerminalOperation | null {
  if (!record(value) || !operationKeys.every(k => Object.hasOwn(value, k) && typeof value[k] === 'string')) return null
  const op = Object.freeze(Object.fromEntries(operationKeys.map(k => [k, value[k]]))) as InitialSyncTerminalOperation
  if (!['organizationId', 'customerTenantId', 'connectionId', 'epochId', 'attemptId'].every(k =>
    validId(op[k as keyof InitialSyncTerminalOperation])) || !resources.has(op.resourceType) ||
    op.persistedKind !== kindFor(op.resourceType)) return null
  return op
}

// The future projection must use explicit six-decimal UTC text. No rounded
// Date, coercion or caller-supplied validity flag can replace exact ordering.
function micros(v: string | null): bigint | null {
  if (v === null || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v)) return null
  const ms = `${v.slice(0, 23)}Z`
  const date = new Date(ms)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== ms) return null
  return BigInt(date.getTime()) * 1000n + BigInt(v.slice(23, 26))
}

/** UNUSED diagnostic decoder for supplied evidence, not a database certificate.
 * A future adapter must establish coherent authoritative read provenance. This
 * function cannot verify that provenance, original-operation settlement, owner
 * identity/expiry, locks, eligibility at mutation time, or delivery. It never
 * authorizes writes/notices or classifies DEFINITE_NON_WRITE. HAW-21 ownership
 * remains separate: even MATCHING_COMPLETION has no current mutation authority.
 * Missing rows (including role-hidden rows) cannot prove replacement/rollback.
 */
export function classifyInitialSyncTerminalEvidence(
  capturedOperation: unknown,
  output: unknown,
): InitialSyncTerminalEvidence {
  // Copy only immutable scalar identity, never return a caller-owned object.
  const op = captureInitialSyncTerminalOperation(capturedOperation)
  if (!op) return unknown('INVALID_OPERATION')
  if (!Array.isArray(output) || output.length !== 1 || !Object.hasOwn(output, 0)) return unknown('UNAVAILABLE_OR_AMBIGUOUS')
  const value: unknown = output[0]
  if (!record(value) || !rowKeys.every(k => Object.hasOwn(value, k) && (value[k] === null || typeof value[k] === 'string'))) {
    return unknown('INVALID_PROJECTION')
  }
  const row = Object.fromEntries(rowKeys.map(k => [k, value[k]])) as Row
  if (row.organizationId !== op.organizationId || row.customerTenantId !== op.customerTenantId ||
      row.connectionOrganizationId !== op.organizationId || row.connectionCustomerTenantId !== op.customerTenantId ||
      row.expectedResourceType !== op.resourceType || row.stateOrganizationId !== op.organizationId ||
      row.stateCustomerTenantId !== op.customerTenantId || row.stateResourceType !== op.resourceType) return unknown('INVALID_SCOPE')
  const start = micros(row.epochStartedAtUtc)
  const now = micros(row.observedAtUtc)
  if (!validId(row.connectionId) || !validId(row.initialSyncEpochId) || start === null || now === null || start > now ||
      row.tenantStatus !== 'ACTIVE' || row.connectionStatus !== 'CONNECTED' ||
      !['CUSTOMER_MANAGED', 'HAWKVIEW_MANAGED'].includes(row.connectionMode ?? '')) return unknown('INVALID_CONTEXT')
  const attempt = micros(row.lastAttemptAtUtc)
  const success = micros(row.lastSuccessfulAtUtc)
  const persisted = row.initialSyncPersistedAttemptId
  const completed = row.initialSyncCompletedAttemptId
  if (!validId(row.stateId) || !validId(row.initialSyncAttemptId) ||
      !validId(row.initialSyncAttemptEpochId) ||
      !['IDLE', 'RUNNING', 'SUCCEEDED', 'FAILED'].includes(row.status ?? '') ||
      attempt === null || attempt > now ||
      (row.initialSyncAttemptEpochId === row.initialSyncEpochId && attempt < start) ||
      (row.lastSuccessfulAtUtc !== null && (success === null || success > now)) ||
      (persisted === null ? row.initialSyncPersistedKind !== null :
        persisted !== row.initialSyncAttemptId || row.initialSyncPersistedKind !== op.persistedKind) ||
      (completed !== null && (completed !== row.initialSyncAttemptId || persisted !== completed ||
        row.status !== 'SUCCEEDED' || row.lastErrorCode !== null || row.lastErrorMessage !== null ||
        success === null || success < attempt))) return unknown('INVALID_RECEIPT')

  const observed = Object.freeze({ connectionId: row.connectionId, epochId: row.initialSyncEpochId,
    attemptEpochId: row.initialSyncAttemptEpochId,
    attemptId: row.initialSyncAttemptId, stateId: row.stateId, status: row.status!, atUtc: row.observedAtUtc! })
  // Replaced storage cannot reveal whether the older operation committed.
  // Epoch rotation retains older resource rows; never relabel their epoch or
  // compare their historical attempt against the new epoch's starting time.
  if (row.connectionId !== op.connectionId || row.initialSyncEpochId !== op.epochId) {
    return Object.freeze({ kind: 'SUPERSEDED', operation: op, observed })
  }
  if (row.initialSyncAttemptEpochId !== op.epochId) return unknown('INVALID_RECEIPT')
  if (row.initialSyncAttemptId !== op.attemptId) return Object.freeze({ kind: 'SUPERSEDED', operation: op, observed })
  if (completed === op.attemptId) return Object.freeze({ kind: 'MATCHING_COMPLETION', operation: op, observed })
  // Retained persistence says nothing about completion or pending execution;
  // preserve FAILED/RUNNING/etc. as observations, never as allowed actions.
  if (persisted === op.attemptId) return Object.freeze({ kind: 'PERSISTED_ONLY', operation: op, observed })
  return unknown('NO_COMPLETION_EVIDENCE')
}
