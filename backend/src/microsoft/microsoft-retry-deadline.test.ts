import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { fetchMicrosoftWithRetry, retryAfterMilliseconds } from './microsoft-request.js'
import {
  M365ManagementActivityService, ManagementActivityHttpError,
  M365ActivityDeadlineError, M365AuditBudgetError, retryDelayMs,
  M365_ACTIVITY_CONTENT_TYPES,
} from '../tenants/m365-management-activity.service.js'

const NOW = Date.parse('2026-09-29T12:00:00Z')
const tenant = {
  id: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222',
  microsoftTenantId: '33333333-3333-4333-8333-333333333333',
  connection: { connectionMode: 'HAWKVIEW_MANAGED', clientId: null, credentialReference: null },
}
const url = `https://manage.office.com/api/v1.0/${tenant.microsoftTenantId}/activity/feed/subscriptions/list`
const publisher = '44444444-4444-4444-8444-444444444444'
const content = { id: 'blob-row', contentUri: url.replace('subscriptions/list', 'audit/blob'), attemptCount: 0 }
const date = (offset: number) => new Date(NOW + offset).toUTCString()
function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const waits: number[] = [], timeouts: number[] = []
  t.mock.method(Math, 'random', () => 0.5)
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return new AbortController().signal })
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => {
    waits.push(ms); t.mock.timers.tick(ms); queueMicrotask(callback); return {} as NodeJS.Timeout
  })
  return { waits, timeouts, tick: (ms: number) => t.mock.timers.tick(ms) }
}
function management(prisma: any = {}) {
  const service = new M365ManagementActivityService(prisma, {} as never) as any
  const warnings: string[] = []
  service.logger = { warn: (s: string) => warnings.push(s), error: (s: string) => warnings.push(s) }
  return { service, warnings }
}
const cases: Array<[string | null, number | null]> = [
  [null, null], ['', null], ['   ', null], ['0', 0], [' 5 ', 5000],
  ['-5', null], ['+5', null], ['1.5', null], ['Infinity', null], ['NaN', null], ['1e2', null],
  ['5', 5000], ['120', 120000], ['3600', 3600000],
  [date(5000), 5000], [date(120000), 120000], [date(-1000), 0], ['garbage', null],
  ['Foo, 29 Sep 2026 11:59:59 GMT', null],
  ['Nonsense, 29-Sep-26 11:59:59 GMT', null],
  ['Foo Sep 29 11:59:59 2026', null],
  ['Tue, 29 Foo 2026 11:59:59 GMT', null],
  ['Tuesday, 29-Foo-26 11:59:59 GMT', null],
  ['Tue Foo 29 11:59:59 2026', null],
  ['Tue, 31 Feb 2026 12:00:00 GMT', null],
  ['Tuesday, 31-Feb-26 12:00:00 GMT', null],
  ['Tue Feb 31 12:00:00 2026', null],
  ['Sun, 29 Feb 2026 11:59:59 GMT', null],
  ['Tue, 00 Sep 2026 11:59:59 GMT', null],
  ['Tue, 29 Sep 2026 24:00:00 GMT', null],
  ['Tue, 29 Sep 2026 11:60:00 GMT', null],
  ['Tue, 29 Sep 2026 11:59:60 GMT', null],
  ['Mon, 29 Sep 2026 11:59:59 GMT', null],
  ['Tuesday, 29-Sep-26 12:00:05 GMT', 5000],
  ['Tue Sep 29 12:00:05 2026', 5000],
  ['Tuesday, 29-Sep-26 11:59:59 GMT', 0],
  ['Tue Sep 29 11:59:59 2026', 0],
  ['Sunday, 06-Nov-94 08:49:37 GMT', 0],
  ['Sun Nov  6 08:49:37 1994', 0],
  ['Thu, 29 Feb 2024 12:00:00 GMT', 0],
]
test('Retry-After parsing distinguishes missing/invalid from zero without shortening valid waits', () => {
  for (const [raw, expected] of cases) assert.equal(retryAfterMilliseconds(raw, NOW), expected, String(raw))
  assert.equal(retryDelayMs(0, 3600), 3600000)
})

