import {
  attemptSend, suppressesAddress,
  type SendTransport, type Suppressions,
} from './alert-sender.js'
import { type Body, type IdempotencyKey, type MessageId, type OperatorAddress } from './email-delivery.js'
import {
  afterAttempt, claimOutcome, claimStatement, eligibility, withdrawStatement,
  type Attempt, type Ineligible, type SendJob, type Settled, type WorkerId,
} from './send-queue.js'

/**
 * THE QUEUE CONSUMER. The thing that was missing: every function below this line already existed
 * and nothing called any of them.
 *
 * WHAT THIS FILE IS ALLOWED TO DECIDE, and it is less than it looks. The claim is decided by the
 * database, the job's next state by `afterAttempt`, the settlement by `attemptSend`, and whether
 * an address is dead by `suppressesAddress`. This module contributes ORDER and PERSISTENCE, and
 * the order is the part with the failures in it.
 *
 * NOTHING HERE CAN REACH A NETWORK. The transport is a parameter and the only two that exist in
 * this repository are `NO_TRANSPORT_CONFIGURED` and the recording double.
 *
 * COLLECTION OUTRANKS ALERTING. `drainOnce` returns a report and throws nothing for any
 * per-job failure — a message that cannot be built, a store that rejects a write and a provider
 * that times out all become entries in the report. A sync must not be failable by an alert, and
 * a worker that throws on a bad job is a worker that a scheduler shares a process with.
 */

// ---------------------------------------------------------------------------------------
// THE SEAM THAT DOES NOT EXIST YET, AND WHY IT IS A SEAM RATHER THAN A TODO
// ---------------------------------------------------------------------------------------

/** What the job is worth sending RIGHT NOW.
 *
 * **A SEND JOB CARRIES NO RECIPIENT AND NO BODY**, and nothing in the schema stores either — no
 * table holds a per-message address, and no function in this repository constructs a `Body`. So
 * the content cannot be loaded; it has to be REBUILT at send time.
 *
 * That is not a workaround, it is the requirement. "Honour current preferences and suppression at
 * send time rather than at queue time" is unsatisfiable if the message was frozen when it was
 * queued: an operator who turns an alert type off, or removes a recipient, between queueing and
 * sending has changed their mind, and a queue that delivers the old decision is a queue that
 * ignores them. Resolving after the claim makes "current" mean current.
 *
 * THE REFUSAL ARM IS THE LOAD-BEARING HALF. `WITHDRAWN` is how a preference change stops a send,
 * and it is deliberately not an error and not a silent skip: it settles the job so it stops being
 * retried, and it says why. A resolver that could only succeed would force the worker to invent a
 * reason for every send it did not make. */
export type Resolution =
  | Readonly<{ send: true; to: OperatorAddress; body: Body }>
  /** Do not send, and this is a decision rather than a failure. The job leaves the queue. */
  | Readonly<{ send: false; because: WithdrawnReason }>

/** Closed, because a free-text reason here is how "we did not send it" becomes unanswerable six
 * months later. Every arm is something an operator did or a fact about configuration.
 *
 * **A VALUE FIRST AND A TYPE SECOND, so the runtime list and the type cannot disagree.** These
 * four are also a CHECK constraint on `alert_send_jobs.withdrawn_because`, and a vocabulary
 * living in a union, an array and a migration is a vocabulary with two chances to drift — where
 * drift surfaces as an insert failing in production rather than as a test going red.
 * `send-queue.test.ts` holds this array against the migration text; deriving the type from it
 * closes the other half here, at no cost. */
export const WITHDRAWN_REASONS = [
  'ALERT_TYPE_DISABLED',
  'NO_VERIFIED_RECIPIENT',
  'INCIDENT_NO_LONGER_ACTIONABLE',
  /** Two causes under one reason, deliberately: a message id this layer cannot parse, and an
   * incident that is gone. They are different CAUSES and the vocabulary is not keyed on causes —
   * it is keyed on what an operator would DO, and today both send them to look at the job.
   *
   * **SPLIT THIS THE MOMENT THE REMEDIES DIVERGE**, which is the trigger rather than a date. The
   * likely one: if incidents acquire a retention or pruning policy, "the incident aged out" stops
   * being something to investigate and becomes expected, while an unparseable id never does — at
   * that point they are two reasons and keeping them as one hides a real defect behind routine
   * housekeeping.
   *
   * Until then a fifth arm would be a vocabulary growing faster than the decisions it records,
   * which is its own way of making the record unreadable. */
  'MESSAGE_CONTENT_UNAVAILABLE',
] as const

export type WithdrawnReason = typeof WITHDRAWN_REASONS[number]

