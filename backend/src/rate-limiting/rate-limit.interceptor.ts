import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { clientAddress } from './client-address.js'
import { normalizePath, planFor } from './rate-limit-policy.js'
import { requestPath } from './request-path.js'
import { rateLimitSettings } from './rate-limit-settings.js'
import { RateLimitStore } from './rate-limit.store.js'

/** The limit on an authenticated subject.
 *
 * AN INTERCEPTOR RATHER THAN A GUARD, and the reason is ordering. This needs the
 * VERIFIED subject, which `IdentityAuthGuard` attaches to the request. Global
 * guards run in module registration order, so a guard here would be keyed on a
 * subject that exists or not depending on where a future edit places
 * `RateLimitingModule` in the imports list — and when it did not exist, every
 * authenticated caller would silently fall into an address bucket instead. Nest
 * runs interceptors after all guards, always, so the subject is there by
 * construction rather than by import position.
 *
 * It does not enforce the unauthenticated bucket. A request that fails
 * authentication never reaches an interceptor, so there is nothing here to meter
 * — see `unauthenticated-rate-limit.middleware.ts`, which runs before the guards
 * for exactly that reason.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RateLimitInterceptor.name)

  constructor(
    @Inject(RateLimitStore)
    private readonly store: RateLimitStore,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    // Anything that is not an HTTP request has no path, no caller and no address.
    if (context.getType() !== 'http') return next.handle()

    const request = context.switchToHttp().getRequest<Request>()
    const settings = rateLimitSettings()
    const plan = planFor(
      {
        path: requestPath(request),
        subject: subjectOf(request),
        clientAddress: clientAddress(
          request.headers['x-forwarded-for'],
          request.socket?.remoteAddress,
          settings.trustedProxyHops,
        ),
      },
      settings,
    )

    // Not enforced at all, or the address bucket, which is the middleware's.
    if (!plan.enforce || plan.bucket !== 'SUBJECT') return next.handle()

    const state = this.store.counter('SUBJECT').hit(plan.key, Date.now())
    if (state.allowed) return next.handle()

    const response = context.switchToHttp().getResponse<Response>()
    response.setHeader('Retry-After', String(state.retryAfterSeconds))
    // Logged without the key. The count, the limit and the route are what an
    // operator needs to tell a runaway client from a limit set too low; which
    // person it was is not, and a user identifier in a log line is a durable
    // copy of it in a place with different access rules.
    this.logger.warn(JSON.stringify({
      event: 'rate_limit_refused',
      bucket: 'SUBJECT',
      path: normalizePath(requestPath(request)),
      count: state.count,
      limit: state.limit,
    }))
    throw new HttpException(
      { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: 'Too many requests.' },
      HttpStatus.TOO_MANY_REQUESTS,
    )
  }
}

/** The subject the auth guard verified, or null.
 *
 * Read from the request rather than from the token, because the token's own
 * claims are only meaningful after verification and this must never key on a
 * value a caller chose: an attacker who could pick their own subject would mint
 * a fresh allowance per request.
 */
function subjectOf(request: Request): string | null {
  const auth = (request as Request & { auth?: { subject?: unknown } }).auth
  return typeof auth?.subject === 'string' && auth.subject !== '' ? auth.subject : null
}
