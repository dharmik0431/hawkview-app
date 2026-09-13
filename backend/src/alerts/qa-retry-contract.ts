// QA PRE-REGISTRATION — THE RETRY LAYER, written before the code exists.
//
// Run from a worktree at the engineer tip: it imports the real step-06 types.
//
// This is M1 and M2's home. My red-line assessment found them unaskable of the send seam and
// said the properties were HOMELESS RATHER THAN LOST. This is the house. It is also the last
// seam before launch, so a property that becomes unaskable here has nothing above it left to
// carry it.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SEAM ATTACK, SPENT FIRST. Seven for seven so far.
//
// The obvious shape is `sendWithRetries(message, maxAttempts): Promise<Outcome>`, or a store
// with `enqueue` / `claim` / `markSent`. Six things it cannot express:
//
// 1. A BOUND HELD BY THE LOOP IS NOT A BOUND. If `maxAttempts` is a parameter of the runner,
//    the count lives in the process. A redeploy, a crash, or a second worker starts it again
//    from zero — so the job retries forever while every test of the runner shows it stopping
//    at three. **The bound has to be a fact recorded on the job, not an argument to the
//    caller.** This is the one I would have got wrong.
//
// 2. AN ATTEMPT THAT NEVER RETURNED CANNOT BE RECORDED BY CODE THAT RECORDS ON RETURN. The
//    process dies between the HTTP call and the write. Anything shaped `const r = await
//    send(); record(r)` is structurally incapable of noticing, and AN ATTEMPT THAT VANISHED
//    LOOKS EXACTLY LIKE AN ATTEMPT THAT NEVER HAPPENED — the silence this feature exists to
//    remove. So the attempt must be written BEFORE the side effect, and the seam must have
//    somewhere to put a started-but-unfinished attempt.
//
// 3. "STOPPED RETRYING" AND "SUCCEEDED" ARE THE SAME OBSERVATION if the only signal is absence
//    from a queue. A job that exhausts its attempts and is dropped leaves the same evidence as
//    one that was delivered: nothing pending. That is EXHAUSTED arriving in a new layer, and it
//    is why exhaustion must be a STATE rather than a removal.
//
// 4. ONE SEND PER LOGICAL MESSAGE IS A PROPERTY OF A HISTORY, NOT OF A CALL. `enqueue` twice
//    returning the same id says the store deduplicated the ROW. It does not say how many times
//    we went to the provider. The seam must answer "how many sends happened for this message",
//    which means the attempts are inspectable and not merely counted.
//
// 5. TWO WORKERS CLAIMING ONE JOB IS THE APPLY'S LESSON IN A NEW PLACE. A `claim()` that reads
//    then writes lets both through — I measured exactly that against Postgres, 25 rounds out of
//    25, on the migration. The claim and the write must be ONE statement, so the seam has to
//    express a conditional claim rather than a fetch.
//
// 6. BACKOFF CANNOT BE TESTED THROUGH A FUNCTION THAT CALLS `Date.now()`. Time has to be an
//    input, or "may this be tried again yet" is only answerable by sleeping.
//
// WHAT THIS DELIBERATELY DOES NOT DECIDE: the schedule, the storage engine, the worker model,
// or how the send is performed. Those are design.
//
// WHAT NOBODY HERE CAN PIN, and it must not hide inside a passing check: whether Resend honours
// an idempotency key. Every crash-retry path below is safe ONLY because the send is idempotent
// at the provider, which is a claim about Resend and not about this code. If it is false,
// attempt 2 after a crash is a second email.
// ═════════════════════════════════════════════════════════════════════════════
import type { IdempotencyKey, MessageId, ProviderMessageId, RefusalCode } from './email-delivery.js'

/** A logical message. The thing that must be sent ONCE however many times it is enqueued. */
export type LogicalMessageId = string & { readonly __logicalMessageId: unique symbol }

/** ONE ATTEMPT, WRITTEN BEFORE THE SEND. `finished` is null for an attempt that started and
 * never came back — the state a crash leaves, and the one a record-on-return design cannot
 * represent at all. */
export interface Attempt {
  readonly ordinal: number
  readonly startedAtIso: string
  readonly finished: AttemptResult | null
}

export type AttemptResult =
  | Readonly<{ kind: 'ACCEPTED'; providerId: ProviderMessageId; atIso: string }>
  | Readonly<{ kind: 'REFUSED'; code: RefusalCode; atIso: string }>
  | Readonly<{ kind: 'ERRORED'; because: string; atIso: string }>

/** WHERE A JOB STANDS. Closed, and EXHAUSTED is a member rather than a removal.
 *
 * `attemptsAllowed` sits on the job, not on the runner — seam attack 1. A restart cannot reset
 * what it never held. */
