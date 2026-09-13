import { type IdempotencyKey, type MessageId, type ProviderMessageId } from './email-delivery.js'

/**
 * THE RETRY LAYER — where idempotence and bounded retries live, because they could not live in
 * `email-delivery.ts`. That module's two homeless properties get a home here.
 *
 * I did not read the pre-registration blobs. This is built from the constraints as relayed, so
 * the independent check stays independent.
 *
 * NOTHING HERE SENDS ANYTHING. It decides what may be attempted, records what was attempted, and
 * emits the SQL for the one operation that cannot be done safely in application code. The send
 * itself belongs to a caller, and the seam is shaped so the obvious caller is correct.
 */

// ---------------------------------------------------------------------------------------
// THE BOUND IS A FACT ON THE JOB. This is the finding the whole module is shaped by.
// ---------------------------------------------------------------------------------------

/** Where a send has got to.
 *
 * THREE OF THESE REFUSE A CLAIM, and that is not a detail. A job that has EXHAUSTED its attempts
 * being claimable again makes the bound DECORATIVE — the count stops the loop and the next claim
 * starts a new loop, so the message retries forever while every test of the runner shows it
 * stopping at three.
 *
 * `EXHAUSTED` AND `GAVE_UP` ARE DIFFERENT FACTS. Exhausted means the budget ran out and the last
 * attempt might have worked. Gave up means something told us further attempts are pointless — a
 * hard bounce, an invalid address — and trying again is not merely futile but rude to the
 * recipient's mail server. Collapsing them loses the difference between "we ran out of patience"
 * and "this address does not exist". */
export type SendState = 'READY' | 'CLAIMED' | 'SENT' | 'EXHAUSTED' | 'GAVE_UP'

/** The states from which no further attempt may be made. Exported so a caller cannot maintain a
 * second, drifting copy of the list. */
export const TERMINAL: readonly SendState[] = ['SENT', 'EXHAUSTED', 'GAVE_UP']

export type WorkerId = string & { readonly __workerId: unique symbol }
export const workerId = (value: string): WorkerId => value as WorkerId

export interface SendJob {
  readonly messageId: MessageId
  /** Sent to the provider on every attempt, unchanged. What makes a retry after a crash safe —
   * see the module's note on what this layer cannot establish. */
  readonly idempotencyKey: IdempotencyKey
  readonly state: SendState
  /** ON THE JOB, NOT IN THE LOOP, and this is the finding.
   *
   * A `maxAttempts` argument to a runner lives in the PROCESS. A redeploy restarts the count from
   * zero; so does a second worker picking the job up. The job then retries forever while every
   * test of the runner shows it stopping at three, because the runner really does stop at three —
   * it is just not the only runner there has ever been.
   *
   * Both numbers are stored so the budget survives the thing that is spending it. */
  readonly attemptsMade: number
  readonly maxAttempts: number
  /** BACKOFF AS A FACT RATHER THAN A SLEEP. A worker that waits in memory is a worker whose wait
   * a redeploy discards, and a wait nobody can see is a wait nobody can test. */
  readonly notBeforeIso: string
  /** Who holds it and until when. Null when unclaimed. */
  readonly claim: Claim | null
  /** Set when the provider accepted it, so `SENT` is not merely a state but a state with the
   * evidence attached. */
  readonly providerId: ProviderMessageId | null
}

export interface Claim {
  readonly by: WorkerId
  readonly atIso: string
  /** A claim that outlives its holder must expire, or a worker that dies holding a job takes the
   * job with it. */
  readonly expiresIso: string
}

// NOTE ON WHAT IS ABSENT, WHICH IS THE POINT OF R8. There is no tenant on `SendJob`, on `Claim`,
// or anywhere in this file, and no function takes one. A per-tenant queue is therefore not
// discouraged — it is UNWRITEABLE, because there is no field to partition on. That is the
// one-message-per-cause rule enforced by the shape rather than by a reviewer noticing.

// ---------------------------------------------------------------------------------------
// ELIGIBILITY. Pure, and the clock is always a parameter.
// ---------------------------------------------------------------------------------------

/** Why a job may not be attempted now. Every arm names the job, because a count is not something
 * an operator can act on. */
export type Ineligible =
  | Readonly<{ kind: 'TERMINAL'; messageId: MessageId; state: SendState }>
  | Readonly<{ kind: 'BUDGET_SPENT'; messageId: MessageId; attemptsMade: number; maxAttempts: number }>
  | Readonly<{ kind: 'BACKING_OFF'; messageId: MessageId; notBeforeIso: string }>
  | Readonly<{ kind: 'CLAIMED_BY_ANOTHER'; messageId: MessageId; by: WorkerId; expiresIso: string }>

