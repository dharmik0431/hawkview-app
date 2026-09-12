// QA PRE-REGISTRATION — STEP 06 (email delivery, Resend), written before the code exists.
//
// The first step where anything leaves the building, and the first where a mistake cannot
// be taken back: an email is not a channel HawkView controls once sent.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SEAM ATTACK, SPENT FIRST
//
// The obvious shape is `send(message): Promise<Outcome>`. Six of the nine properties are
// unpinnable through it.
//
// 1. "ACCEPTED" IS NOT AN OUTCOME, AND THIS IS THE ONE THAT MATTERS. The provider answers
//    synchronously that it has taken the message; whether it arrived is a DIFFERENT FACT
//    THAT ARRIVES LATER, by webhook, about a send that already returned. A function whose
//    return value is "the outcome" can only carry the first of those, so the second has
//    nowhere to land — and a bounce nobody reads is the same shape as a hold that expires:
//    silence produced by a feature whose purpose is delivery.
//
//    So the seam carries provider events as a SEPARATE, LATER input, and `DELIVERED` has no
//    constructor at send time. The strongest available form: the type of what you can learn
//    from a send does not include the thing only a later event can tell you.
//
// 2. IDEMPOTENCE NEEDS THE JOB STORE, not a function call. "Was this already sent" cannot
//    be asked of a send.
//
// 3. BOUNDED RETRIES AND AN OUTCOME PER ATTEMPT NEED THE ATTEMPTS. One call has one result;
//    a bound is a property of a sequence.
//
// 4. "NO SENSITIVE DETAIL" IS NOT CHECKABLE ON A STRING. Asserting the body does not contain
//    a name tests the spelling searched for — the leak-encoding finding from the wrapped-risk
//    tests, one product over. The strong form is that the body is built from a CLOSED
//    VOCABULARY with no slot for an identity, so a leak has no constructor rather than
//    failing a search.
//
// 5. ONE MESSAGE PER MSP CANNOT BE PROTECTED BY A SENDER THAT TAKES A TENANT. Routing
//    already refuses to address a delivery to a tenant; step 06 undoes that the moment its
//    send signature accepts one. So there is no tenant on the send path at all.
//
// 6. AND A RECIPIENT AS A STRING makes "never a customer end user" a property of data again,
//    after the type made it a property of the type upstream.
//
// WHAT MY OWN FIRST DRAFT COULD NOT EXPRESS — checked, not assumed, and recorded because it
// has happened on five of five previous seams:
//
// 7. AN ACCEPTED JOB THAT NEVER RESOLVES. My first shape had a job go PENDING -> ACCEPTED,
//    and DELIVERED or BOUNCED on a later event. A job accepted and then never mentioned
//    again sits in ACCEPTED forever, and ACCEPTED reads like success. Every accounting
//    identity passes: it was sent, an attempt is recorded, nothing failed. That is the same
//    silence as the limit-hold with an invented release, and my seam had no way to say it.
//    `unresolvedSince` makes it expressible; a property makes it visible.
//
// 8. AND A PROVIDER EVENT FOR A MESSAGE WE DO NOT KNOW. Webhooks arrive for ids we have no
//    job for — a replay, a different environment, a forged post. Dropping it silently is the
//    unmapped-row shape from the apply, so the outcome names them.
// ═════════════════════════════════════════════════════════════════════════════
//
// WHICH HALF OF THIS FILE BINDS ME, AND WHICH HALF DOES NOT
//
// THE PROPERTIES (M1-M9) ARE PRE-REGISTERED. They are what I will check, written before the
// code exists so that neither I nor the implementer can shape them after seeing it. Those
// are binding on me: if the built thing fails one I report it, and if I later think a
// property was wrong I say so in a separately-labelled file rather than editing this one.
//
// THE SEAM SHAPE BELOW IS A PROPOSAL, NOT A REQUIREMENT. I do not get to design step 06.
// The types here exist because I had to answer one question honestly — CAN THESE PROPERTIES
// BE CHECKED AT ALL through the obvious shape — and the answer was no for six of nine. So
// this is an existence proof that SOME shape can carry them, offered to the engineer as one
// way rather than the way. Any shape that lets a later provider event land on an earlier
// send, and that has no slot for an identity or a tenant, will do.
//
// IF THE IMPLEMENTER CHOOSES A DIFFERENT SHAPE, the properties stay and my checks get
// rewritten against theirs. What I will not accept is a shape in which a property becomes
// UNASKABLE, because unaskable reads exactly like passing.

// WHAT THIS DELIBERATELY DOES NOT DECIDE: the provider's API shape, the retry schedule, the
// wording of the email, the webhook transport or its signature scheme, or how jobs are
// stored. Those are design.

import type { VerifiedRecipient } from './routing-policy.js'

/** WHAT AN EMAIL MAY SAY. A closed vocabulary with NO SLOT FOR AN IDENTITY.
 *
 * There is no field for an account name, an address, a tenant name, or a count that would
 * identify a person. The email says something needs attention, how urgent, and where to
 * look — and the where is an authenticated, tenant-authorised view rather than a summary.
 *
 * This is the leak-encoding lesson applied before the leak: searching a rendered body for a
 * name tests the spelling you searched for. A body with nowhere to put a name cannot leak
 * one in any encoding. */
export interface MessageBody {
  /** From the catalogue, not free text. */
  readonly alertTypeId: string
  readonly tier: 'PHONE' | 'EMAIL' | 'IN_APP'
  /** How many tenants are affected — a COUNT of tenants, which identifies nobody, and
   * deliberately not which ones. */
  readonly affectedTenantCount: number
  /** Where to look. Authenticated and tenant-authorised at the far end. */
  readonly deepLinkPath: string
}

