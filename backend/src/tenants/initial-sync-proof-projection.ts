import { INITIAL_SYNC_RESOURCE_TYPES } from './initial-sync-status.js'
import {
  validateInitialSyncCompletionProof,
  type InitialSyncCompletionProof,
  type InitialSyncCompletionValidation,
} from './initial-sync-completion-proof.js'

type Scope = { organizationId: string; customerTenantId: string }

// Proposed aliases for one scoped statement, not a production query. Nullable
// joined state columns must stay null when a required resource has no state.
const contextText = [
  'organizationId', 'customerTenantId', 'tenantStatus', 'connectionId',
  'connectionOrganizationId', 'connectionCustomerTenantId', 'connectionStatus',
  'connectionMode', 'initialSyncEpochId', 'epochStartedAtUtc', 'observedAtUtc',
] as const
const stateText = [
  'stateId', 'stateOrganizationId', 'stateCustomerTenantId', 'stateResourceType',
  'initialSyncAttemptEpochId', 'initialSyncAttemptId', 'initialSyncPersistedAttemptId',
  'initialSyncCompletedAttemptId', 'initialSyncPersistedKind', 'status',
  'lastAttemptAtUtc', 'lastSuccessfulAtUtc', 'lastErrorCode', 'lastErrorMessage',
] as const
type TextKey = typeof contextText[number] | typeof stateText[number]
type RawRow = Record<TextKey, string | null> & {
  expectedResourceType: string
  contextTimeValid: boolean | null
  proofTimeValid: boolean | null
}

export type InitialSyncProjectionValidation = InitialSyncCompletionValidation | {
  complete: false
  reason: 'INVALID_PROJECTION'
  incompleteResources: (typeof INITIAL_SYNC_RESOURCE_TYPES[number])[]
}

const required = new Set<string>(INITIAL_SYNC_RESOURCE_TYPES)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const validId = (value: unknown): value is string => typeof value === 'string' &&
  UUID.test(value) && value !== '00000000-0000-0000-0000-000000000000'
const reject = (reason: 'INVALID_PROJECTION' | 'INVALID_CONTEXT' | 'INVALID_RESOURCE_SET'): InitialSyncProjectionValidation => ({
  complete: false, reason, incompleteResources: [...INITIAL_SYNC_RESOURCE_TYPES],
})

function isRawRow(value: unknown): value is RawRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.hasOwn(row, 'expectedResourceType') && typeof row.expectedResourceType === 'string' &&
    [...contextText, ...stateText].every(key => Object.hasOwn(row, key) && (row[key] === null || typeof row[key] === 'string')) &&
    ['contextTimeValid', 'proofTimeValid'].every(key => Object.hasOwn(row, key) && (row[key] === null || typeof row[key] === 'boolean'))
}

// Accept only the future SQL's explicit UTC, six-decimal transport format.
// Keep the final three digits separately; Date comparisons alone lose them.
function exactTime(value: string | null): { date: Date; micros: bigint } | null {
  if (value === null || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) return null
  const milliseconds = `${value.slice(0, 23)}Z`
  const date = new Date(milliseconds)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== milliseconds) return null
  return { date, micros: BigInt(date.getTime()) * 1000n + BigInt(value.slice(23, 26)) }
}

/** Unused, read-only decoder for a future coherent projection. No query, write,
 * ownership reservation or notice authorization is provided here. Accepts raw
 * database output without coercing strings/booleans or trusting derived flags.
 * Returns validation only: rounded Date snapshots must not escape as authority.
 */
