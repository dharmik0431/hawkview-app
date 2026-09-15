import assert from 'node:assert/strict'
import test from 'node:test'
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common'
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import { AppModule } from '../app.module.js'
import { createHawkviewApp } from '../bootstrap.js'
import { IdentityAuthGuard } from '../auth/identity-auth.guard.js'
import { IdentityTokenVerifier } from '../auth/identity-token-verifier.service.js'
import { RequestCorrelationMiddleware } from '../request-correlation.middleware.js'
import { RateLimitInterceptor } from '../rate-limiting/rate-limit.interceptor.js'
import { RateLimitStore } from '../rate-limiting/rate-limit.store.js'
import { UnauthenticatedRateLimitMiddleware } from '../rate-limiting/unauthenticated-rate-limit.middleware.js'
import { UNAUTHENTICATED_REQUESTS_PER_WINDOW } from '../rate-limiting/rate-limit-policy.js'
import {
  RATE_LIMIT_ENFORCE_VARIABLE, TRUSTED_PROXY_HOPS_VARIABLE,
} from '../rate-limiting/rate-limit-settings.js'
import { DeliveryWebhookController } from './delivery-webhook.controller.js'
import { DeliveryOutcomeStore } from './delivery-outcome.store.js'
import { ResendSignatureVerifier } from './resend-signature-verifier.service.js'
import { rejectionCount } from './webhook-rejection-count.js'

/**
 * **WHAT ACTUALLY MEETS A FORGED WEBHOOK, MEASURED THROUGH A REAL SOCKET.**
 *
 * `delivery-webhook.controller.test.ts` constructs the controller directly. It is good for what
 * it tests and it **cannot see middleware, a guard or an interceptor** — so no claim about what
 * reaches the handler can be made from it. Naming the limiter module is not evidence either;
 * this file exists because the question is whether the limiter applies to THIS route, in the
 * assembled application, with and without a Bearer header.
 *
 * READING THE MODULES SAID IT WOULD NOT. That prediction is written down before the results
 * because it is the thing being tested rather than the thing being assumed:
 *   - the middleware returns `next()` for any `Authorization: Bearer <token>`;
 *   - `IdentityAuthGuard` returns true immediately for `@Public()` and never sets `request.auth`;
 *   - so `RateLimitInterceptor` resolves no subject, `plan.bucket` is not `SUBJECT`, and it falls
 *     through.
 * Three modules read separately, each correct on its own. **That is exactly the shape worth
 * measuring rather than reasoning about** — and `request-path.ts` records this feature already
 * shipping a limiter whose every unit test passed while both exemptions silently matched
 * nothing, because the fixtures described a request Express does not deliver.
 *
 * NOTHING REAL IS SENT AND NO DATABASE IS TOUCHED. The verifier and the outcome store are
 * provided as values, so the real classes are never constructed, and the store fake **counts
 * every call** — "a forged flood does no database work" is then an assertion rather than a claim.
 */

const ROUTE = '/api/alerts/delivery/resend'
const BODY = '{"type":"email.delivered","created_at":"2026-09-13T09:00:00.000Z","data":{"email_id":"re_x"}}'

/** Counts everything, answers nothing. A forged request must reach none of it. */
const storeCalls: string[] = []
const outcomeStoreFake = {
  messageForProvider: async () => { storeCalls.push('messageForProvider'); return null },
  record: async () => { storeCalls.push('record') },
}

/** No secret, no crypto, no environment: every request is refused at the signature. */
const verifierFake = { verify: () => 'SIGNATURE_INVALID' as const }

/** Proves the `@Public()` claim rather than assuming it: a public route must never verify a
 * token, so a call here would mean the guard is doing work an attacker can compel. */
const tokenVerifications: string[] = []
const tokenVerifierFake = {
  verify: async (token: string) => {
    tokenVerifications.push(token)
    throw new Error('a public route must never reach token verification')
  },
}

/**
 * THE SHIPPING STACK AROUND THE ONE ROUTE UNDER TEST.
 *
 * The middleware list and its order are **delegated to `AppModule.configure`** rather than
 * retyped here. A retyped list is a description of the application that stops being true the
 * first time somebody edits the real one, and this test would keep passing — the failure mode
 * this whole file exists to avoid. Delegating means a middleware added to `AppModule` and not
 * provided here fails at boot, loudly.
 */
@Module({
  controllers: [DeliveryWebhookController],
  providers: [
    RateLimitStore,
    RequestCorrelationMiddleware,
    UnauthenticatedRateLimitMiddleware,
    { provide: APP_GUARD, useClass: IdentityAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
    { provide: IdentityTokenVerifier, useValue: tokenVerifierFake },
    { provide: ResendSignatureVerifier, useValue: verifierFake },
    { provide: DeliveryOutcomeStore, useValue: outcomeStoreFake },
  ],
})
class DeliveryRouteStack implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    new AppModule().configure(consumer)
  }
}

// ---------------------------------------------------------------------------------------

interface Tally { readonly statuses: Record<number, number>; readonly refused: number }

/** Boots the application through `createHawkviewApp` — the same function `main.ts` uses, so the
 * options, the CORS and the helmet layers are the shipped ones — drives `count` sequential real
 * requests at the route, and reports what came back. */
