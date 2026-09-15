import assert from 'node:assert/strict'
import test from 'node:test'
import { Controller, Module, Post, Req, type NestApplicationOptions } from '@nestjs/common'
import { createHawkviewApp } from './bootstrap.js'
import { NestFactory } from '@nestjs/core'
import { createHmac, randomBytes } from 'node:crypto'
import { HAWKVIEW_NEST_OPTIONS } from './bootstrap-options.js'
import { ResendSignatureVerifier } from './alerts/resend-signature-verifier.service.js'

/**
 * DOES A GENUINE SIGNATURE SURVIVE THE PIPELINE?
 *
 * The verifier's own tests hand `verify()` the raw bytes, so they prove the half that already
 * worked. **The defect was in the seam**: Nest parses the body, the handler gets an object, and
 * re-serialising it does not reproduce what arrived — so a genuine webhook fails verification
 * every time, permanently, reading like a wrong key.
 *
 * This boots a REAL Nest application over a REAL socket with the options `main.ts` uses, and
 * checks the bytes that reach a handler. It uses `HAWKVIEW_NEST_OPTIONS` itself rather than its
 * own literal, or it would prove something about this file instead of about the one that ships.
 */

const BODY = '{"type":  "email.delivered",  "data": {"email_id":  "p-1"}}'
const KEY = randomBytes(32)
const ID = 'msg_1'

/** A handler that reports what it received, both ways. */
@Controller()
class ProbeController {
  @Post('probe')
  receive(@Req() request: { rawBody?: Buffer; body?: unknown }) {
    return {
      raw: request.rawBody === undefined ? null : request.rawBody.toString('utf8'),
      reserialised: JSON.stringify(request.body),
    }
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

const sign = (timestampSeconds: number, body: string): string =>
  `v1,${createHmac('sha256', KEY).update(`${ID}.${timestampSeconds}.${body}`).digest('base64')}`

/** **BOOTS THROUGH THE FUNCTION `main.ts` USES.** An earlier version called
 * `NestFactory.create` itself with the shared options object, which guarded the option and not
 * the wiring: reverting `main.ts` to a bare `create(AppModule)` typechecked clean and left all
 * three of these green. Going through `createHawkviewApp` means there is one create call and
 * these tests exercise it. */
async function post(body: string) {
  const app = await createHawkviewApp(ProbeModule)
  await app.listen(0, '127.0.0.1')
  try {
    const url = await app.getUrl()
    const response = await fetch(`${url.replace('[::1]', '127.0.0.1')}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    return await response.json() as { raw: string | null; reserialised: string }
  } finally {
    await app.close()
  }
}

test('THE RAW BYTES REACH THE HANDLER, and the re-serialised body is not the same string', async () => {
  const received = await post(BODY)

  assert.equal(received.raw, BODY, 'byte for byte, including the spacing')

  // THE CONTROL THAT MAKES THE ABOVE MEAN SOMETHING. If re-serialising happened to reproduce the
  // wire bytes, `rawBody` would be a redundant option and this test would pass either way.
  assert.notEqual(received.reserialised, BODY,
    'the parsed-and-restringified body differs from what arrived — which is the whole defect')
})

test('A GENUINE SIGNATURE VERIFIES OVER THE RAW BYTES AND FAILS OVER THE REBUILD', async () => {
  const received = await post(BODY)
  assert.ok(received.raw !== null)

  const before = process.env.RESEND_WEBHOOK_SIGNING_SECRET
  process.env.RESEND_WEBHOOK_SIGNING_SECRET = `whsec_${KEY.toString('base64')}`
  try {
    const verifier = new ResendSignatureVerifier()
    const now = Date.now()
    const timestamp = Math.floor(now / 1000)
    const signature = sign(timestamp, BODY)

    assert.equal(
      verifier.verify({ id: ID, timestamp: String(timestamp), signature, rawBody: received.raw }, now),
      'AUTHENTIC', 'the genuine delivery notice is accepted')

    // AND THE FAILURE THIS OPTION EXISTS TO PREVENT, demonstrated rather than described: the same
    // genuine signature over the re-serialised body is refused. Every time, not intermittently.
    assert.equal(
      verifier.verify(
        { id: ID, timestamp: String(timestamp), signature, rawBody: received.reserialised }, now),
      'SIGNATURE_INVALID',
      'a route that re-serialises would reject every genuine webhook, permanently')
  } finally {
    if (before === undefined) delete process.env.RESEND_WEBHOOK_SIGNING_SECRET
    else process.env.RESEND_WEBHOOK_SIGNING_SECRET = before
  }
})

test('WITHOUT THE OPTION THERE ARE NO BYTES AT ALL — the state this replaced', async () => {
  // `NestFactory.create(AppModule)` with no options is what main.ts did until this landed. Kept
  // as a test rather than a comment so the difference is demonstrated rather than described:
  // without it there is nothing for a signature to be computed over.
  //
  // THIS ONE CALLS `NestFactory` DIRECTLY ON PURPOSE — it is showing what the OTHER path does,
  // so it must not go through `createHawkviewApp`.
  const app = await NestFactory.create(ProbeModule, { logger: false })
  await app.listen(0, '127.0.0.1')
  try {
    const url = (await app.getUrl()).replace('[::1]', '127.0.0.1')
    const response = await fetch(`${url}/probe`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: BODY,
    })
    const received = await response.json() as { raw: string | null }
    assert.equal(received.raw, null, 'req.rawBody is undefined, so a signature has nothing to check')
  } finally {
    await app.close()
  }
})

test('AND THE APPLICATION THAT SHIPS IS THE ONE THESE TESTS BOOT', async () => {
  // THE BINDING, WHICH WAS THE UNGUARDED HALF. `main.ts` no longer chooses anything: it calls
  // `bootstrap()`, which calls `createHawkviewApp()`, which is what the tests above call. There
  // is one `NestFactory.create` in the codebase, so reverting the options cannot leave these
  // green — measured before this change, the revert typechecked and all three passed.
  assert.equal(HAWKVIEW_NEST_OPTIONS.rawBody, true)
  const received = await post(BODY)
  assert.equal(received.raw, BODY, 'through createHawkviewApp, byte for byte')
})
