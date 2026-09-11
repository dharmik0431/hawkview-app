import { Module } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { RateLimitInterceptor } from './rate-limit.interceptor.js'
import { RateLimitStore } from './rate-limit.store.js'
import { UnauthenticatedRateLimitMiddleware } from './unauthenticated-rate-limit.middleware.js'

/** Rate limiting, in two enforcement points sharing one policy and one store.
 *
 * The middleware is exported rather than applied here: `AppModule` owns the
 * middleware order, and the order matters — request correlation must run first so
 * that a refused request still carries the `X-Request-ID` somebody will quote
 * when asking why it was refused.
 */
@Module({
  providers: [
    RateLimitStore,
    UnauthenticatedRateLimitMiddleware,
    { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
  ],
  exports: [RateLimitStore, UnauthenticatedRateLimitMiddleware],
})
export class RateLimitingModule {}
