/**
 * A bounded, closed record of the LATEST budget refusal observed inside one
 * Microsoft 365 audit attempt.
 *
 * Why this exists. A content-budget refusal is swallowed inside
 * `processContent` and the visit then reaches its terminal write reporting
 * `RUNNING` / `m365-audit-backlog` -- exactly what an ordinary provider retry
 * reports. The boundary the refusal already computed is written to the content
 * row and nowhere a tenant-level reader can see it, so a reader cannot tell a
 * cost refusal from a retry. This envelope closes that gap and nothing else.
 *
 * What it does NOT mean. It describes the latest refused operation of its own
 * attempt. It is NOT a statement about every pending blob, not a tenant-wide
 * resumption time, not a promise that ingestion succeeds at the boundary, and
 * not evidence of current execution or of freshness. Absent or unusable
 * metadata means **unknown** -- never that no budget block exists, and never
 * that work completed. The boundary is the earliest retry eligibility only.
 *
 * Deliberately storable values only: a version, an attempt token, the attempt
 * time, and one refusal of closed shape. No error prose, no provider content
 * id, URI or body, no quota or limit values, no resource payload, no secrets.
 */

/** Which collection path the refusal was observed on. */
export const M365_AUDIT_REFUSAL_PATHS = ['content', 'discovery'] as const
export type M365AuditRefusalPath = typeof M365_AUDIT_REFUSAL_PATHS[number]

/**
 * The eight caps the existing budget decision checks, as closed identifiers.
 *
 * ORDER IS THE CONTRACT. When more than one cap is exceeded by the same
 * decision, the first member of this list that was exceeded is recorded. It
 * matches the existing monthly-over-daily precedence of the thrown error, then
 * orders within a period as tenant bytes, deployment bytes, tenant records,
 * deployment records. The recorded value is therefore a **representative**
 * exceeded cap, not a claim that it was the only one.
 */
export const M365_AUDIT_BUDGET_CONSTRAINTS = [
  'monthly_tenant_bytes',
  'monthly_deployment_bytes',
  'monthly_tenant_records',
  'monthly_deployment_records',
  'daily_tenant_bytes',
  'daily_deployment_bytes',
  'daily_tenant_records',
  'daily_deployment_records',
] as const
export type M365AuditBudgetConstraint = typeof M365_AUDIT_BUDGET_CONSTRAINTS[number]

/** Only this version is read. An unknown version is unknown, never guessed. */
export const M365_AUDIT_ATTEMPT_ENVELOPE_VERSION = 1

/** Deferred codes whose RUNNING state may carry a qualified observation. Both
 *  already exist and are already treated as deferred by the readers. */
export const M365_AUDIT_DEFERRED_CODES = ['m365-audit-backlog', 'm365-audit-budget-exhausted'] as const

const MAX_TOKEN_LENGTH = 64
const MAX_TIMESTAMP_LENGTH = 32

export type M365AuditRefusalObservation = {
  attemptToken: string
  path: M365AuditRefusalPath
  constraint: M365AuditBudgetConstraint
  observedAt: string
  retryNotBefore: string
}

export type M365AuditAttemptEnvelope = {
  v: number
  attemptToken: string
  attemptAt: string
  refusal: M365AuditRefusalObservation | null
}

/** Exactly these own keys, nothing more and nothing less. */
const ENVELOPE_KEYS = ['v', 'attemptToken', 'attemptAt', 'refusal'] as const
const REFUSAL_KEYS = ['attemptToken', 'path', 'constraint', 'observedAt', 'retryNotBefore'] as const

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => own.includes(key))
}

function boundedToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH &&
    /^[A-Za-z0-9-]+$/.test(value)
}

/** A finite instant, round-tripping its own canonical ISO form. */
function instant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TIMESTAMP_LENGTH) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return null
  return new Date(time).toISOString() === value ? time : null
}

/**
 * The representative exceeded cap, in the documented order. `null` when the
 * caller proved no specific cap -- a manually or historically constructed
 * error must yield no detail rather than a fabricated one.
 */
export function selectBudgetConstraint(
  exceeded: Partial<Record<M365AuditBudgetConstraint, boolean>>,
): M365AuditBudgetConstraint | null {
  for (const candidate of M365_AUDIT_BUDGET_CONSTRAINTS) {
    if (exceeded[candidate] === true) return candidate
  }
  return null
}

/** A fresh envelope for an attempt that is starting. Any prior observation is
 *  dropped here, which is how a new attempt invalidates the old one. */
export function beginAttemptEnvelope(attemptToken: string, attemptAt: Date): M365AuditAttemptEnvelope {
  return {
    v: M365_AUDIT_ATTEMPT_ENVELOPE_VERSION,
    attemptToken,
    attemptAt: attemptAt.toISOString(),
    refusal: null,
  }
}

/** The same envelope carrying this attempt's latest refusal. A refusal whose
 *  token does not match the attempt is refused outright. */
