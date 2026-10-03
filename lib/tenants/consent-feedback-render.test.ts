import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const React = require('react')
const { JSDOM } = require('jsdom')
const { createRoot } = require('react-dom/client')
const ts = require('typescript')
const base = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
let tenantId = A
let get: (path: string) => Promise<unknown>
let post: (path: string) => Promise<unknown>
let opened: string[] = []
let popup: object | null = {}
let root: any
let container: HTMLElement
let dom: any
const callbacks: string[] = []
const queryClient = { fetchQuery: async () => null, invalidateQueries: async () => {} }
const TabsContext = React.createContext(null)

// Render the actual pages, schemas and view helpers. Only external boundaries,
// unrelated child workflows and the Tabs primitive are replaced.
const mocks: Record<string, any> = {
  'next/navigation': {
    useParams: () => ({ id: tenantId }),
    useSearchParams: () => new URLSearchParams(window.location.search),
    useRouter: () => ({ push: (path: string) => callbacks.push(path), replace: (path: string) => callbacks.push(path) }),
  },
  'next/link': { __esModule: true, default: ({ children, ...props }: any) => React.createElement('a', props, children) },
  '@/lib/api/client': { apiClient: { get: (path: string) => get(path), post: (path: string) => post(path) } },
  '@tanstack/react-query': { useQueryClient: () => queryClient },
  '@/components/providers/auth-provider': { useAuth: () => ({ session: { user: { id: 'fixture-user', memberships: [] } } }) },
  '@/lib/api/hooks': { useTenantOperationalProjection: () => ({ actionableHealth: { status: 'UNAVAILABLE', items: [] }, tenant: { id: tenantId, name: `Tenant ${tenantId}`, connectionStatus: 'pending' }, refetch: async () => {} }) },
  '@/components/tenant/customer-evidence-details': { CustomerEvidenceDetails: () => null },
  '@/components/tenants/exchange-readonly-setup': { ExchangeReadonlySetup: () => null },
  '@/components/ui/tabs': {
    Tabs: ({ value, onValueChange, children }: any) => React.createElement(TabsContext.Provider, { value: { value, onValueChange } }, children),
    TabsList: ({ children }: any) => React.createElement('div', null, children),
    TabsTrigger: ({ value, children }: any) => {
      const context = React.useContext(TabsContext)
      return React.createElement('button', { role: 'tab', onClick: () => context.onValueChange(value) }, children)
    },
    TabsContent: ({ value, children }: any) => React.useContext(TabsContext).value === value ? React.createElement('div', null, children) : null,
  },
}
const cache = new Map<string, any>()
function load(path: string): any {
  if (cache.has(path)) return cache.get(path)
  const exports: any = {}; cache.set(path, exports)
  const js = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText
  new Function('require', 'exports', js)((name: string) => {
    if (mocks[name]) return mocks[name]
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name)
    const target = name.startsWith('@/') ? resolve(base, name.slice(2)) : resolve(dirname(path), name)
    const file = [target, target + '.ts', target + '.tsx'].find(existsSync)
    assert.ok(file, `module ${name}`)
    return load(file)
  }, exports)
  return exports
}
const Onboarding = load(resolve(base, 'app/(protected)/tenants/[id]/onboarding/page.tsx')).default
const Settings = load(resolve(base, 'app/(protected)/tenants/[id]/settings/page.tsx')).default
const consent = { consentUrl: 'https://login.microsoftonline.com/synthetic/adminconsent', requiredPermissions: [] }
function onboarding(id = tenantId): any {
  return { version: 1, tenant: { id, name: `Tenant ${id}`, primaryDomain: 'synthetic.invalid', microsoftTenantId: id },
    completedAt: null, canFinish: false, steps: {
      microsoftAccess: { required: true, status: 'CONSENT_REQUIRED', errorCode: null, errorMessage: null },
      exchangeReadOnly: { required: false, status: 'CONSENT_REQUIRED', enabledAt: null, deferredAt: null,
        permission: 'Exchange.ManageAsAppV2', capability: 'Get-Mailbox only', disclaimer: 'Synthetic limitation.' },
      reportVisibility: { required: false, status: 'CHECK_REQUIRED', identifiersVisible: null, lastCheckedAt: null, deferredAt: null,
        permission: 'ReportSettings.Read.All', adminCenterUrl: 'https://admin.microsoft.com/#/Settings/Services',
        settingPath: ['Settings', 'Org settings', 'Services', 'Reports'], settingLabel: 'Conceal user, group, and site names in all reports', disclaimer: 'Synthetic limitation.' },
    } }
}
function deferred() {
  let resolve!: (value: any) => void; let reject!: (error: Error) => void
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const callbackCopy = 'Microsoft administrator consent could not be verified.'
const alerts = () => Array.from(container.querySelectorAll('[role="alert"]')).map((el) => el.textContent).join('\n')
function button(text: string | RegExp) {
  const el = Array.from(container.querySelectorAll('button')).find((node) => typeof text === 'string' ? node.textContent?.trim() === text : text.test(node.textContent ?? ''))
  assert.ok(el, `button ${text}: ${container.textContent}`); return el
}
async function click(text: string | RegExp) { await React.act(async () => button(text).click()) }
async function render(Page: any) { await React.act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Page)))) }
async function mount(Page: any, search = '') {
  tenantId = A; opened = []; popup = {}; callbacks.length = 0
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: `https://hawkview.test/tenants/${A}/${Page === Onboarding ? 'onboarding' : 'settings'}${search}` })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true })
  window.open = ((url: string) => { opened.push(url); return popup }) as any
  container = document.getElementById('root')!
  root = createRoot(container)
  await render(Page)
}
async function cleanup() { if (root) await React.act(async () => root.unmount()); dom?.window.close(); root = null }
async function switchTenant(Page: any, id = B) {
  tenantId = id; window.history.replaceState({}, '', `/tenants/${id}/${Page === Onboarding ? 'onboarding' : 'settings'}`)
  await render(Page)
}
function defaults() {
  get = async path => path.endsWith('/onboarding') ? onboarding() : { bundle: { tenant: { id: tenantId } } }
  post = async () => consent
}