for (const [raw, parsed] of cases) {
  test(`Graph retry behavior for ${JSON.stringify(raw)}`, async (t) => {
    const c = clock(t), warnings: string[] = []
    t.mock.method(console, 'warn', (s: string) => warnings.push(s))
    let calls = 0
    const response = await fetchMicrosoftWithRetry('https://graph.microsoft.com/v1.0/users', {}, {
      label: 'users', deadlineAt: NOW + 4_000_000,
      fetchImpl: (async () => {
        calls++; return new Response(calls === 1 ? 'slow' : 'ok', {
          status: calls === 1 ? 429 : 200, headers: raw === null ? {} : { 'Retry-After': raw },
        })
      }) as typeof fetch,
    })
    const deferred = parsed !== null && parsed > 10000
    assert.equal(calls, deferred ? 1 : 2)
    assert.equal(response.status, deferred ? 429 : 200)
    assert.deepEqual(c.waits, deferred ? [] : [parsed ?? 500])
    assert.equal(await response.text(), deferred ? 'slow' : 'ok')
    assert.deepEqual(warnings, raw !== null && parsed === null
      ? [JSON.stringify({ event: 'microsoft_request_retry', reasonCode: 'INVALID_RETRY_AFTER' })] : [])
  })
  test(`M365 retry behavior for ${JSON.stringify(raw)}`, async (t) => {
    const c = clock(t), { service, warnings } = management()
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => {
      calls++; return new Response('slow', { status: calls === 1 ? 429 : 200, headers: raw === null ? {} : { 'Retry-After': raw } })
    })
    if (parsed !== null && parsed > 5000) {
      await assert.rejects(service.request(url, {}, tenant.microsoftTenantId, publisher, NOW + 4_000_000), (e: unknown) => {
        assert.ok(e instanceof ManagementActivityHttpError); assert.equal(e.retryAt?.getTime(), NOW + parsed); return true
      })
      assert.equal(calls, 1); assert.deepEqual(c.waits, [])
    } else {
      assert.equal((await service.request(url, {}, tenant.microsoftTenantId, publisher, NOW + 4_000_000)).status, 200)
      assert.equal(calls, 2); assert.deepEqual(c.waits, [parsed ?? 1000])
    }
    assert.deepEqual(warnings, raw !== null && parsed === null
      ? [JSON.stringify({ event: 'm365_activity_retry', reasonCode: 'INVALID_RETRY_AFTER' })] : [])
  })
}

for (const engine of ['Graph', 'M365']) {
  for (const arm of ['response', 'transport']) {
    test(`${engine} ${arm} refuses a wait that reaches/exceeds the deadline, without a second backoff`, async (t) => {
      const c = clock(t); let calls = 0
      const fetchImpl = async () => {
        calls++; c.tick(100)
        if (arm === 'transport') throw new Error('synthetic transport failure')
        return new Response('slow', { status: 429, headers: { 'Retry-After': '1' } })
      }
      t.mock.method(globalThis, 'fetch', fetchImpl)
      const promise = engine === 'Graph'
        ? fetchMicrosoftWithRetry('https://graph.microsoft.com/v1.0/users', {}, { label: 'users', deadlineAt: NOW + 500 })
        : management().service.request(url, {}, tenant.microsoftTenantId, publisher, NOW + 500)
      await assert.rejects(promise, /bounded collection deadline/)
      assert.equal(Date.now(), NOW + 100); assert.equal(calls, 1)
      assert.deepEqual(c.waits, []); assert.deepEqual(c.timeouts, [500])
    })
    test(`${engine} ${arm} backoff uses the remaining budget on subsequent attempts`, async (t) => {
      const c = clock(t); let calls = 0
      t.mock.method(globalThis, 'fetch', async () => {
        calls++
        if (calls === 3) return new Response('ok')
        if (arm === 'transport') throw new Error('synthetic transport failure')
        return new Response('slow', { status: 503 })
      })
      if (engine === 'Graph') await fetchMicrosoftWithRetry('https://graph.microsoft.com/v1.0/users', {}, { label: 'users', deadlineAt: NOW + 5000 })
      else await management().service.request(url, {}, tenant.microsoftTenantId, publisher, NOW + 5000)
      assert.equal(calls, 3)
      assert.deepEqual(c.waits, engine === 'Graph' ? [500, 1000] : [1000, 2000])
      assert.deepEqual(c.timeouts, engine === 'Graph' ? [5000, 4500, 3500] : [5000, 4000, 2000])
    })
  }
  test(`${engine} does not retry an unsafe POST after a response or transport failure`, async (t) => {
    const c = clock(t)
    for (const transport of [false, true]) {
      let calls = 0
      t.mock.method(globalThis, 'fetch', async () => { calls++; if (transport) throw new Error('synthetic'); return new Response('slow', { status: 503, headers: { 'Retry-After': '0' } }) })
      if (engine === 'Graph') {
        const run = fetchMicrosoftWithRetry('https://graph.microsoft.com/v1.0/users', { method: 'POST' }, { label: 'users', deadlineAt: NOW + 5000 })
        if (transport) await assert.rejects(run); else assert.equal((await run).status, 503)
      } else await assert.rejects(management().service.request(url, { method: 'POST' }, tenant.microsoftTenantId, publisher, NOW + 5000))
      assert.equal(calls, 1)
    }
    assert.deepEqual(c.waits, [])
  })
  test(`${engine} expired deadline performs no request`, async (t) => {
    const c = clock(t); let calls = 0
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('ok') })
    await assert.rejects(engine === 'Graph'
      ? fetchMicrosoftWithRetry('https://graph.microsoft.com/v1.0/users', {}, { label: 'users', deadlineAt: NOW })
      : management().service.request(url, {}, tenant.microsoftTenantId, publisher, NOW), /bounded collection deadline/)
    assert.equal(calls, 0); assert.deepEqual(c.waits, [])
  })
}

