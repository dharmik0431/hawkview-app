import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NO_TRANSPORT_CONFIGURED, attemptSend, suppressesAddress, suppressionsOf,
  type Outbound, type ProviderAnswer, type SendTransport,
} from './alert-sender.js'
import { afterAttempt, claimOutcome, claimStatement, workerId, type SendJob } from './send-queue.js'
import {
  digestId, idempotencyKey, messageId, operatorAddressOf, providerMessageId,
  type Body, type OperatorAddress,
} from './email-delivery.js'
import { type VerifiedRecipient } from './routing-policy.js'

/** The sender. Nothing here reaches a provider; the transport is supplied by the caller and the
 * only one in the repository sends nothing. */

const T0 = '2026-09-13T09:00:00.000Z'
const INBOX: VerifiedRecipient = {
  kind: 'MSP_SECURITY_INBOX',
  address: 'security@an-msp.example',
  verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
}
const TO: OperatorAddress = operatorAddressOf(INBOX)
const BODY: Body = [{ kind: 'OPEN', digest: digestId('r4nd0m') }]

const job = (over: Partial<SendJob> = {}): SendJob => ({
  messageId: messageId('m-1'),
  idempotencyKey: idempotencyKey('idem-1'),
  state: 'READY',
  attemptsMade: 0,
  maxAttempts: 3,
  notBeforeIso: T0,
  claim: null,
  providerId: null,
  ...over,
})

/** The only door: a claim whose row count was one. */
const permitFor = (over: Partial<SendJob> = {}) => {
  const outcome = claimOutcome(claimStatement(messageId('m-1'), workerId('w-1'), T0, 60_000), 1, job(over))
  assert.ok(outcome.won)
  return outcome.permit
}

const outbound = (over: Partial<Outbound> = {}): Outbound => ({
  permit: permitFor(),
  to: TO,
  body: BODY,
  idempotencyKey: idempotencyKey('idem-1'),
  ...over,
})

const transportSaying = (answer: ProviderAnswer): SendTransport & { calls: number } => {
  const t = { calls: 0, send: async () => { t.calls += 1; return answer } }
  return t
}

test('NOTHING IN THIS BUILD CAN REACH A PROVIDER', async () => {
  // THE CURRENT SAFETY PROPERTY, and it is structural rather than configured: there is no Resend
  // client in the repository, so switching the sender on requires somebody to WRITE a transport
  // rather than to set a variable.
  const outcome = await attemptSend(NO_TRANSPORT_CONFIGURED, outbound(), suppressionsOf([]), T0)

  assert.ok(outcome.sent, 'an attempt was made and settled, rather than silently skipped')
  assert.equal(outcome.settled.kind, 'REFUSED_RETRYABLE')

  // RETRYABLE, NOT PERMANENT, AND THAT IS THE DELIBERATE DIRECTION. A permanent refusal would
  // burn the budget and mark the job GAVE_UP — so a system left running against this transport
  // would conclude every address was dead, and whoever finally wired a real provider would
  // inherit a queue that had already given up.
  const after = afterAttempt(job(), outcome.settled)
  assert.equal(after.state, 'READY', 'still waiting, not given up')
  assert.equal(after.attemptsMade, 1)
  assert.ok(!suppressesAddress(outcome.settled), 'and no address is blamed for our own absence')
})

test('A SUPPRESSED ADDRESS IS NOT ATTEMPTED, and the refusal is visible', async () => {
  // Silence has to be a decision somebody can see, not an absence.
  const transport = transportSaying({ accepted: true, providerId: providerMessageId('p-1') })
  const outcome = await attemptSend(transport, outbound(), suppressionsOf([TO]), T0)

  assert.equal(outcome.sent, false)
  assert.equal(outcome.sent === false ? outcome.refused.kind : null, 'ADDRESS_SUPPRESSED')
  assert.equal(transport.calls, 0, 'the provider was never called')

  // AND NO ATTEMPT ROW IS OPENED. One would make `inFlight` report a process that died holding
  // a send that never started.
  assert.ok(!('attempt' in outcome))

  // NOT VACUOUS: the same send to an unsuppressed address goes.
  const allowed = await attemptSend(transport, outbound(), suppressionsOf([]), T0)
  assert.ok(allowed.sent)
  assert.equal(transport.calls, 1)
})