/** Rebuild a message from current state. Supplied by the caller; there is no default, because a
 * default would be a stub that sends a plausible-looking empty message. */
export interface MessageSource {
  resolve(job: SendJob): Promise<Resolution>
}

// ---------------------------------------------------------------------------------------
// PERSISTENCE. Narrow on purpose — four writes, and the worker cannot make a fifth.
// ---------------------------------------------------------------------------------------

/** What the worker needs from a database, and nothing else.
 *
 * DELIBERATELY NOT A PRISMA CLIENT. A worker holding a client can write anything, and the
 * interesting property of this worker is what it CANNOT do — it cannot touch an incident, a
 * tenant or a preference, because there is no method here that reaches one.
 *
 * `settleAttempt` takes the job's next state alongside the settlement because those two writes
 * must be one transaction: an attempt settled without its job advancing is a message that will be
 * sent again, and a job advanced without its attempt settled is a send with no evidence. The
 * implementation decides how; the interface makes it impossible to ask for one without the other. */
export interface SendStore {
  /** Jobs that may be worth claiming. Ordering and limit are the store's business; the worker
   * re-checks eligibility anyway, because a row read a moment ago is a fact about the past. */
  dueJobs(nowIso: string, limit: number): Promise<readonly SendJob[]>
  /** Run the claim UPDATE and return rows affected. The statement is built here so the predicate
   * lives in one place. */
  runClaim(sql: string, params: readonly unknown[]): Promise<number>
  /** Write the attempt BEFORE the send. */
  openAttempt(attempt: Attempt): Promise<void>
  /** Settle the attempt and advance the job, transactionally. */
  settleAttempt(attempt: Attempt, settled: Settled, job: SendJob): Promise<void>
  /** Leave the queue without having sent, recording why.
   *
   * **THIS HAD NO HONEST IMPLEMENTATION UNTIL THE SCHEMA GAINED ONE**, and how that was
   * established matters more than the fix. Every existing state was a lie a reader would act on:
   * CANCELLED is the operator's stop button, so a reader would go looking for who stopped it and
   * find nobody; GAVE_UP is the address refusing us, the same silence with the opposite meaning
   * and a different remedy.
   *
   * **AND THE SHORTCUT WAS REFUSED BY A CONSTRAINT RATHER THAN BY A REVIEWER.**
   * `alert_send_jobs_cancellation_check` is a BICONDITIONAL — state = 'CANCELLED' iff
   * cancelled_at, cancelled_by AND cancelled_because are all non-null — so writing a withdrawal
   * as CANCELLED requires inventing a `cancelled_by`, attributing a system decision to a person.
   * The database enforced a product distinction the code was about to blur.
   *
   * Now: `WITHDRAWN` plus `withdrawn_at` and `withdrawn_because`, added by
   * `20260913200000_send_job_withdrawn`, the reason CHECK-constrained to the four arms of
   * `WithdrawnReason` and no `withdrawn_by` column to fill in. `withdrawStatement` in
   * `send-queue.ts` writes it as one conditional UPDATE.
   *
   * **WHY NO TEST CAUGHT IT, WHICH IS THE PART THAT GENERALISES.** Forty suites were green while
   * the one real implementation would have failed on insert, because the probe's store is in
   * memory and enforces no constraint. *An interface can be satisfied by a double long after it
   * has stopped being satisfiable by a database.* What was pinned was that the worker CALLS
   * `withdraw` — never that a withdrawal could be RECORDED. `send-queue.test.ts` now holds the
   * statement's columns and its vocabulary against the migration text, which is the cheapest
   * instrument that sits on the other side of that seam.
   *
   * **TAKES SQL, LIKE `runClaim`, SO THE STATEMENT IS REACHED RATHER THAN DESCRIBED.** It used to
   * take `(messageId, because, atIso)` and leave the write to whoever implemented it — which is
   * how `withdrawStatement` would have become the fifth function in this feature written correct,
   * tested and unreachable. The guard and the row count are the same contract as a claim: the
   * database decides whether the job was still live, and the caller reads the count. */
  runWithdraw(sql: string, params: readonly unknown[]): Promise<number>
  /** A hard bounce is a fact about the address. Carries the message so the record answers "which
   * send killed this address", which the suppression row alone cannot. */
  suppress(address: OperatorAddress, messageId: MessageId, because: string, atIso: string): Promise<void>
}

// ---------------------------------------------------------------------------------------
// THE REPORT. A count is not something an operator can act on.
// ---------------------------------------------------------------------------------------

