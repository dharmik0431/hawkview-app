import { Injectable } from '@nestjs/common'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { type Authentication } from './email-delivery.js'

/**
 * THE ONE PLACE THAT SEES THE WEBHOOK SECRET.
 *
 * `email-delivery.ts` takes an `Authentication` verdict as a parameter and never learns how it
 * was reached — so the pure module stays testable without a key, and the key lives in exactly one
 * service, shaped like `SchedulerTokenVerifier` which does the same job for the scheduler.
 *
 * IT RETURNS A VERDICT AND NEVER THROWS. `SchedulerTokenVerifier` throws `UnauthorizedException`
 * because a bad scheduler token means the request should not proceed. This is the opposite: a
 * webhook we cannot authenticate is not an error, it is an **unmatched event that must still be
 * recorded** — an endpoint that 401s a forged request tells the forger their signature was
 * checked, and worse, tells us nothing.
 */

/** Resend signs with Svix. Three headers, and the signed content is the id, the timestamp and the
 * raw body joined by dots — RAW, because re-serialising JSON changes bytes and a signature is
 * over bytes. A caller that hands this a parsed-and-restringified body will get
 * `SIGNATURE_INVALID` for a genuine request and will look for the fault in the wrong place. */
export interface SignedWebhook {
  readonly id: string | undefined
  readonly timestamp: string | undefined
  readonly signature: string | undefined
  readonly rawBody: string
}

/** How far out of date a timestamp may be. Five minutes each way, which is Svix's own tolerance.
 *
 * WITHOUT THIS A CAPTURED REQUEST REPLAYS FOR EVER. The signature stays valid because the content
 * has not changed — so an attacker who observes one genuine delivery notice can re-send it
 * indefinitely, and every replay would be recorded as a fresh outcome. */
const TOLERANCE_MS = 5 * 60_000

@Injectable()
export class ResendSignatureVerifier {
  private readonly key: Buffer | null

  constructor() {
    this.key = decodeSecret(process.env.RESEND_WEBHOOK_SIGNING_SECRET)
  }

  /** AUTHENTIC only when a signature is present, well-formed, in date, and matches.
   *
   * UNCONFIGURED IS `SIGNATURE_INVALID`, NOT `AUTHENTIC`. It fails closed: with no secret there
   * is nothing to check against, and an endpoint that accepts everything while unconfigured is
   * the endpoint anybody can use to mark our messages delivered. It is deliberately not a
   * distinct verdict either — `authenticate()` takes three, and adding a fourth would mean every
   * caller had to decide what an unconfigured verifier means, which is a decision with exactly
   * one safe answer. */
  verify(webhook: SignedWebhook, nowMs: number = Date.now()): Authentication {
    if (webhook.signature === undefined || webhook.signature === ''
      || webhook.id === undefined || webhook.timestamp === undefined) {
      return 'SIGNATURE_MISSING'
    }
    if (this.key === null) return 'SIGNATURE_INVALID'

    const sentAt = Number(webhook.timestamp)
    if (!Number.isFinite(sentAt)) return 'SIGNATURE_INVALID'
    if (Math.abs(nowMs - sentAt * 1000) > TOLERANCE_MS) return 'SIGNATURE_INVALID'

    const expected = createHmac('sha256', this.key)
      .update(`${webhook.id}.${webhook.timestamp}.${webhook.rawBody}`)
      .digest()

    // A HEADER CARRIES A SPACE-SEPARATED LIST, because a secret being rotated means two valid
    // signatures at once. Matching any one of them is correct; matching only the first would
    // reject genuine traffic for the length of every rotation.
    for (const candidate of webhook.signature.split(' ')) {
      const [version, encoded] = candidate.split(',')
      if (version !== 'v1' || encoded === undefined) continue
      let supplied: Buffer
      try {
        supplied = Buffer.from(encoded, 'base64')
      } catch {
        continue
      }
      // Length-checked first because `timingSafeEqual` throws on a mismatch, and constant time
      // over unequal lengths is not a property anybody needs.
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
        return 'AUTHENTIC'
      }
    }
    return 'SIGNATURE_INVALID'
  }

  /** Whether a secret is configured at all. For a health check to report the gap, rather than
   * for the verify path, which must behave the same either way. */
  get configured(): boolean {
    return this.key !== null
  }
}

/** `whsec_<base64>`, which is Svix's format. The bare base64 is accepted too, because that is
 * what somebody pasting from a different page will have.
 *
 * A malformed secret is null rather than a throw: a service that cannot construct takes the whole
 * application down at boot, and a missing webhook secret must not stop HawkView collecting. */
function decodeSecret(raw: string | undefined): Buffer | null {
  const trimmed = raw?.trim()
  if (trimmed === undefined || trimmed === '') return null
  const encoded = trimmed.startsWith('whsec_') ? trimmed.slice('whsec_'.length) : trimmed
  try {
    const key = Buffer.from(encoded, 'base64')
    return key.length === 0 ? null : key
  } catch {
    return null
  }
}
