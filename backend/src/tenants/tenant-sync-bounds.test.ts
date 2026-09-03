import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBoundedGraphCollectionPage } from './tenant-sync.service.js'

test('an eight-megabyte Graph sign-in or audit page is cancelled before JSON parsing', async () => {
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024)) },
    cancel() { cancelled = true },
  })
  await assert.rejects(
    () => parseBoundedGraphCollectionPage(new Response(stream), 'sign-in logs'),
    /unreadable bounded response/,
  )
  assert.equal(cancelled, true)
})

test('a bounded Graph collection page parses only valid value arrays', async () => {
  const page = await parseBoundedGraphCollectionPage(new Response(JSON.stringify({ value: [{ id: 'safe' }] })), 'directory audit logs')
  assert.deepEqual(page.value, [{ id: 'safe' }])
})