export type Eligibility =
  | Readonly<{ mayAttempt: true }>
  | Readonly<{ mayAttempt: false; because: Ineligible }>

/** May this job be attempted at this instant?
 *
 * THE CLOCK IS A PARAMETER, in this and in every other function here. A backoff computed through
 * `Date.now()` inside the function cannot be tested at all: there is no input that puts the clock
 * anywhere, so the property "it waits" becomes unaskable and reads as passing. */
export function eligibility(job: SendJob, nowIso: string): Eligibility {
  if (TERMINAL.includes(job.state)) {
    return { mayAttempt: false, because: { kind: 'TERMINAL', messageId: job.messageId, state: job.state } }
  }
  // CHECKED SEPARATELY FROM `EXHAUSTED`, deliberately. A job can be over budget without anybody
  // having marked it exhausted yet — the marking is a write and writes can be interrupted. If
  // eligibility trusted the state alone, a crash between the last attempt and the state change
  // would leave a job that is over budget and still claimable.
  if (job.attemptsMade >= job.maxAttempts) {
    return {
      mayAttempt: false,
      because: {
        kind: 'BUDGET_SPENT', messageId: job.messageId,
        attemptsMade: job.attemptsMade, maxAttempts: job.maxAttempts,
      },
    }
  }
  if (Date.parse(nowIso) < Date.parse(job.notBeforeIso)) {
    return {
      mayAttempt: false,
      because: { kind: 'BACKING_OFF', messageId: job.messageId, notBeforeIso: job.notBeforeIso },
    }
  }
  if (job.claim !== null && Date.parse(nowIso) < Date.parse(job.claim.expiresIso)) {
    return {
      mayAttempt: false,
      because: {
        kind: 'CLAIMED_BY_ANOTHER', messageId: job.messageId,
        by: job.claim.by, expiresIso: job.claim.expiresIso,
      },
    }
  }
  return { mayAttempt: true }
}

/** How long to wait before attempt `n`. Exponential, capped, and PURE.
 *
 * The cap exists because unbounded exponential backoff on a job with a large budget produces a
 * retry scheduled after everybody has stopped looking. */
export function backoffMs(attemptsMade: number, baseMs = 30_000, capMs = 900_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attemptsMade))
}

// ---------------------------------------------------------------------------------------
// THE CLAIM. One statement, because two workers claiming one job is the apply's lesson again.
// ---------------------------------------------------------------------------------------

export interface ClaimStatement {
  readonly sql: string
  readonly params: readonly unknown[]
  /** One if the claim succeeded, zero if another worker got there first. */
  readonly expectedRowCount: 1
}

declare const CLAIMED: unique symbol

/** PERMISSION TO SEND ONE MESSAGE ONCE. The only thing `beginAttempt` accepts.
 *
 * THIS REPLACES A COMMENT THAT SAID "THE CALLER MUST READ THE ROW COUNT". It must, and a
 * comment is advice to somebody who has not written the caller yet — which is exactly the
 * situation the `accept` trap was in when the obvious implementation walked into it.
 *
 * A claim returning zero rows is not an error. It is the other worker winning, and sending
 * anyway is the duplicate this entire layer exists to prevent. So the row count is not
 * something a caller may forget to check: **there is no way to reach a send without having
 * produced one of these, and the only thing that produces one is a row count of exactly one.**
 *
 * Same move as the branded `ValidatedRun` in the apply, and for the same reason: abort-before-
 * write becomes a property of the shape rather than a rule somebody has to remember in the
 * right order. */
export interface SendPermit {
  readonly messageId: MessageId
  readonly idempotencyKey: IdempotencyKey
  /** Which attempt this is. Derived from the job rather than counted by the worker, because a
   * worker-counted attempt number restarts with the worker — the same failure as the bound. */
  readonly attemptNo: number
  readonly [CLAIMED]: true
}

export type ClaimOutcome =
  | Readonly<{ won: true; permit: SendPermit }>
  /** NOT AN ERROR. Another worker holds it, and the correct response is to move on to the next
   * job — which is why this carries no permit rather than carrying one with a flag. */
  | Readonly<{ won: false; because: 'ANOTHER_WORKER_WON' }>

/** Turn a row count into permission, or into a refusal.
 *
 * TAKES THE STATEMENT AS WELL AS THE COUNT so the comparison is against what the statement
 * expected rather than against a literal 1 written at the call site. */
