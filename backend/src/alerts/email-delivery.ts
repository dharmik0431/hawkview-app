import { type AlertTypeId } from './alert-catalog.js'
import { type VerifiedRecipient } from './routing-policy.js'

/**
 * STEP 06 — EMAIL DELIVERY, as a seam that can be asked the questions.
 *
 * THE FINDING THIS FILE IS SHAPED BY: **ACCEPTED IS NOT AN OUTCOME.** The provider answers
 * synchronously; whether the message arrived is a DIFFERENT FACT that arrives later, by
 * webhook, about a send that has already returned. So `send(message): Promise<Outcome>` — the
 * obvious signature — cannot express most of what needs checking, and a seam that cannot
 * express a property cannot pin it. **An unaskable property reads exactly like a passing one.**
 *
 * The consequence is two phases and two vocabularies that never merge: `Acceptance` is what the
 * provider said when asked, `Outcome` is what happened to the message. Nothing converts one
 * into the other.
 *
 * NOTHING HERE TALKS TO A NETWORK, reads an environment variable, or holds a secret. The
 * signature verdict arrives as a parameter (see `authenticate`), so this module can be tested
 * in full without a provider, a key, or an inbox — and so that a webhook handler cannot forget
 * to verify, because an unverified event has no path to becoming an outcome.
 *
 * WHAT RESTS ON RESEND BEHAVING AS DOCUMENTED, and is therefore NOT established by any test
 * here: that an idempotency key is honoured, that "accepted" means the provider has taken
 * responsibility for the message, and any figure about real bounce rates. Those need the
 * provider. See `docs/alerting-email-delivery.md`.
 */

// ---------------------------------------------------------------------------------------
// WHO. Never a customer end user, and that is a property of the type rather than a review.
// ---------------------------------------------------------------------------------------

/** An address this product may send to.
 *
 * THERE IS NO CONSTRUCTOR FROM A STRING. The only way to obtain one is `operatorAddressOf`,
 * which takes a `VerifiedRecipient` — and every arm of that union is an MSP-side inbox that
 * somebody verified. So "never a customer end user as a recipient" is not a rule this code
 * follows; **it is a value this code cannot construct.**
 *
 * The alternative was a check on the address before sending, which fails the way every
 * content check fails: it has to enumerate what is forbidden, and the address that gets
 * through is the one nobody thought to forbid. */
export type OperatorAddress = string & { readonly __operatorAddress: unique symbol }

export function operatorAddressOf(recipient: VerifiedRecipient): OperatorAddress {
  return recipient.address as OperatorAddress
}

// ---------------------------------------------------------------------------------------
// WHAT. A body with no slot for anything that could identify a person or a tenant.
// ---------------------------------------------------------------------------------------

/** Where the message points. AN OPAQUE ID, NOT A PATH CONTAINING ONE.
 *
 * A deep link is the quiet way tenant identifiers reach an inbox: nobody thinks of a URL as
 * message content, and `/tenants/contoso-ltd/incidents/...` names a customer in the subject
 * line's neighbour. The digest is minted per message and resolved server-side behind auth, so
 * the link carries a random token and the recipient still lands in the right place. */
export type DigestId = string & { readonly __digestId: unique symbol }

/** Mint one. Random, and NOT derived from the content — a digest id derived from the incident
 * keys would be a tenant identifier with a hash in front of it, which is the same leak with an
 * extra step and a false sense of having handled it. */
export function digestId(random: string): DigestId {
  return random as DigestId
}

/** One line of the body.
 *
 * EVERY SLOT IS A COUNT OR A CATALOGUE ID. There is no `string` here, no name, no address, no
 * tenant, no incident key (which carries a tenant id inside it), and no free text. M8 and M9
 * are type-level with no runtime variant on purpose: **a leak searched for is a leak you can
 * spell wrong**, and the absence of a slot cannot be spelled wrong. See the eight negatives in
 * the test file — the file type-checking IS the evidence.
 *
 * WHAT AN OPERATOR ACTUALLY NEEDS is here: what kind of thing happened, how much of it, over
 * what window, and a way in. What they do NOT need in an inbox is which customer, by name. */
