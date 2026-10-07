import { captureManagedAuthority, type AuthorityDatabase, type AuthorityTransaction } from '../microsoft/managed-connector-authority.js'
import { DIRECTORY_ROLE_RECEIPT_SCOPE } from './directory-role-receipt-store.js'
import { prepareDirectoryRoles } from './directory-role-collection-validation.js'

/** One hour, for this source only. Not a general freshness policy. */
export const DIRECTORY_ROLE_CURRENT_MS = 60 * 60 * 1000

export const DIRECTORY_ROLE_SOURCE = 'Microsoft Graph v1.0 /roleManagement/directory/roleAssignments'
export const DIRECTORY_ROLE_RESPONSE_VERSION = 'directory-role-results/v1'

/** What the view is allowed to say. "No rows" and "we cannot vouch for what is stored" are different
 * answers and must never collapse into each other. */
export type DirectoryRoleStatus =
  /** No usable activation evidence for this tenant in the data read here, so nothing stored is
   *  vouched for. This is a statement about the evidence, not about any live tenant's history. */
  | 'not-activated'
  /** Activated, but no complete receipt has been published. */
  | 'never-collected'
  /** A complete receipt exists and every binding and eligibility check passes. */
  | 'current'
  /** Those checks pass, but the receipt is older than the one-hour rule for this source. */
  | 'stale'
  /** A complete receipt exists and is NOT currently trustworthy: current state is ineligible, or the
   *  stored payload does not bind to the receipt. */
  | 'superseded'

export interface DirectoryRoleAssignment {
  readonly id: string
  readonly principalId: string | null
  readonly roleDefinitionId: string | null
  readonly roleDisplayName: string | null
  readonly directoryScopeId: string | null
  readonly appScopeId: string | null
}

export interface DirectoryRoleLatestAttempt {
  /** Read from the persisted outcome. 'COMPLETE' is not an outstanding attempt and is reported null. */
  readonly outcome: 'RUNNING' | 'FAILED' | 'PARTIAL' | 'EXPIRED' | null
  readonly terminalAt: string | null
}

export interface DirectoryRoleResults {
  readonly responseVersion: typeof DIRECTORY_ROLE_RESPONSE_VERSION
  readonly source: typeof DIRECTORY_ROLE_SOURCE
  readonly status: DirectoryRoleStatus
  readonly observation: {
    readonly checkedAt: string
    readonly ageMs: number
    readonly observedCount: number
    readonly assignments: readonly DirectoryRoleAssignment[]
    readonly verifiedCompleteEmpty: boolean
  } | null
  readonly latestAttempt: DirectoryRoleLatestAttempt
}

interface CoherentRead {
  tenantStatus: string | null
  connectionStatus: string | null
  connectionMode: string | null
  connectionIncarnation: string | null
  microsoftTenantId: string | null
  scopeVersion: string | null
  scopeIncarnation: string | null
  attemptOutcome: string | null
  attemptTerminalAt: Date | null
  completeId: string | null
  completeConnection: string | null
  completeConfiguration: string | null
  completeScope: string | null
  completeScopeVersion: string | null
  completeMicrosoftTenantId: string | null
  completeCheckedAt: Date | null
  completeDigest: string | null
  completeCount: number | null
  snapshotPayload: unknown
  snapshotAttemptId: string | null
  snapshotObservedAt: Date | null
  readAt: Date
}

const COHERENT_READ_SQL = `/* directory-role-results:coherent-read */
  SELECT clock_timestamp() AS "readAt",
    t.status AS "tenantStatus", t.microsoft_tenant_id::text AS "microsoftTenantId",
    c.status AS "connectionStatus", c.connection_mode AS "connectionMode",
    c.collection_incarnation::text AS "connectionIncarnation",
    s.role_scope_version AS "scopeVersion", s.role_scope_incarnation::text AS "scopeIncarnation",
    s.role_attempt_outcome AS "attemptOutcome", s.role_attempt_terminal_at AS "attemptTerminalAt",
    s.role_complete_id::text AS "completeId", s.role_complete_connection::text AS "completeConnection",
    s.role_complete_configuration::text AS "completeConfiguration", s.role_complete_scope::text AS "completeScope",
    s.role_complete_scope_version AS "completeScopeVersion",
    s.role_complete_microsoft_tenant_id::text AS "completeMicrosoftTenantId",
    s.role_complete_checked_at AS "completeCheckedAt", s.role_complete_digest AS "completeDigest",
    s.role_complete_count AS "completeCount",
    n.payload AS "snapshotPayload", n.role_publication_attempt_id::text AS "snapshotAttemptId",
    n.observed_at AS "snapshotObservedAt"
  FROM customer_tenants t
  LEFT JOIN tenant_connections c ON c.customer_tenant_id = t.id AND c.organization_id = t.organization_id
  LEFT JOIN sync_states s ON s.customer_tenant_id = t.id AND s.organization_id = t.organization_id
    AND s.resource_type = 'DIRECTORY_ROLES'
  LEFT JOIN tenant_entra_snapshots n ON n.customer_tenant_id = t.id AND n.organization_id = t.organization_id
    AND n.resource_type = 'DIRECTORY_ROLES'
  WHERE t.id = $1::uuid AND t.organization_id = $2::uuid`

