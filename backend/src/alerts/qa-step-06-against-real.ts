// QA — my nine step-06 properties, re-checked against the REAL seam (email-delivery.ts).
// My pre-registration said: if the implementer picks a different shape, the properties stay
// and my checks get rewritten. This is that rewrite. The red line was a property becoming
// UNASKABLE, because unaskable reads exactly like passing.
import {
  EMPTY_LEDGER, accept, accounting, authenticate, idempotencyKey, messageId,
  providerMessageId, record, unconfirmed,
  type Acceptance, type Body, type Ledger, type RawWebhook, type SendAttempt,
} from './email-delivery.js'

const BODY: Body = [{ kind: 'WINDOW', fromIso: '2026-09-12T00:00:00.000Z', toIso: '2026-09-12T01:00:00.000Z' }]
const attempt = (id: string, key: string): SendAttempt => ({
  messageId: messageId(id), to: 'soc@msp.example' as never, body: BODY, idempotencyKey: idempotencyKey(key),
})
const accepted = (pid: string, at: string): Acceptance =>
  ({ kind: 'ACCEPTED', providerId: providerMessageId(pid), atIso: at })
const raw = (pid: string, kind: RawWebhook['kind'], at: string): RawWebhook =>
  ({ providerId: providerMessageId(pid), kind, atIso: at, bounce: null })

const T0 = '2026-09-12T00:00:00.000Z'
const results: Record<string, unknown> = {}

// ── M4. ACCEPTED IS NOT DELIVERED ────────────────────────────────────────────
// Strongest possible form: the two vocabularies share no member, so nothing can convert one
// into the other by accident. Type-level, and the negatives are in the module's own test file.
let l: Ledger = accept(EMPTY_LEDGER, attempt('m1', 'k1'), accepted('p1', T0))
results.M4 = {
  askable: true,
  jobStateAfterAcceptance: l.jobs[0]?.state,
  verdict: l.jobs[0]?.state === 'UNRESOLVED'
    ? 'HOLDS — acceptance produces UNRESOLVED, and Outcome has no ACCEPTED arm to promote it'
    : 'FAILED',
}

// ── M5. A BOUNCE LANDS ON ITS JOB ────────────────────────────────────────────
const bounced = record(l, authenticate(raw('p1', 'BOUNCED', '2026-09-12T00:05:00.000Z'), 'AUTHENTIC'))
const bj = bounced.jobs[0]
results.M5 = {
  askable: true,
  state: bj?.state,
  outcome: bj?.state === 'RESOLVED' ? bj.outcome.kind : null,
  bounceClass: bj?.state === 'RESOLVED' && bj.outcome.kind === 'BOUNCED' ? bj.outcome.bounce : null,
  verdict: bj?.state === 'RESOLVED' && bj.outcome.kind === 'BOUNCED' ? 'HOLDS' : 'FAILED',
}

// ── M6. AN EVENT FOR AN UNKNOWN MESSAGE IS NAMED ─────────────────────────────
const unknown = record(l, authenticate(raw('NOT-OURS', 'DELIVERED', T0), 'AUTHENTIC'))
const replayed = record(bounced, authenticate(raw('p1', 'DELIVERED', T0), 'AUTHENTIC'))
results.M6 = {
  askable: true,
  unknownNamed: unknown.unmatched[0]?.because,
  replayNamed: replayed.unmatched[0]?.because,
  forgedNamed: record(l, authenticate(raw('p1', 'DELIVERED', T0), 'SIGNATURE_INVALID')).unmatched[0]?.because,
  verdict: unknown.unmatched[0]?.because === 'NO_SUCH_JOB'
    && replayed.unmatched[0]?.because === 'ALREADY_RESOLVED' ? 'HOLDS — and stronger than I asked' : 'FAILED',
}

// ── M7. AN ACCEPTED JOB THAT NEVER RESOLVES IS REPORTED ──────────────────────
results.M7 = {
  askable: true,
  atOneMinute: unconfirmed(l, '2026-09-12T00:01:00.000Z', 3_600_000).length,
  atTwoHours: unconfirmed(l, '2026-09-12T02:00:00.000Z', 3_600_000).length,
  verdict: unconfirmed(l, '2026-09-12T00:01:00.000Z', 3_600_000).length === 0
    && unconfirmed(l, '2026-09-12T02:00:00.000Z', 3_600_000).length === 1
    ? 'HOLDS — and it discriminates: quiet before the window, reported after' : 'FAILED',
}

// ── M1. THE SAME IDEMPOTENCY KEY SENDS ONCE ──────────────────────────────────
// THE SEAM CARRIES THE KEY AND NEVER READS IT. Nothing here can be asked whether two sends
// carrying one key produced one email. What CAN be asked is what happens when they do.
const twice = accept(accept(EMPTY_LEDGER, attempt('m1', 'SAME'), accepted('p1', T0)),
  attempt('m1', 'SAME'), accepted('p1', T0)) // Resend honouring the key returns the SAME id
const afterEvent = record(twice, authenticate(raw('p1', 'DELIVERED', '2026-09-12T00:05:00.000Z'), 'AUTHENTIC'))
results.M1 = {
  askable: false,
  why: 'no function takes an idempotency key; accept() never reads attempt.idempotencyKey',
  whatHappensIfARetryIsRecorded: {
    jobs: twice.jobs.length,
    accountingCatchesIt: accounting(twice, 0).filter((p) => p.includes('share provider id')),
    afterOneDeliveredEvent: afterEvent.jobs.map((j) => j.state),
    stillUnconfirmedAtTwoHours: unconfirmed(afterEvent, '2026-09-12T02:00:00.000Z', 3_600_000).length,
  },
}

// ── M2. RETRIES ARE BOUNDED; EXHAUSTION IS ABANDONED WITH A REASON ───────────
// There is no ABANDONED state, no attempt ordinal and no bound anywhere in the module.
results.M2 = {
  askable: false,
  why: 'Job has three states and none is ABANDONED; nothing counts attempts; no bound is a parameter',
  jobStatesAvailable: ['UNRESOLVED', 'RESOLVED', 'REFUSED'],
}

// ── M3. EVERY ATTEMPT HAS A RECORDED OUTCOME ─────────────────────────────────
const refused = accept(EMPTY_LEDGER, attempt('m2', 'k2'), { kind: 'REFUSED', code: 'RATE_LIMITED', atIso: T0 })
results.M3 = {
  askable: 'PARTLY',
  why: 'every attempt that reaches accept() lands in exactly one state; an attempt that never '
    + 'reached accept() leaves no trace, and the ledger holds no attempt list to compare against',
  refusedRecorded: refused.jobs[0]?.state,
  accountingBalances: accounting(bounced, 1),
}

// ── M8 / M9. NO IDENTITY IN THE BODY, NO TENANT ON THE PATH ──────────────────
results.M8_M9 = {
  askable: true,
  form: 'type-level, and stronger than my version: BodyLine is a closed union of counts and '
    + 'catalogue ids with no string slot, and SendAttempt carries no tenant of any kind',
  sendAttemptFields: Object.keys(attempt('m', 'k')),
}

console.log(JSON.stringify({ QA_STEP_06_AGAINST_REAL_SEAM: results }, null, 2))