export type BodyLine =
  | Readonly<{ kind: 'TYPE_COUNT'; alertTypeId: AlertTypeId; tenantsAffected: number; incidentsAffected: number }>
  | Readonly<{ kind: 'WINDOW'; fromIso: string; toIso: string }>
  | Readonly<{ kind: 'HELD_UNTIL'; untilIso: string; reason: HoldReason }>
  | Readonly<{ kind: 'OPEN'; digest: DigestId }>

/** Closed, because "because: string" is a free-text slot wearing a reason's clothes. */
export type HoldReason = 'QUIET_HOURS' | 'VOLUME_LIMIT'

/** A body is NON-EMPTY. An email with nothing in it is a notification that something happened
 * and no way to know what, which is worse than not sending. */
export type Body = readonly [BodyLine, ...BodyLine[]]

// ---------------------------------------------------------------------------------------
// THE TWO PHASES. Two vocabularies, and nothing converts between them.
// ---------------------------------------------------------------------------------------

export type MessageId = string & { readonly __messageId: unique symbol }
export type ProviderMessageId = string & { readonly __providerMessageId: unique symbol }
export type IdempotencyKey = string & { readonly __idempotencyKey: unique symbol }

export const messageId = (value: string): MessageId => value as MessageId
export const providerMessageId = (value: string): ProviderMessageId => value as ProviderMessageId
export const idempotencyKey = (value: string): IdempotencyKey => value as IdempotencyKey

export interface SendAttempt {
  readonly messageId: MessageId
  readonly to: OperatorAddress
  readonly body: Body
  /** Sent to the provider so a retry after a timeout does not send twice. **THAT IT WORKS IS
   * A CLAIM ABOUT RESEND, NOT ABOUT THIS CODE** — nothing here can establish it, and the doc
   * says so rather than letting the field imply it. */
  readonly idempotencyKey: IdempotencyKey
}

/** WHAT THE PROVIDER SAID WHEN ASKED. Deliberately not called an outcome.
 *
 * `ACCEPTED` means the provider took the message. It does NOT mean it arrived, and there is no
 * arm here that says it did — the vocabulary has nowhere to record delivery, so nothing can
 * read acceptance as delivery by accident. */
export type Acceptance =
  | Readonly<{ kind: 'ACCEPTED'; providerId: ProviderMessageId; atIso: string }>
  | Readonly<{ kind: 'REFUSED'; code: RefusalCode; atIso: string }>

export type RefusalCode = 'RATE_LIMITED' | 'INVALID_ADDRESS' | 'SUPPRESSED' | 'PROVIDER_ERROR'

/** WHAT HAPPENED TO THE MESSAGE. Arrives later, about a send that already returned.
 *
 * There is no `ACCEPTED` arm here either. The two unions share no member, which is the whole
 * point of there being two. */
export type Outcome =
  | Readonly<{ kind: 'DELIVERED'; atIso: string }>
  | Readonly<{ kind: 'BOUNCED'; atIso: string; bounce: BounceClass }>
  | Readonly<{ kind: 'COMPLAINED'; atIso: string }>

/** HARD and SOFT are different facts about the future, not different severities. A hard bounce
 * means this address will never work; a soft one means try later. Collapsing them produces
 * either a suppressed address that was fine or a retry loop against one that never was. */
export type BounceClass = 'HARD' | 'SOFT'

// ---------------------------------------------------------------------------------------
// AUTHENTICITY. An unsigned event cannot become an outcome, structurally.
// ---------------------------------------------------------------------------------------

/** What arrived at the webhook endpoint, before anything is known about it. */
export interface RawWebhook {
  readonly providerId: ProviderMessageId
  readonly kind: Outcome['kind']
  readonly atIso: string
  readonly bounce: BounceClass | null
}

/** The signature verdict, computed elsewhere — this module never sees the secret.
 *
 * A PARAMETER RATHER THAN A CALL, so the verification can be tested against a real Resend
 * signature in the place that has one, while everything below stays pure. */
export type Authentication = 'AUTHENTIC' | 'SIGNATURE_MISSING' | 'SIGNATURE_INVALID'

/** An event that has been verified. **The only way to make one is `authenticate`.**
 *
 * AN UNAUTHENTICATED WEBHOOK ENDPOINT THAT UPDATES DELIVERY STATE IS AN ENDPOINT ANYBODY CAN
 * USE TO MARK OUR MESSAGES DELIVERED. QA flagged authenticity as unpinnable — they cannot tell
 * a forged event from a real one — so it is pinned from the other side: `record` accepts only
 * this type, and a forged event has no path to producing one. */
