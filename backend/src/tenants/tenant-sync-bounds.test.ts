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

test('scheduler-reachable runtime failure families log only closed identifiers', () => {
  const service = new TenantSyncService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any)
  const messages: string[] = []
  ;(service as any).logger = { warn: (message: string) => messages.push(message) }
  const hostile = 'org-123 tenant-456 group-name user@example.com contoso.example https://graph.example/request request-id access_token=secret eyJhbGciOiJub25lIn0 postgres://private'
  for (const [resource, phase] of [
    ['M365_AUDIT', 'INCREMENTAL'], ['LICENSES', 'INCREMENTAL'], ['DOMAINS', 'SNAPSHOT'],
    ['DOMAIN_DNS_HEALTH', 'SNAPSHOT'], ['GROUPS', 'RELATIONSHIP'], ['MFA_REGISTRATION', 'FALLBACK'],
    ['CONDITIONAL_ACCESS', 'FALLBACK'], ['SHAREPOINT_SITES', 'RECONCILIATION'],
  ] as const) {
    ;(service as any).logOperationalFailure(resource, phase, hostile)
    ;(service as any).logOperationalFailure(resource, phase, { hostile })
  }
  for (const message of messages) {
    const event = JSON.parse(message)
    assert.equal(event.event, 'microsoft_collection_runtime_failure')
    assert.equal(event.outcome, 'FAILED')
    assert.equal(message.includes('tenant-456'), false)
    assert.equal(message.includes('user@example.com'), false)
    assert.equal(message.includes('access_token'), false)
    assert.equal(message.includes('postgres://'), false)
  }
})

test('Graph streamed body matrix accepts cap boundaries and cancels every unsafe body', async () => {
  const valid = JSON.stringify({ value: [] })
  for (const size of [GRAPH_LOG_PAGE_MAX_BYTES - 1, GRAPH_LOG_PAGE_MAX_BYTES]) {
    let padding = 'x'.repeat(size - Buffer.byteLength(valid, 'utf8') - 14)
    let padded = JSON.stringify({ value: [], padding })
    padding += 'x'.repeat(Math.max(0, size - Buffer.byteLength(padded, 'utf8')))
    padded = JSON.stringify({ value: [], padding })
    assert.equal(Buffer.byteLength(padded, 'utf8'), size)
    await assert.doesNotReject(() => parseBoundedGraphCollectionPage(new Response(padded), 'sign-in logs'))
  }
  for (const kind of ['single', 'multi', 'understated'] as const) {
    let cancelled = false
    const stream = new ReadableStream({
      start(controller) {
        if (kind === 'multi') { controller.enqueue(new Uint8Array(GRAPH_LOG_PAGE_MAX_BYTES)); controller.enqueue(new Uint8Array(1)) }
        else controller.enqueue(new Uint8Array(GRAPH_LOG_PAGE_MAX_BYTES + 1))
      }, cancel() { cancelled = true },
    })
    const headers = kind === 'understated' ? { 'content-length': '1' } : undefined
    await assert.rejects(() => parseBoundedGraphCollectionPage(new Response(stream, { headers }), 'directory audit logs'), /unreadable bounded response/)
    assert.equal(cancelled, true)
  }
  let declaredCancelled = false
  const declared = new ReadableStream({ cancel() { declaredCancelled = true } })
  await assert.rejects(() => parseBoundedGraphCollectionPage(new Response(declared, { headers: { 'content-length': String(GRAPH_LOG_PAGE_MAX_BYTES + 1) } }), 'sign-in logs'), /unreadable bounded response/)
  assert.equal(declaredCancelled, true)
  await assert.rejects(() => parseBoundedGraphCollectionPage(new Response(new ReadableStream({ pull() { throw new Error('token=never') } })), 'directory audit logs'), /unreadable bounded response/)
})

test('actual sign-in and directory-audit collectors stop before every persistence boundary on a bounded page failure', async () => {
  const writes: string[] = []
  const prisma = {
    signInLog: { findFirst: async () => null, createMany: async () => writes.push('signIn') },
    directoryAuditLog: { findFirst: async () => null, createMany: async () => writes.push('audit') },
    syncState: { update: async () => writes.push('syncState') },
    tenantEntraSnapshot: { upsert: async () => writes.push('snapshot') },
    changeEvidenceEvent: { createMany: async () => writes.push('evidence') },
  }
  const service = new TenantSyncService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any)
  ;(service as any).runSnapshotSync = async (_tenant: unknown, _resource: unknown, work: () => Promise<void>) => work()
  ;(service as any).logSyncStart = async () => new Date()
  ;(service as any).signInEntitlement = async () => ({ status: 'AVAILABLE' })
  ;(service as any).fetchGraphCollection = async (_url: string, _token: string, resource: string) =>
    parseBoundedGraphCollectionPage(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(GRAPH_LOG_PAGE_MAX_BYTES + 1)) } })), resource)
  const tenant = { id: 'tenant-private', organizationId: 'org-private', microsoftTenantId: 'microsoft-private', displayName: null, primaryDomain: null, status: 'ACTIVE', connection: null }
  await assert.rejects(() => (service as any).syncSignInLogs(tenant, 'token'), /unreadable bounded response/)
  await assert.rejects(() => (service as any).syncDirectoryAuditLogs(tenant, 'token'), /unreadable bounded response/)
  assert.deepEqual(writes, [])
})