async function flood(count: number, headers: Record<string, string>): Promise<Tally> {
  const app = await createHawkviewApp(DeliveryRouteStack)
  await app.listen(0, '127.0.0.1')
  const statuses: Record<number, number> = {}
  try {
    const base = (await app.getUrl()).replace('[::1]', '127.0.0.1')
    for (let index = 0; index < count; index += 1) {
      const response = await fetch(`${base}${ROUTE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: BODY,
      })
      statuses[response.status] = (statuses[response.status] ?? 0) + 1
      await response.arrayBuffer()
    }
  } finally {
    await app.close()
  }
  return { statuses, refused: statuses[429] ?? 0 }
}

function withEnvironment(values: Record<string, string | undefined>, work: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  const put = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  Object.entries(values).forEach(([key, value]) => put(key, value))
  return work().finally(() => Object.entries(before).forEach(([key, value]) => put(key, value)))
}

/** Past the limit by a margin, so neither result is an off-by-one. */
const PAST_THE_LIMIT = UNAUTHENTICATED_REQUESTS_PER_WINDOW + 20

test.beforeEach(() => {
  storeCalls.length = 0
  tokenVerifications.length = 0
  rejectionCount.resetForTest()
})

// ---------------------------------------------------------------------------------------

test('POSITIVE CONTROL: with no Bearer header and a readable address, the route IS refused', async () => {
  // WITHOUT THIS, THE NEXT TEST PROVES NOTHING. A flood that is not refused could mean the
  // header caused the skip, or that this route is exempt by path, or that the address was
  // unreadable, or that enforcement was off. This fixes all four: same route, same app, same
  // settings, one header removed — and it is refused.
  await withEnvironment(
    { [RATE_LIMIT_ENFORCE_VARIABLE]: 'true', [TRUSTED_PROXY_HOPS_VARIABLE]: '0' },
    async () => {
      const result = await flood(PAST_THE_LIMIT, {})

      assert.ok(result.refused > 0, `the limiter must be able to see this route: ${JSON.stringify(result.statuses)}`)
      assert.equal(result.statuses[400], UNAUTHENTICATED_REQUESTS_PER_WINDOW,
        'exactly the window reaches the handler and is refused there; the rest are shed by the middleware')
    },
  )
})

test('THE GAP, MEASURED: any well-formed Bearer header reaches the handler unmetered', async () => {
  // The token is nonsense. It is never verified, because the route is `@Public()` — so this is
  // not an authentication bypass; it is a request that skips the address limiter by presenting
  // something the subject limiter will then never key on.
  await withEnvironment(
    { [RATE_LIMIT_ENFORCE_VARIABLE]: 'true', [TRUSTED_PROXY_HOPS_VARIABLE]: '0' },
    async () => {
      const result = await flood(PAST_THE_LIMIT, { authorization: 'Bearer not-a-real-token' })

      assert.equal(result.refused, 0, 'neither limiter refuses a single one of them')
      assert.equal(result.statuses[400], PAST_THE_LIMIT,
        'every request reaches the handler, and the handler is what refuses it')
      assert.deepEqual(tokenVerifications, [],
        '@Public() short-circuits the guard, so the token is never verified and no subject exists')
    },
  )
})

test('AND THE SHIPPED DEFAULT IS WIDER STILL: with no hop count stated, nothing is metered', async () => {
  // `clientAddress` returns null until the deployment states how much of X-Forwarded-For to
  // believe, which makes the address limiter inert for EVERY request — no header needed. That is
  // a deliberate choice recorded in `client-address.ts` (a shared key is an outage), not a
  // defect, and it is measured here because it widens what the handler has to survive.
  //
  // WHICH OF THESE TWO STATES PRODUCTION IS IN IS NOT ASSERTED HERE. Reading deployment
  // configuration is not mine to do, and the handler's bound has to hold in both.
  await withEnvironment(
    { [RATE_LIMIT_ENFORCE_VARIABLE]: 'true', [TRUSTED_PROXY_HOPS_VARIABLE]: undefined },
    async () => {
      const result = await flood(PAST_THE_LIMIT, {})

      assert.equal(result.refused, 0, 'inert without a stated hop count, with or without a token')
      assert.equal(result.statuses[400], PAST_THE_LIMIT)
    },
  )
})

test('SO THE BOUND IS THE HANDLER: a forged flood does no database work at all', async () => {
  // The conclusion the three results above lead to, asserted rather than argued. Not "the result
  // is small" — no lookup, no write, nothing an attacker can make the database do.
  await withEnvironment(
    { [RATE_LIMIT_ENFORCE_VARIABLE]: 'true', [TRUSTED_PROXY_HOPS_VARIABLE]: undefined },
    async () => {
      const result = await flood(PAST_THE_LIMIT, { authorization: 'Bearer not-a-real-token' })

      assert.equal(result.statuses[400], PAST_THE_LIMIT, 'all of them arrived')
      assert.deepEqual(storeCalls, [], 'and none of them reached the store')
      assert.equal(rejectionCount.read().SIGNATURE_INVALID, PAST_THE_LIMIT,
        'what is left is an integer in memory, one increment per request')
    },
  )
})

test('the limiter this test relies on is the one the application applies', async () => {
  // Guards the delegation above. If `AppModule` stopped applying the unauthenticated limiter,
  // the three results above would still be green and would mean something entirely different.
  const applied: unknown[] = []
  const routes: unknown[] = []
  const consumer = {
    apply: (...middleware: unknown[]) => {
      applied.push(...middleware)
      return { forRoutes: (...forRoutes: unknown[]) => { routes.push(...forRoutes); return consumer } }
    },
  }

  new AppModule().configure(consumer as never)

  assert.ok(applied.includes(UnauthenticatedRateLimitMiddleware), 'applied by the shipping module')
  assert.ok(applied.includes(RequestCorrelationMiddleware), 'and correlation still runs first')
  assert.equal(applied.indexOf(RequestCorrelationMiddleware), 0,
    'a refused request must still carry the X-Request-ID somebody will quote')
  assert.deepEqual(routes, ['*'], 'on every route, so this one is covered by the same wiring')
})
