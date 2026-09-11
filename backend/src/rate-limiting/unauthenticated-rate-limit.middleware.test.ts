import assert from 'node:assert/strict'
import test from 'node:test'
import { RateLimitStore } from './rate-limit.store.js'
import { UNAUTHENTICATED_REQUESTS_PER_WINDOW } from './rate-limit-policy.js'
import { TRUSTED_PROXY_HOPS_VARIABLE } from './rate-limit-settings.js'
import { UnauthenticatedRateLimitMiddleware } from './unauthenticated-rate-limit.middleware.js'

/** The address limit, and the fact that it is inert until told how to read an
 * address. */

function driveMiddleware(
  middleware: UnauthenticatedRateLimitMiddleware,
  options: { path: string; forwardedFor?: string; authorization?: string },
  count: number,
) {
  let refused = 0
  let passed = 0
  let lastStatus: number | undefined
  let lastRetryAfter: string | undefined

  for (let index = 0; index < count; index += 1) {
    const headers: Record<string, unknown> = {}
    if (options.forwardedFor !== undefined) headers['x-forwarded-for'] = options.forwardedFor
    if (options.authorization !== undefined) headers.authorization = options.authorization

    // THE SHAPE EXPRESS ACTUALLY DELIVERS to a middleware mounted on '*': the
    // mount path is stripped from url and path, and only originalUrl survives.
    // Measured in the assembled app. The earlier fixture set path to the real
    // path, described a request that does not occur, and so could not see the
    // defect where both exemptions silently stopped matching.
    const request = { path: '/', url: '/', originalUrl: options.path, headers, socket: { remoteAddress: '10.0.0.1' } }
    const response = {
      setHeader: (name: string, value: string) => { if (name === 'Retry-After') lastRetryAfter = value },
      status: (code: number) => { lastStatus = code; return { json: () => undefined } },
    }
    let continued = false
    middleware.use(request as never, response as never, () => { continued = true })
    if (continued) passed += 1
    else refused += 1
  }
  return { refused, passed, lastStatus, lastRetryAfter }
}

const middleware = () => new UnauthenticatedRateLimitMiddleware(new RateLimitStore())

function withHops(hops: string | undefined, work: () => void) {
  const before = process.env[TRUSTED_PROXY_HOPS_VARIABLE]
  if (hops === undefined) delete process.env[TRUSTED_PROXY_HOPS_VARIABLE]
  else process.env[TRUSTED_PROXY_HOPS_VARIABLE] = hops
  try { work() } finally {
    if (before === undefined) delete process.env[TRUSTED_PROXY_HOPS_VARIABLE]
    else process.env[TRUSTED_PROXY_HOPS_VARIABLE] = before
  }
}

test('with no trusted hop count stated, nothing is refused', () => {
  // THE SHIPPED DEFAULT, ASSERTED RATHER THAN ASSUMED. Until the deployment says
  // how much of X-Forwarded-For to believe, every request resolves to the same
  // unknown address — so enforcing would refuse the whole world from one bucket.
  // Inert is the deliberate choice, and this is what it looks like.
  withHops(undefined, () => {
    const flood = driveMiddleware(
      middleware(),
      { path: '/api/tenants/t1', forwardedFor: '198.51.100.23' },
      UNAUTHENTICATED_REQUESTS_PER_WINDOW * 3)
    assert.equal(flood.refused, 0)
  })
})

test('with a hop count stated, an unauthenticated flood from one address IS refused', () => {
  // THE POSITIVE CONTROL FOR THE TEST ABOVE, and the proof that the code is
  // complete rather than absent: the limit works the moment it is configured.
  withHops('1', () => {
    const subject = middleware()
    const within = driveMiddleware(
      subject, { path: '/api/tenants/t1', forwardedFor: '198.51.100.23' },
      UNAUTHENTICATED_REQUESTS_PER_WINDOW)
    assert.equal(within.refused, 0)

    const beyond = driveMiddleware(
      subject, { path: '/api/tenants/t1', forwardedFor: '198.51.100.23' }, 3)
    assert.equal(beyond.refused, 3)
    assert.equal(beyond.lastStatus, 429)
    assert.ok(Number(beyond.lastRetryAfter) >= 1)
  })
})