test('A HARD BOUNCE SUPPRESSES THE ADDRESS; A SOFT ONE DOES NOT', async () => {
  // A hard bounce is a fact about an address, not an error in a log. Continuing to attempt it is
  // what earns a sending domain a reputation problem — and that damage lands on every other
  // message, not on the one that bounced.
  const permanent = await attemptSend(
    transportSaying({ accepted: false, permanent: true, because: 'no such mailbox' }),
    outbound(), suppressionsOf([]), T0)
  assert.ok(permanent.sent)
  assert.equal(permanent.settled.kind, 'REFUSED_PERMANENT')
  assert.equal(suppressesAddress(permanent.settled), true)
  assert.equal(afterAttempt(job({ maxAttempts: 5 }), permanent.settled).state, 'GAVE_UP',
    'and it stops at once rather than spending the budget')

  const soft = await attemptSend(
    transportSaying({ accepted: false, permanent: false, because: 'rate limited' }),
    outbound(), suppressionsOf([]), T0)
  assert.ok(soft.sent)
  assert.equal(suppressesAddress(soft.settled), false, 'a bad day is not a dead mailbox')
  assert.equal(afterAttempt(job(), soft.settled).state, 'READY')

  // AND AN ACCEPTED SEND SUPPRESSES NOTHING, or the check is satisfied by suppressing always.
  const accepted = await attemptSend(
    transportSaying({ accepted: true, providerId: providerMessageId('p-1') }),
    outbound(), suppressionsOf([]), T0)
  assert.ok(accepted.sent)
  assert.equal(suppressesAddress(accepted.settled), false)
})

test('SUPPRESSION IS PER ADDRESS, NOT PER JOB', async () => {
  // The fact is about the address, so a DIFFERENT message to the same dead mailbox must also not
  // be attempted. Keying it to the job would let every new incident retry the same dead inbox.
  const transport = transportSaying({ accepted: true, providerId: providerMessageId('p-2') })
  const another = outbound({
    permit: permitFor({ messageId: messageId('m-2') }),
    idempotencyKey: idempotencyKey('idem-2'),
  })
  const outcome = await attemptSend(transport, another, suppressionsOf([TO]), T0)

  assert.equal(outcome.sent, false)
  assert.equal(transport.calls, 0)

  // A different address is unaffected — suppression is not a global mute.
  const elsewhere = await attemptSend(transport, outbound({
    to: operatorAddressOf({ ...INBOX, address: 'other@an-msp.example' }),
  }), suppressionsOf([TO]), T0)
  assert.ok(elsewhere.sent)
})

test('AN ACCEPTED SEND CARRIES THE PROVIDER ID, and the attempt precedes it', async () => {
  const transport = transportSaying({ accepted: true, providerId: providerMessageId('p-9') })
  const outcome = await attemptSend(transport, outbound(), suppressionsOf([]), T0)

  assert.ok(outcome.sent)
  assert.equal(outcome.settled.kind, 'ACCEPTED')
  assert.equal(outcome.settled.kind === 'ACCEPTED' ? outcome.settled.providerId : null, 'p-9')

  // THE ATTEMPT IS OPEN AND UNSETTLED as the sender returns it — written before the side effect,
  // so a crash mid-send leaves the evidence rather than no trace. The caller settles it.
  assert.equal(outcome.attempt.settled, null)
  assert.equal(outcome.attempt.attemptNo, 1)
  assert.equal(outcome.attempt.messageId, 'm-1')

  // AND THE JOB THEN CARRIES THE EVIDENCE, so SENT is never a state somebody has to trust.
  const after = afterAttempt(job(), outcome.settled)
  assert.equal(after.state, 'SENT')
  assert.equal(after.providerId, 'p-9')
})

test('THE TRANSPORT CANNOT BE CALLED WITHOUT A PERMIT', () => {
  // The whole seam. A worker that ignored the claim's row count has no permit, so there is
  // nothing to build an `Outbound` from — the send is unavailable rather than discouraged.
  const lost = claimOutcome(claimStatement(messageId('m-1'), workerId('w-1'), T0, 60_000), 0, job())
  assert.equal(lost.won, false, 'zero rows means another worker won')

  // @ts-expect-error - a refused claim has no permit to reach for
  const stolen = lost.permit
  // @ts-expect-error - and one cannot be written by hand
  const forged: Outbound = { permit: { messageId: messageId('m-1'), idempotencyKey: idempotencyKey('k'), attemptNo: 1 }, to: TO, body: BODY, idempotencyKey: idempotencyKey('k') }

  assert.equal(stolen, undefined)
  assert.ok(forged !== null)
})
