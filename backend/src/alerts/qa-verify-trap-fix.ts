// QA — verify the RULING, not the change. Two questions:
//   1. does the obvious caller now produce ONE job?
//   2. is the retry still VISIBLE, or did we trade a permanent false unconfirmed for a silent one?
import {
  EMPTY_LEDGER, accept, accounting, authenticate, idempotencyKey, messageId,
  providerMessageId, record, unconfirmed,
  type Acceptance, type Body, type RawWebhook, type SendAttempt,
} from './email-delivery.js'

const BODY: Body = [{ kind: 'WINDOW', fromIso: '2026-09-12T00:00:00.000Z', toIso: '2026-09-12T01:00:00.000Z' }]
const attempt = (id: string): SendAttempt => ({
  messageId: messageId(id), to: 'soc@msp.example' as never, body: BODY, idempotencyKey: idempotencyKey('SAME'),
})
const ok = (pid: string, at: string): Acceptance => ({ kind: 'ACCEPTED', providerId: providerMessageId(pid), atIso: at })
const raw = (pid: string, k: RawWebhook['kind'], at: string): RawWebhook =>
  ({ providerId: providerMessageId(pid), kind: k, atIso: at, bounce: null })
const T0 = '2026-09-12T00:00:00.000Z', T1 = '2026-09-12T00:00:30.000Z'

// THE OBVIOUS CALLER: send, accept, timeout, send again with the same key, accept again.
const once = accept(EMPTY_LEDGER, attempt('m1'), ok('p1', T0))
const retried = accept(once, attempt('m1'), ok('p1', T1))   // Resend returns the SAME id
const resolved = record(retried, authenticate(raw('p1', 'DELIVERED', '2026-09-12T00:05:00.000Z'), 'AUTHENTIC'))

// AND THE CONTROL: a genuinely different message must still make its own job.
const different = accept(retried, attempt('m2'), ok('p2', T1))

console.log(JSON.stringify({
  QA_TRAP_FIX: {
    q1_obviousCallerProducesOneJob: {
      jobsAfterRetry: retried.jobs.length,
      statesAfterOneDeliveredEvent: resolved.jobs.map((j) => j.state),
      stillUnconfirmedAtTwoHours: unconfirmed(resolved, '2026-09-12T02:00:00.000Z', 3_600_000).length,
      verdict: retried.jobs.length === 1 && unconfirmed(resolved, '2026-09-12T02:00:00.000Z', 3_600_000).length === 0
        ? 'CLOSED - my measured case is now unreachable' : 'STILL OPEN',
    },
    q2_theRetryIsStillVisible: {
      retriesRecorded: retried.retries.length,
      retryEntry: retried.retries[0] ?? null,
      accountingSeesIt: accounting(retried, 0),
      verdict: retried.retries.length === 1
        ? 'VISIBLE - absorbed into a named list, not silently dropped'
        : 'SILENT - a worse trade than the bug it replaced',
    },
    q3_controlADifferentMessageStillGetsItsOwnJob: {
      jobs: different.jobs.length,
      retries: different.retries.length,
      verdict: different.jobs.length === 2 && different.retries.length === 1
        ? 'DISCRIMINATES - absorbs only a repeated provider id' : 'OVER-ABSORBS',
    },
  },
}, null, 2))

// THE FIRING CASE. Same provider id, DIFFERENT message: not a retry, a collision — and one
// message's outcome would resolve the other's job. Absorbing that silently would be the real
// danger of this ruling, so the guard must discriminate rather than absorb everything.
const collision = accept(once, attempt('DIFFERENT-MESSAGE'), ok('p1', T1))
console.log(JSON.stringify({
  QA_TRAP_FIX_FIRING_CASE: {
    jobs: collision.jobs.length,
    retries: collision.retries.length,
    accountingProblems: accounting(collision, 0),
    verdict: accounting(collision, 0).length === 1
      ? 'FIRES - a collision is named, so the absorb is not indiscriminate'
      : 'DOES NOT FIRE - absorbing hides a genuine identifier collision',
  },
}, null, 2))