export type JobResult =
  | Readonly<{ messageId: MessageId; kind: 'SENT'; attemptNo: number }>
  | Readonly<{ messageId: MessageId; kind: 'REFUSED'; attemptNo: number; settled: Settled }>
  | Readonly<{ messageId: MessageId; kind: 'WITHDRAWN'; because: WithdrawnReason }>
  /** The withdrawal updated no row, so the job had already finished — a stop pressed between the
   * claim and this write is the reachable case. NOT `WITHDRAWN` and not `FAILED`: nothing went
   * wrong and nothing was withdrawn, and reporting either would make the drain report disagree
   * with the table. Distinct from `LOST_CLAIM`, which is another WORKER winning rather than
   * another DECISION landing. */
  | Readonly<{ messageId: MessageId; kind: 'ALREADY_SETTLED'; because: WithdrawnReason }>
  | Readonly<{ messageId: MessageId; kind: 'SUPPRESSED_ADDRESS'; address: OperatorAddress }>
  | Readonly<{ messageId: MessageId; kind: 'LOST_CLAIM' }>
  | Readonly<{ messageId: MessageId; kind: 'INELIGIBLE'; because: Ineligible }>
  /** The store or the transport threw. NAMED RATHER THAN PROPAGATED, because a worker that
   * throws can fail whatever it shares a process with. */
  | Readonly<{ messageId: MessageId; kind: 'FAILED'; at: 'RESOLVE' | 'OPEN' | 'SEND' | 'SETTLE'; because: string }>

export interface DrainReport {
  readonly considered: number
  readonly results: readonly JobResult[]
}

const because = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// ---------------------------------------------------------------------------------------
// THE DRAIN
// ---------------------------------------------------------------------------------------

export interface DrainOptions {
  readonly store: SendStore
  readonly transport: SendTransport
  readonly source: MessageSource
  readonly suppressions: Suppressions
  readonly by: WorkerId
  readonly nowIso: string
  /** How long a claim is held. A claim that outlives its holder must expire or a dead worker
   * takes the job with it. */
  readonly holdForMs: number
  readonly limit: number
}

/** One pass over the queue.
 *
 * ONE PASS RATHER THAN A LOOP, and that is the shape decision. A `while (true)` worker owns its
 * own lifetime, its own sleep and its own failure policy, and none of those can be tested from
 * outside — the scheduler that calls this decides how often, and a test decides by calling it
 * once. The retry budget already lives on the job precisely so the process does not hold it.
 *
 * THE ORDER, AND EVERY STEP OF IT IS LOAD-BEARING:
 *
 *  1. Re-check eligibility in memory. Cheap, and it keeps a job the database would refuse out of
 *     the claim path — but it is NOT the guard. The database's WHERE clause is.
 *  2. Claim. The row count decides, not this code.
 *  3. Resolve the message from CURRENT state. After the claim, so a preference change between
 *     queueing and now is honoured; before the attempt row, so a withdrawal leaves no attempt.
 *  4. Check suppression and open the attempt — both inside `attemptSend`, in that order.
 *  5. Send.
 *  6. Settle the attempt and advance the job together.
 *  7. Suppress the address if the settlement was a permanent refusal.
 *
 * Step 7 is last and separate because it is about a DIFFERENT SUBJECT. The job's fate and the
 * address's fate are two decisions, and doing them in one write is how a bad day for one message
 * silences an entire inbox.
 */
