// Test-only preload, mounted into an otherwise unmodified production image.
import assert from 'node:assert/strict'

const target = 'https://cron-smoke.invalid/api/internal/sync/due-tenants'
const secret = 'synthetic-cron-smoke-secret-not-a-real-credential'
let requests = 0
globalThis.fetch = async (url, options) => {
  requests += 1
  assert.equal(requests, 1, 'Cron must not retry')
  assert.equal(String(url), target)
  assert.equal(options.method, 'POST')
  assert.deepEqual(options.headers, { Accept: 'application/json', Authorization: `Bearer ${secret}` })
  assert.ok(options.signal instanceof AbortSignal)
  assert.equal(options.signal.aborted, false)
  assert.equal(options.body, undefined)
  if (process.env.CRON_SMOKE_SCENARIO === 'failure') {
    return new Response('PRIVATE_CRON_SENTINEL', { status: 503 })
  }
  assert.equal(process.env.CRON_SMOKE_SCENARIO, 'success')
  return Response.json({
    due: 2, succeeded: 1, partial: 1, failed: 0, skipped: 0,
    privateDebug: 'PRIVATE_CRON_SENTINEL',
  })
}
process.on('exit', () => {
  assert.equal(requests, 1, 'Packaged entrypoint must actually dispatch once')
  console.log('CRON_SMOKE_REQUESTS=1')
})
