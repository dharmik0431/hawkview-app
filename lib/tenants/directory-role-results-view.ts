/** Client boundary for the stored DIRECTORY_ROLES results API.
 *
 * Parsing validates the shape the server promised. It does NOT establish that the server authorized
 * this caller for this tenant, and it does NOT establish that the stored evidence is trustworthy —
 * that decision is the server's `status`, which this parser carries through verbatim. */

export const DIRECTORY_ROLE_RESPONSE_VERSION = 'directory-role-results/v1'
export const DIRECTORY_ROLE_SOURCE = 'Microsoft Graph v1.0 /roleManagement/directory/roleAssignments'

/** Mirrors the server union exactly. 'not-activated' and 'never-collected' are DIFFERENT from a
 * verified empty, and the view must never collapse them. */
export type DirectoryRoleStatus =
  | 'not-activated' | 'never-collected' | 'current' | 'stale' | 'superseded'

export type DirectoryRoleAssignmentView = {
  readonly id: string
  readonly principalId: string | null
  readonly roleDefinitionId: string | null
  readonly roleDisplayName: string | null
  readonly directoryScopeId: string | null
  readonly appScopeId: string | null
}

export type DirectoryRoleObservationView = {
  readonly checkedAt: Date
  readonly ageMs: number
  readonly observedCount: number
  readonly assignments: readonly DirectoryRoleAssignmentView[]
  readonly verifiedCompleteEmpty: boolean
}

export type DirectoryRoleLatestAttemptView = {
  readonly outcome: 'RUNNING' | 'FAILED' | 'PARTIAL' | 'EXPIRED' | null
  readonly terminalAt: Date | null
}

export type DirectoryRoleResultsView = {
  readonly status: DirectoryRoleStatus
  readonly source: string
  /** Present only for 'current' and 'stale'. */
  readonly observation: DirectoryRoleObservationView | null
  /** Always separate from the observation: a failed attempt never stands in for one. */
  readonly latestAttempt: DirectoryRoleLatestAttemptView
  readonly health?: DirectoryRoleHealthView
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const time = (v: unknown): Date | null => {
  if (typeof v !== 'string' || !v) return null
  const at = new Date(v)
  return Number.isFinite(at.getTime()) ? at : null
}

const HEALTH_PAIRS = {
  ACTIVATION_EVIDENCE_UNAVAILABLE: ['not-activated', 'REVIEW_SOURCE_CONTROL'],
  NO_COMPLETE_RECEIPT: ['never-collected', 'AWAIT_NORMAL_COLLECTION'],
  CURRENT_ELIGIBILITY_UNAVAILABLE: ['superseded', 'REVIEW_CONNECTION_SETUP'],
  RECEIPT_BINDING_CHANGED: ['superseded', 'REQUIRE_NEW_COMPLETE_OBSERVATION'],
  SNAPSHOT_BINDING_UNVERIFIED: ['superseded', 'REREAD_OR_REPORT'],
  PUBLICATION_TIME_MISMATCH: ['superseded', 'REREAD_OR_REPORT'],
  STORED_PAYLOAD_INVALID: ['superseded', 'REREAD_OR_REPORT'],
  STORED_CONTENT_MISMATCH: ['superseded', 'REREAD_OR_REPORT'],
  COMPLETE_OBSERVATION_CURRENT: ['current', 'NONE'],
  COMPLETE_EMPTY_CURRENT: ['current', 'NONE'],
  COMPLETE_OBSERVATION_STALE: ['stale', 'AWAIT_NORMAL_COLLECTION'],
} as const

export type DirectoryRoleHealthView = {
  readonly version: 1
  readonly reasonCode: keyof typeof HEALTH_PAIRS
  readonly recoveryCode: typeof HEALTH_PAIRS[keyof typeof HEALTH_PAIRS][1]
}

/** Optional explanations cannot change status or admit an observation. Reject the whole explanation
 * on any mismatch, preserving exactly the rendering of an older response without health. */
function parseHealth(raw: unknown, status: DirectoryRoleStatus, count: number | null): DirectoryRoleHealthView | undefined {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.reasonCode !== 'string'
    || !Object.prototype.hasOwnProperty.call(HEALTH_PAIRS, raw.reasonCode)) return undefined
  const reasonCode = raw.reasonCode as keyof typeof HEALTH_PAIRS
  const [expectedStatus, recoveryCode] = HEALTH_PAIRS[reasonCode]
  if (expectedStatus !== status || raw.recoveryCode !== recoveryCode) return undefined
  if (reasonCode === 'COMPLETE_EMPTY_CURRENT' && count !== 0) return undefined
  if (reasonCode === 'COMPLETE_OBSERVATION_CURRENT' && !(count !== null && count > 0)) return undefined
  return { version: 1, reasonCode, recoveryCode }
}

