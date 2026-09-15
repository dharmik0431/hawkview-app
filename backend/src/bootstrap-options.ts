import { type NestApplicationOptions } from '@nestjs/common'

/**
 * THE OPTIONS `main.ts` BOOTS WITH, EXPORTED SO A TEST CAN BOOT WITH THE SAME ONES.
 *
 * A constant rather than an object literal inside `bootstrap()`, because the property below is
 * load-bearing for signature verification and a test that asserted it against its own literal
 * would prove nothing about the application that ships. This is the one object both read.
 */
export const HAWKVIEW_NEST_OPTIONS: NestApplicationOptions = {
  /**
   * **A SIGNATURE IS OVER BYTES, AND WITHOUT THIS THE BYTES ARE GONE.**
   *
   * Nest parses JSON bodies and hands the handler the parsed object. Re-serialising that object
   * does not reproduce what arrived — measured on a real pipeline, two spaces after a comma were
   * enough to change the digest, and the signature computed over the rebuild differed from the
   * genuine one. So a Resend webhook verified against a re-serialised body fails **every time**,
   * not intermittently: a permanent outage that reads like a wrong key.
   *
   * `rawBody: true` keeps the original buffer on `req.rawBody` for handlers that ask for it.
   *
   * WHAT IT COSTS, STATED RATHER THAN DISCOVERED: one extra buffer per parsed request body, for
   * every route rather than only the webhook. That is bounded by the body-parser's own size
   * limit and inbound bodies here are small — HawkView's memory pressure is Graph responses on
   * the way out, not request bodies on the way in. A route-scoped parser would have been
   * narrower, but Nest registers its parsers at creation, so anything scoped would run after
   * `json()` had already consumed the stream and would silently see nothing. The narrow option
   * is the one that does not work.
   *
   * THE VERIFIER WAS ALREADY CORRECT. This is the seam that feeds it, and no test could see the
   * gap because every test handed `verify()` the raw bytes directly — the half that already
   * worked. A route test must drive the real pipeline.
   */
  rawBody: true,
}