export function claimOutcome(
  statement: ClaimStatement,
  rowsUpdated: number,
  job: SendJob,
): ClaimOutcome {
  if (rowsUpdated !== statement.expectedRowCount) {
    return { won: false, because: 'ANOTHER_WORKER_WON' }
  }
  return {
    won: true,
    permit: {
      messageId: job.messageId,
      idempotencyKey: job.idempotencyKey,
      attemptNo: job.attemptsMade + 1,
    } as unknown as SendPermit,
  }
}

/** Claim a job for one worker, as ONE conditional UPDATE.
 *
 * NOT A READ THEN A WRITE. Selecting a READY job in one statement and updating it in another is
 * the naive shape that lost every round of the apply's concurrency test — two workers both read
 * READY, both write, both send. The condition is in the WHERE clause so the database decides,
 * and the row count says who won.
 *
 * The same predicate carries every eligibility rule, because a claim guarded by application logic
 * and a claim guarded by SQL are two places that can disagree about who may send. */
export function claimStatement(
  messageId: MessageId,
  by: WorkerId,
  nowIso: string,
  holdForMs: number,
): ClaimStatement {
  const expires = new Date(Date.parse(nowIso) + holdForMs).toISOString()
  return {
    sql: [
      'UPDATE alert_send_jobs',
      "SET state = 'CLAIMED', claimed_by = $2, claimed_at = $3::timestamptz, claim_expires_at = $4::timestamptz",
      'WHERE message_id = $1',
      // The terminal states refuse a claim. R2 failed against QA's own reference because an
      // EXHAUSTED job could be claimed again, which makes the bound decorative.
      "  AND state NOT IN ('SENT', 'EXHAUSTED', 'GAVE_UP')",
      '  AND attempts_made < max_attempts',
      '  AND not_before_at <= $3::timestamptz',
      '  AND (claim_expires_at IS NULL OR claim_expires_at <= $3::timestamptz)',
    ].join('\n'),
    params: [messageId, by, nowIso, expires],
    expectedRowCount: 1,
  }
}

// ---------------------------------------------------------------------------------------
// ATTEMPTS. Written BEFORE the side effect, or a crash leaves no trace of the send.
// ---------------------------------------------------------------------------------------

/** One attempt at sending. The `settled` half arrives after the provider answers — or never.
 *
 * AN ATTEMPT THAT NEVER RETURNED CANNOT BE RECORDED BY CODE THAT RECORDS ON RETURN. If the row is
 * written when the send completes, a crash mid-send leaves NO TRACE THAT ANYTHING WAS SENT — and
 * the retry then sends a second email believing it is the first. So the attempt is written first
 * and settled second, and an attempt with `settled: null` past its deadline is exactly the
 * evidence that something was in flight when the lights went out. */
export interface Attempt {
  readonly messageId: MessageId
  readonly attemptNo: number
  readonly startedAtIso: string
  readonly settled: Settled | null
}

/** Open an attempt. TAKES A PERMIT, WHICH IS THE WHOLE POINT.
 *
 * This is the row that must be written BEFORE the side effect, so it is also the narrowest
 * place to stand between a caller and a send. A worker that ignored the claim’s row count has
 * no permit, and therefore nothing to open an attempt with — the mistake is not discouraged,
 * it is unavailable.
 *
 * The attempt number comes from the permit rather than from the caller, so two workers cannot
 * both write attempt 1 and disagree with the job’s own count. */
export function beginAttempt(permit: SendPermit, startedAtIso: string): Attempt {
  return {
    messageId: permit.messageId,
    attemptNo: permit.attemptNo,
    startedAtIso,
    settled: null,
  }
}

export type Settled =
  | Readonly<{ kind: 'ACCEPTED'; providerId: ProviderMessageId; atIso: string }>
  | Readonly<{ kind: 'REFUSED_RETRYABLE'; atIso: string; because: string }>
  | Readonly<{ kind: 'REFUSED_PERMANENT'; atIso: string; because: string }>

/** Attempts that started and never finished, as of `nowIso`.
 *
 * NOT AN ERROR LIST. On a healthy system this is empty most of the time and briefly non-empty
 * whenever a send is in flight, which is why it takes a deadline rather than reporting every
 * unsettled attempt. Past the deadline, an unsettled attempt means a process died holding a send
 * whose outcome nobody knows. */
export function inFlight(attempts: readonly Attempt[], nowIso: string, afterMs: number): readonly Attempt[] {
  const now = Date.parse(nowIso)
  return attempts.filter(
    (attempt) => attempt.settled === null && now - Date.parse(attempt.startedAtIso) >= afterMs)
}

