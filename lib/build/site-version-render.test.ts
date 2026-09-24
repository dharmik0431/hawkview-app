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
const build = { kind: 'build', sourceHash: 'a1234567890b'.repeat(5) + 'cdef', builtAt: '2026-09-23T15:30:00.000Z' }
let identity: any = build
let pathname = '/dashboard'
const h = React.createElement
const mocks: Record<string, any> = {
  '@/lib/config/frontend-build-identity': { get FRONTEND_BUILD_IDENTITY() { return identity } },
  'next-themes': { useTheme: () => ({ theme: 'light', resolvedTheme: 'light', setTheme() {} }) },
  'next/navigation': { usePathname: () => pathname },
  '@/components/brand/hawkview-brand': { HawkViewBrand: (props: any) => h('span', { className: props.className }, 'HawkView') },
  '@/components/auth/auth-form': { AuthForm: () => h('form', null, h('h1', null, 'Sign in'), h('input', { 'aria-label': 'Email' }), h('button', null, 'Sign in')) },
  '@/components/providers/auth-provider': { useAuth: () => ({ cacheScope: 'synthetic' }) },
  '@/components/layout/notification-panel': { NotificationPanel: () => h('button', { className: 'h-9 w-9', 'aria-label': 'Notifications' }, 'Bell') },
  '@/components/layout/user-menu': { UserMenu: () => h('button', { className: 'h-9 w-9', 'aria-label': 'Account menu' }, 'User') },
  '@/components/layout/mobile-navigation': { MobileNavigation: () => h('button', { className: 'h-10 w-10 shrink-0 lg:hidden', 'aria-label': 'Open main navigation' }, 'Menu') },
  '@/lib/api/client': { apiClient: { get() { throw Error('Version rendering must not request backend data') } } },
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
const Login = load(resolve(base, 'app/(public)/login/page.tsx')).default
const { Topbar } = load(resolve(base, 'components/layout/topbar.tsx'))
const { SiteVersion } = load(resolve(base, 'components/layout/site-version.tsx'))
function app() { return h('div', null, h('section', { id: 'login' }, h(Login)), h('section', { id: 'signed-in' }, h(Topbar))) }

test('actual login chain and signed-in topbar render the same accessible compiled identity', () => {
  identity = build; pathname = '/dashboard'
  const dom = new JSDOM(renderToStaticMarkup(app()))
  for (const id of ['login', 'signed-in']) {
    const surface = dom.window.document.getElementById(id)!
    assert.equal(surface.querySelectorAll('details').length, 1)
    assert.match(surface.querySelector('summary')!.textContent!, /Version a1234567890b/)
    assert.match(surface.querySelector('summary')!.getAttribute('aria-label')!, /Frontend site version/)
    assert.equal(surface.querySelector('dd')!.textContent, build.sourceHash)
    assert.equal(surface.querySelector('time')!.getAttribute('datetime'), build.builtAt)
    assert.match(surface.textContent!, /15:30:00 UTC/)
    const details = surface.querySelector('details')!
    assert.equal(details.open, false)
    surface.querySelector('summary')!.click()
    assert.equal(details.open, true, 'native disclosure opens without application JS')
  }
  assert.ok(!dom.window.document.querySelector('#login details')!.parentElement!.className.includes('lg:hidden'))
  dom.window.close()
})
test('source identity renders the same version on login and signed-in without invented build time', () => {
  identity = { kind: 'source', sourceHash: build.sourceHash, builtAt: null }; pathname = '/dashboard'
  const dom = new JSDOM(renderToStaticMarkup(app()))
  for (const id of ['login', 'signed-in']) {
    const surface = dom.window.document.getElementById(id)!
    assert.match(surface.querySelector('summary')!.textContent!, /Version a1234567890b/)
    assert.equal(surface.querySelector('dd')!.textContent, build.sourceHash)
    assert.equal(surface.querySelector('time'), null)
    assert.match(surface.textContent!, /source used for this compilation/)
    assert.doesNotMatch(surface.textContent!, /Development|Built \(UTC\)|production|deployment/i)
    surface.querySelector('summary')!.click()
    assert.equal(surface.querySelector('details')!.open, true)
  }
  dom.window.close()
})
test('title-hidden admin and team routes retain the visible version', () => {
  identity = build
  for (pathname of ['/admin/overview', '/settings/team', '/team-access']) {
    const dom = new JSDOM(renderToStaticMarkup(h(Topbar)))
    assert.equal(dom.window.document.querySelector('h1'), null)
    assert.match(dom.window.document.querySelector('summary')!.textContent!, /Version a1234567890b/)
    dom.window.close()
  }
})
test('development and unavailable identities are explicit on both surfaces', () => {
  pathname = '/dashboard'
  for (const [kind, label] of [['development', 'Development'], ['unavailable', 'Version unavailable']]) {
    identity = { kind, sourceHash: null, builtAt: null }
    const dom = new JSDOM(renderToStaticMarkup(app()))
    for (const id of ['login', 'signed-in']) {
      assert.equal(dom.window.document.querySelector(`#${id} [aria-label="Frontend site version"]`)!.textContent, label)
      assert.equal(dom.window.document.querySelector(`#${id} details`), null)
    }
    dom.window.close()
  }
})
for (const hydratedIdentity of [build, { kind: 'source', sourceHash: build.sourceHash, builtAt: null }]) test(`SSR hydration preserves ${hydratedIdentity.kind} identity without clocks or API calls`, async () => {
  identity = hydratedIdentity; pathname = '/dashboard'
  const dom = new JSDOM('<div id="root">' + renderToString(app()) + '</div>', { url: 'https://synthetic.invalid' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const errors: unknown[] = []; let root: any
  try {
    await React.act(async () => { root = hydrateRoot(dom.window.document.getElementById('root'), app(), { onRecoverableError: (error: unknown) => errors.push(error) }) })
    assert.deepEqual(errors, [])
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('dd')).map((node: any) => node.textContent).filter((value: string) => value === build.sourceHash), [build.sourceHash, build.sourceHash])
    assert.equal(dom.window.document.querySelectorAll('time').length, hydratedIdentity.kind === 'build' ? 2 : 0)
    if (hydratedIdentity.kind === 'source') assert.doesNotMatch(dom.window.document.body.textContent!, /Development|Built \(UTC\)/)
  } finally {
    if (root) await React.act(async () => root.unmount())
    for (const [key, descriptor] of Array.from(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key] }
    dom.window.close()
  }
})
// Optional local visual artifact; never fetched from a backend or published.
if (process.env.HAWKVIEW_VERSION_PREVIEW_DIR) {
  identity = build; pathname = '/dashboard'
  for (const [name, node] of [['login', h(Login)], ['topbar', h(Topbar)], ['details', h(SiteVersion)]]) {
    writeFileSync(resolve(process.env.HAWKVIEW_VERSION_PREVIEW_DIR, `${name}.html`), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body>' + renderToStaticMarkup(node) + '</body></html>')
  }
}