export async function drainOnce(options: DrainOptions): Promise<DrainReport> {
  const { store, transport, source, suppressions, by, nowIso, holdForMs, limit } = options
  const results: JobResult[] = []

  let due: readonly SendJob[]
  try {
    due = await store.dueJobs(nowIso, limit)
  } catch (error) {
    // The queue could not be read at all. One entry, no message id to attach it to, and no throw.
    return { considered: 0, results: [{ messageId: '' as MessageId, kind: 'FAILED', at: 'RESOLVE', because: because(error) }] }
  }

  for (const job of due) {
    const eligible = eligibility(job, nowIso)
    if (!eligible.mayAttempt) {
      results.push({ messageId: job.messageId, kind: 'INELIGIBLE', because: eligible.because })
      continue
    }

    const statement = claimStatement(job.messageId, by, nowIso, holdForMs)
    let rows: number
    try {
      rows = await store.runClaim(statement.sql, statement.params)
    } catch (error) {
      results.push({ messageId: job.messageId, kind: 'FAILED', at: 'OPEN', because: because(error) })
      continue
    }

    const claimed = claimOutcome(statement, rows, job)
    if (!claimed.won) {
      results.push({ messageId: job.messageId, kind: 'LOST_CLAIM' })
      continue
    }

    // CURRENT state, after the claim. See `Resolution`.
    let resolution: Resolution
    try {
      resolution = await source.resolve(job)
    } catch (error) {
      results.push({ messageId: job.messageId, kind: 'FAILED', at: 'RESOLVE', because: because(error) })
      continue
    }

    if (!resolution.send) {
      // BEFORE ANY ATTEMPT ROW EXISTS, so a withdrawal leaves no evidence of a send that never
      // happened. The statement is built here for the same reason the claim's is: the predicate
      // that decides whether this job may still be settled belongs in one place.
      const withdrawal = withdrawStatement(job.messageId, resolution.because, nowIso)
      try {
        const rows = await store.runWithdraw(withdrawal.sql, withdrawal.params)
        results.push({
          messageId: job.messageId,
          // ZERO ROWS IS NOT AN ERROR AND NOT A WITHDRAWAL. The guard excludes terminal jobs, so
          // no rows means the job finished between the resolve and this write — a stop landing in
          // between. Reporting it as WITHDRAWN would make the report disagree with the table.
          kind: rows === withdrawal.expectedRowCount ? 'WITHDRAWN' : 'ALREADY_SETTLED',
          because: resolution.because,
        })
      } catch (error) {
        results.push({ messageId: job.messageId, kind: 'FAILED', at: 'SETTLE', because: because(error) })
      }
      continue
    }

    const outbound = {
      permit: claimed.permit,
      to: resolution.to,
      body: resolution.body,
      idempotencyKey: job.idempotencyKey as IdempotencyKey,
    }

    // `attemptSend` checks suppression before opening the attempt, so the attempt row is only
    // written for a send that was actually going to happen. The store write has to follow the
    // same order, which is why the attempt is persisted here rather than before the call.
    if (suppressions.has(resolution.to)) {
      results.push({ messageId: job.messageId, kind: 'SUPPRESSED_ADDRESS', address: resolution.to })
      continue
    }

    let outcome: Awaited<ReturnType<typeof attemptSend>>
    let opened: Attempt | null = null
    try {
      // Written BEFORE the side effect: a crash mid-send must leave evidence that something was
      // in flight, or the retry sends a second email believing it is the first.
      opened = { messageId: job.messageId, attemptNo: claimed.permit.attemptNo, startedAtIso: nowIso, settled: null }
      await store.openAttempt(opened)
    } catch (error) {
      results.push({ messageId: job.messageId, kind: 'FAILED', at: 'OPEN', because: because(error) })
      continue
    }

    try {
      outcome = await attemptSend(transport, outbound, suppressions, nowIso)
    } catch (error) {
      // The attempt row stays open and unsettled, which is exactly the evidence `inFlight` reads.
      results.push({ messageId: job.messageId, kind: 'FAILED', at: 'SEND', because: because(error) })
      continue
    }

    if (!outcome.sent) {
      results.push({ messageId: job.messageId, kind: 'SUPPRESSED_ADDRESS', address: outcome.refused.address })
      continue
    }

    const next = afterAttempt(job, outcome.settled)
    try {
      await store.settleAttempt(outcome.attempt, outcome.settled, next)
    } catch (error) {
      results.push({ messageId: job.messageId, kind: 'FAILED', at: 'SETTLE', because: because(error) })
      continue
    }

    if (suppressesAddress(outcome.settled)) {
      try {
        const why = outcome.settled.kind === 'REFUSED_PERMANENT' ? outcome.settled.because : 'permanent refusal'
        await store.suppress(resolution.to, job.messageId, why, nowIso)
      } catch (error) {
        // The send is already settled and recorded. A failure here loses the address-level
        // consequence, which is worth reporting and is NOT worth undoing the settlement for.
        results.push({ messageId: job.messageId, kind: 'FAILED', at: 'SETTLE', because: because(error) })
      }
    }

    results.push(
      outcome.settled.kind === 'ACCEPTED'
        ? { messageId: job.messageId, kind: 'SENT', attemptNo: outcome.attempt.attemptNo }
        : { messageId: job.messageId, kind: 'REFUSED', attemptNo: outcome.attempt.attemptNo, settled: outcome.settled },
    )
  }

  return { considered: due.length, results }
}

/** Messages this pass actually handed to a provider.
 *
 * **A QUEUED JOB IS NOT A DELIVERED EMAIL AND NEITHER IS AN ACCEPTED ONE.** This counts sends the
 * provider ACCEPTED — which is a fact about a handoff, not about an inbox. Whether it arrived is
 * a different fact that arrives later by webhook, and `email-delivery.ts` keeps the two
 * vocabularies apart on purpose. Named `accepted` rather than `delivered` so the weaker word is
 * the one in reach. */
export function accepted(report: DrainReport): readonly MessageId[] {
  return report.results.filter((r) => r.kind === 'SENT').map((r) => r.messageId)
}