// This store evaluates the actual caller predicates; it is deliberately an
// offline double, not evidence for PostgreSQL locking/transaction behavior.
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, expected]: [string, any]) => {
    if (key === 'OR') return expected.some((part: any) => matches(row, part))
    const actual = row[key]
    if (expected === null || typeof expected !== 'object' || expected instanceof Date) return actual === expected
    return Object.entries(expected).every(([op, value]: [string, any]) => {
      if (op === 'in') return value.includes(actual)
      if (op === 'lte') return actual !== null && actual <= value
      if (op === 'lt') return actual !== null && actual < value
      throw new Error(`Unsupported offline predicate: ${op}`)
    })
  })
}
function ledger() {
  const rows: any[] = [{ ...content, ...{ organizationId: tenant.organizationId, customerTenantId: tenant.id }, status: 'PENDING', nextRetryAt: null, updatedAt: new Date(NOW) }]
  const state: any = { lastSuccessfulAt: new Date(NOW - 3600000) }
  const selections: any[] = []
  const updates: any[] = []
  const prisma: any = {
    syncState: {
      findUnique: async () => state,
      upsert: async ({ update }: any) => Object.assign(state, update),
      update: async ({ data }: any) => Object.assign(state, data),
    },
    m365ActivityContent: {
      count: async ({ where }: any) => rows.filter(row => matches(row, where)).length,
      findMany: async ({ where, take }: any) => { selections.push(where); return rows.filter(row => matches(row, where)).slice(0, take).map(row => ({ ...row })) },
      updateMany: async ({ where, data }: any) => {
        updates.push({ where, data })
        const selected = rows.filter(row => matches(row, where))
        for (const row of selected) {
          for (const [key, value] of Object.entries(data) as Array<[string, any]>) {
            row[key] = value?.increment !== undefined ? row[key] + value.increment : value
          }
        }
        return { count: selected.length }
      },
      deleteMany: async () => ({ count: 0 }),
    },
    m365ActivitySubscription: { findMany: async () => [] },
    m365AuditRecord: { deleteMany: async () => ({ count: 0 }) },
    m365AuditDailyUsage: { deleteMany: async () => ({ count: 0 }) },
    $transaction: async (operations: any[]) => Promise.all(operations),
  }
  const { service } = management(prisma)
  service.microsoftConsent = { getTenantManagementActivityContext: async () => ({ accessToken: 'synthetic-token', publisherIdentifier: publisher }) }
  service.ensureSubscriptions = async () => new Set(M365_ACTIVITY_CONTENT_TYPES)
  service.discoverContent = async () => false
  return { service, prisma, rows, state, selections, updates }
}
for (const raw of ['3600', date(3600000)]) {
  test(`content ${raw} preserves not-before through deadline refusal, storage and later selection`, async (t) => {
    const c = clock(t), store = ledger(); let calls = 0
    const otherRows = [
      { ...store.rows[0], id: 'other-organization', organizationId: 'other-organization' },
      { ...store.rows[0], id: 'other-tenant', customerTenantId: 'other-tenant' },
    ]
    store.rows.push(...otherRows.map(row => ({ ...row })))
    t.mock.method(globalThis, 'fetch', async () => {
      calls++; return new Response('synthetic', { status: calls === 1 ? 429 : 404, headers: { 'Retry-After': raw } })
    })
    await store.service.syncTenant(tenant)
    assert.equal(calls, 1); assert.deepEqual(c.waits, [])
    assert.equal(store.rows[0].status, 'RETRY')
    assert.equal(store.rows[0].nextRetryAt.getTime(), NOW + 3600000)
    assert.equal(store.state.status, 'RUNNING'); assert.equal(store.state.lastErrorCode, 'm365-audit-backlog')
    c.tick(3599999)
    await store.service.syncTenant(tenant)
    assert.equal(calls, 1, 'not eligible one millisecond before not-before')
    c.tick(1)
    await store.service.syncTenant(tenant)
    assert.equal(calls, 2, 'eligible exactly at stored not-before')
    assert.equal(store.rows[0].status, 'FAILED'); assert.equal(store.rows[0].nextRetryAt, null)
    assert.deepEqual(store.rows.slice(1), otherRows, 'other scope is untouched')
    assert.ok(store.selections.every(where => where.organizationId === tenant.organizationId && where.customerTenantId === tenant.id))
  })
}

