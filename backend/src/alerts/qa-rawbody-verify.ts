// QA — the rawBody fix verified the way the break was proved: a real Nest pipeline over a real
// socket, driving THE REAL AppModule rather than a two-line probe module.
//
// WHY NOT THROUGH THEIR TEST. The defect lived in the seam between bootstrap and handler, and
// their test boots ProbeModule — one controller, no middleware, no guards. main.ts boots
// AppModule, which applies two middlewares to every route AND registers a GLOBAL AUTH GUARD. A
// check whose module is not the module that ships is the same shape of gap as the one fixed.
//
// AND THE BYTES ARE COMPARED AS BYTES. Their test returns the raw buffer decoded to a string in a
// JSON response and compares strings, so the claim travels through a decode and a re-encode. This
// digests the Buffer INSIDE the handler and compares that digest with the digest of what went on
// the wire, so the comparison does not depend on the round trip.
//
// EVERY CLAIM IS GATED ON status === 200. My first run of this file reported
// RESERIALISE_REALLY_DIFFERS: true off the body of a 401 — the route never ran, and two booleans
// read true over an error page. A boolean computed over an error page is not a result.
import { Controller, Module, Post, Req, type NestApplicationOptions } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { AppModule } from '../app.module.js'
import { HAWKVIEW_NEST_OPTIONS } from '../bootstrap-options.js'
import { Public } from '../auth/public.decorator.js'
import { ResendSignatureVerifier } from './resend-signature-verifier.service.js'

const KEY = randomBytes(32)
process.env.RESEND_WEBHOOK_SIGNING_SECRET = 'whsec_' + KEY.toString('base64')

const ID = 'msg_qa_1'
// Two spaces after each comma — the spacing a re-serialisation cannot reproduce.
const BODY = Buffer.from('{"type":  "email.delivered",  "data": {"email_id":  "p-1"}}', 'utf8')
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const sign = (ts: number, body: string) =>
  'v1,' + createHmac('sha256', KEY).update(ID + '.' + ts + '.' + body).digest('base64')

type Report = {
  rawPresent: boolean
  rawSha: string | null
  rawLength: number | null
  reserialisedSha: string
  verdictOverRaw: string | null
  verdictOverReserialised: string | null
}
type Wire = { status: number; body: Partial<Report> }
type Incoming = { rawBody?: Buffer; body?: unknown; headers: Record<string, string | undefined> }

const look = (req: Incoming): Report => {
  // THE VERIFIER RUNS HERE, in the handler, on the Buffer the pipeline delivered — not on a
  // string pulled back out of a JSON response.
  const verifier = new ResendSignatureVerifier()
  const reserialised = JSON.stringify(req.body)
  const head = {
    id: req.headers['svix-id'],
    timestamp: req.headers['svix-timestamp'],
    signature: req.headers['svix-signature'],
  }
  return {
    rawPresent: req.rawBody !== undefined,
    rawSha: req.rawBody === undefined ? null : sha(req.rawBody),
    rawLength: req.rawBody === undefined ? null : req.rawBody.length,
    reserialisedSha: sha(reserialised),
    verdictOverRaw: req.rawBody === undefined ? null
      : verifier.verify({ ...head, rawBody: req.rawBody.toString('utf8') }),
    verdictOverReserialised: verifier.verify({ ...head, rawBody: reserialised }),
  }
}

@Controller()
class QaProbeController {
  /** A webhook route must be Public — Resend sends no bearer token. */
  @Public()
  @Post('qa-rawbody-probe')
  open(@Req() req: Incoming): Report { return look(req) }

  /** THE CONTROL FOR THE GUARD. Identical, minus the decorator. A webhook controller written
   * without it is refused before the verifier is ever reached. */
  @Post('qa-rawbody-guarded')
  guarded(@Req() req: Incoming): Report { return look(req) }
}

// IMPORTS THE REAL AppModule, so every middleware, parser and guard main.ts gets is here too.
@Module({ imports: [AppModule], controllers: [QaProbeController] })
class QaProbeModule {}

