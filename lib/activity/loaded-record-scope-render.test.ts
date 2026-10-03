import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import test from 'node:test'
const require = createRequire(import.meta.url)
const React = require('react')
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const ts = require('typescript')
const base = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const h = React.createElement
const pending: { path: string; signal: AbortSignal; resolve: (data: unknown) => void; reject: (error: Error) => void }[] = []
const exportsSeen: { tab: string; rows: any[]; tenant: string }[] = []
const notifications: any[] = []
const mocks: Record<string, any> = {
  '@/lib/api/client': { apiClient: { get: (path: string, options: { signal: AbortSignal }) => new Promise((resolve, reject) => pending.push({ path, signal: options.signal, resolve, reject })) } },
  '@/components/providers/notification-provider': { triggerNotification: (value: unknown) => notifications.push(value) },
  './utils/csv-exporter': {
    exportSignInsToCsv: (rows: any[], tenant: string) => { exportsSeen.push({ tab: 'signins', rows, tenant }); return true },
    exportAuditLogsToCsv: (rows: any[], tenant: string) => { exportsSeen.push({ tab: 'audit', rows, tenant }); return true },
  },
  './components/signin-logs-page': { SignInLogsPage: () => h('div', null, 'Sign-in table') },
  './components/audit-logs-page': { AuditLogsPage: () => h('div', null, 'Audit table') },
}
const cache = new Map<string, any>()
function load(path: string): any {
  if (cache.has(path)) return cache.get(path)
  const exports: any = {}; cache.set(path, exports)
  const js = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText
  new Function('require', 'exports', js)((name: string) => {
    if (mocks[name]) return mocks[name]
    if (name === 'next/link') return { __esModule: true, default: ({ children, ...props }: any) => React.createElement('a', props, children) }
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name)
    const target = name.startsWith('@/') ? resolve(base, name.slice(2)) : resolve(dirname(path), name)
    return load([target, target + '.tsx', target + '.ts'].find(p => existsSync(p))!)
  }, exports)
  return exports
}
const Page = load(resolve(base, 'app/(protected)/activity/page.tsx')).default
const recent = new Date().toISOString()
const old = new Date(Date.now() - 20 * 86400000).toISOString()
const signIn = (id: string, date = recent) => ({ id, createdAt: date, userPrincipalName: `${id}@example.invalid`, userDisplayName: id, appDisplayName: 'Synthetic App', result: 'success' })
const audit = (id: string, date = recent) => ({ id, createdAt: date, activity: id, result: 'success' })
const bundle = (id: string, limit: unknown, signIns: unknown = [], auditLogs: unknown = []) => ({ bundle: { tenant: { id }, signIns, auditLogs, logRetention: { displayedRecordLimit: limit, months: 6 } } })

