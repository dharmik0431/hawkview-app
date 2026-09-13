// QA PRE-REGISTRATION — CANCELLING UNSENT JOBS, written before the code exists.
//
// PM's ruling, which I am registering against rather than restating: incidents ARE the record
// and must survive; a JOB is an intent to send. Cancelling unattempted intent is the only undo
// that matters, and it is the operator's stop button on a first run going wrong.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SEAM ATTACK, SPENT FIRST. Nine for nine.
//
// The obvious shape is `cancelJob(messageId)`, or an operator running
// `UPDATE alert_send_jobs SET state = 'CANCELLED'`. Six things it cannot express:
//
// 1. "UNSENT" IS A RACE, NOT A STATE YOU CAN READ. A job can be CLAIMED and in flight at the
//    instant somebody cancels it — the provider may already have the message. **A cancel that
//    reads the state and then writes it has the apply's defect exactly**, and the failure is
//    worse here: the operator is told the message was stopped and it was already sent. The
//    check and the write must be ONE statement, and the statement must refuse a job whose
//    attempt is open.
//
// 2. A STOP BUTTON THAT WORKS ONE ROW AT A TIME IS NOT A STOP BUTTON. If D9's first run is
//    wrong, the operator has minutes. So cancellation is a BULK operation over a scope, and the
//    scope has to be expressible — an organisation, a run, everything queued.
//
// 3. AND BULK CANCELLATION HAS A BOUNDARY NOBODY WILL THINK ABOUT UNTIL IT BITES: jobs created
//    AFTER the operator pressed stop. A cancel that takes a scope and no instant silently
//    races the producer, and the intake runs every five minutes. Whether "stop" means "these
//    jobs" or "and anything that arrives next" is a DECISION, and it must be in the type rather
//    than in whoever wrote the WHERE clause.
//
// 4. CANCELLED IS NOT EXHAUSTED AND IS NOT GAVE_UP. Three terminal states with three different
//    meanings: we ran out of attempts, the provider refused permanently, a person stopped it.
//    Collapsing any two makes "why did nobody get this alert" unanswerable — the same silence
//    this feature exists to remove, arriving in the audit trail instead of the inbox.
//
// 5. AN IN-FLIGHT ATTEMPT'S OUTCOME MUST STILL LAND. If a job was claimed and the provider
//    accepted it, the webhook arrives later. A cancel that deletes the job, or that makes it
//    unmatchable, turns a real delivery event into an unmatched one — the apply's unmapped-row
//    shape, one layer up. **Cancelling must never remove the row the event needs to find.**
//
// 6. A CANCEL NOBODY CAN ACCOUNT FOR IS A SILENT NON-DELIVERY. Six months later the question is
//    "why was this MSP never told", and "the job is CANCELLED" is not an answer. Who, when, and
//    why must be recorded where the job is, not in a log somebody has to still have.
//
// WHAT THIS DELIBERATELY DOES NOT DECIDE: the transport for the operator's instruction, whether
// it is a CLI or an endpoint, or how the scope is named.
// ═════════════════════════════════════════════════════════════════════════════
import type { MessageId } from './email-delivery.js'

/** Who stopped it, when, and why. On the job, because a log is a thing somebody has to still
 * have six months later. */
export interface CancelStamp {
  readonly byOperator: string
  readonly atIso: string
  /** Free text ON PURPOSE, and the one place in this feature where that is right: the reason a
   * person stopped a run is not drawn from any vocabulary we can enumerate in advance. */
  readonly because: string
}

/** THE SCOPE, WITH ITS BOUNDARY IN THE TYPE. `createdBeforeIso` is not optional: a bulk cancel
 * that does not say where the producer stands races it silently. */
export type CancelScope =
  | Readonly<{ kind: 'ONE_MESSAGE'; messageId: MessageId }>
  | Readonly<{ kind: 'ORGANISATION'; organizationId: string; createdBeforeIso: string }>
  | Readonly<{ kind: 'EVERYTHING_QUEUED'; createdBeforeIso: string }>

/** What a cancel did, per job. Never a count alone: an operator stopping a bad run needs to know
 * which ones were already gone. */
export type CancelVerdict =
  | Readonly<{ kind: 'CANCELLED'; messageId: MessageId }>
  /** Claimed by a worker, so it may already be at the provider. NOT cancelled, and said so. */
  | Readonly<{ kind: 'REFUSED_IN_FLIGHT'; messageId: MessageId; claimedBy: string }>
  /** Already terminal. Distinguished from in-flight because the remedies differ. */
  | Readonly<{ kind: 'REFUSED_ALREADY_RESOLVED'; messageId: MessageId; state: string }>

export interface CancelOutcome {
  readonly cancelled: readonly CancelVerdict[]
  readonly refused: readonly CancelVerdict[]
  /** Cancelled plus refused equals considered, or a job went missing from the accounting. */
  readonly considered: number
}

/** The statement a cancel must emit: the check and the write in ONE, like the claim. */
export interface CancelStatement {
  readonly sql: string
  readonly params: readonly unknown[]
}

/** THE PROPERTIES. Pre-registered, binding on me.
 *
 * C1 A CLAIMED JOB IS NEVER CANCELLED. It may already be at the provider, so the answer is
 *    REFUSED_IN_FLIGHT and the operator is told which ones those are — never a silent success.
 * C2 THE CHECK AND THE WRITE ARE ONE STATEMENT. A read-then-write cancel tells an operator a
 *    message was stopped that had already gone.
 * C3 CANCELLING IS BULK AND SCOPED, because a stop button that works one row at a time is not
 *    one.
 * C4 THE SCOPE CARRIES ITS BOUNDARY. `createdBeforeIso` is required on every bulk scope, so
 *    "stop" cannot silently race the producer that runs every five minutes.
 * C5 CANCELLED IS ITS OWN TERMINAL STATE, distinct from EXHAUSTED and GAVE_UP — we ran out of
 *    attempts, the provider refused, a person stopped it. Three facts, three remedies.
 * C6 THE ROW SURVIVES. A cancel never deletes the job, because a later provider event needs the
 *    row to find, and an event that finds nothing becomes unmatched.
 * C7 WHO, WHEN AND WHY ARE ON THE JOB. "Why was this MSP never told" is answerable from the
 *    record rather than from a log somebody has to still have.
 * C8 THE INCIDENT IS UNTOUCHED. Cancelling intent must not erase the fact — incidents are the
 *    record, which is the same reasoning that makes the apply an annotation rather than a
 *    re-keying.
 * C9 EVERY CONSIDERED JOB IS ACCOUNTED FOR: cancelled plus refused equals considered.
 */
export const PRE_REGISTERED_CANCEL = [
  'C1 a claimed job is never cancelled',
  'C2 the check and the write are one statement',
  'C3 cancelling is bulk and scoped',
  'C4 the scope carries its boundary',
  'C5 CANCELLED is its own terminal state',
  'C6 the row survives',
  'C7 who, when and why are on the job',
  'C8 the incident is untouched',
  'C9 every considered job is accounted for',
] as const

/** WHAT BINDS ME AND WHAT DOES NOT. C1-C9 are pre-registered and binding. The shapes above are a
 * PROPOSAL — if the implementer picks another, the properties stay and my checks get rewritten.
 *
 * THE ONE I WILL NOT TRADE: C1 with C2. A cancel that refuses an in-flight job by reading its
 * state first is a cancel that will one day report success on a message already delivered, and
 * an operator who has been told a message was stopped behaves differently from one who has been
 * told it might not have been. */