test('content preserves an HTTP error not-before even when inline cutoff precedes deadline', async (t) => {
  const c = clock(t), store = ledger()
  t.mock.method(globalThis, 'fetch', async () => new Response('slow', { status: 503, headers: { 'Retry-After': '120' } }))
  await store.service.processContent(tenant, 'token', publisher, { remainingBytes: 1e6 }, content, NOW + 180000)
  assert.equal(store.rows[0].nextRetryAt.getTime(), NOW + 120000)
  assert.deepEqual(c.waits, [])
})

test('content keeps local backoff after zero/past server dates and existing quota/permission outcomes', async (t) => {
  const c = clock(t)
  for (const failure of [
    new ManagementActivityHttpError('zero', 429, 0, new Date(NOW)),
    new ManagementActivityHttpError('past', 503, 0, new Date(NOW - 1000)),
    new M365AuditBudgetError('quota', new Date(NOW + 86400000)),
    new ManagementActivityHttpError('permission', 403),
  ]) {
    const store = ledger()
    store.service.request = async () => { throw failure }
    const run = store.service.processContent(tenant, 'token', publisher, { remainingBytes: 1e6 }, content, NOW + 5000)
    if (failure instanceof ManagementActivityHttpError && failure.status === 403) {
      await assert.rejects(run, /permission/); assert.equal(store.rows[0].status, 'FAILED'); assert.equal(store.rows[0].nextRetryAt, null)
    } else {
      await run
      assert.equal(store.rows[0].status, 'RETRY')
      assert.equal(store.rows[0].nextRetryAt.getTime(), NOW + (failure instanceof M365AuditBudgetError ? 86400000 : 2000))
    }
  }
  assert.deepEqual(c.waits, [])
})

test('syncTenant propagates one bounded deadline to subscriptions, discovery and content', async (t) => {
  clock(t); const store = ledger(), deadlines: number[] = []
  const configured = process.env.M365_AUDIT_MAX_RUNTIME_SECONDS
  process.env.M365_AUDIT_MAX_RUNTIME_SECONDS = '45'
  t.after(() => { if (configured === undefined) delete process.env.M365_AUDIT_MAX_RUNTIME_SECONDS; else process.env.M365_AUDIT_MAX_RUNTIME_SECONDS = configured })
  store.service.ensureSubscriptions = async (...args: any[]) => { deadlines.push(args[4]); return new Set(M365_ACTIVITY_CONTENT_TYPES) }
  store.service.discoverContent = async (...args: any[]) => { deadlines.push(args[5]); return false }
  store.service.processContent = async (...args: any[]) => { deadlines.push(args[5]); return [] }
  await store.service.syncTenant(tenant)
  assert.deepEqual(deadlines, [NOW + 45000, NOW + 45000, NOW + 45000])
})

test('subscription list, POST start and 400 verification all receive the caller deadline', async (t) => {
  clock(t)
  const { service } = management({ m365ActivitySubscription: { findMany: async () => [], upsert: async () => undefined } })
  service.readMeteredJson = async (_tenant: unknown, response: Response) => response.json()
  service.reserveSubscriptionStart = async () => 'Audit.Exchange'
  const calls: Array<{ method: string; deadline: number }> = []
  service.request = async (_url: string, init: RequestInit, _tenant: string, _publisher: string, deadline: number) => {
    calls.push({ method: init.method ?? 'GET', deadline })
    if (init.method === 'POST') throw new ManagementActivityHttpError('already enabled', 400)
    return new Response(JSON.stringify(calls.length === 1 ? [] : [{ contentType: 'Audit.Exchange', status: 'enabled' }]))
  }
  const enabled = await service.ensureSubscriptions(tenant, 'token', publisher, new Date(), NOW + 1000)
  assert.equal(enabled.has('Audit.Exchange'), true)
  assert.deepEqual(calls, [{ method: 'GET', deadline: NOW + 1000 }, { method: 'POST', deadline: NOW + 1000 }, { method: 'GET', deadline: NOW + 1000 }])
})