export type RetryState =
  | Readonly<{ kind: 'WAITING'; notBeforeIso: string }>
  | Readonly<{ kind: 'IN_FLIGHT'; since: string; attemptOrdinal: number }>
  | Readonly<{ kind: 'SENT'; providerId: ProviderMessageId; atIso: string }>
  | Readonly<{ kind: 'EXHAUSTED'; afterAttempts: number; lastBecause: string }>
  | Readonly<{ kind: 'GAVE_UP'; because: RefusalCode; atIso: string }>

export interface RetryJob {
  readonly logicalMessageId: LogicalMessageId
  readonly messageId: MessageId
  readonly idempotencyKey: IdempotencyKey
  /** THE BOUND, ON THE JOB. */
  readonly attemptsAllowed: number
  readonly attempts: readonly Attempt[]
  readonly state: RetryState
}

export interface RetryStore {
  readonly jobs: readonly RetryJob[]
}

/** A conditional claim: it names what it expects to find, so the store can make the check and
 * the write one statement. A `claim(): Job` cannot be asked whether two workers both got it. */
export type Claim = Readonly<{
  logicalMessageId: LogicalMessageId
  expectedState: RetryState['kind']
  expectedAttempts: number
  workerId: string
  atIso: string
}>

export type ClaimResult =
  | Readonly<{ kind: 'CLAIMED'; job: RetryJob }>
  | Readonly<{ kind: 'LOST'; because: 'STATE_MOVED' | 'ATTEMPTS_MOVED' | 'NO_SUCH_JOB' }>

/** THE SEAM. Time in, no clock inside; store in, store out. */
export interface RetrySeam {
  readonly enqueue: (store: RetryStore, job: Omit<RetryJob, 'state' | 'attempts'>, nowIso: string) => RetryStore
  readonly claim: (store: RetryStore, claim: Claim) => Readonly<{ store: RetryStore; result: ClaimResult }>
  readonly finish: (store: RetryStore, id: LogicalMessageId, result: AttemptResult, nowIso: string) => RetryStore
  /** Jobs whose attempt started and never finished, older than a cutoff. The crash report. */
  readonly stranded: (store: RetryStore, nowIso: string, afterMs: number) => readonly RetryJob[]
  /** Every job in exactly one state, every attempt accounted for. Empty when the books balance. */
  readonly accounting: (store: RetryStore) => readonly string[]
}

/** THE PROPERTIES. Pre-registered, and binding on me.
 *
 * R1 ONE SEND PER LOGICAL MESSAGE. Enqueued twice, it has one job and one attempt chain.
 * R2 THE BOUND IS ON THE JOB. A fresh runner with a different opinion cannot raise it.
 * R3 EXHAUSTION IS A STATE, never a removal and never indistinguishable from SENT.
 * R4 AN ATTEMPT THAT NEVER FINISHED IS VISIBLE, and reported by `stranded`.
 * R5 ONE CLAIM WINS. A second claim on stale expectations is LOST, not a second send.
 * R6 TIME IS AN INPUT. No function consults a clock.
 * R7 EVERY JOB IS IN EXACTLY ONE STATE, and `accounting` says so rather than a reader assuming.
 * R8 NO TENANT ANYWHERE, carried up from M9 — a per-tenant retry queue undoes the coalescing.
 * R9 A REFUSAL IS NOT AN EXHAUSTION. GAVE_UP and EXHAUSTED are different facts with different
 *    remedies, and collapsing them hides which one happened.
 * R10 A TERMINAL STATE IS NOT CLAIMABLE. FOUND BY MY OWN CHECKS, not by inspection: R2 failed
 *    against my own reference because a job that had EXHAUSTED could be claimed again, which
 *    makes the bound decorative. SENT, EXHAUSTED and GAVE_UP must all refuse a claim.
 */
export const PRE_REGISTERED_RETRY = [
  'R1 one send per logical message',
  'R2 the bound is on the job, not the runner',
  'R3 exhaustion is a state, never a removal',
  'R4 an attempt that never finished is visible',
  'R5 one claim wins',
  'R6 time is an input',
  'R7 every job is in exactly one state',
  'R8 no tenant anywhere',
  'R9 a refusal is not an exhaustion',
  'R10 a terminal state is not claimable',
] as const

/** WHAT I PROPOSE VERSUS WHAT BINDS ME, the same split as step 06.
 *
 * R1-R9 ARE PRE-REGISTERED AND BIND ME. The shape above is A PROPOSAL: it exists because I had
 * to answer whether these can be checked at all, and six of them could not be through the
 * obvious shape. If the implementer picks another shape the properties stay and my checks get
 * rewritten. The one thing I will not accept is a shape in which a property becomes UNASKABLE
 * — and this time there is no layer above to carry it. */
