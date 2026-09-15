import assert from 'node:assert/strict'
import test from 'node:test'
import { DeliveryWebhookController, PERSISTENCE_FAILED } from './delivery-webhook.controller.js'
import { type DeliveryOutcomeStore } from './delivery-outcome.store.js'
import { type OutcomeRow } from './delivery-events.js'
import { messageId, type Authentication, type MessageId, type ProviderMessageId } from './email-delivery.js'
import { type ResendSignatureVerifier } from './resend-signature-verifier.service.js'
import { rejectionCount } from './webhook-rejection-count.js'

/**
 * THE ROUTE HANDLER, AND WHAT THESE TESTS CANNOT SEE.
 *
 * **THIS FILE PROVES NOTHING ABOUT MIDDLEWARE, GUARDS OR INTERCEPTORS.** The controller is
 * constructed directly, so nothing here exercises `@Public()`, the unauthenticated rate-limit
 * middleware, or `RateLimitInterceptor` — a request never passes through them. Any claim about
 * what reaches this handler is a claim about code these tests do not run.
 *
 * That matters because of what was verified by reading those modules rather than by asserting it
 * here: `unauthenticated-rate-limit.middleware.test.ts` drives three windows of traffic carrying
 * `Authorization: Bearer a-token` and refuses none — with a positive control showing the same
 * address refused without one — and `RateLimitInterceptor` enforces only the SUBJECT bucket, its
 * own comment stating it does not enforce the unauthenticated one. A `@Public()` route resolves
 * no subject. **So a forged request with any well-formed Bearer header reaches this handler
 * unmetered by both, and the bound has to be inside the handler.**
 *
 * What these tests do prove is exactly that: for a request that fails verification, the handler
 * reaches no store, parses nothing, and refuses. That is an in-process property and it is
 * testable here, which is why the bound was moved here.
 */

const AT = '2026-09-13T09:00:00.000Z'

const body = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'email.delivered',
  created_at: AT,
  data: { email_id: 're_abc123' },
  ...over,
})

/** Records every call, and throws if asked to, so "did the handler touch the database" is a
 * question with an answer rather than an assumption. */
function fakeStore(matched: MessageId | null = null, failing = false) {
  const calls: string[] = []
  const recorded: OutcomeRow[] = []
  const store = {
    messageForProvider: async (_id: ProviderMessageId) => {
      calls.push('messageForProvider')
      if (failing) throw new Error('connection reset')
      return matched
    },
    record: async (row: OutcomeRow) => {
      calls.push('record')
      if (failing) throw new Error('connection reset')
      recorded.push(row)
    },
  } as unknown as DeliveryOutcomeStore
  return { store, calls, recorded }
}

const fakeVerifier = (verdict: Authentication) =>
  ({ verify: () => verdict }) as unknown as ResendSignatureVerifier

const request = (raw: string | undefined) =>
  ({ rawBody: raw === undefined ? undefined : Buffer.from(raw, 'utf8') }) as never

// ---------------------------------------------------------------------------------------

test('an unverifiable request is REFUSED and touches no store at all', async () => {
  // THE BOUND, AND IT IS THAT NOTHING HAPPENS. Not "the result is small" — no SQL, no parse, no
  // lookup. Neither limiter protects this route, so absence of work is the only defence
  // available, and it is the one an attacker cannot exhaust.
  for (const verdict of ['SIGNATURE_MISSING', 'SIGNATURE_INVALID'] as const) {
    const { store, calls } = fakeStore(messageId('m1'))
    const controller = new DeliveryWebhookController(fakeVerifier(verdict), store)

    await assert.rejects(
      () => controller.receive(request(body())),
      (error: Error & { status?: number }) => error.status === 400,
      `${verdict} must be refused with 400, as the provider's own verification example does`,
    )
    assert.deepEqual(calls, [], `${verdict} must not reach the database`)
  }
})

