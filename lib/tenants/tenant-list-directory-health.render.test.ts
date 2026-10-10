import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
const require = createRequire(import.meta.url)
const React = require('react'), { JSDOM } = require('jsdom'), { createRoot } = require('react-dom/client'), ts = require('typescript')
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query')
const h = React.createElement
const base = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const cache = new Map<string, any>()
const SCOPE_A = 'identity:subject-a:organizations:org-a'
const SCOPE_B = 'identity:subject-b:organizations:org-b'
const now = Date.parse('2026-10-10T01:00:00Z')
let clock = now, scope = SCOPE_A, generation = 'subject-a:0', authLoading = false
let authRenders: string[] = []
let reads: Array<{ endpoint: string; init: any }> = []
let sourceGet: (endpoint: string, init: any) => Promise<any>
let listGet: () => Promise<any>
const originalFetch = globalThis.fetch
before(() => { globalThis.fetch = async () => { throw Error('External network forbidden') } })
after(() => { globalThis.fetch = originalFetch })
function tenant(id = 'tenant-a', name = 'Alpha', provider = 'microsoft'): any {
  return { id, name, provider, domain: `${name.toLowerCase()}.invalid`, organization: { id: 'org-a', name: 'Workspace' },
    status: 'active', attention: [], data: { status: 'COMPLETE' }, lastSync: null, onboarding: { complete: true } }
}
function receipt(status = 'current', count = 2, ageMs = 60_000): any {
  const pair = status === 'not-activated' ? ['ACTIVATION_EVIDENCE_UNAVAILABLE', 'REVIEW_SOURCE_CONTROL']
    : status === 'superseded' ? ['STORED_CONTENT_MISMATCH', 'REREAD_OR_REPORT']
    : status === 'never-collected' ? ['NO_COMPLETE_RECEIPT', 'AWAIT_NORMAL_COLLECTION']
    : status === 'stale' ? ['COMPLETE_OBSERVATION_STALE', 'AWAIT_NORMAL_COLLECTION']
    : [count ? 'COMPLETE_OBSERVATION_CURRENT' : 'COMPLETE_EMPTY_CURRENT', 'NONE']
  return { responseVersion: 'directory-role-results/v1', source: 'Microsoft Graph v1.0 /roleManagement/directory/roleAssignments', status,
    observation: ['current', 'stale'].includes(status) ? {
      checkedAt: new Date(now - 60_000).toISOString(), ageMs, observedCount: count,
      assignments: Array.from({ length: count }, (_, i) => ({ id: `private-assignment-${i}`, roleDisplayName: 'Private role', principalId: null, roleDefinitionId: null, directoryScopeId: '/', appScopeId: null })),
      verifiedCompleteEmpty: count === 0,
    } : null, health: { version: 1, reasonCode: pair[0], recoveryCode: pair[1] }, latestAttempt: { outcome: null, terminalAt: null } }
}
const apiClient = {
  get: async (endpoint: string, init: any) => {
    if (endpoint === '/api/tenants') return listGet()
    assert.match(endpoint, /^\/api\/tenants\/[^/]+\/directory-roles\/results$/)
    assert.equal(init.cache, 'no-store'); assert.ok(init.signal instanceof AbortSignal)
    reads.push({ endpoint, init })
    return sourceGet(endpoint, init)
  },
  post: () => { throw Error('No mutation allowed') }, put: () => { throw Error('No mutation allowed') },
  patch: () => { throw Error('No mutation allowed') }, delete: () => { throw Error('No mutation allowed') },
}
function load(file: string): any {
  if (cache.has(file)) return cache.get(file)
  const exports: any = {}; cache.set(file, exports)
  const js = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  new Function('require', 'exports', js)((name: string) => {
    if (name === '@/components/providers/auth-provider') return { useAuth: () => {
      authRenders.push(scope)
      return { cacheScope: scope, isLoading: authLoading, currentIdentityToken: () => generation, session: { user: { memberships: [] } } }
    } }
    if (name === '@/lib/api/client' || (name === './client' && dirname(file) === resolve(base, 'lib/api'))) return { apiClient }
    if (name === 'next/navigation') return { useRouter: () => ({ push: () => { throw Error('Unexpected navigation') } }) }
    if (name === 'next/link') return { __esModule: true, default: ({ children, ...props }: any) => h('a', props, children) }
    // Unrelated, closed administration surfaces are outside this read-only entry point.
    if (name === '@/components/tenants/tenant-issue-drawer') return { TenantIssueDrawer: ({ isOpen }: any) => { assert.equal(isOpen, false); return null } }
    if (name === '@/components/tenants/tenant-onboarding-dialog') return { TenantOnboardingDialog: () => null }
    if (name === './directory-role-control') return { DirectoryRoleControl: () => { throw Error('Compact view must not mount collection control') } }
    if (name === './directory-role-export-button') return { DirectoryRoleExportButton: () => { throw Error('Compact view must not mount assignment export') } }
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name)
    const path = name.startsWith('@/') ? resolve(base, name.slice(2)) : resolve(dirname(file), name)
    const resolved = [path, path + '.tsx', path + '.ts'].find(candidate => existsSync(candidate))
    if (!resolved) throw Error(`Cannot resolve ${name} from ${file}`)
    return load(resolved)
  }, exports)
  return exports
}
const Page = load(resolve(base, 'app/(protected)/tenants/page.tsx')).default
async function waitFor(predicate: () => boolean, label: string) {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return
    await React.act(async () => { await new Promise(done => setTimeout(done, 0)) })
  }
  assert.fail(`Timed out: ${label}`)
}
function deferred() {
  let resolve!: (value: any) => void, reject!: (error: any) => void
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function mounted(run: (ctx: any) => Promise<void>, mode = 'list') {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.invalid/tenants' })
  const saved = new Map(['window', 'document', 'navigator', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, value })
  // Method shims witness calls only. Native containment/Escape generation/restoration are NOT tested.
  const modalCalls = { show: 0, close: 0 }
  dom.window.HTMLDialogElement.prototype.showModal = function () { modalCalls.show++; this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { modalCalls.close++; this.open = false }
  dom.window.localStorage.setItem('hawkview_tenants_view_mode', mode)
  const originalNow = Date.now; clock = now; Date.now = () => clock
  scope = SCOPE_A; generation = 'subject-a:0'; authLoading = false; authRenders = []; reads = []
  listGet = async () => ({ tenants: [tenant(), tenant('tenant-b', 'Beta'), tenant('google', 'Other', 'google')] })
  sourceGet = async () => receipt()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } } })
  // Preserve the accepted 60s cache across unmount in cache-specific tests (production default is 5m).
  client.setQueryDefaults(['directory-role-results'], { gcTime: 300_000 })
  const root = createRoot(dom.window.document.getElementById('root'))
  const tree = () => h(QueryClientProvider, { client }, h(Page))
  const render = () => React.act(async () => root.render(tree()))
  const doc = dom.window.document
  const action = (name = 'Alpha') => doc.querySelector(`button[aria-label="Directory health for ${name}"]`)
  const dialog = () => doc.querySelector('dialog')
  const click = (element: any) => React.act(async () => { assert.ok(element, 'click target exists'); element.click() })
  const open = async (name = 'Alpha') => { await waitFor(() => !!action(name), 'tenant list'); await click(action(name)) }
  try { await run({ doc, client, render, action, dialog, open, click, modalCalls, dom,
    text: () => dialog()?.textContent ?? '',
    ready: async () => { await render(); await waitFor(() => !!action(), 'tenant list') },
    batchIdentityRoundTrip: async () => React.act(async () => {
      scope = SCOPE_B; generation = 'subject-b:1'; root.render(tree())
      scope = SCOPE_A; generation = 'subject-a:2'; root.render(tree())
    }),
  }) }
  finally {
    await React.act(async () => root.unmount()); await client.cancelQueries(); client.clear()
    await React.act(async () => { await new Promise(done => setTimeout(done, 0)) })
    Date.now = originalNow
    for (const [key, descriptor] of Array.from(saved)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as any)[key]
    dom.window.close()
  }
}
for (const mode of ['list', 'tile']) test(`${mode}: real tenant page opens exactly one supported named read, closes and restores explicit focus`, async () => mounted(async ({ ready, doc, action, dialog, open, text, click, modalCalls }) => {
  await ready(); assert.match(doc.body.textContent, /No findings reported/); assert.match(doc.body.textContent, /No actions reported/); assert.equal(reads.length, 0); assert.equal(doc.querySelectorAll('button[aria-haspopup="dialog"]').length, 2)
  assert.equal(action('Other'), null)
  const trigger = action(); trigger.focus(); await open()
  await waitFor(() => text().includes('Complete observation: 2'), 'receipt')
  assert.equal(reads.length, 1); assert.equal(reads[0].endpoint, '/api/tenants/tenant-a/directory-roles/results')
  assert.equal(doc.querySelectorAll('dialog').length, 1)
  assert.equal(doc.getElementById(dialog().getAttribute('aria-labelledby')).textContent, 'Directory health — Alpha')
  assert.equal(doc.activeElement.getAttribute('aria-label'), 'Close directory health')
  assert.doesNotMatch(text(), /private-assignment|Private role/)
  assert.ok(dialog().querySelector('a[href="/tenants/tenant-a/entra?view=overview"]') || [...dialog().querySelectorAll('a')].some((a: any) => a.textContent.includes('Open Entra directory')))
  await click(doc.querySelector('button[aria-label="Close directory health"]'))
  assert.equal(Boolean(dialog()), false); assert.equal(doc.activeElement, trigger)
  assert.equal(modalCalls.show, 1); assert.equal(modalCalls.close, 1)
}, mode))
for (const [status, count, textExpected] of [
  ['current', 0, 'Verified complete-empty observation'], ['stale', 2, 'older than the one-hour'],
  ['not-activated', 0, 'activation evidence is unavailable'], ['never-collected', 0, 'No complete directory role observation'],
  ['superseded', 0, 'verified content or count'],
] as const) test(`actual compact parser/renderer preserves ${status}/${count}`, async () => mounted(async ({ ready, open, text }) => {
  sourceGet = async () => receipt(status, count, status === 'stale' ? 7_200_000 : 60_000)
  await ready(); await open(); await waitFor(() => text().includes(textExpected), status)
  assert.doesNotMatch(text(), /private-assignment|Private role/)
  assert.equal(reads.length, 1)
}))
for (const outcome of ['FAILED', 'PARTIAL', 'EXPIRED']) test(`latest ${outcome} remains separate from completed observation`, async () => mounted(async ({ ready, open, text, dialog }) => {
  sourceGet = async () => ({ ...receipt(), latestAttempt: { outcome, terminalAt: new Date(now).toISOString() } })
  await ready(); await open(); await waitFor(() => text().includes('Complete observation: 2'), outcome)
  assert.equal(dialog().querySelectorAll('time').length, 2)
  assert.match(text(), outcome === 'FAILED' ? /attempt failed/ : outcome === 'PARTIAL' ? /did not finish/ : /attempt expired/)
}))
for (const fail of ['malformed', 'rejected']) test(`${fail} does not become successful empty; stored retry uses the same GET`, async () => mounted(async ({ ready, open, text, click, dialog }) => {
  sourceGet = fail === 'malformed' ? async () => ({ status: 'current' }) : async () => { throw Error('Synthetic unavailable') }
  await ready(); await open(); await waitFor(() => text().includes('unavailable right now'), fail)
  assert.doesNotMatch(text(), /complete-empty|Complete observation/)
  sourceGet = async () => receipt('current', 0)
  await click([...dialog().querySelectorAll('button')].find((b: any) => b.textContent.includes('Try again')))
  await waitFor(() => text().includes('complete-empty'), 'recovered stored read'); assert.equal(reads.length, 2)
}))
test('encoded tenant id, dispatched native cancel handler and fresh/stale cache reopening', async () => mounted(async ({ ready, open, dialog, click, client, dom, doc, text, action }) => {
  listGet = async () => ({ tenants: [tenant('space/slash ?')] })
  await ready(); await open(); await waitFor(() => text().includes('Complete observation'), 'receipt')
  assert.equal(reads[0].endpoint, '/api/tenants/space%2Fslash%20%3F/directory-roles/results')
  await React.act(async () => dialog().dispatchEvent(new dom.window.Event('cancel', { cancelable: true })))
  assert.equal(Boolean(dialog()), false); assert.equal(doc.activeElement, action())
  await open(); assert.equal(reads.length, 1)
  await click(doc.querySelector('button[aria-label="Close directory health"]'))
  clock += 61_000; await open(); await waitFor(() => reads.length === 2, 'stale cached remount')
  assert.equal(client.getQueryCache().findAll({ queryKey: ['directory-role-results'] }).length, 1)
}))
test('closing and selecting another tenant aborts the first reader, late result cannot replace the new tenant', async () => mounted(async ({ ready, open, dialog, text, click, doc }) => {
  const old = deferred(); sourceGet = async endpoint => endpoint.includes('tenant-a') ? old.promise : receipt('current', 7)
  await ready(); await open(); assert.equal(reads.length, 1)
  await click(doc.querySelector('button[aria-label="Close directory health"]')); assert.equal(reads[0].init.signal.aborted, true)
  await open('Beta'); await waitFor(() => text().includes('Complete observation: 7'), 'replacement')
  await React.act(async () => old.resolve(receipt('current', 99)))
  assert.match(text(), /Directory health — Beta/); assert.doesNotMatch(text(), /99|Alpha/); assert.equal(doc.querySelectorAll('dialog').length, 1)
}))
for (const late of ['success', 'failure']) test(`visible A→B→A and late ${late} after new identity succeeded`, async () => mounted(async ({ ready, open, render, text, client, dialog }) => {
  const old = deferred(); sourceGet = async () => old.promise
  await ready(); await open(); assert.equal(reads.length, 1)
  scope = SCOPE_B; generation = 'subject-b:1'
  client.setQueryData(['tenants', scope], { tenants: [tenant('tenant-a', 'Replacement')] })
  await render(); assert.equal(Boolean(dialog()), false); assert.equal(reads[0].init.signal.aborted, true)
  sourceGet = async () => receipt('current', 7); await open('Replacement')
  await waitFor(() => text().includes('Complete observation: 7'), 'replacement success')
  await React.act(async () => late === 'success' ? old.resolve(receipt('current', 99)) : old.reject(Error('old failure')))
  assert.match(text(), /Replacement/); assert.doesNotMatch(text(), /Alpha|99|unavailable right now/)
  scope = SCOPE_A; generation = 'subject-a:2'; await render(); assert.equal(Boolean(dialog()), false)
}))
test('batched A0→B1→A2 never reopens without a click; the control verifies no intermediate B render', async () => mounted(async ({ ready, open, dialog, client, batchIdentityRoundTrip, text }) => {
  await ready(); await open(); await waitFor(() => text().includes('Complete observation'), 'initial observation')
  assert.ok(client.getQueryData(['tenants', SCOPE_A]).tenants.some((t: any) => t.id === 'tenant-a'))
  authRenders = []; const before = reads.length
  await batchIdentityRoundTrip()
  assert.ok(authRenders.length > 0); assert.equal(authRenders.includes(SCOPE_B), false, 'CONTROL PRECONDITION: B was never rendered')
  assert.equal(Boolean(dialog()), false, 'no unrequested dialog after a new identity generation returns to the same scope')
  assert.equal(reads.length, before)
}))
for (const change of ['scope-only', 'loading', 'signed-out', 'bootstrap', 'removed', 'list-error']) test(`${change} clears intent, including retained data, before it can reopen`, async () => mounted(async ({ ready, open, render, client, dialog, text, doc }) => {
  await ready(); await open(); await waitFor(() => text().includes('Complete observation'), 'initial')
  const trigger = doc.querySelector('button[aria-label="Directory health for Alpha"]')
  let explicitlyFocused = 0; trigger.focus = () => { explicitlyFocused++ }
  if (change === 'scope-only') { scope = 'identity:subject-a:organizations:org-other'; client.setQueryData(['tenants', scope], { tenants: [tenant()] }) }
  if (change === 'loading') authLoading = true
  if (change === 'signed-out') scope = 'signed-out'
  if (change === 'bootstrap') scope = 'identity:subject-a:bootstrap-pending'
  if (change === 'removed') await React.act(async () => client.setQueryData(['tenants', scope], { tenants: [] }))
  if (change === 'list-error') {
    listGet = async () => { throw Error('Retained list unavailable') }
    await React.act(async () => client.refetchQueries({ queryKey: ['tenants', scope] }))
    assert.ok(client.getQueryData(['tenants', scope]), 'error retains previous rows in cache')
  }
  await render(); assert.equal(Boolean(dialog()), false); assert.equal(explicitlyFocused, 0)
  scope = SCOPE_A; authLoading = false
  await React.act(async () => client.setQueryData(['tenants', scope], { tenants: [tenant()] }))
  await render(); assert.equal(Boolean(dialog()), false, 'invalidated intent must not silently return')
}))
test('current receipt ages stale on resume without a GET; manual reread reanchors', async () => mounted(async ({ ready, open, text, dom, dialog, click }) => {
  await ready(); await open(); await waitFor(() => text().includes('within the one-hour'), 'current')
  clock += 3_600_001
  await React.act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')))
  assert.match(text(), /older than the one-hour/); assert.equal(reads.length, 1)
  await click([...dialog().querySelectorAll('button')].find((b: any) => b.textContent.includes('Re-read stored results')))
  await waitFor(() => text().includes('within the one-hour'), 'reread'); assert.equal(reads.length, 2)
}))