export function envelopeWithRefusal(
  envelope: M365AuditAttemptEnvelope,
  refusal: {
    attemptToken: string
    path: M365AuditRefusalPath
    constraint: M365AuditBudgetConstraint
    observedAt: Date
    retryNotBefore: Date
  },
): M365AuditAttemptEnvelope | null {
  if (refusal.attemptToken !== envelope.attemptToken) return null
  if (!Number.isFinite(refusal.observedAt.getTime())) return null
  if (!Number.isFinite(refusal.retryNotBefore.getTime())) return null
  return {
    ...envelope,
    refusal: {
      attemptToken: refusal.attemptToken,
      path: refusal.path,
      constraint: refusal.constraint,
      observedAt: refusal.observedAt.toISOString(),
      retryNotBefore: refusal.retryNotBefore.toISOString(),
    },
  }
}

/** Strict parse. Anything unexpected -- a legacy null, an unknown version, an
 *  extra key, a non-closed enum, an unparseable instant -- is `null`. */
export function parseAttemptEnvelope(value: unknown): M365AuditAttemptEnvelope | null {
  if (!plainRecord(value) || !exactKeys(value, ENVELOPE_KEYS)) return null
  if (value.v !== M365_AUDIT_ATTEMPT_ENVELOPE_VERSION) return null
  if (!boundedToken(value.attemptToken)) return null
  if (instant(value.attemptAt) === null) return null
  const refusal = value.refusal
  if (refusal === null) {
    return { v: value.v, attemptToken: value.attemptToken, attemptAt: value.attemptAt as string, refusal: null }
  }
  if (!plainRecord(refusal) || !exactKeys(refusal, REFUSAL_KEYS)) return null
  if (!boundedToken(refusal.attemptToken)) return null
  if (!(M365_AUDIT_REFUSAL_PATHS as readonly unknown[]).includes(refusal.path)) return null
  if (!(M365_AUDIT_BUDGET_CONSTRAINTS as readonly unknown[]).includes(refusal.constraint)) return null
  if (instant(refusal.observedAt) === null || instant(refusal.retryNotBefore) === null) return null
  return {
    v: value.v,
    attemptToken: value.attemptToken,
    attemptAt: value.attemptAt as string,
    refusal: {
      attemptToken: refusal.attemptToken,
      path: refusal.path as M365AuditRefusalPath,
      constraint: refusal.constraint as M365AuditBudgetConstraint,
      observedAt: refusal.observedAt as string,
      retryNotBefore: refusal.retryNotBefore as string,
    },
  }
}

/** What a reader may be told, once every condition below holds. */
export type QualifiedBudgetRefusal = {
  path: M365AuditRefusalPath
  constraint: M365AuditBudgetConstraint
  observedAt: string
  /** Earliest retry eligibility. NOT a promise of resumption or completion. */
  retryNotBefore: string
}

/**
 * The reader gate. Returns a detail only when all of these hold, against ONE
 * captured evaluation clock:
 *
 *   - the resource is M365_AUDIT and its state is currently RUNNING;
 *   - its error code is one of the two already-recognised deferred codes;
 *   - the envelope parses at a supported version and carries a refusal;
 *   - the refusal belongs to the envelope's own attempt token;
 *   - the envelope's attempt time equals the row's captured `lastAttemptAt`;
 *   - the observation time is finite, not in the future, and not before the
 *     attempt started;
 *   - the boundary is finite and STRICTLY after the evaluation clock.
 *
 * Nothing here consults a usage date, so a monthly boundary stays usable across
 * a UTC day rollover for as long as its own attempt is still the current one.
 * At the exact boundary the detail is suppressed -- which withholds a stale
 * future claim without inventing success.
 */
export function qualifiedBudgetRefusal(
  state: {
    resourceType?: string
    status?: string
    lastErrorCode?: string | null
    lastAttemptAt?: Date | null
    m365AuditAttempt?: unknown
  } | null | undefined,
  now: Date,
): QualifiedBudgetRefusal | null {
  if (!state) return null
  if (state.resourceType !== 'M365_AUDIT') return null
  if (state.status !== 'RUNNING') return null
  if (typeof state.lastErrorCode !== 'string') return null
  if (!(M365_AUDIT_DEFERRED_CODES as readonly string[]).includes(state.lastErrorCode)) return null
  const evaluatedAt = now.getTime()
  if (!Number.isFinite(evaluatedAt)) return null
  const envelope = parseAttemptEnvelope(state.m365AuditAttempt)
  if (!envelope || !envelope.refusal) return null
  if (envelope.refusal.attemptToken !== envelope.attemptToken) return null
  const attemptAt = instant(envelope.attemptAt)
  const recorded = state.lastAttemptAt
  if (attemptAt === null || !(recorded instanceof Date)) return null
  const recordedAt = recorded.getTime()
  if (!Number.isFinite(recordedAt) || recordedAt !== attemptAt) return null
  const observedAt = instant(envelope.refusal.observedAt)
  const retryNotBefore = instant(envelope.refusal.retryNotBefore)
  if (observedAt === null || retryNotBefore === null) return null
  if (observedAt > evaluatedAt || observedAt < attemptAt) return null
  if (retryNotBefore <= evaluatedAt) return null
  return {
    path: envelope.refusal.path,
    constraint: envelope.refusal.constraint,
    observedAt: envelope.refusal.observedAt,
    retryNotBefore: envelope.refusal.retryNotBefore,
  }
}