test('discovery and blob request pass the exact caller deadline to HTTP transport', async (t) => {
  clock(t); const store = ledger(), deadlines: number[] = []
  // Restore the production method hidden by the content-ledger fixture.
  store.service.discoverContent = (M365ManagementActivityService.prototype as any).discoverContent
  store.prisma.m365ActivitySubscription.findUnique = async () => null
  store.prisma.m365ActivitySubscription.update = async () => ({ lastSuccessfulPollAt: new Date(NOW) })
  store.prisma.m365ActivityContent.createMany = async () => ({ count: 0 })
  store.service.readMeteredJson = async (_tenant: unknown, response: Response) => response.json()
  store.service.request = async (...args: any[]) => { deadlines.push(args[4]); return new Response('[]') }
  await store.service.discoverContent(tenant, 'token', publisher, new Set(['Audit.Exchange']), new Date(), NOW + 1234, { remainingBytes: 1e6 })
  store.service.request = async (...args: any[]) => { deadlines.push(args[4]); throw new M365ActivityDeadlineError() }
  await store.service.processContent(tenant, 'token', publisher, { remainingBytes: 1e6 }, content, NOW + 1234)
  assert.deepEqual(deadlines, [NOW + 1234, NOW + 1234])
})

test('M365 retains server not-before when the diagnostic body fails', async (t) => {
  const c = clock(t), { service, warnings } = management(); let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error('synthetic body failure')) } }), {
      status: 429, headers: { 'Retry-After': '120' },
    })
  })
  await assert.rejects(service.request(url, {}, tenant.microsoftTenantId, publisher, NOW + 500), (e: unknown) => {
    assert.ok(e instanceof M365ActivityDeadlineError)
    assert.equal(e.retryAt?.getTime(), NOW + 120000); return true
  })
  assert.equal(calls, 1); assert.deepEqual(c.waits, [])
  assert.deepEqual(warnings, [JSON.stringify({ event: 'm365_activity_retry', reasonCode: 'ERROR_BODY_UNAVAILABLE' })])
})

test('M365 server not-before is measured at header receipt, not after diagnostic parsing', async (t) => {
  const c = clock(t), { service } = management(); let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response(new ReadableStream({ pull(controller) { c.tick(1000); controller.close() } }, { highWaterMark: 0 }), {
      status: 429, headers: { 'Retry-After': '120' },
    })
  })
  await assert.rejects(service.request(url, {}, tenant.microsoftTenantId, publisher, NOW + 180000), (e: unknown) => {
    assert.ok(e instanceof ManagementActivityHttpError)
    assert.equal(e.retryAt?.getTime(), NOW + 120000); return true
  })
  assert.equal(calls, 1); assert.deepEqual(c.waits, [])
})

for (const engine of ['Graph', 'M365']) {
  test(`${engine} rejects a response arriving after its deadline`, async (t) => {
    const c = clock(t); let calls = 0
    t.mock.method(globalThis, 'fetch', async () => { calls++; c.tick(501); return new Response('late') })
    await assert.rejects(engine === 'Graph'
      ? fetchMicrosoftWithRetry('https://graph.microsoft.com/v1.0/users', {}, { label: 'users', deadlineAt: NOW + 500 })
      : management().service.request(url, {}, tenant.microsoftTenantId, publisher, NOW + 500), /bounded collection deadline/)
    assert.equal(calls, 1); assert.deepEqual(c.waits, [])
  })
}


test('obsolete HTTP dates resolve their two-digit year relative to the caller clock', () => {
  const now = Date.parse('1990-01-01T00:00:00Z')
  assert.equal(retryAfterMilliseconds('Sunday, 01-Jan-06 00:00:00 GMT', now), Date.parse('2006-01-01T00:00:00Z') - now)
  // 2077 is more than fifty years after 2026; resolve 77 as 1977.
  assert.equal(retryAfterMilliseconds('Saturday, 01-Jan-77 00:00:00 GMT', NOW), 0)
})
