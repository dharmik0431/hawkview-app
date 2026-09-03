import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  assertGraphCollectionBounds,
  GRAPH_LOG_COLLECTION_DEADLINE_MS,
  GRAPH_LOG_COLLECTION_MAX_PAGES,
  GRAPH_LOG_COLLECTION_MAX_ROWS,
  GRAPH_LOG_COLLECTION_MAX_MATERIALIZED_BYTES,
  GRAPH_LOG_PAGE_MAX_BYTES,
  MAILBOX_USAGE_CSV_MAX_BYTES,
  MAILBOX_USAGE_CSV_MAX_COLUMNS,
  MAILBOX_USAGE_CSV_MAX_ROWS,
  parseBoundedGraphCollectionPage,
  parseCsvRows,
  parseMailboxUsageCsv,
  settleSyncCollectorModules,
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

test('Graph log collection has a cumulative retained-payload ceiling before persistence', async () => {
  assert.ok(GRAPH_LOG_COLLECTION_MAX_MATERIALIZED_BYTES <= 8 * 1024 * 1024)
  const service = new TenantSyncService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any)
  const maximum = 32
  const exactValue = { padding: 'x'.repeat(maximum - Buffer.byteLength(JSON.stringify({ padding: '' }), 'utf8')) }
  assert.equal(Buffer.byteLength(JSON.stringify(exactValue), 'utf8'), maximum)
  ;(service as any).fetchGraphPage = async () => new Response(JSON.stringify({ value: [exactValue] }))
  await assert.doesNotReject(
    () => (service as any).fetchGraphCollection('https://graph.microsoft.com/v1.0/start', 'token', 'sign-in logs', maximum),
  )
  ;(service as any).fetchGraphPage = async () => new Response(JSON.stringify({
    value: [{ ...exactValue, padding: `${exactValue.padding}x` }],
  }))
  await assert.rejects(
    () => (service as any).fetchGraphCollection('https://graph.microsoft.com/v1.0/start', 'token', 'sign-in logs', maximum),
    /unreadable bounded response/,
  )
})

test('full-sync collector schedule serializes heavy Graph logs while safe work remains concurrent', async () => {
  let signInActive = false
  let auditActive = false
  let safeStartedDuringSignIn = false
  let releaseSignIn!: () => void
  const signInCanFinish = new Promise<void>((resolve) => { releaseSignIn = resolve })
  const order: string[] = []
  const results = await settleSyncCollectorModules([
    {
      resource: 'SIGN_INS',
      synchronize: async () => {
        assert.equal(auditActive, false)
        signInActive = true
        order.push('sign-in:start')
        await signInCanFinish
        signInActive = false
        order.push('sign-in:end')
      },
    },
    {
      resource: 'AUDIT_LOGS',
      synchronize: async () => {
        assert.equal(signInActive, false)
        auditActive = true
        order.push('audit:start')
        auditActive = false
      },
    },
    {
      resource: 'M365_AUDIT',
      synchronize: async () => {
        safeStartedDuringSignIn = signInActive
        order.push('safe:start')
        releaseSignIn()
      },
    },
  ])
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled', 'fulfilled'])
  assert.equal(safeStartedDuringSignIn, true)
  assert.ok(order.indexOf('sign-in:end') < order.indexOf('audit:start'))

  const afterFailure: string[] = []
  const failureResults = await settleSyncCollectorModules([
    { resource: 'SIGN_INS', synchronize: async () => { afterFailure.push('sign-in'); throw new Error('bounded failure') } },
    { resource: 'AUDIT_LOGS', synchronize: async () => { afterFailure.push('audit') } },
  ])
  assert.deepEqual(afterFailure, ['sign-in', 'audit'])
  assert.deepEqual(failureResults.map((result) => result.status), ['rejected', 'fulfilled'])
})

