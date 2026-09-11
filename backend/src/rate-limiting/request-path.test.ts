import assert from 'node:assert/strict'
import test from 'node:test'
import { requestPath } from './request-path.js'
import { isExemptPath } from './rate-limit-policy.js'

/** The field that means what it says at every layer. */

test('originalUrl wins, because it is the only one a mount does not rewrite', () => {
  // THE DEFECT, AS A TEST. This is exactly what Express hands a middleware
  // registered with forRoutes('*'): the mount path stripped from url and path,
  // the real path surviving only in originalUrl. Measured in the assembled app,
  // not imagined.
  const mounted = { path: '/', url: '/', originalUrl: '/api/internal/sync/due-tenants' }
  assert.equal(requestPath(mounted), '/api/internal/sync/due-tenants')

  // And the consequence that matters: the exemption matches again.
  assert.equal(isExemptPath(requestPath(mounted)), 'SCHEDULER_HEARTBEAT')

  // POSITIVE CONTROL, which is the whole reason this file exists: reading `path`
  // from that same request yields "/", which matches no exemption at all. That is
  // how the heartbeat came to be refused while every unit test passed.
  assert.equal(isExemptPath(mounted.path), null)
})

test('a health probe through a mount is still recognised', () => {
  assert.equal(
    isExemptPath(requestPath({ path: '/', url: '/', originalUrl: '/health' })),
    'HEALTH_PROBE')
})

test('a query string rides along and is stripped by the policy, not here', () => {
  // Kept deliberately: this function answers "what did the caller ask for", and
  // normalizing is the policy's job so that there is one place doing it.
  const withQuery = { path: '/', url: '/', originalUrl: '/health?probe=1' }
  assert.equal(requestPath(withQuery), '/health?probe=1')
  assert.equal(isExemptPath(requestPath(withQuery)), 'HEALTH_PROBE')
})

test('it falls back in order of trustworthiness rather than failing', () => {
  assert.equal(requestPath({ path: '/p', url: '/u', originalUrl: '' }), '/u')
  assert.equal(requestPath({ path: '/p', url: '', originalUrl: '' }), '/p')
  // Nothing at all still yields a path the policy can reason about, rather than
  // an empty string that matches nothing and silently enforces on everything.
  assert.equal(requestPath({ path: '', url: '', originalUrl: '' }), '/')
})
