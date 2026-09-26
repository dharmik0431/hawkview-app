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
const mocks: Record<string, any> = {
  '@/lib/api/client': { apiClient: { get: (path: string, options: { signal: AbortSignal }) => new Promise((resolve, reject) => pending.push({ path, signal: options.signal, resolve, reject })) } },
  '@/components/providers/notification-provider': { triggerNotification() { throw Error('Unexpected notification') } },
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
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name)
    const target = name.startsWith('@/') ? resolve(base, name.slice(2)) : resolve(dirname(path), name)
    return load([target, target + '.tsx', target + '.ts'].find(p => existsSync(p))!)
  }, exports)
  return exports
}
const Page = load(resolve(base, 'app/(protected)/activity/page.tsx')).default
const bundle = (id: string, months: unknown) => ({ bundle: { tenant: { id }, signIns: [], auditLogs: [], logRetention: { months } } })
async function harness(run: (context: any) => Promise<void>) {
  pending.length = 0
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.invalid' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const root = createRoot(dom.window.document.getElementById('root'))
  const badge = () => dom.window.document.querySelector('div.rounded-full.h-8') as HTMLElement
  const expect = (text = 'Retention: Not reported') => {
    assert.equal(badge().textContent, text)
    assert.match(badge().className, /bg-secondary/)
    assert.doesNotMatch(badge().className, /bg-green|bg-emerald/)
  }
  const request = (path: string) => { const item = pending.shift(); assert.equal(item?.path, path); return item! }
  const select = async (id: string) => React.act(async () => {
    const select = dom.window.document.querySelector('select') as HTMLSelectElement
    select.value = id; select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  const resolveRequest = async (req: typeof pending[number], data: unknown) => React.act(async () => req.resolve(data))
  const click = async (text: RegExp) => React.act(async () => {
    const button = Array.from(dom.window.document.querySelectorAll('button')).find((el: any) => text.test(el.textContent)) as HTMLButtonElement
    assert.ok(button, String(text)); button.click()
  })
  try {
    await React.act(async () => root.render(h(Page)))
    expect()
    await resolveRequest(request('/api/tenants'), { tenants: [{ id: 'a', name: 'Tenant A' }, { id: 'b', name: 'Tenant B' }] })
    expect()
    await run({ expect, select, request, resolveRequest, click, document: dom.window.document })
  } finally {
    await React.act(async () => root.unmount())
    for (const [key, descriptor] of Array.from(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key] }
    dom.window.close()
  }
}
test('actual page reads supplied retention for sign-ins and audits, including singular and non-six values', async () => {
  await harness(async ({ expect, select, request, resolveRequest, click }: any) => {
    for (const months of [6, 1, 12]) {
      await select('a'); expect()
      await resolveRequest(request('/api/tenants/a'), bundle('a', months))
      expect(`Retention: ${months} ${months === 1 ? 'month' : 'months'}`)
      await click(/^Audit logs/); expect(`Retention: ${months} ${months === 1 ? 'month' : 'months'}`)
      await click(/^Sign-in logs/)
      await select(''); expect()
    }
  })
})
test('missing or malformed retention and mismatched bundle tenant never produce a numeric claim', async () => {
  await harness(async ({ expect, select, request, resolveRequest }: any) => {
    for (const months of [undefined, null, '6', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, true]) {
      await select('a')
      await resolveRequest(request('/api/tenants/a'), bundle('a', months)); expect()
      await select('')
    }
    for (const response of [{ bundle: { tenant: { id: 'a' }, signIns: [], auditLogs: [] } }, bundle('b', 6), { bundle: { logRetention: { months: 6 } } }, { bundle: null }]) {
      await select('a'); await resolveRequest(request('/api/tenants/a'), response); expect(); await select('')
    }
  })
})
test('tenant switch, failed read, retry, and late aborted responses cannot reuse another tenant retention', async () => {
  await harness(async ({ expect, select, request, resolveRequest, click }: any) => {
    await select('a'); const abandoned = request('/api/tenants/a')
    await select('b'); expect(); assert.equal(abandoned.signal.aborted, true)
    const current = request('/api/tenants/b')
    await resolveRequest(abandoned, bundle('a', 6)); expect()
    await resolveRequest(current, bundle('b', 12)); expect('Retention: 12 months')
    await select('a'); expect()
    const failed = request('/api/tenants/a')
    await React.act(async () => failed.reject(new Error('Synthetic unavailable'))); expect()
    await click(/^Try again$/); expect()
    await resolveRequest(request('/api/tenants/a'), bundle('a', 1)); expect('Retention: 1 month')
    await select(''); expect()
  })
})
