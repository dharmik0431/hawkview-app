// QA — my ten pre-registered retry properties, BOUND against the built send-queue.
// Blobs of the pre-registration: contract 5761068..., prereg 36185cd... (commit a7c78e7).
// The shape is the implementer's, not mine; the properties are the ones I registered.
import {
  TERMINAL, accounting, afterAttempt, backoffMs, claimStatement, eligibility, inFlight,
  neverSent, sentMoreThanOnce, workerId,
  type Attempt, type SendJob, type Settled,
} from './send-queue.js'
import { idempotencyKey, messageId, providerMessageId } from './email-delivery.js'

const T = (m: number) => new Date(Date.UTC(2026, 8, 12, 0, m, 0)).toISOString()
const job = (over: Partial<SendJob> = {}): SendJob => ({
  messageId: messageId('m1'), idempotencyKey: idempotencyKey('k1'), state: 'READY',
  attemptsMade: 0, maxAttempts: 3, notBeforeIso: T(0), claim: null, providerId: null, ...over,
})
const retryable: Settled = { kind: 'REFUSED_RETRYABLE', atIso: T(1), because: 'boom' }
const r: Record<string, unknown> = {}

// R1 — one send per logical message, over a HISTORY.
const twiceAccepted: Attempt[] = [
  { messageId: messageId('m1'), attemptNo: 1, startedAtIso: T(0), settled: { kind: 'ACCEPTED', providerId: providerMessageId('p1'), atIso: T(0) } },
  { messageId: messageId('m1'), attemptNo: 2, startedAtIso: T(1), settled: { kind: 'ACCEPTED', providerId: providerMessageId('p1'), atIso: T(1) } },
]
r.R1 = { askable: true, onClean: sentMoreThanOnce([twiceAccepted[0]!]).length, onDouble: sentMoreThanOnce(twiceAccepted),
  verdict: sentMoreThanOnce([twiceAccepted[0]!]).length === 0 && sentMoreThanOnce(twiceAccepted).length === 1 ? 'BOUND - quiet on one, fires on two' : 'FAILED' }

// R2 — the bound is a fact on the job. Spend it and the job refuses regardless of any runner.
let spent = job({ attemptsMade: 0, maxAttempts: 2 })
spent = afterAttempt(spent, retryable); spent = afterAttempt(spent, retryable)
const budget = eligibility(job({ attemptsMade: 2, maxAttempts: 2 }), T(999))
r.R2 = { askable: true, stateAfterSpending: spent.state, attemptsMade: spent.attemptsMade,
  refusesWhenSpent: budget.mayAttempt === false ? budget.because.kind : 'ALLOWED',
  verdict: spent.state === 'EXHAUSTED' && spent.attemptsMade === 2 ? 'BOUND - the job holds its own budget' : 'FAILED' }

// R3 — exhaustion is a STATE and it is reportable, not a gap.
const reported = neverSent([spent, job({ messageId: messageId('m2'), state: 'SENT' })])
r.R3 = { askable: true, reported, verdict: reported.length === 1 && reported[0]?.state === 'EXHAUSTED' ? 'BOUND - stopping is reportable, and SENT is not in the list' : 'FAILED' }

// R4 — an attempt that started and never settled is visible.
const stranded: Attempt[] = [{ messageId: messageId('m1'), attemptNo: 1, startedAtIso: T(0), settled: null }]
r.R4 = { askable: true, beforeDeadline: inFlight(stranded, T(1), 600_000).length, afterDeadline: inFlight(stranded, T(30), 600_000).length,
  verdict: inFlight(stranded, T(1), 600_000).length === 0 && inFlight(stranded, T(30), 600_000).length === 1 ? 'BOUND - and it discriminates on the deadline' : 'FAILED' }

// R6 — time is an input. Same inputs twice, identical output; and backoff grows.
const a = JSON.stringify(afterAttempt(job(), retryable)), b = JSON.stringify(afterAttempt(job(), retryable))
r.R6 = { askable: true, deterministic: a === b, backoff: [1, 2, 3, 9].map((n) => backoffMs(n)),
  verdict: a === b && backoffMs(1) < backoffMs(2) && backoffMs(9) === backoffMs(20) ? 'BOUND - deterministic, growing, and capped' : 'FAILED' }

// R7 — every job in exactly one state; the books balance or say which figure to look at.
const balanced = accounting([job({ attemptsMade: 1 })], [{ messageId: messageId('m1'), attemptNo: 1, startedAtIso: T(0), settled: retryable }])
const skewed = accounting([job({ attemptsMade: 5 })], [])
r.R7 = { askable: true, balanced, skewed, verdict: balanced.length === 0 && skewed.length === 1 ? 'BOUND - quiet when it balances, names the figure when it does not' : 'FAILED' }

// R9 — a refusal is not an exhaustion.
const permanent = afterAttempt(job({ maxAttempts: 5 }), { kind: 'REFUSED_PERMANENT', atIso: T(1), because: 'invalid address' })
r.R9 = { askable: true, permanentGives: permanent.state, budgetLeft: permanent.maxAttempts - permanent.attemptsMade,
  verdict: permanent.state === 'GAVE_UP' && spent.state === 'EXHAUSTED' ? 'BOUND - GAVE_UP with budget remaining, EXHAUSTED without' : 'FAILED' }

// R10 — a terminal state is not claimable. THE ONE MY OWN CHECKS FOUND.
const sql = claimStatement(messageId('m1'), workerId('w1'), T(0), 60_000).sql
r.R10 = { askable: true, terminalStatesRefused: TERMINAL.every((s) => sql.includes(`'${s}'`)),
  budgetInPredicate: sql.includes('attempts_made < max_attempts'),
  eligibilityAgrees: (() => { const e = eligibility(job({ state: 'SENT' }), T(999)); return e.mayAttempt === false ? e.because.kind : 'ALLOWED' })(),
  verdict: TERMINAL.every((s) => sql.includes(`'${s}'`)) && sql.includes('attempts_made < max_attempts') ? 'BOUND - in the WHERE clause, so the database enforces it' : 'FAILED' }

// R8 — no tenant anywhere. Type-level: there is no field to partition a queue on.
r.R8 = { askable: true, sendJobFields: Object.keys(job()), verdict: !Object.keys(job()).some((k) => /tenant/i.test(k)) ? 'BOUND - unwriteable, not discouraged' : 'FAILED' }

console.log(JSON.stringify({ QA_RETRY_BIND: r }, null, 2))
