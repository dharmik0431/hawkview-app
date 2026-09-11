import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HEALTH_PATH_PREFIX,
  SCHEDULER_PATH_PREFIX,
  SUBJECT_REQUESTS_PER_WINDOW,
  UNAUTHENTICATED_REQUESTS_PER_WINDOW,
  isExemptPath,
  normalizePath,
  planFor,
} from './rate-limit-policy.js'

/** The policy, which is the part of rate limiting that can break the product. */

const HEARTBEAT = '/api/internal/sync/due-tenants'

test('NO input makes the scheduler heartbeat enforceable', () => {
  // THE ASSERTION THIS FILE EXISTS FOR, written as a sweep rather than one case,
  // because the risk is not that the obvious call is wrong — it is that some
  // combination nobody pictured falls through to a counter. One request every
  // five minutes causes all collection; refusing it stops collection with no
  // error on any screen, which is indistinguishable from the product simply
  // having nothing new to say.
  const subjects = [null, '', 'auth0|operator', 'x'.repeat(500)]
  const addresses = [null, '', '198.51.100.23', '10.0.0.1']
  const paths = [
    HEARTBEAT,
    HEARTBEAT + '/',
    HEARTBEAT.toUpperCase(),
    HEARTBEAT + '?trigger=cron',
    SCHEDULER_PATH_PREFIX,
    SCHEDULER_PATH_PREFIX + '/some-future-internal-route',
  ]

  let checked = 0
  for (const enforce of [true, false]) {
    for (const subject of subjects) {
      for (const clientAddress of addresses) {
        for (const path of paths) {
          const plan = planFor({ path, subject, clientAddress }, { enforce })
          assert.equal(plan.enforce, false, 'the heartbeat must never be enforced: ' + path)
          assert.equal(
            plan.enforce === false && plan.because,
            'SCHEDULER_HEARTBEAT',
            'and it must say why, before any other reason applies: ' + path)
          checked += 1
        }
      }
    }
  }

  // The sweep actually ran. Without this the loops could have iterated zero
  // times and the test would report success having asserted nothing — the
  // vacuity this codebase has been bitten by repeatedly.
  assert.equal(checked, 2 * subjects.length * addresses.length * paths.length)
  assert.ok(checked > 0)

  // POSITIVE CONTROL: the SAME inputs on an ordinary route ARE enforced. Without
  // it, everything above would also pass against a policy that enforces nothing
  // at all, which is precisely how a rate limiter can appear to work.
  const ordinary = planFor(
    { path: '/api/tenants/t1/risky-users/assessment', subject: 'auth0|operator', clientAddress: null },
    { enforce: true })
  assert.equal(ordinary.enforce, true)
})

test('health probes are exempt, and a route that merely starts alike is not', () => {
  // Refusing a probe does not slow an attacker down; it tells the platform the
  // service is unhealthy and removes it from rotation.
  assert.equal(isExemptPath(HEALTH_PATH_PREFIX), 'HEALTH_PROBE')
  assert.equal(isExemptPath('/health/database'), 'HEALTH_PROBE')

  // Prefix precision. A future admin route whose name happens to begin with the
  // same letters must not inherit an exemption.
  assert.equal(isExemptPath('/healthcheck-admin'), null)
  assert.equal(isExemptPath('/api/internal/syncing-secrets'), null)
})

test('an exemption cannot be sidestepped, or gained, by spelling', () => {
  assert.equal(normalizePath('/Health/'), '/health')
  assert.equal(normalizePath('health'), '/health')
  assert.equal(normalizePath('/health?probe=1'), '/health')
  assert.equal(normalizePath('/health#fragment'), '/health')
  assert.equal(normalizePath('/health///'), '/health')
  assert.equal(normalizePath('/'), '/')
  assert.equal(normalizePath(''), '/')
})

test('an authenticated subject is preferred over the address it came from', () => {
  // An MSP office is many operators behind one NAT. Keyed on the address, a busy
  // afternoon in a ten-person office is indistinguishable from one abusive
  // caller, and all ten are refused together.
  const plan = planFor(
    { path: '/api/tenants/t1', subject: 'auth0|operator', clientAddress: '198.51.100.23' },
    { enforce: true })
  assert.equal(plan.enforce, true)
  assert.equal(plan.enforce === true && plan.bucket, 'SUBJECT')
  assert.equal(plan.enforce === true && plan.key, 'subject:auth0|operator')

  // Two operators sharing one address are two buckets.
  const colleague = planFor(
    { path: '/api/tenants/t1', subject: 'auth0|colleague', clientAddress: '198.51.100.23' },
    { enforce: true })
  assert.notEqual(plan.enforce === true && plan.key, colleague.enforce === true && colleague.key)
})

test('a request with no identity falls to its address', () => {
  const plan = planFor(
    { path: '/api/tenants/t1', subject: null, clientAddress: '198.51.100.23' },
    { enforce: true })
  assert.equal(plan.enforce, true)
  assert.equal(plan.enforce === true && plan.bucket, 'UNAUTHENTICATED')
  assert.equal(plan.enforce === true && plan.key, 'address:198.51.100.23')
})

test('no identity and no knowable address enforces NOTHING, rather than one shared bucket', () => {
  // THE OUTAGE NOT TAKEN. With no trusted hop count configured every request
  // resolves to the same unknown address, so enforcing here would mean a single
  // bucket for the entire internet plus every customer — a per-caller limit that
  // is actually a global one, which is how a limiter takes an API down while
  // every test still passes.
  const plan = planFor(
    { path: '/api/tenants/t1', subject: null, clientAddress: null },
    { enforce: true })
  assert.equal(plan.enforce, false)
  assert.equal(plan.enforce === false && plan.because, 'NO_TRUSTED_CLIENT_ADDRESS')
  // And no key was minted, so there is nothing for a counter to land on.
  assert.equal('key' in plan, false)
})

test('enforcement can be switched off entirely, and says so', () => {
  // The operator escape hatch. If this component is ever suspected of refusing
  // real traffic, it must be removable without a code change and without
  // guessing which limit misfired.
  const plan = planFor(
    { path: '/api/tenants/t1', subject: 'auth0|operator', clientAddress: '198.51.100.23' },
    { enforce: false })
  assert.equal(plan.enforce, false)
  assert.equal(plan.enforce === false && plan.because, 'ENFORCEMENT_DISABLED')

  // POSITIVE CONTROL: the same request with enforcement on is enforced, so the
  // switch is what did this rather than the request being exempt anyway.
  const on = planFor(
    { path: '/api/tenants/t1', subject: 'auth0|operator', clientAddress: '198.51.100.23' },
    { enforce: true })
  assert.equal(on.enforce, true)
})

test('the limits keep the headroom they were derived from', () => {
  // Guarding the derivation, not the number. Six requests per tenant page and
  // about sixty a minute for brisk browsing were measured; a limit within the
  // same order of magnitude as real use is one that will interrupt real work.
  const measuredBrowsingPerMinute = 60
  assert.ok(
    SUBJECT_REQUESTS_PER_WINDOW >= measuredBrowsingPerMinute * 10,
    'the per-subject limit must stay an order of magnitude above measured browsing')
  assert.ok(
    UNAUTHENTICATED_REQUESTS_PER_WINDOW < SUBJECT_REQUESTS_PER_WINDOW,
    'an unauthenticated caller must not get the allowance an authenticated one does')
})
