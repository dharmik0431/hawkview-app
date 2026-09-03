import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertGraphCollectionBounds,
  GRAPH_LOG_COLLECTION_DEADLINE_MS,
  GRAPH_LOG_COLLECTION_MAX_PAGES,
  GRAPH_LOG_COLLECTION_MAX_ROWS,
  GRAPH_LOG_PAGE_MAX_BYTES,
  MAILBOX_USAGE_CSV_MAX_BYTES,
  MAILBOX_USAGE_CSV_MAX_COLUMNS,
  MAILBOX_USAGE_CSV_MAX_ROWS,
  parseBoundedGraphCollectionPage,
  parseCsvRows,
  TenantSyncService,
} from './tenant-sync.service.js'

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

test('Graph collection page, row, repeat and deadline boundaries fail closed only past their limits', () => {
  const deadline = Date.now() + GRAPH_LOG_COLLECTION_DEADLINE_MS
  assert.doesNotThrow(() => assertGraphCollectionBounds({ pageCount: GRAPH_LOG_COLLECTION_MAX_PAGES, rowCount: GRAPH_LOG_COLLECTION_MAX_ROWS, url: 'https://graph.microsoft.com/ok', seenUrls: new Set(), deadlineAt: deadline }))
  for (const input of [
    { pageCount: GRAPH_LOG_COLLECTION_MAX_PAGES + 1, rowCount: 0, url: 'https://graph.microsoft.com/ok', seenUrls: new Set<string>(), deadlineAt: deadline },
    { pageCount: 1, rowCount: GRAPH_LOG_COLLECTION_MAX_ROWS + 1, url: 'https://graph.microsoft.com/ok', seenUrls: new Set<string>(), deadlineAt: deadline },
    { pageCount: 1, rowCount: 0, url: 'https://graph.microsoft.com/repeat', seenUrls: new Set<string>(['https://graph.microsoft.com/repeat']), deadlineAt: deadline },
    { pageCount: 1, rowCount: 0, url: 'https://graph.microsoft.com/ok', seenUrls: new Set<string>(), deadlineAt: Date.now() - 1 },
  ]) assert.throws(() => assertGraphCollectionBounds(input), /bounded collection limit/)
})

test('mailbox CSV byte, row and column limits accept exact values and reject plus one', () => {
  assert.ok(GRAPH_LOG_PAGE_MAX_BYTES < 8 * 1024 * 1024)
  assert.doesNotThrow(() => parseCsvRows('a'.repeat(MAILBOX_USAGE_CSV_MAX_BYTES)))
  assert.throws(() => parseCsvRows('a'.repeat(MAILBOX_USAGE_CSV_MAX_BYTES + 1)), /response-size/)
  const header = Array.from({ length: MAILBOX_USAGE_CSV_MAX_COLUMNS }, (_, i) => `h${i}`).join(',')
  const row = Array.from({ length: MAILBOX_USAGE_CSV_MAX_COLUMNS }, (_, i) => `v${i}`).join(',')
  assert.doesNotThrow(() => parseCsvRows(`${header}\n${row}`))
  assert.throws(() => parseCsvRows(`${header},extra\n${row},extra`), /row or column/)
  const small = 'h\nv'
  assert.doesNotThrow(() => parseCsvRows([small, ...Array.from({ length: MAILBOX_USAGE_CSV_MAX_ROWS - 2 }, () => 'v')].join('\n')))
  assert.throws(() => parseCsvRows([small, ...Array.from({ length: MAILBOX_USAGE_CSV_MAX_ROWS - 1 }, () => 'v')].join('\n')), /row or column/)
})

test('Exchange initial sync-state failure closes the anonymous telemetry lifecycle before collection work', async () => {
  const hostile = 'token=never user@example.com contoso.example https://secret.example/path'
  let workCalls = 0
  const service = new TenantSyncService({
    syncState: { upsert: async () => { throw new Error(hostile) } },
  } as any, {} as any, {} as any, {} as any, {} as any, {} as any)
  const messages: string[] = []
  ;(service as any).logger = { log: (message: string) => messages.push(message), warn: (message: string) => messages.push(message) }
  await assert.rejects(
    () => (service as any).runSnapshotSync({ id: 'tenant-private', organizationId: 'org-private' }, 'EXCHANGE_MAILBOX_CONFIGURATION', async () => { workCalls += 1 }),
    /token=never/,
  )
  assert.equal(workCalls, 0)
  assert.equal(messages.length, 2)
  assert.equal(JSON.parse(messages[0]!).outcome, 'STARTED')
  assert.equal(JSON.parse(messages[1]!).outcome, 'FAILED')
  assert.equal(messages.join('\n').includes('tenant-private'), false)
  assert.equal(messages.join('\n').includes(hostile), false)
})