/** One send per logical message, checked over a HISTORY.
 *
 * NOTHING ABOUT A SINGLE CALL CAN ESTABLISH THIS, which is why it is a function over the whole
 * attempt list rather than a guard inside a send. Empty means every message was accepted at most
 * once.
 *
 * WHAT IT CANNOT SEE, and this is load-bearing: two attempts that were both accepted by the
 * provider under the same idempotency key are ONE email if the provider honours the key, and TWO
 * if it does not. This function reports the duplication; only the provider can say whether it
 * became two messages. See the module note. */
export function sentMoreThanOnce(attempts: readonly Attempt[]): readonly string[] {
  const accepted = new Map<string, number>()
  for (const attempt of attempts) {
    if (attempt.settled?.kind !== 'ACCEPTED') continue
    accepted.set(attempt.messageId, (accepted.get(attempt.messageId) ?? 0) + 1)
  }
  return [...accepted.entries()]
    .filter(([, count]) => count > 1)
    .map(([messageId, count]) =>
      `${messageId} was accepted ${count} times — one email only if the provider honoured the `
      + 'idempotency key, which nothing here can establish.')
}

// ---------------------------------------------------------------------------------------
// STOPPING. "Stopped retrying" and "succeeded" must not be the same observation.
// ---------------------------------------------------------------------------------------

/** What the next state is after an attempt settles.
 *
 * A PERMANENT REFUSAL STOPS IMMEDIATELY rather than spending the remaining budget. Retrying a
 * hard bounce is not merely futile; it is repeated delivery attempts to a mail server that has
 * already said no, which is how a sending domain earns a reputation problem. */
export function afterAttempt(job: SendJob, settled: Settled): SendJob {
  const attemptsMade = job.attemptsMade + 1
  if (settled.kind === 'ACCEPTED') {
    return { ...job, state: 'SENT', attemptsMade, claim: null, providerId: settled.providerId }
  }
  if (settled.kind === 'REFUSED_PERMANENT') {
    return { ...job, state: 'GAVE_UP', attemptsMade, claim: null }
  }
  return attemptsMade >= job.maxAttempts
    ? { ...job, state: 'EXHAUSTED', attemptsMade, claim: null }
    : {
        ...job,
        state: 'READY',
        attemptsMade,
        claim: null,
        notBeforeIso: new Date(Date.parse(settled.atIso) + backoffMs(attemptsMade)).toISOString(),
      }
}

/** Messages that will never be sent, and why.
 *
 * **"STOPPED RETRYING" AND "SUCCEEDED" ARE THE SAME OBSERVATION** if the only signal is absence
 * from a queue — both look like a job that is no longer there. That is `EXHAUSTED` one layer up,
 * the third time this shape has appeared in this feature, and the answer is the same each time:
 * the stopping has to be REPORTABLE rather than inferable from a gap.
 *
 * A function rather than a field, so it is asked on a clock rather than rendered if somebody
 * remembers to. */
export function neverSent(jobs: readonly SendJob[]): readonly Readonly<{
  messageId: MessageId
  state: 'EXHAUSTED' | 'GAVE_UP'
  attemptsMade: number
}>[] {
  return jobs
    .filter((job): job is SendJob & { state: 'EXHAUSTED' | 'GAVE_UP' } =>
      job.state === 'EXHAUSTED' || job.state === 'GAVE_UP')
    .map((job) => ({ messageId: job.messageId, state: job.state, attemptsMade: job.attemptsMade }))
}

/** Every job in exactly one state, and every attempt belonging to a job. Empty when the books
 * balance; a list rather than a boolean, so a reader knows which figure to go and look at. */
export function accounting(jobs: readonly SendJob[], attempts: readonly Attempt[]): readonly string[] {
  const problems: string[] = []
  const byMessage = new Map(jobs.map((job) => [job.messageId as string, job]))

  for (const [messageId, count] of countBy(jobs.map((job) => job.messageId as string))) {
    if (count > 1) problems.push(`${count} jobs for message ${messageId}`)
  }
  for (const attempt of attempts) {
    if (!byMessage.has(attempt.messageId)) {
      problems.push(`attempt ${attempt.attemptNo} for ${attempt.messageId}, which has no job`)
    }
  }
  for (const job of jobs) {
    const made = attempts.filter((attempt) => attempt.messageId === job.messageId).length
    if (made !== job.attemptsMade) {
      problems.push(
        `${job.messageId} records ${job.attemptsMade} attempts made and ${made} attempt rows — `
        + 'the budget and the history disagree, and the budget is the one that stops the retrying.')
    }
  }
  return [...problems, ...sentMoreThanOnce(attempts)]
}

const countBy = (values: readonly string[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}
