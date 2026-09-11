import { Inject, Injectable, Logger, type NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { clientAddress } from './client-address.js'
import { normalizePath, planFor } from './rate-limit-policy.js'
import { requestPath } from './request-path.js'
import { rateLimitSettings } from './rate-limit-settings.js'
import { RateLimitStore } from './rate-limit.store.js'

/** The limit on callers who present no identity at all.
 *
 * MIDDLEWARE RATHER THAN AN INTERCEPTOR, because a request that fails
 * authentication never reaches an interceptor — the guard throws first. Metering
 * unauthenticated traffic therefore has to happen before the guards run, which
 * is what middleware is.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not meter a request that carries a
 * syntactically valid `Bearer` token. Such a request is metered by subject once
 * the subject is verified. Metering it here as well would mean metering
 * authenticated traffic by ADDRESS before we know whose it is, and an MSP office
 * is many operators behind one address — a busy afternoon would be refused as if
 * it were one abusive caller.
 *
 * The consequence is a real and stated gap: a flood of well-formed but invalid
 * tokens is skipped here and rejected by the guard, so it is not counted
 * anywhere. Closing that means counting verification FAILURES per address, which
 * cannot be done safely until the deployment states how to identify an address
 * at all — today it cannot, so that limit would key every failure in the world
 * into one bucket. `docs/rate-limiting.md` records this as the follow-up and what
 * it depends on.
 */

/** Matches the same shape `IdentityAuthGuard` requires, so the two agree about
 * what counts as presenting a token. Anything this accepts, the guard will try to
 * verify; anything it rejects, the guard refuses outright. */
const BEARER_TOKEN = /^Bearer ([^\s]+)$/

@Injectable()
export class UnauthenticatedRateLimitMiddleware implements NestMiddleware {
  private readonly logger = new Logger(UnauthenticatedRateLimitMiddleware.name)

  constructor(
    @Inject(RateLimitStore)
    private readonly store: RateLimitStore,
  ) {}

  use(request: Request, response: Response, next: NextFunction) {
    const authorization = request.headers.authorization
    if (typeof authorization === 'string' && BEARER_TOKEN.test(authorization)) {
      return next()
    }

    const settings = rateLimitSettings()
    const plan = planFor(
      {
        path: requestPath(request),
        // Null by construction: this runs before anything has verified an
        // identity, so there is no subject to be had here even in principle.
        subject: null,
        clientAddress: clientAddress(
          request.headers['x-forwarded-for'],
          request.socket?.remoteAddress,
          settings.trustedProxyHops,
        ),
      },
      settings,
    )

    if (!plan.enforce || plan.bucket !== 'UNAUTHENTICATED') return next()

    const state = this.store.counter('UNAUTHENTICATED').hit(plan.key, Date.now())
    if (state.allowed) return next()

    response.setHeader('Retry-After', String(state.retryAfterSeconds))
    this.logger.warn(JSON.stringify({
      event: 'rate_limit_refused',
      bucket: 'UNAUTHENTICATED',
      path: normalizePath(requestPath(request)),
      count: state.count,
      limit: state.limit,
    }))
    // Ended here rather than passed on. A 429 from middleware keeps the refusal
    // cheap, which is the point of shedding an unauthenticated flood before it
    // reaches token verification.
    response.status(429).json({ statusCode: 429, message: 'Too many requests.' })
  }
}