/** Puts EXACT BYTES on the wire. A string body would be re-encoded; this writes the Buffer. */
function post(port: number, path: string, body: Buffer, headers: Record<string, string>): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      // The leading slash matters: without it the request line is malformed and Node's own HTTP
      // parser answers 400 with an empty body, before Nest sees anything. That 400 is what my
      // first run of this version reported, and it is why every claim is gated on status 200.
      host: '127.0.0.1', port, path: '/' + path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(body.length), ...headers },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Partial<Report> }) }
        catch {
          console.error('NON-JSON RESPONSE', res.statusCode, JSON.stringify(res.headers), JSON.stringify(text.slice(0, 300)))
          resolve({ status: res.statusCode ?? 0, body: {} })
        }
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function run(options: NestApplicationOptions, path: string, body: Buffer, headers: Record<string, string>) {
  const app = await NestFactory.create(QaProbeModule, { ...options, logger: ['error'], abortOnError: false })
  await app.listen(0, '127.0.0.1')
  try {
    const url = new URL(await app.getUrl())
    return await post(Number(url.port), path, body, headers)
  } finally { await app.close() }
}

async function main() {
  const ts = Math.floor(Date.now() / 1000)
  const genuine = { 'svix-id': ID, 'svix-timestamp': String(ts), 'svix-signature': sign(ts, BODY.toString('utf8')) }
  const wireSha = sha(BODY)

  const shipped = await run(HAWKVIEW_NEST_OPTIONS, 'qa-rawbody-probe', BODY, genuine)
  const unfixed = await run({}, 'qa-rawbody-probe', BODY, genuine)
  const TAMPERED = Buffer.from('{"type":  "email.delivered",  "data": {"email_id":  "p-victim"}}', 'utf8')
  const tampered = await run(HAWKVIEW_NEST_OPTIONS, 'qa-rawbody-probe', TAMPERED, genuine)
  const guarded = await run(HAWKVIEW_NEST_OPTIONS, 'qa-rawbody-guarded', BODY, genuine)

  // A Nest POST answers 201, not 200. My first gate said `=== 200` and every claim below read
  // FALSE over a body that was completely correct — the gate was wrong in the safe direction,
  // which is the direction a gate should be wrong in.
  const ok = (w: Wire) => w.status === 200 || w.status === 201
  console.log(JSON.stringify({
    QA_RAWBODY_VERIFY: {
      boundTo: '6017f23, the tip of agent/alerts-step-01. main.ts and bootstrap-options.ts are '
        + 'unchanged since 48d74bf, so the tip and the fix are the same code.',
      module: 'QaProbeModule imports the REAL AppModule, so both global middlewares and the '
        + 'global auth guard are in this pipeline. Their test boots a module that has none.',
      wire: { sha: wireSha, bytes: BODY.length },

      shippedOptions: {
        status: shipped.status, ...shipped.body,
        ROUTE_ACTUALLY_RAN: ok(shipped),
        BYTES_ARRIVE_IDENTICAL: ok(shipped) && shipped.body.rawSha === wireSha
          && shipped.body.rawLength === BODY.length,
        // The control that makes the line above mean something: if a re-serialise reproduced the
        // wire bytes, rawBody would be redundant and this would pass either way.
        RESERIALISE_REALLY_DIFFERS: ok(shipped) && shipped.body.reserialisedSha !== wireSha,
        GENUINE_SIGNATURE_AUTHENTICATES_IN_THE_HANDLER: ok(shipped)
          && shipped.body.verdictOverRaw === 'AUTHENTIC',
        REBUILD_IS_REFUSED: ok(shipped) && shipped.body.verdictOverReserialised === 'SIGNATURE_INVALID',
      },

      withoutTheOption: {
        status: unfixed.status, ...unfixed.body,
        NO_BYTES_AT_ALL: ok(unfixed) && unfixed.body.rawPresent === false
          && unfixed.body.verdictOverRaw === null,
      },

      tamperedBody: {
        status: tampered.status, ...tampered.body,
        REFUSED_OVER_RAW: ok(tampered) && tampered.body.verdictOverRaw === 'SIGNATURE_INVALID',
        DIFFERENT_BYTES: ok(tampered) && tampered.body.rawSha !== wireSha,
      },

      theGuardIsLiveInThisPipeline: {
        status: guarded.status,
        REFUSED_BEFORE_THE_HANDLER: guarded.status === 401,
        note: 'a webhook controller written without the Public decorator is 401ed before the '
          + 'verifier runs, and Resend sends no bearer token',
      },

      notEstablished: {
        productionRoute: 'there is NO webhook controller anywhere in src, so nothing routes to '
          + 'the verifier; a real webhook authenticating is bound to the handler boundary only',
        diRegistration: 'ResendSignatureVerifier appears in no module file, so it is not in the '
          + 'DI graph; this probe constructs it directly, as their test does',
      },
    },
  }, null, 2))
}

main().catch((e) => { console.error('QA PROBE FAILED:', e); process.exitCode = 1 })
