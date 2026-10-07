import { captureManagedAuthority, type AuthorityDatabase } from '../microsoft/managed-connector-authority.js'
import { DIRECTORY_ROLE_RECEIPT_SCOPE } from './directory-role-receipt-store.js'

/** One hour, for this source only. Not a general freshness policy. */
export const DIRECTORY_ROLE_CURRENT_MS = 60 * 60 * 1000

export const DIRECTORY_ROLE_SOURCE = 'Microsoft Graph v1.0 /roleManagement/directory/roleAssignments'
export const DIRECTORY_ROLE_RESPONSE_VERSION = 'directory-role-results/v1'

/** What the view is allowed to say. Deliberately NOT a boolean: "no rows" and "we cannot vouch for
 * what is stored" are different answers and must never collapse into each other. */
export type DirectoryRoleStatus =
  /** The fenced path was never activated for this tenant, so anything stored came from the legacy
   *  collector and is not vouched for here. */
  | 'not-activated'
  /** Activated, but no complete receipt has ever been published. */
  | 'never-collected'
  /** A complete receipt exists and every coherence key matches current state. */
  | 'current'
  /** Coherent, but older than the one-hour rule for this source. */
  | 'stale'
  /** A complete receipt exists but the connection, authority or scope has changed under it. */
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
  /** Latest attempt state, kept SEPARATE from observation eligibility: a failed or partial attempt
   *  never replaces a last complete snapshot and never implies zero assignments. */
  readonly outcome: 'RUNNING' | 'FAILED' | 'PARTIAL' | 'EXPIRED' | null
  readonly terminalAt: string | null
}

export interface DirectoryRoleResults {
  readonly responseVersion: typeof DIRECTORY_ROLE_RESPONSE_VERSION
  readonly source: typeof DIRECTORY_ROLE_SOURCE
  readonly status: DirectoryRoleStatus
  /** Present only for 'current' and 'stale'. Never populated from legacy or mismatched evidence. */
  readonly observation: {
    readonly checkedAt: string
    readonly ageMs: number
    readonly observedCount: number
    readonly assignments: readonly DirectoryRoleAssignment[]
    /** True only for a coherent COMPLETE whose count is zero — the one trustworthy empty. */
    readonly verifiedCompleteEmpty: boolean
  } | null
  readonly latestAttempt: DirectoryRoleLatestAttempt
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** Rows are projected field-by-field. The stored payload is provider-shaped and is never spread into
 * the response, so a new provider field cannot reach the browser by accident. */
function assignments(payload: unknown): DirectoryRoleAssignment[] {
  if (!Array.isArray(payload)) return []
  const out: DirectoryRoleAssignment[] = []
  for (const row of payload) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const id = str(r.id)
    if (!id) continue
    const definition = typeof r.roleDefinition === 'object' && r.roleDefinition !== null
      ? (r.roleDefinition as Record<string, unknown>)
      : null
    out.push({
      id,
      principalId: str(r.principalId),
      roleDefinitionId: str(r.roleDefinitionId) ?? (definition ? str(definition.id) : null),
      roleDisplayName: definition ? str(definition.displayName) : null,
      directoryScopeId: str(r.directoryScopeId),
      appScopeId: str(r.appScopeId),
    })
  }
  return out
}

interface StateRow {
  roleScopeVersion: string | null; roleScopeIncarnation: string | null
  roleAttemptOutcome: string | null; roleAttemptTerminalAt: Date | null; roleAttemptId: string | null
  roleCompleteId: string | null; roleCompleteConnection: string | null
  roleCompleteConfiguration: string | null; roleCompleteScope: string | null
  roleCompleteScopeVersion: string | null; roleCompleteMicrosoftTenantId: string | null
  roleCompleteCheckedAt: Date | null; roleCompleteCount: number | null
}

/** Reads stored DIRECTORY_ROLES evidence for one tenant and decides, fail-closed, whether it may be
 * presented as a current trusted success.
 *
 * AUTHORIZATION IS NOT DONE HERE. The caller must already have established that this identity may
 * read this tenant; this function takes ids it is told to trust and performs no membership check. */
