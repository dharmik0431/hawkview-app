import {
  BadRequestException, Controller, Headers, HttpCode, Inject,
  InternalServerErrorException, Logger, Post, Req, type RawBodyRequest,
} from '@nestjs/common'
import type { Request } from 'express'
import { Public } from '../auth/public.decorator.js'
import { type CorrelatedRequest } from '../request-correlation.middleware.js'
import { authenticate } from './email-delivery.js'
import { outcomeRow, parseResendEvent } from './delivery-events.js'
import { DeliveryOutcomeStore } from './delivery-outcome.store.js'
import { ResendSignatureVerifier } from './resend-signature-verifier.service.js'
import { rejectionCount } from './webhook-rejection-count.js'

/**
 * WHERE THE PROVIDER TELLS US WHAT HAPPENED.
 *
 * `@Public()` IS REQUIRED AND IS NOT A RELAXATION. A global auth guard 401s an undecorated route
 * before the handler runs, and Resend sends no bearer token — so without it this endpoint rejects
 * every genuine webhook and the failure looks like a provider problem. Authentication here is the
 * SIGNATURE, checked before anything else happens.
 *
 * THE RAW BYTES COME FROM `req.rawBody`, put there by `rawBody: true` in the shared bootstrap
 * options. NOT re-derived: re-serialising the parsed JSON changes bytes — two spaces after a
 * comma were enough, measured — and a signature is over bytes, so a rebuilt body fails EVERY
 * time. That is a permanent outage that reads like a wrong key.
 *
 * ---------------------------------------------------------------------------------------
 * A REVERSAL, RECORDED HERE BECAUSE THE CODE IS WHERE SOMEBODY WILL LOOK FOR THE REASONING.
 *
 * This route used to return 200 to a forged request and write a row for it. Two arguments held it
 * up and BOTH PREMISES WERE FALSE:
 *
 *  1. "A non-2xx makes the provider retry a forged body for hours." Resend's retry guidance is
 *     about THEIR OWN delivery attempts. A forged request was never sent by Resend, so their
 *     retry policy does not apply to it — and their official verification example validates
 *     first and returns 400. I applied a fact about the provider's behaviour to traffic the
 *     provider never sent.
 *  2. "Answering differently is a cryptographic oracle." It is not. A padding or timing oracle
 *     leaks key material incrementally; this leaks the existence of a signature check that every
 *     webhook endpoint on the internet performs. A forger who sends an unsigned request already
 *     knows they do not hold the secret — a 400 tells them nothing they did not arrive with. I
 *     invented that framing and it inflated ordinary rejection into a security property.
 *
 * SO THE ORDER IS NOW VERIFY FIRST, AND REJECT. No parse, no lookup, no database write, and no
 * delivery outcome for a request that did not authenticate.
 * ---------------------------------------------------------------------------------------
 */
/** THE WHOLE BODY OF A 500 FROM THIS ROUTE. A constant, exported so the test asserting that a
 * synthetic database error does NOT appear in the response can assert what DOES, rather than
 * matching on a status code that would still pass while leaking. */
export const PERSISTENCE_FAILED = 'Failed to record delivery outcome.'

@Controller('api/alerts/delivery')
export class DeliveryWebhookController {
  private readonly logger = new Logger(DeliveryWebhookController.name)

  constructor(
    @Inject(ResendSignatureVerifier) private readonly verifier: ResendSignatureVerifier,
    @Inject(DeliveryOutcomeStore) private readonly store: DeliveryOutcomeStore,
  ) {}