export interface AuthenticEvent {
  readonly providerId: ProviderMessageId
  readonly kind: Outcome['kind']
  readonly atIso: string
  readonly bounce: BounceClass | null
  readonly __authentic: true
}

/** An event that did not become an outcome, and why. NEVER DROPPED SILENTLY.
 *
 * The unmapped-row shape from the apply, arriving in a new place: an event about a provider id
 * we hold no job for is a fact about our system — a message somebody else's job sent, a job we
 * lost, or an id we never recorded — and discarding it makes all three look like nothing
 * happening. */
export type UnmatchedEvent = Readonly<{
  providerId: ProviderMessageId
  atIso: string
  because: 'SIGNATURE_MISSING' | 'SIGNATURE_INVALID' | 'NO_SUCH_JOB' | 'ALREADY_RESOLVED'
}>

export type Received =
  | Readonly<{ authentic: true; event: AuthenticEvent }>
  | Readonly<{ authentic: false; rejected: UnmatchedEvent }>

export function authenticate(raw: RawWebhook, verdict: Authentication): Received {
  if (verdict !== 'AUTHENTIC') {
    return { authentic: false, rejected: { providerId: raw.providerId, atIso: raw.atIso, because: verdict } }
  }
  return {
    authentic: true,
    event: {
      providerId: raw.providerId, kind: raw.kind, atIso: raw.atIso, bounce: raw.bounce,
      __authentic: true,
    },
  }
}

// ---------------------------------------------------------------------------------------
// THE LEDGER. Where a message stands, and where every event went.
// ---------------------------------------------------------------------------------------

/** ACCEPTED IS NOT A RESTING STATE, and the type will not let it be one.
 *
 * QA's own first draft had an accepted job that was never mentioned again sit in `ACCEPTED`
 * forever — and ACCEPTED reads like success while every accounting identity passes. The
 * unresolved arm therefore CARRIES `unresolvedSince`: you cannot construct one without saying
 * when the waiting started, which is what makes `unconfirmed` answerable.
 *
 * `REFUSED` carries no `providerId` because the provider never gave one. A single shape with a
 * nullable id would let a refused job be looked up by an id it does not have. */
export type Job =
  | Readonly<{
      state: 'UNRESOLVED'
      messageId: MessageId
      providerId: ProviderMessageId
      acceptedAtIso: string
      /** When the wait began. Equal to `acceptedAtIso` today and separate on purpose: a job
       * re-opened by a later event waits from then, not from the original send. */
      unresolvedSinceIso: string
    }>
  | Readonly<{
      state: 'RESOLVED'
      messageId: MessageId
      providerId: ProviderMessageId
      acceptedAtIso: string
      outcome: Outcome
    }>
  | Readonly<{ state: 'REFUSED'; messageId: MessageId; refusedAtIso: string; code: RefusalCode }>

export interface Ledger {
  readonly jobs: readonly Job[]
  /** Every event that did not resolve a job, with its reason. Empty is a claim; non-empty is
   * a finding. Either way it is stated. */
  readonly unmatched: readonly UnmatchedEvent[]
}

export const EMPTY_LEDGER: Ledger = { jobs: [], unmatched: [] }

/** Record what the provider said about a send. Produces a job in exactly one state. */
export function accept(ledger: Ledger, attempt: SendAttempt, acceptance: Acceptance): Ledger {
  const job: Job = acceptance.kind === 'ACCEPTED'
    ? {
        state: 'UNRESOLVED',
        messageId: attempt.messageId,
        providerId: acceptance.providerId,
        acceptedAtIso: acceptance.atIso,
        unresolvedSinceIso: acceptance.atIso,
      }
    : { state: 'REFUSED', messageId: attempt.messageId, refusedAtIso: acceptance.atIso, code: acceptance.code }
  return { ...ledger, jobs: [...ledger.jobs, job] }
}

/** Record an event. **Takes `Received`, not `RawWebhook`** — so a caller that skipped
 * verification has nothing to pass. */