test('rejecting is counted in memory, with nothing derived from the request', async () => {
  // A map keyed by address or by claimed provider id would be the obvious richer version and
  // would hand the attacker the allocation. A fixed set of counters cannot be grown.
  rejectionCount.resetForTest(AT)
  const { store } = fakeStore()
  const controller = new DeliveryWebhookController(fakeVerifier('SIGNATURE_INVALID'), store)

  await assert.rejects(() => controller.receive(request(body())))
  await assert.rejects(() => controller.receive(request(body({ data: { email_id: 'other' } }))))

  const counts = rejectionCount.read()
  assert.equal(counts.SIGNATURE_INVALID, 2)
  assert.equal(counts.SIGNATURE_MISSING, 0, 'the verdicts are counted apart')
  assert.deepEqual(
    Object.keys(counts).sort(), ['SIGNATURE_INVALID', 'SIGNATURE_MISSING', 'sinceIso'],
    'no key may be derived from anything a caller sends',
  )
})

test('the signature is checked BEFORE the body is parsed', async () => {
  // Order is the property. Parsing first would do attacker-controlled work — JSON.parse over a
  // body of their choosing — before establishing they may ask for anything at all.
  const { store, calls } = fakeStore()
  const controller = new DeliveryWebhookController(fakeVerifier('SIGNATURE_INVALID'), store)

  // A body that would crash a parser, or cost it: refused before it is looked at.
  await assert.rejects(() => controller.receive(request('{'.repeat(10_000))))
  assert.deepEqual(calls, [])
})

test('a verified, matched event is stored in full', async () => {
  const { store, recorded, calls } = fakeStore(messageId('m1'))
  const controller = new DeliveryWebhookController(fakeVerifier('AUTHENTIC'), store)

  const result = await controller.receive(request(body()))

  assert.deepEqual(calls, ['messageForProvider', 'record'])
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]!.kind, 'DELIVERED')
  assert.deepEqual(result, { recorded: true })
})

test('a verified event matching no job is stored in full, not counted', async () => {
  // The asymmetry that makes the bound safe: this path needs the signing secret, so its volume is
  // bounded by the provider's traffic. Aggregating it would lose what it is for — a job we lost,
  // or an id we never recorded.
  const { store, recorded } = fakeStore(null)
  const controller = new DeliveryWebhookController(fakeVerifier('AUTHENTIC'), store)

  await controller.receive(request(body()))

  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]!.kind, 'UNMATCHED')
  assert.equal(recorded[0]!.because, 'NO_SUCH_JOB')
})

test('an authentic but unmodelled event is acknowledged, not refused', async () => {
  // Resend sends email.sent and email.opened on every send. This is past the signature, so it is
  // the provider's own traffic — refusing it would make them retry something we will never want.
  const { store, calls } = fakeStore(messageId('m1'))
  const controller = new DeliveryWebhookController(fakeVerifier('AUTHENTIC'), store)

  const result = await controller.receive(request(body({ type: 'email.opened' })))

  assert.deepEqual(result, { recorded: false })
  assert.deepEqual(calls, [], 'nothing to record, so nothing is written')
})

test('a transient failure on an AUTHENTIC event surfaces, and is never a false acknowledgement', async () => {
  // Swallowing it would tell Resend the event was handled and lose the outcome permanently. This
  // is the one path where their retry guidance genuinely applies, because the request really did
  // come from them — which is precisely the distinction the withdrawn 200-to-forged argument got
  // backwards.
  const { store } = fakeStore(messageId('m1'), true)
  const controller = new DeliveryWebhookController(fakeVerifier('AUTHENTIC'), store)

  await assert.rejects(
    () => controller.receive(request(body())),
    (error: Error & { status?: number }) => error.status === 500,
    'a persistence failure must be observable and retryable, not a 200',
  )
})

test('a missing raw body is refused rather than read as an empty event', async () => {
  // `rawBody` is undefined when the bootstrap constant is not in force. Bytes that never arrived
  // cannot match a signature, so this is refused on the same path as any other unverifiable
  // request — and the 400 is a truthful answer about the request rather than about our wiring.
  const { store, calls } = fakeStore(messageId('m1'))
  const controller = new DeliveryWebhookController(fakeVerifier('SIGNATURE_MISSING'), store)

  await assert.rejects(() => controller.receive(request(undefined)))
  assert.deepEqual(calls, [])
})