  @Public()
  @Post('resend')
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('svix-id') svixId?: string,
    @Headers('svix-timestamp') svixTimestamp?: string,
    @Headers('svix-signature') svixSignature?: string,
  ): Promise<{ recorded: boolean }> {
    const rawBody = request.rawBody?.toString('utf8') ?? ''

    const verdict = this.verifier.verify({
      id: svixId, timestamp: svixTimestamp, signature: svixSignature, rawBody,
    })

    // THE BOUND, AND IT IS THAT NOTHING HAPPENS. No SQL, no parse, no allocation beyond an
    // in-process counter increment.
    //
    // NEITHER LIMITER PROTECTS THIS ROUTE, which is why the work has to be absent rather than
    // merely capped. Verified, not assumed:
    //   - `unauthenticated-rate-limit.middleware` leaves a request carrying ANY well-formed
    //     Bearer header "for the subject limit" — its own test drives 3x the window with
    //     `Bearer a-token` and refuses none, with a positive control showing the same address is
    //     refused without one.
    //   - `RateLimitInterceptor` enforces only the SUBJECT bucket, and its own comment says it
    //     does not enforce the unauthenticated one. A `@Public()` route resolves no subject, so
    //     `plan.bucket !== 'SUBJECT'` and it falls through.
    // So a forged request carrying any Bearer header reaches this line unmetered by both.
    //
    // The previous version counted rejections with a shared-row SQL upsert per request. That
    // bounded the ROW COUNT at 24x2 and left the DATABASE WORK unbounded — the thing an attacker
    // actually consumes. Counting attacker requests exactly is not a requirement that outranks
    // API availability.
    if (verdict !== 'AUTHENTIC') {
      rejectionCount.record(verdict)
      throw new BadRequestException('invalid signature')
    }

    const parsed = parseResendEvent(rawBody)
    if (!parsed.parsed) {
      // AUTHENTIC BUT NOT SOMETHING WE MODEL. Resend sends `email.sent` and `email.opened` on
      // every send; a 2xx is correct, because the request was genuine and there is nothing to do.
      // This is not the attacker path — it is already past the signature.
      return { recorded: false }
    }

    const received = authenticate(parsed.raw, verdict)
    if (!received.authentic) return { recorded: false }

    try {
      // Matching is the store's question: it holds the provider ids. A verified event that ties
      // to no job still produces a row in full — that one means a job we lost or an id we never
      // recorded, which is a fact about this system that a count could not answer, and it needs
      // the signing secret to produce so its volume is bounded by the provider.
      const matched = await this.store.messageForProvider(received.event.providerId)
      await this.store.record(outcomeRow(received.event, matched), { eventId: svixId ?? '', event: received.event })
    } catch (error) {
      // A TRANSIENT FAILURE ON AN AUTHENTIC EVENT MUST NOT BECOME A SUCCESSFUL ACKNOWLEDGEMENT.
      // Swallowing it would tell Resend the event was handled and lose the outcome permanently —
      // and this is the one path where their retry guidance genuinely applies, because the
      // request really did come from them. A 5xx keeps it observable and retryable.
      //
      // **THE STATUS IS THE ANSWER; THE EXCEPTION TEXT IS NOT.** This used to interpolate
      // `error.message` into the response, which puts database exception text — connection
      // strings, constraint names, fragments of SQL — into an HTTP body sent to whoever made the
      // request. A leak test that only checks for 500 cannot see that, so the message is now a
      // constant and the detail goes to the log with the correlation id that is already on the
      // response as `X-Request-ID`.
      //
      // The log takes the error's NAME, never its message: a name is a closed set the driver
      // chose, a message is free text assembled from whatever the database was handling. `code`
      // rides along only when it matches a short enumerable shape, so a driver that puts prose
      // there cannot widen this.
      const code = (error as { code?: unknown }).code
      this.logger.error(JSON.stringify({
        event: 'delivery_outcome_persist_failed',
        requestId: (request as Partial<CorrelatedRequest>).requestId ?? null,
        name: error instanceof Error ? error.name : 'UNKNOWN',
        code: typeof code === 'string' && /^[A-Z0-9_]{1,12}$/.test(code) ? code : null,
      }))
      throw new InternalServerErrorException(PERSISTENCE_FAILED)
    }

    return { recorded: true }
  }
}