/** WHAT A SEND CAN TELL YOU, AND IT IS LESS THAN YOU WANT.
 *
 * `ACCEPTED` means the provider took it. It does NOT mean it arrived, and there is no member
 * here that says it did — because at send time nobody can know. */
export type SendResult =
  | Readonly<{ kind: 'ACCEPTED'; providerMessageId: string }>
  | Readonly<{ kind: 'REFUSED'; because: string }>
  | Readonly<{ kind: 'ERRORED'; because: string }>

/** WHAT ONLY A LATER EVENT CAN TELL YOU. Keyed on the provider's id, which is the only thing
 * both sides share. */
export type ProviderEvent =
  | Readonly<{ kind: 'DELIVERED'; providerMessageId: string; at: Date }>
  | Readonly<{ kind: 'BOUNCED'; providerMessageId: string; at: Date; because: string }>
  | Readonly<{ kind: 'COMPLAINED'; providerMessageId: string; at: Date }>

export interface Attempt {
  readonly at: Date
  readonly result: SendResult
}

export interface DeliveryJob {
  readonly jobId: string
  /** The same key twice is the same message. What makes a retry a retry rather than a
   * second email. */
  readonly idempotencyKey: string
  readonly organizationId: string
  readonly to: VerifiedRecipient
  readonly body: MessageBody
}

/** WHERE A JOB HAS GOT TO. `ACCEPTED_AWAITING_CONFIRMATION` is deliberately not called
 * "sent": it is the state in which nobody yet knows, and naming it "sent" is how an
 * unresolved job reads as a success. */
export type JobState =
  | Readonly<{ kind: 'NOT_ATTEMPTED' }>
  | Readonly<{ kind: 'ACCEPTED_AWAITING_CONFIRMATION'; providerMessageId: string; since: Date }>
  // BOTH RESOLVED STATES CARRY THE PROVIDER ID. Added because a DELIVERED that cannot say
  // WHICH message was delivered is a worse record - you cannot trace it back to the send,
  // or to the webhook that resolved it, without a join nobody kept. It also makes 'sent
  // once' observable without depending on which state name a job happens to be in.
  | Readonly<{ kind: 'DELIVERED'; providerMessageId: string; at: Date }>
  | Readonly<{ kind: 'BOUNCED'; providerMessageId: string; at: Date; because: string }>
  | Readonly<{ kind: 'ABANDONED'; afterAttempts: number; because: string }>

export interface JobReport {
  readonly jobId: string
  readonly state: JobState
  readonly attempts: readonly Attempt[]
  /** Set when the job is accepted and no provider event has resolved it. The field that
   * makes an unresolved send SAYABLE rather than merely possible. */
  readonly unresolvedSince: Date | null
}

/** A provider event we have no job for. Named rather than dropped. */
export interface UnmatchedEvent {
  readonly providerMessageId: string
  readonly kind: ProviderEvent['kind']
  readonly because: string
}

export interface SendTick {
  readonly at: Date
  readonly events: readonly ProviderEvent[]
}

export interface MailOutcome {
  readonly jobs: readonly JobReport[]
  readonly unmatched: readonly UnmatchedEvent[]
  /** Jobs accepted longer ago than the confirmation window with nothing heard. The worst
   * state this step can produce, stated rather than inferable from absence. */
  readonly unconfirmed: readonly Readonly<{ jobId: string; since: Date; sentence: string }>[]
}

/** The seam. Jobs plus a sequence of moments carrying provider events.
 *
 * NO TENANT ANYWHERE ON IT. A sender that takes a tenant makes a per-tenant loop the
 * natural thing to write, which undoes routing's coalescing at the last step. */
export type MailSeam = (input: Readonly<{
  jobs: readonly DeliveryJob[]
  ticks: readonly SendTick[]
  maxAttempts: number
  confirmWithinMs: number
}>) => MailOutcome

/** THE PROPERTIES.
 *
 * M1 THE SAME IDEMPOTENCY KEY SENDS ONCE, however many jobs carry it.
 * M2 RETRIES ARE BOUNDED, and a job that exhausts them is ABANDONED with a reason — never
 *    left looking pending.
 * M3 EVERY ATTEMPT HAS A RECORDED OUTCOME. A send whose result nobody recorded is
 *    indistinguishable from one that never happened.
 * M4 ACCEPTED IS NOT DELIVERED. A job the provider took is ACCEPTED_AWAITING_CONFIRMATION
 *    until an event says otherwise, and DELIVERED has no constructor at send time.
 * M5 A BOUNCE LANDS ON ITS JOB and moves it out of accepted.
 * M6 AN EVENT FOR AN UNKNOWN MESSAGE IS NAMED, not dropped.
 * M7 AN ACCEPTED JOB THAT NEVER RESOLVES IS REPORTED once the window passes.
 * M8 THE BODY CANNOT CARRY AN IDENTITY — no field for a name, an address, or a tenant.
 * M9 NO TENANT ON THE SEND PATH, so a per-tenant message is unexpressible.
 */
export const PRE_REGISTERED_STEP_06 = [
  'M1 the same idempotency key sends once',
  'M2 retries are bounded and exhaustion is ABANDONED with a reason',
  'M3 every attempt has a recorded outcome',
  'M4 accepted is not delivered',
  'M5 a bounce lands on its job',
  'M6 an event for an unknown message is named',
  'M7 an accepted job that never resolves is reported',
  'M8 the body cannot carry an identity',
  'M9 no tenant on the send path',
] as const
