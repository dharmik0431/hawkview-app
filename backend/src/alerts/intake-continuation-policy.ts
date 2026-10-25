/**
 * Pure source-version rules for the proposed durable alert-intake continuation.
 * Nothing calls this from the production selector or writer yet. In particular,
 * this module does not decide whether old evidence should create an incident.
 *
 * Timestamp values must be lossless database representations. Converting a
 * PostgreSQL timestamptz to JavaScript Date before comparing can discard
 * microseconds and mistake an updated row for the one selected earlier.
 */
export type IntakeSourceSnapshot = Readonly<{
  id: string
  organizationId: string
  customerTenantId: string
  matchedResultId: string
  dedupeKey: string
  ruleId: string
  ruleVersion: string
  subjectType: string
  subjectId: string
  state: string
  severity: string
  confidence: string
  coverage: string
  observedAt: string
  expiresAt: string
  updatedAt: string
}>

export type IntakeDecisionReceipt = Readonly<{
  findingId: string
  organizationId: string
  customerTenantId: string
  ruleId: string
  ruleVersion: string
  outcome: 'COMPLETED' | 'BLOCKED_UNMAPPED' | 'AGED_OUT_RECORDED' | 'EXPIRED_BEFORE_INTAKE'
  mappingRevision: string
}>

export type IntakeReviewReason =
  | 'INACTIVE'
  | 'UNSEEN'
  | 'IDENTITY_CHANGED'
  | 'SCOPE_MISMATCH'
  | 'MAPPING_CHANGED'
  | 'UNCHANGED'
  | 'BLOCKED_UNMAPPED'

export function isActiveIntakeFinding(state: string): boolean {
  return state === 'OPEN' || state === 'UPDATED'
}

/** Strict write-time CAS guard; never use this full tuple as the candidate retry predicate. */
export function sameIntakeSourceSnapshot(
  selected: IntakeSourceSnapshot,
  current: IntakeSourceSnapshot,
): boolean {
  return selected.id === current.id &&
    selected.organizationId === current.organizationId &&
    selected.customerTenantId === current.customerTenantId &&
    selected.matchedResultId === current.matchedResultId &&
    selected.dedupeKey === current.dedupeKey &&
    selected.ruleId === current.ruleId &&
    selected.ruleVersion === current.ruleVersion &&
    selected.subjectType === current.subjectType &&
    selected.subjectId === current.subjectId &&
    selected.state === current.state &&
    selected.severity === current.severity &&
    selected.confidence === current.confidence &&
    selected.coverage === current.coverage &&
    selected.observedAt === current.observedAt &&
    selected.expiresAt === current.expiresAt &&
    selected.updatedAt === current.updatedAt
}

/**
 * Durable eligibility follows the immutable finding UUID, not the evaluator's
 * mutable source version. Its routine OPEN -> UPDATED and timestamp refreshes
 * must not requeue a completed or terminal finding ahead of unseen evidence.
 * Producers upsert by scoped dedupe key without updating that key on the same
 * finding row. A deliberate new evidence identity must create a new UUID.
 * A changed tenant scope requires explicit review; it is not a candidate.
 * Unmapped rules reopen only when their rule id/version or reviewed mapping
 * revision changes. The future SQL selector must apply this predicate before
 * ORDER BY/LIMIT, not after fetching the first page.
 */
export function intakeReviewReason(
  source: IntakeSourceSnapshot,
  receipt: IntakeDecisionReceipt | null,
  mappingRevision: string,
): IntakeReviewReason {
  if (!isActiveIntakeFinding(source.state)) return 'INACTIVE'
  if (receipt === null) return 'UNSEEN'
  if (receipt.organizationId !== source.organizationId ||
    receipt.customerTenantId !== source.customerTenantId) return 'SCOPE_MISMATCH'
  if (receipt.findingId !== source.id) return 'IDENTITY_CHANGED'
  if (receipt.outcome === 'BLOCKED_UNMAPPED') {
    return receipt.ruleId !== source.ruleId ||
      receipt.ruleVersion !== source.ruleVersion ||
      receipt.mappingRevision !== mappingRevision
      ? 'MAPPING_CHANGED' : 'BLOCKED_UNMAPPED'
  }
  return 'UNCHANGED'
}