export function record(ledger: Ledger, received: Received): Ledger {
  if (!received.authentic) {
    return { ...ledger, unmatched: [...ledger.unmatched, received.rejected] }
  }
  const event = received.event
  const outcome: Outcome = event.kind === 'BOUNCED'
    // A bounce with no classification is a SOFT bounce only if we say so, and we do not: an
    // unclassified bounce treated as soft retries forever against an address that may never
    // work. HARD is the reading that stops, and stopping is the recoverable mistake.
    ? { kind: 'BOUNCED', atIso: event.atIso, bounce: event.bounce ?? 'HARD' }
    : event.kind === 'COMPLAINED'
      ? { kind: 'COMPLAINED', atIso: event.atIso }
      : { kind: 'DELIVERED', atIso: event.atIso }

  // NARROWED BY A TYPE PREDICATE RATHER THAN BY AN INDEX. A REFUSED job has no `providerId`
  // to match on, and saying so with a predicate lets the compiler carry that fact into the
  // branch instead of a comment claiming it.
  const open = ledger.jobs.filter(
    (job): job is Extract<Job, { state: 'UNRESOLVED' }> =>
      job.state === 'UNRESOLVED' && job.providerId === event.providerId)

  if (open.length === 0) {
    // A SECOND OUTCOME IS NOT AN UPDATE, and an event for a job we do not hold is not nothing.
    // Resend can redeliver a webhook, and a delivered message can later be complained about —
    // overwriting would leave the first fact gone with nothing recording it was ever true.
    // Both are named here rather than dropped, which is the unmapped-row shape from the apply
    // arriving in a new place.
    const resolvedAlready = ledger.jobs.some(
      (job) => job.state === 'RESOLVED' && job.providerId === event.providerId)
    return {
      ...ledger,
      unmatched: [...ledger.unmatched, {
        providerId: event.providerId,
        atIso: event.atIso,
        because: resolvedAlready ? 'ALREADY_RESOLVED' : 'NO_SUCH_JOB',
      }],
    }
  }

  const target = open[0]
  return {
    ...ledger,
    jobs: ledger.jobs.map((job): Job => (job === target
      ? {
          state: 'RESOLVED',
          messageId: target.messageId,
          providerId: target.providerId,
          acceptedAtIso: target.acceptedAtIso,
          outcome,
        }
      : job)),
  }
}
// ---------------------------------------------------------------------------------------
// THE REPORTS. Silence has to be reportable or it is not detectable.
// ---------------------------------------------------------------------------------------

/** Jobs the provider accepted and never spoke about again.
 *
 * **A BOUNCE NOBODY READS IS THE SAME SILENCE AS A HOLD THAT EXPIRES** — the fifth member of
 * that family in this feature. A message that vanished into the provider looks delivered
 * indefinitely unless something asks this question on a clock, so it is a function rather than
 * a field somebody might render.
 *
 * `afterMs` IS A PARAMETER AND HAS NO DEFAULT. The honest value is derived from observed
 * provider latency, which no worktree here has; a default would be a guess that reads as a
 * measurement, and every caller would inherit it without deciding. */
export function unconfirmed(ledger: Ledger, nowIso: string, afterMs: number): readonly Job[] {
  const now = Date.parse(nowIso)
  return ledger.jobs.filter((job) =>
    job.state === 'UNRESOLVED' && now - Date.parse(job.unresolvedSinceIso) >= afterMs)
}

/** Every message in exactly one state, and every event in exactly one place.
 *
 * Empty when the books balance. A list rather than a boolean, because a reader needs to know
 * WHICH figure to go and look at. */
export function accounting(
  ledger: Ledger,
  eventsReceived: number,
): readonly string[] {
  const problems: string[] = []
  const resolved = ledger.jobs.filter((job) => job.state === 'RESOLVED').length
  const accountedFor = resolved + ledger.unmatched.length
  if (accountedFor !== eventsReceived) {
    problems.push(
      `${eventsReceived} events received, ${accountedFor} accounted for `
      + `(${resolved} resolved a job, ${ledger.unmatched.length} unmatched) — an event either `
      + 'resolves a job or is named as unmatched, so these must be equal.')
  }
  const byProvider = new Map<string, number>()
  for (const job of ledger.jobs) {
    if (job.state === 'REFUSED') continue
    byProvider.set(job.providerId, (byProvider.get(job.providerId) ?? 0) + 1)
  }
  for (const [providerId, count] of byProvider) {
    if (count > 1) problems.push(`${count} jobs share provider id ${providerId}`)
  }
  return problems
}