test('callback failure survives successful load and Strict Mode query cleanup', async () => {
  defaults()
  try {
    await mount(Onboarding, '?microsoftConsent=error&error=denied')
    assert.ok(container.textContent?.includes(`Tenant ${A}`))
    assert.ok(alerts().includes(callbackCopy)); assert.equal(window.location.search, '')
    await render(Onboarding); assert.ok(alerts().includes(callbackCopy))
    await click('Dismiss consent message'); assert.equal(alerts(), '')
  } finally { await cleanup() }
})
test('callback and load failures remain distinct; successful reload clears only load failure', async () => {
  defaults(); get = async () => { throw Error('synthetic unavailable') }
  try {
    await mount(Onboarding, '?microsoftConsent=error&error=denied')
    assert.ok(alerts().includes(callbackCopy)); assert.match(alerts(), /Tenant setup could not be loaded/)
    const next = deferred(); get = () => next.promise
    await click('Reload'); assert.ok(alerts().includes(callbackCopy)); assert.doesNotMatch(alerts(), /Tenant setup could not be loaded/)
    await React.act(async () => next.reject(Error('still unavailable')))
    assert.ok(alerts().includes(callbackCopy)); assert.match(alerts(), /Tenant setup could not be loaded/)
    get = async () => onboarding(); await click('Reload')
    assert.ok(alerts().includes(callbackCopy)); assert.doesNotMatch(alerts(), /Tenant setup could not be loaded/)
  } finally { await cleanup() }
})
test('tenant switch removes callback feedback and discards prior tenant load completion', async () => {
  defaults(); const old = deferred(); get = () => old.promise
  try {
    await mount(Onboarding, '?microsoftConsent=error&error=denied')
    assert.ok(alerts().includes(callbackCopy))
    get = async () => onboarding(B); await switchTenant(Onboarding)
    await React.act(async () => old.resolve(onboarding(A)))
    assert.ok(container.textContent?.includes(`Tenant ${B}`)); assert.ok(!container.textContent?.includes(`Tenant ${A}`))
    assert.equal(alerts(), '')
    await switchTenant(Onboarding, A); assert.equal(alerts(), '')
  } finally { await cleanup() }
})
test('successful callback still notifies its opener without rendering a failure', async () => {
  defaults()
  const messages: unknown[] = []
  try {
    await mount(Onboarding)
    await React.act(async () => root.unmount()); root = createRoot(container)
    Object.defineProperty(window, 'opener', { configurable: true, value: { closed: false, postMessage: (...args: unknown[]) => messages.push(args) } })
    window.close = () => {}
    window.history.replaceState({}, '', `?microsoftConsent=success&tenantId=${A}`)
    await render(Onboarding)
    assert.ok(messages.length > 0); assert.equal(alerts(), '')
    assert.equal((messages[0] as any)[0].tenantId, A)
    assert.equal((messages[0] as any)[1], 'https://hawkview.test')
  } finally { await cleanup() }
})
for (const entry of ['banner', 'overview', 'permissions', 'administration']) {
  test(`settings rejected POST has visible feedback from ${entry}`, async () => {
    defaults(); post = async () => { throw Error('synthetic unavailable') }
    try {
      await mount(Settings)
      if (entry === 'permissions') await click(/^Permissions/)
      if (entry === 'administration') await click(/^Administration/)
      await click(entry === 'banner' ? 'Review & Authorize' : /Review [Pp]ermissions/)
      assert.match(alerts(), /Microsoft consent workflow is unavailable/); assert.equal(opened.length, 0)
      assert.equal(button('Review & Authorize').disabled, false)
    } finally { await cleanup() }
  })
}
for (const [name, response] of [
  ['missing URL', { requiredPermissions: [] }], ['invalid URL', { ...consent, consentUrl: 'not-a-url' }],
  ['unsafe URL scheme', { ...consent, consentUrl: 'javascript:alert(1)' }], ['invalid permission shape', { consentUrl: consent.consentUrl }],
] as const) {
  test(`settings ${name} produces visible failure and no popup`, async () => {
    defaults(); post = async () => response
    try {
      await mount(Settings); await click('Review & Authorize')
      assert.match(alerts(), /Microsoft consent returned an invalid response/); assert.equal(opened.length, 0)
      assert.equal(container.querySelector('a[href="' + consent.consentUrl + '"]'), null)
    } finally { await cleanup() }
  })
}
test('blocked popup exposes validated user-activated recovery without claiming consent completed', async () => {
  defaults()
  try {
    await mount(Settings); popup = null; await click('Review & Authorize')
    assert.match(alerts(), /consent window could not be opened/)
    const link = Array.from(container.querySelectorAll('a')).find(el => el.textContent === 'Open Microsoft consent')!
    assert.ok(link); assert.equal(link.href, consent.consentUrl); assert.equal(link.target, '_blank')
    assert.match(link.rel, /noopener/); assert.match(link.rel, /noreferrer/)
    assert.equal(opened.length, 1); assert.doesNotMatch(alerts(), /completed|verified|authorized successfully/i)
    popup = {}; await click('Review & Authorize')
    assert.doesNotMatch(alerts(), /consent window could not be opened/)
    assert.equal(container.querySelector(`a[href="${consent.consentUrl}"]`), null); assert.equal(opened.length, 2)
  } finally { await cleanup() }
})
test('retry clears rejected-action feedback; valid popup is not reported blocked or completed', async () => {
  defaults(); post = async () => { throw Error('synthetic unavailable') }
  try {
    await mount(Settings); await click('Review & Authorize'); assert.match(alerts(), /workflow is unavailable/)
    post = async () => consent; await click('Review & Authorize')
    assert.doesNotMatch(alerts(), /workflow is unavailable|consent window could not be opened/)
    assert.deepEqual(opened, [consent.consentUrl])
    assert.doesNotMatch(container.textContent ?? '', /consent (completed|verified|succeeded)/i)
  } finally { await cleanup() }
})
for (const outcome of ['resolve', 'reject']) {
  test(`old-tenant ${outcome} cannot open a popup or overwrite current tenant feedback`, async () => {
    defaults(); const old = deferred(); let calls = 0; post = () => { calls++; return old.promise }
    try {
      await mount(Settings)
      await React.act(async () => { button('Review & Authorize').click(); button('Review & Authorize').click() })
      assert.equal(calls, 1)
      await switchTenant(Settings)
      post = async () => { if (outcome === 'resolve') throw Error('current tenant unavailable'); return consent }
      await click('Review & Authorize')
      if (outcome === 'resolve') assert.match(alerts(), /workflow is unavailable/)
      else assert.doesNotMatch(alerts(), /workflow is unavailable/)
      await React.act(async () => outcome === 'resolve' ? old.resolve(consent) : old.reject(Error('old failed')))
      if (outcome === 'resolve') assert.match(alerts(), /workflow is unavailable/)
      else assert.doesNotMatch(alerts(), /workflow is unavailable/)
      assert.equal(opened.length, outcome === 'resolve' ? 0 : 1)
      assert.equal(button('Review & Authorize').disabled, false)
      await switchTenant(Settings, A); assert.doesNotMatch(alerts(), /workflow is unavailable/)
    } finally { await cleanup() }
  })
}
test('unmounted settings action cannot open the consent popup', async () => {
  defaults(); const pending = deferred(); post = () => pending.promise
  try {
    await mount(Settings); await click('Review & Authorize')
    await React.act(async () => root.unmount()); root = null
    await React.act(async () => pending.resolve(consent)); assert.equal(opened.length, 0)
  } finally { await cleanup() }
})
