import { INITIAL_SYNC_RESOURCE_TYPES } from './initial-sync-status.js'

type ResourceType = typeof INITIAL_SYNC_RESOURCE_TYPES[number]
type Scope = { organizationId: string; customerTenantId: string }

/** Proposed receipt projection only; these fields are not installed storage.
 * A coherent, authority-guarded reader must supply this snapshot. This unused
 * predicate cannot prove database durability, provider completeness or ownership. */
export type InitialSyncCompletionProof = Scope & {
  resourceType: string
  initialSyncAttemptEpochId: string | null
  initialSyncAttemptId: string | null
  initialSyncPersistedAttemptId: string | null
  initialSyncCompletedAttemptId: string | null
  status: string
  lastAttemptAt: Date | null
  lastSuccessfulAt: Date | null
  lastErrorCode: string | null
  coverage: string
  authenticationSource: string | null
}

export type InitialSyncCompletionSnapshot = {
  scope: Scope
  tenantStatus: string
  connection: (Scope & {
    status: string
    connectionMode: string
    initialSyncEpochId: string | null
    /** Current epoch boundary from the same scoped connection read. */
    epochStartedAt: Date | null
  }) | null
  /** Required resources only; the future reader must explicitly project them. */
  proofs: readonly InitialSyncCompletionProof[]
  now: Date
}

export type InitialSyncCompletionValidation = {
  complete: boolean
  reason: 'COMPLETE' | 'INVALID_CONTEXT' | 'INVALID_RESOURCE_SET' | 'INCOMPLETE_PROOF'
  incompleteResources: ResourceType[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const validId = (value: string | null): value is string =>
  typeof value === 'string' && UUID.test(value) && value !== '00000000-0000-0000-0000-000000000000'
const time = (value: Date | null): number => value instanceof Date ? value.getTime() : NaN
const sameScope = (a: Scope, b: Scope) =>
  a.organizationId === b.organizationId && a.customerTenantId === b.customerTenantId
const required = new Set<string>(INITIAL_SYNC_RESOURCE_TYPES)

/** Baseline readiness may combine different resource attempts in one epoch.
 * Full-run success and incremental notice mutation must additionally match
 * their returned attempt identities under the shared write authority. */
export function validateInitialSyncCompletionProof(
  input: InitialSyncCompletionSnapshot,
): InitialSyncCompletionValidation {
  const connection = input.connection
  const now = time(input.now)
  const start = time(connection?.epochStartedAt ?? null)
  if (!validId(input.scope.organizationId) || !validId(input.scope.customerTenantId) ||
      input.tenantStatus !== 'ACTIVE' || !connection || !sameScope(input.scope, connection) ||
      connection.status !== 'CONNECTED' ||
      !['HAWKVIEW_MANAGED', 'CUSTOMER_MANAGED'].includes(connection.connectionMode) ||
      !validId(connection.initialSyncEpochId) || !Number.isFinite(now) ||
      !Number.isFinite(start) || start > now) {
    return { complete: false, reason: 'INVALID_CONTEXT', incompleteResources: [...INITIAL_SYNC_RESOURCE_TYPES] }
  }

  // Never let Map's last-wins behavior hide an ambiguous duplicate. This
  // required-only projection rejects unexpected rows as well as foreign scope.
  const rows = new Map<string, InitialSyncCompletionProof>()
  for (const proof of input.proofs) {
    if (!sameScope(input.scope, proof) || !required.has(proof.resourceType) || rows.has(proof.resourceType)) {
      return { complete: false, reason: 'INVALID_RESOURCE_SET', incompleteResources: [...INITIAL_SYNC_RESOURCE_TYPES] }
    }
    rows.set(proof.resourceType, proof)
  }

  const incompleteResources = INITIAL_SYNC_RESOURCE_TYPES.filter(resource => {
    const proof = rows.get(resource)
    if (!proof) return true
    const attempt = time(proof.lastAttemptAt)
    const success = time(proof.lastSuccessfulAt)
    return proof.initialSyncAttemptEpochId !== connection.initialSyncEpochId ||
      !validId(proof.initialSyncAttemptId) ||
      proof.initialSyncPersistedAttemptId !== proof.initialSyncAttemptId ||
      proof.initialSyncCompletedAttemptId !== proof.initialSyncAttemptId ||
      proof.status !== 'SUCCEEDED' || proof.coverage !== 'FULL' || proof.lastErrorCode !== null ||
      (resource === 'SIGN_INS' && proof.authenticationSource !== 'GRAPH_SIGN_INS') ||
      !Number.isFinite(attempt) || !Number.isFinite(success) ||
      attempt < start || success < attempt || success > now
  })
  return {
    complete: incompleteResources.length === 0,
    reason: incompleteResources.length === 0 ? 'COMPLETE' : 'INCOMPLETE_PROOF',
    incompleteResources,
  }
}