test('the verifier is given the raw bytes, not a re-serialised body', async () => {
  // Re-serialising changes bytes — two spaces after a comma were enough, measured — and a
  // signature is over bytes. A rebuilt body fails EVERY time: a permanent outage that reads like
  // a wrong key.
  const seen: string[] = []
  const verifier = {
    verify: (webhook: { rawBody: string }) => { seen.push(webhook.rawBody); return 'AUTHENTIC' as const },
  } as unknown as ResendSignatureVerifier
  const { store } = fakeStore(messageId('m1'))
  const odd = '{"type":"email.delivered",  "created_at":"2026-09-13T09:00:00.000Z",  "data":{"email_id":"re_abc123"}}'

  await new DeliveryWebhookController(verifier, store).receive(request(odd))

  assert.deepEqual(seen, [odd], 'the bytes handed to the verifier must be the bytes that arrived')
})

test('THE DATABASE ERROR DOES NOT TRAVEL IN THE RESPONSE, only the status does', async () => {
  // A LEAK TEST THAT CHECKS THE STATUS CODE CANNOT SEE THIS, which is why the old version passed
  // while the body carried `error.message`. Driver exceptions carry connection strings, constraint
  // names and fragments of SQL, and `InternalServerErrorException(message)` puts its argument
  // straight into the JSON body.
  //
  // The synthetic error below is built from strings that could only come from the exception, so a
  // substring search over the WHOLE serialised response is decisive — asserting the safe message
  // is present would not be, because both can be true at once.
  const SECRET = 'postgresql://hawkview:hunter2@db.internal:5432/hawkview_production'
  const failing = {
    messageForProvider: async () => { throw new Error(`connect ECONNREFUSED ${SECRET} relation "alert_send_attempts"`) },
    record: async () => {},
  } as unknown as DeliveryOutcomeStore
  const controller = new DeliveryWebhookController(fakeVerifier('AUTHENTIC'), failing)

  const error = await controller.receive(request(body())).then(
    () => null,
    (thrown: Error & { status?: number; getResponse?: () => unknown }) => thrown,
  )

  assert.ok(error, 'the failure must still surface')
  assert.equal(error.status, 500, 'and must still be retryable')

  // Everything a caller could read: the message, and the serialised body Nest sends.
  const visible = `${error.message} ${JSON.stringify(error.getResponse?.() ?? {})}`
  assert.ok(!visible.includes(SECRET), `the connection string reached the response: ${visible}`)
  assert.ok(!visible.includes('hunter2'), 'the password reached the response')
  assert.ok(!visible.includes('ECONNREFUSED'), 'the driver error reached the response')
  assert.ok(!visible.includes('alert_send_attempts'), 'an internal table name reached the response')
  assert.ok(visible.includes(PERSISTENCE_FAILED), 'and what is returned is the stable message')
})

test('the 500 body is the same whatever the database said', async () => {
  // The complement: two different internal failures must be indistinguishable from outside. A
  // response that varies with the exception is an oracle for what the database is doing, which is
  // the property the constant exists to hold — and one the test above cannot establish alone.
  const bodies: string[] = []
  for (const thrown of ['connect ETIMEDOUT 10.0.0.5:5432', 'duplicate key value violates unique constraint "x_pkey"']) {
    const failing = {
      messageForProvider: async () => { throw new Error(thrown) },
      record: async () => {},
    } as unknown as DeliveryOutcomeStore
    const error = await new DeliveryWebhookController(fakeVerifier('AUTHENTIC'), failing)
      .receive(request(body()))
      .then(() => null, (e: Error & { getResponse?: () => unknown }) => e)
    bodies.push(JSON.stringify(error?.getResponse?.() ?? {}))
  }

  assert.equal(bodies[0], bodies[1], 'the response varies with the database error')
})
