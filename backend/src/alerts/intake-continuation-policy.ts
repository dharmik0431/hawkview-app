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

/** A pure classification of a *locked* finding against one UTC clock sampled
 * by the database at decision time. It does not authorize any write or send.
 * Trusted outcomes preserve the source's exact observed timestamp for history;
 * an untrusted observation must never be presented as a confirmed event time. */
export type IntakeMode =
  | Readonly<{ kind: 'ACTIVE_ELIGIBLE'; observedAtExact: string; processedAtExact: string }>
  | Readonly<{ kind: 'HISTORICAL_ONLY'; reason: 'AGED_OUT' | 'EXPIRED_AT_PROCESSING' |
      'SOURCE_EXPIRED'; observedAtExact: string; processedAtExact: string }>
  | Readonly<{ kind: 'INELIGIBLE'; reason: 'SOURCE_NOT_ACTIVE';
      observedAtExact: string; processedAtExact: string }>
  | Readonly<{ kind: 'UNTRUSTED_TIME'; reason: 'PROCESSING_CLOCK_INVALID' |
      'OBSERVATION_INVALID' | 'OBSERVATION_IN_FUTURE' | 'EXPIRY_INVALID' |
      'EXPIRY_BEFORE_OBSERVATION'; observedAtExact: string | null;
      processedAtExact: string | null }>

const MICROSECONDS_PER_DAY = 86_400_000_000n

/** PostgreSQL `to_char(... AT TIME ZONE 'UTC', ...US...)` preserves six digits;
 * application ISO clocks may have three. Date.parse alone loses the remainder. */
function exactUtcMicroseconds(value: string | null | undefined): bigint | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}|\d{6})Z$/.exec(value)
  if (!match) return null
  const millisecondsIso = `${match[1]}.${match[2].slice(0, 3)}Z`
  const milliseconds = Date.parse(millisecondsIso)
  if (!Number.isFinite(milliseconds) ||
      new Date(milliseconds).toISOString() !== millisecondsIso) return null
  const remainder = match[2].length === 6 ? match[2].slice(3) : '0'
  return BigInt(milliseconds) * 1_000n + BigInt(remainder)
}

export function classifyLockedIntakeMode(
  source: Pick<IntakeSourceSnapshot, 'state' | 'observedAt' | 'expiresAt'>,
  processingClockUtcIso: string,
): IntakeMode {
  const processed = exactUtcMicroseconds(processingClockUtcIso)
  if (processed === null) return {
    kind: 'UNTRUSTED_TIME', reason: 'PROCESSING_CLOCK_INVALID',
    observedAtExact: null, processedAtExact: null,
  }
  const observed = exactUtcMicroseconds(source.observedAt)
  if (observed === null) return {
    kind: 'UNTRUSTED_TIME', reason: 'OBSERVATION_INVALID',
    observedAtExact: null, processedAtExact: processingClockUtcIso,
  }
  if (observed > processed) return {
    kind: 'UNTRUSTED_TIME', reason: 'OBSERVATION_IN_FUTURE',
    observedAtExact: null, processedAtExact: processingClockUtcIso,
  }
  const expires = exactUtcMicroseconds(source.expiresAt)
  if (expires === null) return {
    kind: 'UNTRUSTED_TIME', reason: 'EXPIRY_INVALID',
    observedAtExact: null, processedAtExact: processingClockUtcIso,
  }
  if (expires < observed) return {
    kind: 'UNTRUSTED_TIME', reason: 'EXPIRY_BEFORE_OBSERVATION',
    observedAtExact: null, processedAtExact: processingClockUtcIso,
  }
  const times = { observedAtExact: source.observedAt, processedAtExact: processingClockUtcIso }
  if (source.state === 'EXPIRED') return { kind: 'HISTORICAL_ONLY', reason: 'SOURCE_EXPIRED', ...times }
  if (!isActiveIntakeFinding(source.state)) return { kind: 'INELIGIBLE', reason: 'SOURCE_NOT_ACTIVE', ...times }
  if (expires <= processed) return { kind: 'HISTORICAL_ONLY', reason: 'EXPIRED_AT_PROCESSING', ...times }
  if (processed - observed > MICROSECONDS_PER_DAY) {
    return { kind: 'HISTORICAL_ONLY', reason: 'AGED_OUT', ...times }
  }
  return { kind: 'ACTIVE_ELIGIBLE', ...times }
}

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