function assignment(value: unknown): DirectoryRoleAssignmentView | null {
  if (!isRecord(value)) return null
  const id = text(value.id)
  if (!id) return null
  return {
    id,
    principalId: text(value.principalId),
    roleDefinitionId: text(value.roleDefinitionId),
    roleDisplayName: text(value.roleDisplayName),
    directoryScopeId: text(value.directoryScopeId),
    appScopeId: text(value.appScopeId),
  }
}

/** Returns null for anything unsupported or malformed. A null result means "we could not read this
 * answer", which the view renders differently from any server status — degrading it into
 * 'never-collected' would state something the server did not say. */
export function parseDirectoryRoleResults(value: unknown): DirectoryRoleResultsView | null {
  if (!isRecord(value)) return null
  if (value.responseVersion !== DIRECTORY_ROLE_RESPONSE_VERSION) return null
  const source = text(value.source)
  if (!source) return null

  const status = value.status
  if (status !== 'not-activated' && status !== 'never-collected' && status !== 'current'
    && status !== 'stale' && status !== 'superseded') return null

  if (!isRecord(value.latestAttempt)) return null
  const outcome = value.latestAttempt.outcome
  if (outcome !== null && outcome !== 'RUNNING' && outcome !== 'FAILED'
    && outcome !== 'PARTIAL' && outcome !== 'EXPIRED') return null
  const terminalRaw = value.latestAttempt.terminalAt
  if (terminalRaw !== null && typeof terminalRaw !== 'string') return null
  const terminalAt = terminalRaw === null ? null : time(terminalRaw)
  if (terminalRaw !== null && !terminalAt) return null
  const latestAttempt: DirectoryRoleLatestAttemptView = { outcome, terminalAt }

  const raw = value.observation
  if (!Object.prototype.hasOwnProperty.call(value, 'observation')) return null

  // Only 'current' and 'stale' may carry an observation; any other status carrying one contradicts
  // itself, and those two statuses without one are equally contradictory.
  const mayObserve = status === 'current' || status === 'stale'
  if (!mayObserve) {
    if (raw !== null) return null
    return { status, source, observation: null, latestAttempt, health: parseHealth(value.health, status, null) }
  }
  if (!isRecord(raw)) return null

  const checkedAt = time(raw.checkedAt)
  if (!checkedAt || !finite(raw.ageMs) || !finite(raw.observedCount)) return null
  if (!Array.isArray(raw.assignments)) return null
  const assignments: DirectoryRoleAssignmentView[] = []
  for (const row of raw.assignments) {
    const parsed = assignment(row)
    if (!parsed) return null
    assignments.push(parsed)
  }
  // The server's own count and the rows it sent must agree, or we cannot report either.
  if (raw.observedCount !== assignments.length) return null
  // Verbatim, never re-derived from the row count: if the server stops vouching for an empty result,
  // the client must not promote it back to "verified".
  if (typeof raw.verifiedCompleteEmpty !== 'boolean') return null
  if (raw.verifiedCompleteEmpty !== (assignments.length === 0)) return null

  return {
    status,
    source,
    observation: {
      checkedAt,
      ageMs: raw.ageMs,
      observedCount: assignments.length,
      assignments,
      verifiedCompleteEmpty: raw.verifiedCompleteEmpty,
    },
    latestAttempt,
    health: parseHealth(value.health, status, assignments.length),
  }
}