test('a caller cannot escape its bucket by varying the header it sends', () => {
  // The proxy appends what it saw; the entries to the left are the caller's own
  // claim. If those counted, a flood would get a fresh allowance per request.
  withHops('1', () => {
    const subject = middleware()
    let refused = 0
    for (let index = 0; index < UNAUTHENTICATED_REQUESTS_PER_WINDOW + 20; index += 1) {
      const result = driveMiddleware(
        subject,
        { path: '/api/tenants/t1', forwardedFor: `10.9.9.${index % 200}, 198.51.100.23` },
        1)
      refused += result.refused
    }
    assert.ok(refused > 0, 'varying the claimed address must not mint new allowances')
  })
})

test('THE HEARTBEAT IS NOT REFUSED HERE EITHER, however hard it is hit', () => {
  // The scheduler presents a bearer token, so it is skipped on that ground too —
  // but the exemption must not depend on that. If the token were ever absent or
  // reshaped, the route still must not be refused, because the consequence is
  // collection stopping with nothing to see.
  withHops('1', () => {
    const flood = driveMiddleware(
      middleware(),
      { path: '/api/internal/sync/due-tenants', forwardedFor: '198.51.100.23' },
      UNAUTHENTICATED_REQUESTS_PER_WINDOW * 5)
    assert.equal(flood.refused, 0)

    // POSITIVE CONTROL on the same configuration: another route from the same
    // address is refused, so the pass above is the exemption rather than an
    // inert limiter.
    const ordinary = driveMiddleware(
      middleware(), { path: '/api/tenants/t1', forwardedFor: '198.51.100.23' },
      UNAUTHENTICATED_REQUESTS_PER_WINDOW + 5)
    assert.ok(ordinary.refused > 0)
  })
})

test('health probes are exempt here too', () => {
  withHops('1', () => {
    const flood = driveMiddleware(
      middleware(), { path: '/health', forwardedFor: '198.51.100.23' },
      UNAUTHENTICATED_REQUESTS_PER_WINDOW * 3)
    assert.equal(flood.refused, 0)
  })
})

test('a request carrying a bearer token is left for the subject limit', () => {
  // Metering it here as well would meter authenticated traffic by ADDRESS before
  // the subject is known, and an MSP office is many operators behind one address.
  withHops('1', () => {
    const flood = driveMiddleware(
      middleware(),
      { path: '/api/tenants/t1', forwardedFor: '198.51.100.23', authorization: 'Bearer a-token' },
      UNAUTHENTICATED_REQUESTS_PER_WINDOW * 3)
    assert.equal(flood.refused, 0)

    // POSITIVE CONTROL: the same address WITHOUT a token is refused, so the pass
    // above is the token and not the address being unreadable.
    const anonymous = driveMiddleware(
      middleware(), { path: '/api/tenants/t1', forwardedFor: '198.51.100.23' },
      UNAUTHENTICATED_REQUESTS_PER_WINDOW + 5)
    assert.ok(anonymous.refused > 0)
  })
})

test('a malformed authorization header is treated as no token at all', () => {
  // It will be refused by the guard, so it is unauthenticated traffic and is
  // metered as such. Only the shape the guard accepts earns the skip.
  withHops('1', () => {
    const flood = driveMiddleware(
      middleware(),
      { path: '/api/tenants/t1', forwardedFor: '198.51.100.23', authorization: 'Basic abc' },
      UNAUTHENTICATED_REQUESTS_PER_WINDOW + 5)
    assert.ok(flood.refused > 0)
  })
})