export function validateInitialSyncCompletionProjection(
  scope: Scope,
  output: unknown,
): InitialSyncProjectionValidation {
  if (!validId(scope.organizationId) || !validId(scope.customerTenantId)) return reject('INVALID_CONTEXT')
  if (!Array.isArray(output)) return reject('INVALID_PROJECTION')
  if (output.length !== INITIAL_SYNC_RESOURCE_TYPES.length) return reject('INVALID_RESOURCE_SET')
  // Materialize holes too: Array.every alone would skip absent array elements.
  const rawRows: unknown[] = [...output]
  if (!rawRows.every(isRawRow)) return reject('INVALID_PROJECTION')
  const rows: RawRow[] = rawRows
  const first = rows[0]!
  // Repeated context must describe one observation, never a mixture of reads.
  if (rows.some(row => [...contextText, 'contextTimeValid' as const].some(key => row[key] !== first[key]))) {
    return reject('INVALID_PROJECTION')
  }
  const now = exactTime(first.observedAtUtc)
  const start = exactTime(first.epochStartedAtUtc)
  if (first.organizationId !== scope.organizationId || first.customerTenantId !== scope.customerTenantId ||
      first.connectionOrganizationId !== scope.organizationId || first.connectionCustomerTenantId !== scope.customerTenantId ||
      !validId(first.connectionId) || first.tenantStatus !== 'ACTIVE' || first.connectionStatus !== 'CONNECTED' ||
      !['CUSTOMER_MANAGED', 'HAWKVIEW_MANAGED'].includes(first.connectionMode ?? '') ||
      !validId(first.initialSyncEpochId) || first.contextTimeValid !== true || !now || !start || start.micros > now.micros) {
    return reject('INVALID_CONTEXT')
  }

  const seen = new Set<string>()
  const seenStates = new Set<string>()
  const proofs: InitialSyncCompletionProof[] = []
  for (const row of rows) {
    const resource = row.expectedResourceType
    if (!required.has(resource) || seen.has(resource)) return reject('INVALID_RESOURCE_SET')
    seen.add(resource)
    if (row.stateId === null) {
      // An absent LEFT JOIN cannot carry invented evidence from another row.
      if (stateText.some(key => row[key] !== null) || row.proofTimeValid === true) return reject('INVALID_PROJECTION')
      continue
    }
    if (!validId(row.stateId) || seenStates.has(row.stateId) || row.stateOrganizationId !== scope.organizationId ||
        row.stateCustomerTenantId !== scope.customerTenantId || row.stateResourceType !== resource) {
      return reject('INVALID_RESOURCE_SET')
    }
    seenStates.add(row.stateId)
    const attempt = exactTime(row.lastAttemptAtUtc)
    const success = exactTime(row.lastSuccessfulAtUtc)
    const full = validId(row.initialSyncAttemptId) &&
      row.initialSyncAttemptEpochId === first.initialSyncEpochId &&
      row.initialSyncPersistedAttemptId === row.initialSyncAttemptId &&
      row.initialSyncCompletedAttemptId === row.initialSyncAttemptId &&
      row.initialSyncPersistedKind === (resource === 'SIGN_INS' ? 'GRAPH_SIGN_INS' : 'FULL_RESOURCE') &&
      row.status === 'SUCCEEDED' && row.lastErrorCode === null && row.lastErrorMessage === null &&
      row.proofTimeValid === true && attempt !== null && success !== null &&
      attempt.micros >= start.micros && success.micros >= attempt.micros && success.micros <= now.micros
    proofs.push({
      ...scope, resourceType: resource,
      initialSyncAttemptEpochId: row.initialSyncAttemptEpochId,
      initialSyncAttemptId: row.initialSyncAttemptId,
      initialSyncPersistedAttemptId: row.initialSyncPersistedAttemptId,
      initialSyncCompletedAttemptId: row.initialSyncCompletedAttemptId,
      status: row.status ?? '', lastAttemptAt: attempt?.date ?? null,
      lastSuccessfulAt: success?.date ?? null, lastErrorCode: row.lastErrorCode,
      coverage: full ? 'FULL' : 'UNKNOWN',
      authenticationSource: full && resource === 'SIGN_INS' ? 'GRAPH_SIGN_INS' : null,
    })
  }
  return validateInitialSyncCompletionProof({
    scope, tenantStatus: first.tenantStatus!, now: now.date,
    connection: { ...scope, status: first.connectionStatus!, connectionMode: first.connectionMode!,
      initialSyncEpochId: first.initialSyncEpochId, epochStartedAt: start.date },
    proofs,
  })
}
