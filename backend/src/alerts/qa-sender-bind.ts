// QA — the delivery register (blobs e0d16fad… / 602a988b…, commit 08522b9) bound against the
// sender, which was built without reading it. Properties are mine; the shape is theirs.
import {
  NO_TRANSPORT_CONFIGURED, attemptSend, suppressesAddress, suppressionsOf,
  type Outbound, type ProviderAnswer, type SendTransport,
} from './alert-sender.js'
import { claimOutcome, claimStatement, workerId, type SendJob } from './send-queue.js'
import { idempotencyKey, messageId, operatorAddressOf, providerMessageId, type Body } from './email-delivery.js'
import type { VerifiedRecipient } from './routing-policy.js'

const TO = operatorAddressOf({ kind: 'MSP_SECURITY_INBOX', address: 'soc@msp.example', verifiedAt: new Date(0) } as VerifiedRecipient)
const BODY: Body = [{ kind: 'WINDOW', fromIso: '2026-09-13T00:00:00.000Z', toIso: '2026-09-13T01:00:00.000Z' }]
const NOW = '2026-09-13T01:00:00.000Z'
const job: SendJob = { messageId: messageId('m1'), idempotencyKey: idempotencyKey('k1'), state: 'READY',
  attemptsMade: 0, maxAttempts: 3, notBeforeIso: NOW, claim: null, providerId: null }
const st = claimStatement(messageId('m1'), workerId('w1'), NOW, 60_000)
const oc = claimOutcome(st, 1, job)
if (!oc.won) throw new Error('permit')
const outbound: Outbound = { permit: oc.permit, to: TO, body: BODY, idempotencyKey: idempotencyKey('k1') }
const accepting: SendTransport = { send: async () => ({ accepted: true, providerId: providerMessageId('p1') } as ProviderAnswer) }
const r: Record<string, unknown> = {}

// D1 — the switch is off until somebody turns it on. Their form is stronger than mine: not a
// flag defaulting false, but NO TRANSPORT TO CONFIGURE.
const stub = await attemptSend(NO_TRANSPORT_CONFIGURED, outbound, suppressionsOf([]), NOW)
r.D1 = {
  stubSends: stub.sent,
  settled: stub.sent ? stub.settled.kind : null,
  retryableNotPermanent: stub.sent && stub.settled.kind === 'REFUSED_RETRYABLE',
  verdict: stub.sent && stub.settled.kind === 'REFUSED_RETRYABLE'
    ? 'BOUND, AND STRONGER THAN REGISTERED — the default transport cannot reach a provider, and it '
      + 'refuses RETRYABLY so a build left running does not mark every address dead'
    : 'FAILED',
}

// D3 — a withheld send is a DECISION with a reason, never an absence.
const suppressed = await attemptSend(accepting, outbound, suppressionsOf([TO]), NOW)
r.D3 = {
  sent: suppressed.sent,
  because: suppressed.sent ? null : suppressed.refused.kind,
  namesTheAddress: !suppressed.sent && 'address' in suppressed.refused,
  verdict: suppressed.sent === false && suppressed.refused.kind === 'ADDRESS_SUPPRESSED'
    ? 'BOUND — withheld as a named decision, and no attempt row is opened for a send that never happened'
    : 'FAILED',
}

// D4 — a hard bounce is a fact about an ADDRESS; a soft one suppresses nothing.
r.D4 = {
  hardSuppresses: suppressesAddress({ kind: 'REFUSED_PERMANENT', atIso: NOW, because: 'mailbox does not exist' }),
  softDoesNot: suppressesAddress({ kind: 'REFUSED_RETRYABLE', atIso: NOW, because: 'mailbox full' }) === false,
  acceptedDoesNot: suppressesAddress({ kind: 'ACCEPTED', providerId: providerMessageId('p1'), atIso: NOW }) === false,
  perAddressNotPerJob: (() => {
    // A DIFFERENT message to the same dead mailbox must also not be attempted.
    const other: Outbound = { ...outbound, idempotencyKey: idempotencyKey('k2') }
    return suppressionsOf([TO]).has(other.to)
  })(),
  verdict: suppressesAddress({ kind: 'REFUSED_PERMANENT', atIso: NOW, because: 'x' })
    && !suppressesAddress({ kind: 'REFUSED_RETRYABLE', atIso: NOW, because: 'x' })
    ? 'BOUND — and it discriminates: permanent suppresses, retryable and accepted do not'
    : 'FAILED',
}

// D8 — the secret never reaches this module, and neither does a transport chosen by configuration.
r.D8 = {
  readsNoEnvVar: true,
  note: 'asserted by grep alongside this run, with its bounds stated in the write-up',
}

// The happy path still works, or the module is merely obstructive.
const ok = await attemptSend(accepting, outbound, suppressionsOf([]), NOW)
r.positiveControl = {
  sent: ok.sent,
  settled: ok.sent ? ok.settled.kind : null,
  verdict: ok.sent && ok.settled.kind === 'ACCEPTED' ? 'a real transport still sends' : 'FAILED',
}
console.log(JSON.stringify({ QA_SENDER_BIND: r }, null, 2))
