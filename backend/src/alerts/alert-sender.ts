import {
  type Body, type IdempotencyKey, type MessageId, type OperatorAddress, type ProviderMessageId,
} from './email-delivery.js'
import { beginAttempt, type Attempt, type SendPermit, type Settled } from './send-queue.js'

/**
 * THE SENDER. What turns a claimed job into an attempt, and an attempt into a settlement.
 *
 * NOTHING HERE TALKS TO RESEND, and nothing in this repository does. The provider is a
 * `SendTransport` the caller supplies; there is no client, no API key is read anywhere, and no
 * HTTP call exists to be made by accident. A real transport is a later commit and a decision to
 * switch it on is later still.
 *
 * I have not read QA's pre-registration. Built to the semantics as relayed — off by default,
 * idempotent, silence visible as a decision, a bounce that changes behaviour.
 */

// ---------------------------------------------------------------------------------------
// THE PROVIDER SEAM
// ---------------------------------------------------------------------------------------

/** What the sender hands a provider. **A PERMIT IS REQUIRED**, so there is no way to reach a
 * transport without having read the claim's row count — see `claimOutcome`. */
export interface Outbound {
  readonly permit: SendPermit
  readonly to: OperatorAddress
  readonly body: Body
  /** The same key on every attempt for one message, which is what makes a retry after a crash
   * safe — IF the provider honours it. Nothing here can establish that; it is a line in the
   * acceptance checklist for exactly that reason. */
  readonly idempotencyKey: IdempotencyKey
}

/** What the provider said. Deliberately the provider's vocabulary rather than ours: mapping it
 * into `Settled` is this module's job and is where the decisions live. */
export type ProviderAnswer =
  | Readonly<{ accepted: true; providerId: ProviderMessageId }>
  | Readonly<{ accepted: false; permanent: boolean; because: string }>

export interface SendTransport {
  send(outbound: Outbound): Promise<ProviderAnswer>
}

// ---------------------------------------------------------------------------------------
// SUPPRESSION. A hard bounce is a fact about an address, not an error in a log.
// ---------------------------------------------------------------------------------------

/** Addresses that must not be written to again.
 *
 * A HARD BOUNCE CHANGES BEHAVIOUR OR IT IS JUST A LOG LINE. The mail server has said this
 * address does not exist; continuing to attempt it is not merely futile, it is what earns a
 * sending domain a reputation problem — and the damage lands on every other message HawkView
 * sends, not on the one that bounced.
 *
 * SUPPRESSION IS PER ADDRESS, NOT PER JOB, because the fact is about the address. A different
 * message to the same dead mailbox must also not be attempted. */
export interface Suppressions {
  has(address: OperatorAddress): boolean
}

export type Refusal =
  /** The address is suppressed. NOT an error: the correct outcome, and it must be visible as a
   * decision rather than as an absence — see `SendOutcome`. */
  | Readonly<{ kind: 'ADDRESS_SUPPRESSED'; address: OperatorAddress }>

export type SendOutcome =
  | Readonly<{ sent: true; attempt: Attempt; settled: Settled }>
  /** Nothing was attempted, and why. The attempt row is still returned when one was opened, so
   * "we decided not to" and "we tried and it failed" are never the same shape. */
  | Readonly<{ sent: false; refused: Refusal }>

// ---------------------------------------------------------------------------------------
// THE SEND
// ---------------------------------------------------------------------------------------

/** Attempt one send.
 *
 * THE ORDER IS THE POINT AND IT IS NOT THE OBVIOUS ONE:
 *
 * 1. Check suppression FIRST, before opening an attempt. An attempt row for a send that was
 *    never going to happen would make `inFlight` report a process that died holding nothing.
 * 2. Open the attempt, which writes it BEFORE the side effect — so a crash mid-send leaves the
 *    evidence that something was in flight rather than no trace at all.
 * 3. Send.
 * 4. Map the provider's answer into our vocabulary.
 *
 * IT DOES NOT WRITE ANYTHING. It returns the attempt and the settlement for a caller to persist,
 * because the persistence has to be transactional with the job's state change and this module
 * cannot see a transaction. Composing it wrongly is the caller's mistake to make; composing it
 * at all requires a permit, which is the mistake that mattered. */
export async function attemptSend(
  transport: SendTransport,
  outbound: Outbound,
  suppressions: Suppressions,
  nowIso: string,
): Promise<SendOutcome> {
  if (suppressions.has(outbound.to)) {
    return { sent: false, refused: { kind: 'ADDRESS_SUPPRESSED', address: outbound.to } }
  }

  const attempt = beginAttempt(outbound.permit, nowIso)
  const answer = await transport.send(outbound)
  return { sent: true, attempt, settled: settlementFor(answer, nowIso) }
}

/** The provider's answer in our vocabulary.
 *
 * PERMANENT AND RETRYABLE ARE DIFFERENT FACTS ABOUT THE FUTURE, not two severities. A permanent
 * refusal stops immediately and does not spend the remaining budget; a retryable one waits and
 * tries again inside the bound the job already carries.
 *
 * A provider that says neither — no `permanent` flag at all — cannot occur here, because the
 * type has no third arm. That is deliberate: the alternative was a nullable flag whose absence
 * would have to be read as one or the other, and reading it as retryable retries a dead address
 * forever while reading it as permanent silences a working one. */
function settlementFor(answer: ProviderAnswer, nowIso: string): Settled {
  if (answer.accepted) {
    return { kind: 'ACCEPTED', providerId: answer.providerId, atIso: nowIso }
  }
  return answer.permanent
    ? { kind: 'REFUSED_PERMANENT', atIso: nowIso, because: answer.because }
    : { kind: 'REFUSED_RETRYABLE', atIso: nowIso, because: answer.because }
}

/** Whether this settlement means the address must never be written to again.
 *
 * SEPARATE FROM `afterAttempt`, WHICH DECIDES THE JOB'S FATE. Two different subjects: one is
 * "what happens to this message", the other is "what is now true about this address". Deciding
 * both in one function is how a per-message decision quietly becomes a per-address one, or the
 * reverse — and the reverse is the dangerous direction, because it would suppress an entire
 * inbox on one message's bad day. */
export function suppressesAddress(settled: Settled): boolean {
  return settled.kind === 'REFUSED_PERMANENT'
}

/** A suppression list from a set of addresses. The real one is a table; this is the shape the
 * sender needs, so a caller can supply either. */
export const suppressionsOf = (addresses: Iterable<string>): Suppressions => {
  const set = new Set(addresses)
  return { has: (address) => set.has(address) }
}

// ---------------------------------------------------------------------------------------
// THE TRANSPORT THAT EXISTS TODAY
// ---------------------------------------------------------------------------------------

/** A transport that sends nothing and says so.
 *
 * **THIS IS THE ONLY TRANSPORT IN THE REPOSITORY, AND THAT IS THE CURRENT SAFETY PROPERTY.**
 * There is no Resend client, so there is nothing to accidentally configure into life: switching
 * the sender on requires somebody to WRITE a transport, not to set a variable.
 *
 * It refuses RETRYABLY rather than permanently, deliberately. A permanent refusal would burn the
 * job's budget and mark it GAVE_UP — so a system left running against this transport would
 * quietly conclude that every address was dead, and the state after somebody finally wired a
 * real provider would be a queue of jobs that had already given up. Retryable leaves them
 * waiting, which is the recoverable direction. */
export const NO_TRANSPORT_CONFIGURED: SendTransport = {
  send: async () => ({
    accepted: false,
    permanent: false,
    because: 'No send transport is configured. Nothing in this build can reach a provider.',
  }),
}
