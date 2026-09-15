import {
  type Outbound, type ProviderAnswer, type SendTransport,
} from './alert-sender.js'
import { providerMessageId, type OperatorAddress } from './email-delivery.js'

/**
 * A TRANSPORT THAT RECORDS WHAT IT WAS HANDED AND SENDS NOTHING.
 *
 * `NO_TRANSPORT_CONFIGURED` already establishes the safety property — there is no client, so
 * switching sending on requires somebody to WRITE a transport rather than to set a variable.
 * What it cannot do is answer a question. It refuses everything retryably and keeps nothing, so
 * a worker driven against it can be observed to make no progress and cannot be observed to have
 * handed the right message to the right address with the right key.
 *
 * THIS IS A TEST DOUBLE AND IT IS NOT A PROVIDER. It holds no credential, opens no socket, and
 * has no configuration that could point it at one. The distinction from the production transport
 * that does not exist yet is not a flag on this object; it is that this object's `send` is a
 * closure over an array.
 *
 * WHY IT RECORDS THE WHOLE `Outbound` RATHER THAN A SUMMARY. A summary is a decision about what
 * mattered, taken before the test that needs it was written — and the properties most worth
 * pinning here are about fields nobody thought to summarise: that the idempotency key is the
 * SAME across retries of one message and DIFFERENT across messages, that the recipient is the
 * address the job named, that the permit's attempt number came from the job rather than from a
 * counter in the worker. A recorded summary answers the first question and silently cannot
 * answer the other two.
 */

/** One handoff, exactly as the sender presented it. */
export interface Handoff {
  readonly outbound: Outbound
  /** Which call this was, from the transport's own count. Deliberately NOT read from the permit:
   * a test that wants to assert the permit's attempt number is right cannot use the permit's
   * attempt number as the thing it compares against. See `a-check-must-not-share-an-origin`. */
  readonly callNo: number
}

/** How the double should answer. A function rather than a value, so one transport can refuse the
 * first attempt and accept the second — which is the only way to exercise a retry path end to
 * end without a real provider that fails on demand. */
export type Answering = (handoff: Handoff) => ProviderAnswer

export interface RecordingTransport extends SendTransport {
  /** Every handoff in order. */
  readonly handoffs: readonly Handoff[]
  /** Addresses written to, in order, with duplicates kept — because "we sent twice" is the
   * defect this queue exists to prevent and a Set would erase it. */
  readonly addressed: readonly OperatorAddress[]
}

/** Accepts everything, recording as it goes. The provider id is derived from the message and
 * attempt so a test can tell two acceptances apart without reaching into the transport. */
export const acceptsEverything: Answering = ({ outbound }) =>
  ({
    accepted: true,
    providerId: providerMessageId(`rec_${outbound.permit.messageId}_${outbound.permit.attemptNo}`),
  })

/** Refuses retryably, like a provider having a bad minute. */
export const refusesRetryably = (because = 'recording transport: retryable'): Answering =>
  () => ({ accepted: false, permanent: false, because })

/** Refuses permanently, like a mail server saying the mailbox does not exist. The settlement this
 * produces is what `suppressesAddress` turns into a suppression, so this is the arm that drives
 * the address-level consequence rather than the message-level one. */
export const refusesPermanently = (because = 'recording transport: permanent'): Answering =>
  () => ({ accepted: false, permanent: true, because })

/** Answer differently per call, by index. Falls back to the last entry once exhausted, so
 * `[refuse, accept]` describes "fails once then succeeds forever" without the test having to
 * count how many attempts the retry policy will actually make. */
export const inSequence = (answers: readonly Answering[]): Answering => {
  if (answers.length === 0) throw new Error('inSequence needs at least one answer')
  return (handoff) => answers[Math.min(handoff.callNo - 1, answers.length - 1)]!(handoff)
}

/** Build one.
 *
 * THE ANSWER IS REQUIRED, with no default. A default would be `acceptsEverything`, and a test
 * that forgot to say what the provider does would then be a test asserting the happy path while
 * reading as a test about something else. Making it explicit costs one argument and removes the
 * class.
 */
export function recordingTransport(answering: Answering): RecordingTransport {
  const handoffs: Handoff[] = []
  const addressed: OperatorAddress[] = []
  return {
    handoffs,
    addressed,
    send: async (outbound: Outbound): Promise<ProviderAnswer> => {
      const handoff: Handoff = { outbound, callNo: handoffs.length + 1 }
      handoffs.push(handoff)
      addressed.push(outbound.to)
      return answering(handoff)
    },
  }
}

/** Distinct idempotency keys seen, in first-seen order.
 *
 * A HELPER BECAUSE THE ASSERTION IT SERVES IS EASY TO WRITE BACKWARDS. "Retries reuse the key"
 * and "different messages get different keys" are two properties, and a test that checks only
 * the first passes on a transport that was handed one key for everything — which is the
 * catastrophic direction, since a shared key across messages is a provider deduplicating away a
 * real alert. */
export function distinctKeys(transport: RecordingTransport): readonly string[] {
  const seen: string[] = []
  for (const { outbound } of transport.handoffs) {
    if (!seen.includes(outbound.idempotencyKey)) seen.push(outbound.idempotencyKey)
  }
  return seen
}