export interface DirectoryRoleReaderDatabase extends AuthorityDatabase {
  // Structural and deliberately loose on the ARGUMENT side so the generated Prisma client satisfies
  // it; every value read out of it is narrowed below rather than trusted from this signature.
  syncState: { findFirst(args: any): Promise<any> }
  tenantEntraSnapshot: { findFirst(args: any): Promise<any> }
}

export async function readDirectoryRoleResults(
  db: DirectoryRoleReaderDatabase,
  input: { organizationId: string; customerTenantId: string; microsoftTenantId: string; collectionIncarnation: string | null; now: number }
): Promise<DirectoryRoleResults> {
  const where = { customerTenantId: input.customerTenantId, organizationId: input.organizationId, resourceType: 'DIRECTORY_ROLES' as const }
  const state: StateRow | null = await db.syncState.findFirst({ where })
  const authority = await captureManagedAuthority(db)

  const latestAttempt: DirectoryRoleLatestAttempt = {
    outcome: state?.roleAttemptOutcome === 'FAILED' || state?.roleAttemptOutcome === 'PARTIAL' || state?.roleAttemptOutcome === 'EXPIRED'
      ? state.roleAttemptOutcome
      : state?.roleAttemptId && !state.roleAttemptOutcome ? 'RUNNING' : null,
    terminalAt: state?.roleAttemptTerminalAt ? state.roleAttemptTerminalAt.toISOString() : null,
  }
  const base = { responseVersion: DIRECTORY_ROLE_RESPONSE_VERSION, source: DIRECTORY_ROLE_SOURCE, observation: null, latestAttempt } as const

  // FAIL CLOSED #1: without the durable opt-in, capture returns to the legacy collector, so anything
  // in the snapshot was written unfenced. It is not presented as a trusted observation.
  if (!state || state.roleScopeVersion !== DIRECTORY_ROLE_RECEIPT_SCOPE || !state.roleScopeIncarnation) {
    return { ...base, status: 'not-activated' }
  }
  if (!state.roleCompleteId || !state.roleCompleteCheckedAt) {
    return { ...base, status: 'never-collected' }
  }

  // FAIL CLOSED #2: every coherence key must match CURRENT state, including the scope incarnation —
  // a re-activation mints a new one, so evidence from a previous activation is superseded, not current.
  const coherent =
    state.roleCompleteScopeVersion === DIRECTORY_ROLE_RECEIPT_SCOPE
    && state.roleCompleteMicrosoftTenantId === input.microsoftTenantId
    && state.roleCompleteScope === state.roleScopeIncarnation
    && state.roleCompleteConnection === input.collectionIncarnation
    && !!authority && state.roleCompleteConfiguration === authority.configurationRevision
  if (!coherent) return { ...base, status: 'superseded' }

  const snapshot: { payload: unknown; rolePublicationAttemptId: string | null } | null = await db.tenantEntraSnapshot.findFirst({ where: { customerTenantId: input.customerTenantId, organizationId: input.organizationId, resourceType: 'DIRECTORY_ROLES' } })
  // FAIL CLOSED #3: the snapshot and the receipt are two write targets. Only a snapshot stamped with
  // THIS complete attempt may be read as its rows; an unstamped snapshot is legacy evidence.
  if (!snapshot || snapshot.rolePublicationAttemptId !== state.roleCompleteId) {
    return { ...base, status: 'superseded' }
  }
  const rows = assignments(snapshot.payload)
  // FAIL CLOSED #4: the receipt's counted rows and the stored rows must agree, or we cannot say what
  // was observed — including the zero case, which is the only trustworthy empty.
  if (state.roleCompleteCount === null || state.roleCompleteCount !== rows.length) {
    return { ...base, status: 'superseded' }
  }

  const checkedAt = state.roleCompleteCheckedAt
  const ageMs = Math.max(0, input.now - checkedAt.getTime())
  return {
    ...base,
    status: ageMs <= DIRECTORY_ROLE_CURRENT_MS ? 'current' : 'stale',
    observation: {
      checkedAt: checkedAt.toISOString(),
      ageMs,
      observedCount: rows.length,
      assignments: rows,
      verifiedCompleteEmpty: rows.length === 0,
    },
  }
}
