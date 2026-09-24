import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import test from 'node:test'
const require = createRequire(import.meta.url)
const React = require('react')
const { renderToString, renderToStaticMarkup } = require('react-dom/server')
const { hydrateRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const ts = require('typescript')
const base = resolve(dirname(new URL(import.meta.url).pathname), '../..')
let release: any = { phase: 1, pullRequest: 296, label: '1.296' }
let pathname = '/dashboard'
let collapsed = false
let owner = true
const h = React.createElement
const mocks: Record<string, any> = {
  'next/link': { __esModule: true, default: React.forwardRef(function TestLink({ children, ...props }: any, ref: any) { return h('a', { ...props, ref }, children) }) },
  '@/lib/config/frontend-release': { get FRONTEND_RELEASE() { return release } },
  'next-themes': { useTheme: () => ({ theme: 'light', resolvedTheme: 'light', setTheme() {} }) },
  'next/navigation': { usePathname: () => pathname },
  '@/components/brand/hawkview-brand': { HawkViewBrand: (props: any) => h('span', { className: props.className }, 'HawkView') },
  '@/components/auth/auth-form': { AuthForm: () => h('form', null, h('h1', null, 'Sign in'), h('input', { 'aria-label': 'Email' }), h('button', null, 'Sign in')) },
  '@/components/providers/auth-provider': { useAuth: () => ({ cacheScope: 'synthetic', session: { user: { memberships: owner ? [{ role: 'MSP_OWNER' }] : [] } } }) },
  '@/components/providers/sidebar-provider': { useSidebar: () => ({ isCollapsed: collapsed, toggleCollapsed() {} }) },
  '@/components/layout/notification-panel': { NotificationPanel: () => h('button', { className: 'h-9 w-9', 'aria-label': 'Notifications' }, 'Bell') },
  '@/components/layout/user-menu': { UserMenu: () => h('button', { className: 'h-9 w-9', 'aria-label': 'Account menu' }, 'User') },
  '@/lib/api/client': { apiClient: { get() { throw Error('Version rendering must not request backend data') } } },
}
const cache = new Map<string, any>()
function load(path: string): any {
  if (path.endsWith('.json')) return JSON.parse(readFileSync(path, 'utf8'))
  if (cache.has(path)) return cache.get(path)
  const exports: any = {}; cache.set(path, exports)
  const js = ts.transpileModule(readFileSync(path, 'utf8').replace('<style jsx global>', '<style>'), { compilerOptions: {
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
const Login = load(resolve(base, 'app/(public)/login/page.tsx')).default
const { Topbar } = load(resolve(base, 'components/layout/topbar.tsx'))
const { Sidebar } = load(resolve(base, 'components/layout/sidebar.tsx'))
const { SiteVersion } = load(resolve(base, 'components/layout/site-version.tsx'))
function app() { return h('div', null, h('section', { id: 'login' }, h(Login)), h('section', { id: 'signed-in' }, h(Sidebar), h('div', { id: 'topbar' }, h(Topbar)))) }

function assertLabelOnly(surface: Element, label: string) {
  const labels = surface.querySelectorAll('[aria-label="Frontend site version"]')
  assert.equal(labels.length, 1)
  const labelNode = labels[0]
  assert.equal(labelNode.tagName, 'SPAN')
  assert.equal(labelNode.textContent, `Version ${label}`)
  assert.equal(labelNode.getAttribute('tabindex'), null)
  assert.equal(labelNode.getAttribute('title'), null)
  assert.equal(surface.querySelector('details, summary, time'), null)
  assert.doesNotMatch(surface.textContent ?? '', /Source fingerprint|Frontend version details|Built \(UTC\)|show version details/)
}
test('actual login chain and signed-in sidebar show only the phase.PR label', () => {
  release = { phase: 1, pullRequest: 296, label: '1.296' }; pathname = '/dashboard'
  const dom = new JSDOM(renderToStaticMarkup(app()))
  for (const id of ['login', 'signed-in']) assertLabelOnly(dom.window.document.getElementById(id)!, '1.296')
  assert.ok(!dom.window.document.querySelector('#login [aria-label="Frontend site version"]')!.parentElement!.className.includes('lg:hidden'))
  dom.window.close()
})
test('topbar has no version label, including title-hidden admin and team routes', () => {
  for (pathname of ['/admin/overview', '/settings/team', '/team-access']) {
    const dom = new JSDOM(renderToStaticMarkup(h(Topbar)))
    assert.equal(dom.window.document.querySelector('h1'), null)
    assert.equal(dom.window.document.querySelector('[aria-label="Frontend site version"]'), null)
    dom.window.close()
  }
})
test('expanded and collapsed sidebar place readable version above owner or member footer actions', () => {
  for (collapsed of [false, true]) for (owner of [false, true]) {
    const dom = new JSDOM(renderToStaticMarkup(h(Sidebar)))
    assertLabelOnly(dom.window.document.body, '1.296')
    const label = dom.window.document.querySelector('[aria-label="Frontend site version"]')!
    assert.ok(!label.parentElement!.className.includes('sr-only'))
    assert.ok(label.compareDocumentPosition(dom.window.document.querySelector('a[href^="mailto:"]')!) & 4)
    const admin = dom.window.document.querySelector('a[href="/admin/overview"]')
    assert.equal(Boolean(admin), owner)
    if (admin) assert.ok(label.compareDocumentPosition(admin) & 4)
    dom.window.close()
  }
  collapsed = false; owner = true
})
test('unassigned and invalid releases show only truthful fallback labels', () => {
  for (const value of [{ phase: 1, pullRequest: null, label: '1.local' }, { phase: null, pullRequest: null, label: 'Unavailable' }]) {
    release = value
    const dom = new JSDOM(renderToStaticMarkup(app()))
    for (const id of ['login', 'signed-in']) assertLabelOnly(dom.window.document.getElementById(id)!, value.label === 'Unavailable' ? 'unavailable' : value.label)
    dom.window.close()
  }
  release = { phase: 1, pullRequest: 296, label: '1.296' }
})
test('actual tracked release JSON and reader feed both UI mounting points', () => {
  const actual = load(resolve(base, 'lib/config/frontend-release.ts')).FRONTEND_RELEASE
  const tracked = JSON.parse(readFileSync(resolve(base, 'lib/config/frontend-release.json'), 'utf8'))
  assert.equal(actual.phase, tracked.phase)
  assert.equal(actual.pullRequest, tracked.pullRequest)
  assert.equal(actual.label, `${tracked.phase}.${tracked.pullRequest ?? 'local'}`)
  release = actual; pathname = '/dashboard'
  const dom = new JSDOM(renderToStaticMarkup(app()))
  for (const id of ['login', 'signed-in']) assertLabelOnly(dom.window.document.getElementById(id)!, actual.label)
  dom.window.close()
  release = { phase: 1, pullRequest: 296, label: '1.296' }
})
test('SSR hydration preserves the release label without additional details or API calls', async () => {
  pathname = '/dashboard'
  const dom = new JSDOM('<div id="root">' + renderToString(app()) + '</div>', { url: 'https://synthetic.invalid' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const errors: unknown[] = []; let root: any
  try {
    await React.act(async () => { root = hydrateRoot(dom.window.document.getElementById('root'), app(), { onRecoverableError: (error: unknown) => errors.push(error) }) })
    assert.deepEqual(errors, [])
    for (const id of ['login', 'signed-in']) assertLabelOnly(dom.window.document.getElementById(id)!, '1.296')
    const trigger = dom.window.document.querySelector('[aria-label="Open main navigation"]') as HTMLButtonElement
    await React.act(async () => trigger.click())
    const drawer = dom.window.document.querySelector('[role="dialog"]')!
    assertLabelOnly(drawer, '1.296')
    const label = drawer.querySelector('[aria-label="Frontend site version"]')!
    for (const selector of ['a[href="/admin/overview"]', 'a[href^="mailto:"]']) assert.ok(label.compareDocumentPosition(drawer.querySelector(selector)!) & 4)
    await React.act(async () => (drawer.querySelector('[aria-label="Close main navigation"]') as HTMLButtonElement).click())
    assert.equal(dom.window.document.querySelector('[role="dialog"]'), null)
    owner = false
    await React.act(async () => root.render(app()))
    await React.act(async () => trigger.click())
    const memberDrawer = dom.window.document.querySelector('[role="dialog"]')!
    assertLabelOnly(memberDrawer, '1.296')
    assert.equal(memberDrawer.querySelector('a[href="/admin/overview"]'), null)
    assert.ok(memberDrawer.querySelector('[aria-label="Frontend site version"]')!.compareDocumentPosition(memberDrawer.querySelector('a[href^="mailto:"]')!) & 4)
  } finally {
    owner = true
    if (root) await React.act(async () => root.unmount())
    for (const [key, descriptor] of Array.from(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key] }
    dom.window.close()
  }
})
// Optional local visual artifact; never fetched from a backend or published.
if (process.env.HAWKVIEW_VERSION_PREVIEW_DIR) {
  pathname = '/dashboard'
  for (const [name, node] of [['login', h(Login)], ['topbar', h(Topbar)], ['details', h(SiteVersion)]]) {
    writeFileSync(resolve(process.env.HAWKVIEW_VERSION_PREVIEW_DIR, `${name}.html`), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body>' + renderToStaticMarkup(node) + '</body></html>')
  }
}