test('the actual full tenant sync uses the serialized heavy-collector schedule', async () => {
  const prisma: any = {
    syncState: {
      findUnique: async () => ({ id: 'users-state', lastSuccessfulAt: new Date(), deltaLink: null }),
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
      findMany: async () => [],
    },
    tenantConnection: { update: async () => ({}) },
    $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
  }
  const microsoftConsent = { getTenantAccessToken: async () => 'token' }
  const notifications = { publishIncident: async () => undefined }
  const service = new TenantSyncService(prisma, microsoftConsent as any, {} as any, notifications as any, {} as any, {} as any)
  ;(service as any).synchronizeUsers = async () => ({ deltaLink: 'next-delta' })
  for (const method of [
    'syncLicenses', 'syncOrganizationConfiguration', 'syncDomains', 'syncGroups',
    'syncSharePointSites', 'syncSharePointSettings', 'syncSharePointUsage',
    'syncExchangeMailboxDirectory', 'syncExchangeMailboxSettings',
    'syncExchangeAcceptedDomains', 'syncExchangeMailboxUsage',
    'syncExchangeMailboxRules', 'syncDomainDnsHealth',
    'syncAuthenticationRegistrations', 'syncAuthenticationMethodPolicy',
    'syncM365AuditActivity', 'syncSecurityDefaults', 'refreshCollectionFieldStates',
  ]) (service as any)[method] = async () => undefined

  let signInActive = false
  let safeStartedDuringSignIn = false
  let releaseSignIn!: () => void
  const signInCanFinish = new Promise<void>((resolve) => { releaseSignIn = resolve })
  ;(service as any).syncSignInLogs = async () => {
    signInActive = true
    await signInCanFinish
    signInActive = false
  }
  ;(service as any).syncDirectoryAuditLogs = async () => {
    assert.equal(signInActive, false)
  }
  let safeReleased = false
  ;(service as any).syncEntraCollection = async () => {
    if (!safeReleased) {
      safeReleased = true
      safeStartedDuringSignIn = signInActive
      releaseSignIn()
    }
  }
  const tenant = {
    id: 'tenant-private', organizationId: 'org-private', microsoftTenantId: 'microsoft-private',
    displayName: null, primaryDomain: null, status: 'ACTIVE',
    connection: { status: 'CONNECTED', connectionMode: 'HAWKVIEW_MANAGED', clientId: null, credentialReference: null, exchangeReadOnlyEnabledAt: null },
  }
  const result = await (service as any).syncConnectedTenant(tenant, false, { includeBundle: false })
  assert.equal(result.status, 'SUCCEEDED')
  assert.equal(safeStartedDuringSignIn, true)
})