/** Reads stored DIRECTORY_ROLES evidence for one tenant and decides, fail-closed, whether it may be
 * presented as a current trusted success.
 *
 * AUTHORIZATION IS NOT DONE HERE. The caller must already have established that this identity may
 * read this tenant; this function takes ids it is told to trust and performs no membership check.
 *
 * Tenant, connection, scope, receipt, snapshot and the read clock come from ONE statement inside the
 * same transaction that captures the managed authority, so a status change cannot slip between the
 * eligibility decision and the payload it admits. */
export async function readDirectoryRoleResults(
  db: AuthorityDatabase,
  input: { organizationId: string; customerTenantId: string }
): Promise<DirectoryRoleResults> {
  const { row, authority } = await db.$transaction(async (tx: AuthorityTransaction) => {
    const rows = await tx.$queryRawUnsafe<CoherentRead[]>(COHERENT_READ_SQL, input.customerTenantId, input.organizationId)
    const captured = await captureManagedAuthority({ $transaction: async work => work(tx) })
    return { row: rows[0] ?? null, authority: captured }
  }, { isolationLevel: 'ReadCommitted' })

  const outcome = row?.attemptOutcome
  const latestAttempt: DirectoryRoleLatestAttempt = {
    // Read from the persisted writer shape. COMPLETE means the attempt finished and is reported as
    // no outstanding attempt; it is never inferred from a null column.
    outcome: outcome === 'RUNNING' || outcome === 'FAILED' || outcome === 'PARTIAL' || outcome === 'EXPIRED'
      ? outcome
      : null,
    terminalAt: row?.attemptTerminalAt ? new Date(row.attemptTerminalAt).toISOString() : null,
  }
  const base = { responseVersion: DIRECTORY_ROLE_RESPONSE_VERSION, source: DIRECTORY_ROLE_SOURCE, observation: null, latestAttempt } as const

  // FAIL CLOSED #1 — no usable activation evidence: capture would fall back to the legacy collector,
  // so whatever is stored was not written by the fenced path and is not vouched for here.
  if (!row || row.scopeVersion !== DIRECTORY_ROLE_RECEIPT_SCOPE || !row.scopeIncarnation) {
    return { ...base, status: 'not-activated' }
  }
  if (!row.completeId || !row.completeCheckedAt) {
    return { ...base, status: 'never-collected' }
  }

  // FAIL CLOSED #2 — current eligibility, read at the same point as the payload. The receipt store
  // admits an attempt only for an ACTIVE/CONNECTED/HAWKVIEW_MANAGED tenant on an immutable managed
  // authority; a retained receipt must not outlive that state.
  const eligible =
    row.tenantStatus === 'ACTIVE'
    && row.connectionStatus === 'CONNECTED'
    && row.connectionMode === 'HAWKVIEW_MANAGED'
    && !!row.connectionIncarnation
    && !!authority
    && authority.credentialReference === `encrypted-secret:${authority.configurationRevision}`
  // FAIL CLOSED #3 — the receipt must bind to CURRENT scope, connection, authority and tenant.
  const bound =
    row.completeScopeVersion === DIRECTORY_ROLE_RECEIPT_SCOPE
    && row.completeMicrosoftTenantId === row.microsoftTenantId
    && row.completeScope === row.scopeIncarnation
    && row.completeConnection === row.connectionIncarnation
    && !!authority && row.completeConfiguration === authority.configurationRevision
  if (!eligible || !bound) return { ...base, status: 'superseded' }

  // FAIL CLOSED #4 — the stored payload must bind to the receipt by publication id, by the SAME
  // publication clock, and by the canonical digest and count of the WHOLE payload.
  if (row.snapshotAttemptId !== row.completeId || !row.snapshotObservedAt) {
    return { ...base, status: 'superseded' }
  }
  const checkedAt = new Date(row.completeCheckedAt)
  if (new Date(row.snapshotObservedAt).getTime() !== checkedAt.getTime()) {
    return { ...base, status: 'superseded' }
  }
  // Reuses the collection canonicalization contract unchanged: it rejects the whole payload if ANY
  // row is malformed, rebuilds each row with fixed key order (so JSONB key order cannot change the
  // digest) and sorts by id. A dropped-row projection would let a malformed payload read as empty.
  let canonical: { rows: readonly unknown[]; contentDigest: string }
  try {
    canonical = prepareDirectoryRoles(row.snapshotPayload as readonly unknown[])
  } catch {
    return { ...base, status: 'superseded' }
  }
  if (canonical.contentDigest !== row.completeDigest
    || row.completeCount !== canonical.rows.length) {
    return { ...base, status: 'superseded' }
  }

  const assignments: DirectoryRoleAssignment[] = canonical.rows.map(value => {
    const r = value as { id: string; principalId: string | null; roleDefinitionId: string | null;
      directoryScopeId: string | null; appScopeId: string | null; roleDefinition: { displayName: string | null } }
    return {
      id: r.id,
      principalId: r.principalId,
      roleDefinitionId: r.roleDefinitionId,
      roleDisplayName: r.roleDefinition.displayName,
      directoryScopeId: r.directoryScopeId,
      appScopeId: r.appScopeId,
    }
  })

  const ageMs = Math.max(0, new Date(row.readAt).getTime() - checkedAt.getTime())
  return {
    ...base,
    status: ageMs <= DIRECTORY_ROLE_CURRENT_MS ? 'current' : 'stale',
    observation: {
      checkedAt: checkedAt.toISOString(),
      ageMs,
      observedCount: assignments.length,
      assignments,
      verifiedCompleteEmpty: assignments.length === 0,
    },
  }
}