async function harness(run: (context: any) => Promise<void>) {
  pending.length = 0
  exportsSeen.length = 0
  notifications.length = 0
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.invalid' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const root = createRoot(dom.window.document.getElementById('root'))
  const scope = () => dom.window.document.querySelector('[aria-label="Loaded activity scope"]')?.textContent ?? ''
  const body = () => dom.window.document.body.textContent
  const request = (path: string) => { const item = pending.shift(); assert.equal(item?.path, path); return item! }
  const select = async (value: string, index = 0) => React.act(async () => {
    const el = dom.window.document.querySelectorAll('select')[index] as HTMLSelectElement
    el.value = value; el.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  const reply = async (req: typeof pending[number], data: unknown) => React.act(async () => req.resolve(data))
  const fail = async (req: typeof pending[number]) => React.act(async () => req.reject(Error('Synthetic unavailable')))
  const button = (text: RegExp) => {
    const el = Array.from(dom.window.document.querySelectorAll('button')).find((el: any) => text.test(el.textContent)) as HTMLButtonElement
    assert.ok(el, String(text)); return el
  }
  const click = async (text: RegExp) => React.act(async () => button(text).click())
  const unknown = () => {
    assert.match(scope(), /Loaded and matching counts are unavailable/)
    assert.match(scope(), /Load limit: Not reported/)
    assert.equal(button(/^Export CSV$/).disabled, true)
  }
  try {
    await React.act(async () => root.render(h(Page)))
    assert.equal(scope(), '')
    await reply(request('/api/tenants'), { tenants: [{ id: 'a', name: 'Tenant A' }, { id: 'b', name: 'Tenant B' }] })
    assert.equal(scope(), '')
    await run({ scope, body, select, request, reply, fail, click, button, unknown })
    assert.equal(pending.length, 0, 'All requests are accounted for; filters/export do not fetch more records')
  } finally {
    await React.act(async () => root.unmount())
    for (const [key, descriptor] of Array.from(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as any)[key]
    }
    dom.window.close()
  }
}

test('actual page dynamically discloses capped and below-cap subsets for each tab', async () => {
  await harness(async ({ select, request, reply, scope, click }: any) => {
    await select('a')
    await reply(request('/api/tenants/a'), bundle('a', 2, [signIn('one'), signIn('two')], [audit('audit-one')]))
    assert.match(scope(), /Sign-in logs: 2 loaded; 2 match current filters/)
    assert.match(scope(), /up to 2 most recent records per log type for this tenant/)
    assert.match(scope(), /reported load limit is reached; older records may be excluded/)
    await click(/^Audit logs/)
    assert.match(scope(), /Audit logs: 1 loaded; 1 match current filters/)
    assert.doesNotMatch(scope(), /limit is reached/)
    assert.match(scope(), /Total available records and completeness are unknown/)
    assert.match(scope(), /Date ranges and other filters only narrow the loaded records/)
    assert.match(scope(), /CSV exports only matching loaded records/)
    await select('b')
    await reply(request('/api/tenants/b'), bundle('b', 1234, [], []))
    assert.match(scope(), /Audit logs: 0 loaded; 0 match current filters/)
    assert.match(scope(), /up to 1,234 most recent/)
    assert.match(scope(), /completeness are unknown/)
    assert.doesNotMatch(scope(), /5,000|all records|complete history|showing .* of/i)
    await click(/^Sign-in logs/)
    assert.match(scope(), /Sign-in logs: 0 loaded/)
  })
})

test('actual date and user filters and both CSV exports use only matching loaded rows', async () => {
  await harness(async ({ select, request, reply, scope, click, button }: any) => {
    await select('a')
    await reply(request('/api/tenants/a'), bundle('a', 3,
      [signIn('one'), signIn('two'), signIn('older', old)],
      [audit('audit-one'), audit('audit-older', old)]))
    assert.match(scope(), /3 loaded; 2 match current filters/)
    assert.match(button(/^Export CSV$/).title, /matching loaded events/)
    await click(/^Export CSV$/)
    assert.deepEqual(exportsSeen.at(-1)?.rows.map(r => r.eventId), ['one', 'two'])
    assert.equal(exportsSeen.at(-1)?.tenant, 'Tenant A')
    assert.match(notifications.at(-1).description, /2 matching loaded events/)
    await select('one@example.invalid', 1)
    assert.match(scope(), /3 loaded; 1 match current filters/)
    await click(/^Export CSV$/)
    assert.deepEqual(exportsSeen.at(-1)?.rows.map(r => r.eventId), ['one'])
    await select('all', 1)
    await select('30d', 2)
    assert.match(scope(), /3 loaded; 3 match current filters/)
    await click(/^Audit logs/)
    assert.match(scope(), /Audit logs: 2 loaded; 2 match current filters/)
    await select('7d', 2)
    assert.match(scope(), /2 loaded; 1 match current filters/)
    await click(/^Export CSV$/)
    assert.equal(exportsSeen.at(-1)?.tab, 'audit')
    assert.deepEqual(exportsSeen.at(-1)?.rows.map(r => r.eventId), ['audit-one'])
    assert.equal(pending.length, 0)
  })
})

test('missing and invalid limits never become a numeric fallback or completeness claim', async () => {
  await harness(async ({ select, request, reply, scope, click }: any) => {
    for (const limit of [undefined, null, '5000', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, true]) {
      await select('a')
      await reply(request('/api/tenants/a'), bundle('a', limit, [signIn('one')], [audit('audit-one')]))
      for (const tab of [/^Sign-in logs/, /^Audit logs/]) {
        await click(tab)
        assert.match(scope(), /1 loaded; 1 match current filters/)
        assert.match(scope(), /Load limit: Not reported/)
        assert.match(scope(), /Total available records and completeness are unknown/)
        assert.doesNotMatch(scope(), /5,000|up to|limit is reached|unlimited/i)
      }
      await select('')
    }
    await select('a')
    await reply(request('/api/tenants/a'), { bundle: { tenant: { id: 'a' }, signIns: [], auditLogs: [] } })
    assert.match(scope(), /Load limit: Not reported/)
  })
})

test('contradictory limit metadata is disclosed without implying a reliable effective cap', async () => {
  await harness(async ({ select, request, reply, scope }: any) => {
    await select('a')
    await reply(request('/api/tenants/a'), bundle('a', 1, [signIn('one'), signIn('two')]))
    assert.match(scope(), /2 loaded; 2 match current filters/)
    assert.match(scope(), /loaded count exceeds the reported limit; the effective limit is unknown/)
    assert.doesNotMatch(scope(), /limit is reached/)
  })
})

test('tenant changes, aborted responses, failures, retry and reset never retain old scope or exports', async () => {
  await harness(async ({ select, request, reply, fail, scope, click, unknown }: any) => {
    await select('a'); unknown()
    const abandoned = request('/api/tenants/a')
    await select('b'); unknown()
    assert.equal(abandoned.signal.aborted, true)
    const current = request('/api/tenants/b')
    await reply(abandoned, bundle('a', 17, [signIn('stale')]))
    unknown()
    await reply(current, bundle('b', 23, [signIn('current')], [audit('current-audit')]))
    assert.match(scope(), /up to 23 most recent/)
    await click(/^Audit logs/)
    await select('a'); unknown()
    await click(/^Export CSV$/)
    assert.equal(exportsSeen.length, 0)
    await fail(request('/api/tenants/a')); unknown()
    await click(/^Try again$/); unknown()
    await reply(request('/api/tenants/a'), bundle('a', 7, [], [audit('new-audit')]))
    assert.match(scope(), /Audit logs: 1 loaded; 1 match/)
    assert.match(scope(), /up to 7 most recent/)
    await click(/^Export CSV$/)
    assert.deepEqual(exportsSeen.at(-1)?.rows.map(r => r.eventId), ['new-audit'])
    assert.equal(exportsSeen.at(-1)?.tenant, 'Tenant A')
    await click(/^Reset$/)
    assert.equal(scope(), '')
  })
})

test('mismatched bundles and unavailable arrays stay unknown and cannot be exported as another tenant or empty evidence', async () => {
  await harness(async ({ select, request, reply, scope, body, click, unknown, button }: any) => {
    for (const data of [bundle('b', 17, [signIn('wrong-tenant')]), { bundle: null }, { bundle: { signIns: [signIn('missing-tenant')] } }]) {
      await select('a'); await reply(request('/api/tenants/a'), data); unknown()
      assert.match(body(), /could not be loaded for this tenant/)
      await select('')
    }
    await select('a')
    await reply(request('/api/tenants/a'), bundle('a', 17, null, [audit('audit-one')]))
    assert.match(scope(), /Loaded and matching counts are unavailable/)
    assert.equal(button(/^Export CSV$/).disabled, true)
    await click(/^Audit logs/)
    assert.match(scope(), /Audit logs: 1 loaded; 1 match/)
    await click(/^Export CSV$/)
    assert.deepEqual(exportsSeen.at(-1)?.rows.map(r => r.eventId), ['audit-one'])
  })
})


test('production-sized cap stays disclosed when filters match none of the loaded records', async () => {
  await harness(async ({ select, request, reply, scope, button, click }: any) => {
    await select('a')
    await reply(request('/api/tenants/a'), bundle('a', 5000,
      Array.from({ length: 5000 }, (_, i) => signIn(`older-${i}`, old)), []))
    assert.match(scope(), /5,000 loaded; 0 match current filters/)
    assert.match(scope(), /reported load limit is reached/)
    assert.equal(button(/^Export CSV$/).disabled, true)
    await click(/^Audit logs/)
    assert.match(scope(), /Audit logs: 0 loaded; 0 match current filters/)
    assert.doesNotMatch(scope(), /limit is reached/)
    assert.match(scope(), /completeness are unknown/)
  })
})