test('isolated near-limit Graph collectors remain below a constrained Render memory envelope', () => {
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', '--max-old-space-size=320', '--import', 'tsx', 'src/tenants/tenant-sync-memory-probe.ts'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith('HAWKVIEW_MEMORY_PROBE='))
  assert.ok(marker, result.stdout)
  const evidence = JSON.parse(marker.slice('HAWKVIEW_MEMORY_PROBE='.length))
  assert.equal(evidence.maximumConcurrentHeavyCollectors, 1)
  assert.equal(evidence.collectorsCompleted, 2)
  assert.equal(evidence.mailboxRowsProjected, MAILBOX_USAGE_CSV_MAX_ROWS - 1)
  assert.equal(evidence.mailboxColumnsParsed, MAILBOX_USAGE_CSV_MAX_COLUMNS)
  assert.ok(evidence.mailboxCsvBytes <= MAILBOX_USAGE_CSV_MAX_BYTES)
  assert.ok(evidence.peakRssMiB <= 300, JSON.stringify(evidence))
  assert.ok(evidence.rssGrowthMiB <= 160, JSON.stringify(evidence))
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

test('mailbox usage CSV projects only bounded mailbox fields rather than retaining arbitrary cells', () => {
  const headers = ['User Principal Name', 'Storage Used (Byte)', 'Item Count', ...Array.from({ length: MAILBOX_USAGE_CSV_MAX_COLUMNS - 3 }, (_, index) => `unused-${index}`)]
  const row = ['user@example.test', '42', '3', ...Array.from({ length: MAILBOX_USAGE_CSV_MAX_COLUMNS - 3 }, () => 'x')]
  const projected = parseMailboxUsageCsv([headers.join(','), row.join(',')].join('\n'))
  assert.deepEqual(projected, [{ 'User Principal Name': 'user@example.test', 'Storage Used (Byte)': '42', 'Item Count': '3' }])
  assert.throws(
    () => parseMailboxUsageCsv(['User Principal Name', ...Array.from({ length: MAILBOX_USAGE_CSV_MAX_ROWS }, () => 'user@example.test')].join('\n')),
    /row or column/,
  )
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

test('the real snapshot wrapper records only its failed operational state when bounded sign-in or audit pages abort', async () => {
  const stateUpserts: any[] = []
  const stateUpdates: any[] = []
  const forbiddenWrites: string[] = []
  const incidents: any[] = []
  const prisma = {
    syncState: {
      upsert: async (args: any) => { stateUpserts.push(args); return { lastSuccessfulAt: null } },
      update: async (args: any) => { stateUpdates.push(args); return { consecutiveFailures: 1 } },
    },
    signInLog: { createMany: async () => forbiddenWrites.push('signIn') },
    directoryAuditLog: { createMany: async () => forbiddenWrites.push('audit') },
    tenantEntraSnapshot: { upsert: async () => forbiddenWrites.push('snapshot') },
    changeEvidenceEvent: { createMany: async () => forbiddenWrites.push('evidence') },
  }
  const notifications = {
    publishIncident: async (input: any) => { incidents.push(input) },
    resolveIncident: async () => forbiddenWrites.push('resolved'),
  }
  const service = new TenantSyncService(prisma as any, {} as any, {} as any, notifications as any, {} as any, {} as any)
  const messages: string[] = []
  ;(service as any).logger = { warn: (message: string) => messages.push(message) }
  ;(service as any).logSyncStart = async () => new Date()
  ;(service as any).signInEntitlement = async () => ({ status: 'AVAILABLE' })
  ;(service as any).fetchGraphCollection = async (_url: string, _token: string, resource: string) =>
    parseBoundedGraphCollectionPage(
      new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(GRAPH_LOG_PAGE_MAX_BYTES + 1)) } })),
      resource,
    )
  const tenant = { id: 'tenant-private', organizationId: 'org-private', microsoftTenantId: 'microsoft-private', displayName: null, primaryDomain: null, status: 'ACTIVE', connection: null }
  await assert.rejects(() => (service as any).syncSignInLogs(tenant, 'token'), /could not safely refresh sign ins/)
  await assert.rejects(() => (service as any).syncDirectoryAuditLogs(tenant, 'token'), /could not safely refresh audit logs/)
  assert.deepEqual(forbiddenWrites, [])
  assert.equal(stateUpserts.length, 2)
  assert.equal(stateUpdates.length, 2)
  for (const [index, resourceType] of ['SIGN_INS', 'AUDIT_LOGS'].entries()) {
    const upsert = stateUpserts[index]
    assert.deepEqual(upsert.where, { customerTenantId_resourceType: { customerTenantId: 'tenant-private', resourceType } })
    assert.deepEqual({ ...upsert.create, lastAttemptAt: 'DATE' }, {
      organizationId: 'org-private', customerTenantId: 'tenant-private', resourceType,
      status: 'RUNNING', lastAttemptAt: 'DATE',
    })
    assert.ok(upsert.create.lastAttemptAt instanceof Date)
    assert.deepEqual({ ...upsert.update, lastAttemptAt: 'DATE' }, {
      status: 'RUNNING', lastAttemptAt: 'DATE', lastErrorCode: null, lastErrorMessage: null,
    })
    assert.ok(upsert.update.lastAttemptAt instanceof Date)
    assert.deepEqual(stateUpdates[index], {
      where: { customerTenantId_resourceType: { customerTenantId: 'tenant-private', resourceType } },
      data: {
        status: 'FAILED',
        lastErrorCode: 'HAWKVIEW_INTERNAL_FAILURE',
        lastErrorMessage: `HawkView could not safely refresh ${resourceType === 'SIGN_INS' ? 'sign ins' : 'audit logs'}. HawkView has not completed the first collection yet. HawkView support should investigate if this continues.`,
        consecutiveFailures: { increment: 1 },
      },
    })
  }
  assert.deepEqual(incidents.map((incident) => incident.metadata), [
    { resourceType: 'SIGN_INS', consecutiveFailures: 1, failureClass: 'HAWKVIEW_INTERNAL', reasonCode: 'HAWKVIEW_INTERNAL_FAILURE' },
    { resourceType: 'AUDIT_LOGS', consecutiveFailures: 1, failureClass: 'HAWKVIEW_INTERNAL', reasonCode: 'HAWKVIEW_INTERNAL_FAILURE' },
  ])
  assert.equal(incidents.length, 2)
  for (const [index, resourceType] of ['SIGN_INS', 'AUDIT_LOGS'].entries()) {
    assert.deepEqual(Object.keys(incidents[index]).sort(), [
      'actionLabel', 'actionUrl', 'category', 'customerTenantId', 'dedupeKey',
      'description', 'eventType', 'metadata', 'organizationId', 'severity', 'source', 'title',
    ].sort())
    assert.equal(incidents[index].eventType, 'tenant.sync_failed')
    assert.equal(incidents[index].organizationId, 'org-private')
    assert.equal(incidents[index].customerTenantId, 'tenant-private')
    assert.equal(incidents[index].dedupeKey, `tenant:tenant-private:sync:${resourceType}`)
    assert.equal(incidents[index].description.includes('token'), false)
    assert.equal(incidents[index].description.includes('private'), false)
  }
  assert.equal(messages.length, 2)
  for (const message of messages) {
    assert.equal(message.includes('tenant-private'), false)
    assert.equal(message.includes('token'), false)
    assert.equal(JSON.parse(message).event, 'microsoft_collection_failed')
  }
})
