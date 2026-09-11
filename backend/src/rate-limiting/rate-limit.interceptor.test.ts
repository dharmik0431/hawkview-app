import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpException } from '@nestjs/common'
import { RateLimitInterceptor } from './rate-limit.interceptor.js'
import { RateLimitStore } from './rate-limit.store.js'
import { SUBJECT_REQUESTS_PER_WINDOW } from './rate-limit-policy.js'
import { RATE_LIMIT_ENFORCE_VARIABLE } from './rate-limit-settings.js'

/** The subject limit at the point that actually runs.
 *
 * Separate from `rate-limit-policy.test.ts` on purpose. That file proves the
 * decision is right; this one proves the decision is the one being consulted. A
 * policy with a correct exemption and an interceptor that forgets to call it
 * would leave every assertion in that file passing.
 */

const HANDLED = Symbol('handled')
const next = { handle: () => HANDLED } as never

function requestFor(options: { path: string; subject?: string | null }) {
  return {
    path: options.path,
    url: options.path,
    originalUrl: options.path,
    headers: {} as Record<string, unknown>,
    socket: { remoteAddress: '10.0.0.1' },
    ...(options.subject === undefined || options.subject === null
      ? {}
      : { auth: { subject: options.subject } }),
  }
}

function contextFor(request: Record<string, unknown>) {
  const headers: Record<string, string> = {}
  const response = { setHeader: (name: string, value: string) => { headers[name] = value } }
  return {
    headers,
    context: {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as never,
  }
}

/** Runs `count` requests and reports how many were refused. */
function drive(
  interceptor: RateLimitInterceptor,
  request: Record<string, unknown>,
  count: number,
) {
  let refused = 0
  let passed = 0
  let lastRetryAfter: string | undefined
  for (let index = 0; index < count; index += 1) {
    const { context, headers } = contextFor(request)
    try {
      const result = interceptor.intercept(context, next)
      assert.equal(result, HANDLED)
      passed += 1
    } catch (error) {
      assert.ok(error instanceof HttpException)
      assert.equal(error.getStatus(), 429)
      lastRetryAfter = headers['Retry-After']
      refused += 1
    }
  }
  return { refused, passed, lastRetryAfter }
}

const interceptor = () => new RateLimitInterceptor(new RateLimitStore())

test('an authenticated caller is allowed up to the limit and then refused', () => {
  const subject = interceptor()
  const request = requestFor({ path: '/api/tenants/t1', subject: 'auth0|operator' })

  const within = drive(subject, request, SUBJECT_REQUESTS_PER_WINDOW)
  assert.equal(within.refused, 0, 'nothing within the limit may be refused')

  const beyond = drive(subject, request, 5)
  assert.equal(beyond.refused, 5)
  assert.equal(beyond.passed, 0)
  // A refusal has to tell the caller when to come back, or a well-behaved client
  // cannot behave well.
  assert.ok(Number(beyond.lastRetryAfter) >= 1)
})

test('THE HEARTBEAT SURVIVES A FLOOD THAT WOULD REFUSE ANY OTHER ROUTE', () => {
  // The failure PM asked to be got right, reproduced at the enforcement point
  // rather than argued about. One refusal here stops all collection, silently,
  // and looks exactly like a product with nothing new to report.
  const subject = interceptor()
  const heartbeat = requestFor({ path: '/api/internal/sync/due-tenants', subject: 'scheduler' })

  const flood = drive(subject, heartbeat, SUBJECT_REQUESTS_PER_WINDOW * 3)
  assert.equal(flood.refused, 0, 'the heartbeat must never be refused')
  assert.equal(flood.passed, SUBJECT_REQUESTS_PER_WINDOW * 3)

  // POSITIVE CONTROL, ON THE SAME INTERCEPTOR AND THE SAME SUBJECT: an ordinary
  // route is refused. Without this the result above would also hold for an
  // interceptor that enforces nothing, which is the shape of a rate limiter that
  // appears to work and does not.
  const ordinary = requestFor({ path: '/api/tenants/t1', subject: 'scheduler' })
  const refusedSomewhere = drive(subject, ordinary, SUBJECT_REQUESTS_PER_WINDOW + 5)
  assert.ok(refusedSomewhere.refused > 0, 'the control must actually be capable of refusing')
})

test('health probes are never refused either', () => {
  // Refusing a probe does not throttle anyone; it convinces the platform the
  // service is unhealthy and takes it out of rotation.
  const subject = interceptor()
  for (const path of ['/health', '/health/database']) {
    const flood = drive(subject, requestFor({ path, subject: 'probe' }), 500)
    assert.equal(flood.refused, 0, path + ' must never be refused')
  }
})

test('one caller exhausting its allowance does not refuse anybody else', () => {
  // The reason the key is the subject. If a limit could be spent on someone
  // else's behalf it would be an attack rather than a protection.
  const subject = interceptor()
  drive(subject, requestFor({ path: '/api/tenants/t1', subject: 'auth0|noisy' }), SUBJECT_REQUESTS_PER_WINDOW + 10)

  const colleague = drive(subject, requestFor({ path: '/api/tenants/t1', subject: 'auth0|quiet' }), 10)
  assert.equal(colleague.refused, 0)
})

test('an unauthenticated request is left to the middleware, not refused here', () => {
  // With no verified subject there is nothing this interceptor may key on. It
  // must pass the request along rather than inventing a bucket.
  const subject = interceptor()
  const flood = drive(subject, requestFor({ path: '/api/tenants/t1', subject: null }), 1_000)
  assert.equal(flood.refused, 0)
})

test('enforcement can be switched off without a deploy', () => {
  const before = process.env[RATE_LIMIT_ENFORCE_VARIABLE]
  process.env[RATE_LIMIT_ENFORCE_VARIABLE] = 'false'
  try {
    const subject = interceptor()
    const flood = drive(subject, requestFor({ path: '/api/tenants/t1', subject: 'auth0|operator' }), SUBJECT_REQUESTS_PER_WINDOW + 50)
    assert.equal(flood.refused, 0)
  } finally {
    if (before === undefined) delete process.env[RATE_LIMIT_ENFORCE_VARIABLE]
    else process.env[RATE_LIMIT_ENFORCE_VARIABLE] = before
  }

  // POSITIVE CONTROL: with the variable back to its default the same traffic IS
  // refused, so the pass above is the switch and not the fixture.
  const subject = interceptor()
  const flood = drive(subject, requestFor({ path: '/api/tenants/t1', subject: 'auth0|operator' }), SUBJECT_REQUESTS_PER_WINDOW + 50)
  assert.ok(flood.refused > 0)
})

test('a non-http execution context is passed through untouched', () => {
  const subject = interceptor()
  const nonHttp = { getType: () => 'rpc' } as never
  assert.equal(subject.intercept(nonHttp, next), HANDLED)
})
