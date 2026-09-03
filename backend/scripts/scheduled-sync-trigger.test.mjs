import assert from 'node:assert/strict'
import test from 'node:test'
import { runScheduledSync, SCHEDULED_SYNC_RESPONSE_MAX_BYTES, summarizeScheduledSyncResult } from './scheduled-sync-trigger.mjs'

const options = { targetUrl: 'https://api.example.test/api/internal/sync/due-tenants', sharedSecret: 'x'.repeat(32), timeoutMs: 100 }

test('returns the API result after exactly one request', async () => {
  let calls = 0
  const result = await runScheduledSync({ ...options, fetchImpl: async () => {
    calls += 1
    return new Response(JSON.stringify({ succeeded: 1 }), { status: 200 })
  } })
  assert.deepEqual(result, { succeeded: 1 })
  assert.equal(calls, 1)
})

test('does not retry any HTTP failure', async () => {
  for (const status of [400, 401, 403, 429, 500, 502, 503, 504]) {
    let calls = 0
    await assert.rejects(() => runScheduledSync({ ...options, fetchImpl: async () => { calls += 1; return new Response('private response', { status }) } }), /HTTP/)
    assert.equal(calls, 1)
  }
})

test('does not retry transient transport failures', async () => {
  let calls = 0
  await assert.rejects(() => runScheduledSync({ ...options, fetchImpl: async () => { calls += 1; throw new TypeError('network unavailable') } }), /could not reach/)
  assert.equal(calls, 1)
})

test('failure text never includes the response body or scheduler secret', async () => {
  await assert.rejects(() => runScheduledSync({ ...options, fetchImpl: async () => new Response('access_token=never', { status: 503 }) }), (error) => {
    assert.equal(String(error).includes('access_token=never'), false)
    assert.equal(String(error).includes(options.sharedSecret), false)
    return true
  })
})

test('bounds streamed responses and maps body failures to fixed safe codes', async () => {
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(SCHEDULED_SYNC_RESPONSE_MAX_BYTES + 1)) },
    cancel() { cancelled = true },
  })
  await assert.rejects(() => runScheduledSync({ ...options, fetchImpl: async () => new Response(stream) }), /SCHEDULER_RESPONSE_(TOO_LARGE|READ_FAILED)/)
  assert.equal(cancelled, true)
  await assert.rejects(() => runScheduledSync({ ...options, fetchImpl: async () => new Response(new ReadableStream({ pull() { throw new Error('access_token=never') } })) }), (error) => {
    assert.equal(String(error).includes('access_token=never'), false)
    assert.match(String(error), /SCHEDULER_RESPONSE_READ_FAILED/)
    return true
  })
})

test('success output summary is aggregate-only', () => {
  assert.deepEqual(summarizeScheduledSyncResult({ due: 2, succeeded: 1, partial: 1, results: [{ tenantId: 'private', microsoftTenantId: 'private' }], error: 'private' }), {
    outcome: 'COMPLETED', due: 2, succeeded: 1, partial: 1, failed: 0, skipped: 0,
  })
})
