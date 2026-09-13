// QA — does the raw body survive to a controller through the pipeline main.ts actually builds?
// The verifier computes HMAC over `id.timestamp.RAW_BODY`. If the raw bytes are gone, the only
// thing available is a re-serialisation of the parsed object — and that is not byte-identical.
// Every test of the verifier so far supplied the raw bytes itself, so none of them could see this.
import { createHmac } from 'node:crypto'
import { Controller, Module, Post, Req } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { Request } from 'express'

const SECRET = Buffer.from('qa-secret')
const ID = 'msg_1'
const TS = Math.floor(Date.now() / 1000).toString()
// WHAT RESEND ACTUALLY SENDS: their key order, their spacing, a unicode escape. A parsed-then-
// restringified copy of this is a different byte sequence with the same meaning.
const WIRE = '{"type":"email.delivered",  "data":{"email_id":"p1","to":"s\u00f8ren@msp.example"}}'
const sign = (body: string) => createHmac('sha256', SECRET).update(`${ID}.${TS}.${body}`).digest('base64')
const GENUINE = sign(WIRE)

const seen: Record<string, unknown> = {}

@Controller('qa')
class Probe {
  @Post('hook')
  hook(@Req() req: Request & { rawBody?: Buffer }) {
    const raw = req.rawBody?.toString('utf8')
    const restringified = JSON.stringify(req.body)
    seen.rawBodyAvailable = raw !== undefined
    seen.restringified = restringified
    seen.restringifiedMatchesWire = restringified === WIRE
    seen.signatureOverRestringified = sign(restringified)
    seen.genuineSignature = GENUINE
    seen.wouldVerify = sign(restringified) === GENUINE
    return { ok: true }
  }
}
@Module({ controllers: [Probe] })
class ProbeModule {}

// BOOTSTRAPPED EXACTLY AS main.ts DOES IT: NestFactory.create(AppModule), no options.
const app = await NestFactory.create(ProbeModule, { logger: false, rawBody: true })
await app.listen(8123, '127.0.0.1')
await fetch('http://127.0.0.1:8123/qa/hook', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: WIRE,
})
await app.close()

console.log(JSON.stringify({
  QA_RAWBODY: {
    bootstrappedAs: 'NestFactory.create(Module, { rawBody: true })  — the REMEDY, as a positive control',
    rawBodyAvailableToTheController: seen.rawBodyAvailable,
    whatWasSentOnTheWire: WIRE,
    whatTheControllerCanReconstruct: seen.restringified,
    reconstructionIsByteIdentical: seen.restringifiedMatchesWire,
    genuineSignature: seen.genuineSignature,
    signatureOverTheReconstruction: seen.signatureOverRestringified,
    aGenuineWebhookWouldVerify: seen.wouldVerify,
    verdict: seen.rawBodyAvailable === false && seen.wouldVerify === false
      ? 'CONFIRMED — the raw body does not survive, and a GENUINE Resend webhook would fail '
        + 'verification for ever. No existing test can see this, because every one supplies the '
        + 'raw bytes directly to the verifier.'
      : 'not reproduced',
  },
}, null, 2))
