import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import test from 'node:test'
import type { TenantBundle, TenantSyncStatus, SyncOutcomeProjection } from '../types/tenant-data.ts'
const require = createRequire(import.meta.url)
const React = require('react')
const { JSDOM } = require('jsdom')
const { createRoot } = require('react-dom/client')
const ts = require('typescript')
const base = resolve(dirname(new URL(import.meta.url).pathname), '..')
const cache = new Map<string, any>()
function load(path: string): any {
  if (cache.has(path)) return cache.get(path)
  const exports: any = {}
  cache.set(path, exports)
  const js = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  new Function('require', 'exports', js)((name: string) => {
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name)
    const target = name.startsWith('@/') ? resolve(base, name.slice(2)) : resolve(dirname(path), name)
    const file = [target, target + '.tsx', target + '.ts'].find(p => existsSync(p))!
    return load(file)
  }, exports)
  return exports
}
const { deriveTenantWorkspaceDisplay } = load(resolve(base, 'lib/tenant-workspace-state.ts'))
const { TenantOverview } = load(resolve(base, 'app/(protected)/tenants/[id]/components/tenant-overview.tsx'))
const { ModuleHeader } = load(resolve(base, 'app/(protected)/tenants/[id]/components/module-header.tsx'))
const { projectSyncOutcome } = load(resolve(base, 'backend/src/tenants/sync-outcome-projection.ts'))
const stamp = '2026-09-29T12:00:00.000Z'
function keyFor(kind: SyncOutcomeProjection['recordedOutcome']['kind']) {
  return kind === 'LIMITED_COLLECTION_RECORDED' || kind === 'INITIALIZATION_WAIT_RECORDED' ? 'signIns'
    : kind === 'DEFERRED_WORK_RECORDED' ? 'm365Audit' : 'users'
}
function entry(kind: SyncOutcomeProjection['recordedOutcome']['kind'], status = 'running'): TenantSyncStatus {
  const key = keyFor(kind)
  const resource = key === 'signIns' ? 'SIGN_INS' : key === 'm365Audit' ? 'M365_AUDIT' : 'USERS'
  const raw = kind === 'AWAITING_EXECUTION' ? 'queued' : status
  const code = kind === 'LIMITED_COLLECTION_RECORDED' ? 'sign-ins-non-premium-fallback-active'
    : kind === 'INITIALIZATION_WAIT_RECORDED' ? 'sign-ins-audit-subscription-initializing'
      : kind === 'DEFERRED_WORK_RECORDED' ? 'm365-audit-backlog' : null
  return { status: raw, lastSuccessfulAt: stamp, lastError: null,
    outcomeProjection: projectSyncOutcome(resource, { status: raw.toUpperCase(), lastSuccessfulAt: new Date(stamp),
      lastAttemptAt: new Date(stamp), lastErrorCode: code }, new Date('2026-09-29T13:00:00.000Z')) }
}

function bundle(sync: TenantBundle['sync'], id = 'tenant-a'): TenantBundle {
  return { tenant: { id, status: 'connected' }, users: [], signIns: [], exchange: {}, sharepoint: {}, teams: {}, sync }
}
const healthy = { status: 'VERIFIED', items: [] }
async function mounted(run: (h: {
  render: (data: TenantBundle, options?: { manual?: boolean; health?: any; evidence?: any; freshness?: any }) => Promise<void>
  text: () => string; click: (label: string) => Promise<void>; document: any
}) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.invalid' })
  const saved = new Map(['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const root = createRoot(dom.window.document.getElementById('root'))
  try {
    await run({
      render: async (data, options = {}) => {
        const display = deriveTenantWorkspaceDisplay(data, options.manual ?? false, options.evidence ?? null, Object.prototype.hasOwnProperty.call(options, 'health') ? options.health : healthy)
        await React.act(async () => root.render(React.createElement(React.Fragment, null,
          React.createElement(ModuleHeader, { section: 'overview', display, freshness: options.freshness }),
          React.createElement(TenantOverview, { bundle: data, display, isSyncing: options.manual ?? false,
            onOpenModule: () => {}, onSync: () => {}, riskyUsers: React.createElement('p', null, `${data.tenant.id}: 2 identities require review`) }))))
      },
      text: () => dom.window.document.body.textContent,
      click: async label => {
        const button = [...dom.window.document.querySelectorAll('button')].find((b: any) => b.textContent === label) as any
        assert.ok(button, `Missing button: ${label}`)
        await React.act(async () => button.click())
      }, document: dom.window.document,
    })
  } finally {
    await React.act(async () => root.unmount())
    for (const [key, descriptor] of Array.from(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as any)[key]
    }
    dom.window.close()
  }
}
function noActiveClaim(text: string) {
  assert.doesNotMatch(text, /Collecting Microsoft 365|Synchronization (?:is )?in progress|Initial sync in progress|Collecting now|Populating progressively|All Microsoft 365 services and permissions are operating normally|Syncing/i)
}

test('composed overview renders optional partial, queued, deferred and unknown distinctly without claiming execution', async () => mounted(async h => {
  for (const [kind, state, phrase] of [
    ['LIMITED_COLLECTION_RECORDED', 'Partially Synchronized', 'Limited collection recorded'],
    ['AWAITING_EXECUTION', 'Health Not Verified', 'Collection queued'],
    ['DEFERRED_WORK_RECORDED', 'Health Not Verified', 'Deferred work recorded'],
    ['INITIALIZATION_WAIT_RECORDED', 'Health Not Verified', 'Initialization wait recorded'],
    ['UNKNOWN', 'Health Not Verified', 'Collection outcome unknown'],
  ] as const) {
    await h.render(bundle({ [keyFor(kind)]: entry(kind) }))
    assert.ok(h.text().includes(state))
    assert.doesNotMatch(h.text(), /Recorded synchronization results|View .*source details/)
    assert.doesNotMatch(h.text(), /No actionable issues reported|Resolve issue/)
    assert.match(h.text(), /2 identities require review/)
    assert.match(h.text(), /Last successful sync/)
    noActiveClaim(h.text())
  }
}))

test('composed overview keeps authoritative permission failure and manual request visible together', async () => mounted(async h => {
  const data = bundle({ users: entry('UNKNOWN'), teams: { ...entry('FAILED', 'failed'), lastError: '403 Forbidden' } })
  const health = { status: 'VERIFIED', items: [{ key: 'authorization-required', label: 'Required permission missing', severity: 'high', why: 'An independent permission verification failed.' }] }
  await h.render(data, { manual: true, health })
  assert.match(h.text(), /Needs Attention/)
  assert.match(h.text(), /2 actionable issues/)
  assert.match(h.text(), /Required permission missing/)
  assert.match(h.text(), /Synchronization request pending/)
  assert.match(h.text(), /collection needs review/)
  await h.click('Issue details')
  await h.click('Technical details')
  assert.match(h.text(), /independent permission verification failed/)
  noActiveClaim(h.text())
}))

test('composed freshness preserves stale, partial, timestamps and unknown activity simultaneously', async () => mounted(async h => {
  const data = bundle({ users: entry('UNKNOWN') })
  data.tenant.isStale = true
  const freshness = { service: 'office365', status: 'RUNNING', freshnessStatus: 'STALE',
    partialFailures: [{ collector: 'users', status: 'FAILED', message: 'Retained failure' }], lastSuccessfulCollectionAt: stamp }
  await h.render(data, { manual: true, freshness })
  assert.match(h.text(), /Stale/)
  assert.match(h.text(), /Last known data/)
  assert.match(h.text(), /Partial — 1 collector need attention/)
  assert.match(h.text(), /Stale data/)
  assert.match(h.text(), /Collector activity not verified/)
  assert.match(h.text(), /Updated/)
  noActiveClaim(h.text())
}))

test('mounted A -> B -> A removes drawer diagnostics and request display while preserving each tenant evidence', async () => mounted(async h => {
  const a = bundle({ users: { ...entry('FAILED', 'failed'), lastError: 'Tenant A diagnostic only' } })
  await h.render(a, { manual: true, health: null })
  // Use a verified actionable finding so the drawer follows the production health source.
  const attention = { status: 'VERIFIED', items: [{ key: 'sync-users', label: 'Tenant A failure', severity: 'high', why: 'Tenant A diagnostic only' }] }
  await h.render(a, { manual: true, health: attention })
  await h.click('Issue details')
  await h.click('Technical details')
  assert.ok(h.document.querySelector('[aria-label="Close remediation drawer"]'))
  assert.match(h.text(), /Tenant A diagnostic only/)
  const b = bundle({}, 'tenant-b')
  await h.render(b, { health: { status: 'UNAVAILABLE', items: [] } })
  assert.ok(h.document.querySelector('[aria-label="Close remediation drawer"]') === null, 'Previous tenant drawer must be cleared')
  assert.doesNotMatch(h.text(), /Tenant A|Synchronization request pending|tenant-a: 2/)
  assert.match(h.text(), /Health Not Verified/)
  assert.match(h.text(), /tenant-b: 2 identities require review/)
  const signIn = entry('UNKNOWN')
  signIn.outcomeProjection!.resourceType = 'SIGN_INS'
  signIn.lastSuccessfulAt = null
  a.sync = { signIns: signIn }
  await h.render(a, { evidence: { availability: 'CURRENT_LIMITED', coverage: 'LIMITED', selectedSource: 'OFFICE_365_ACTIVITY_FEED', observedAt: stamp, reasonCode: 'SIGN_IN_FALLBACK_ACTIVE', reason: 'Current limited audit evidence.' } })
  assert.match(h.text(), /Partially Synchronized/)
  assert.doesNotMatch(h.text(), /Tenant A diagnostic only|Collection outcome unknown|tenant-b: 2|Synchronization request pending|Initial collection is incomplete/)
  assert.ok(h.document.querySelector('[aria-label="Close remediation drawer"]') === null, 'Previous tenant drawer must be cleared')
  noActiveClaim(h.text())
}))

test('a verified successful record preserves positive health without a blanket service claim', async () => mounted(async h => {
  await h.render(bundle({ users: entry('SUCCEEDED', 'succeeded') }))
  assert.match(h.text(), /Healthy/)
  assert.doesNotMatch(h.text(), /Successful collection recorded|Recorded synchronization results/)
  await h.click('Active issues (0)')
  assert.match(h.text(), /No actionable issues reported/)
  assert.match(h.text(), /2 identities require review/)
  noActiveClaim(h.text())
}))

test('tenant page keys the entire workspace by account and tenant to isolate late requests', () => {
  const source = readFileSync(resolve(base, 'app/(protected)/tenants/[id]/page.tsx'), 'utf8')
  assert.match(source, /<TenantDetailsWorkspace key=\{JSON\.stringify\(\[cacheScope, params\?\.id\]\)\} \/>/)
  assert.match(source, /function TenantDetailsWorkspace\(\)/)
})

test('missing or malformed health renders not verified instead of a zero count, without hiding legacy diagnostics', async () => mounted(async h => {
  for (const health of [null, { status: 'BOGUS', items: [] }, { status: 'VERIFIED', items: null }, { status: 'VERIFIED', items: [{}] }]) {
    await h.render(bundle({ users: entry('UNKNOWN') }), { health })
    assert.match(h.text(), /Health Not Verified/)
    assert.match(h.text(), /Active issues \(Not verified\)/)
    assert.doesNotMatch(h.text(), /0 actionable issues|Active issues \(0\)|Active issues0/)
    await h.render(bundle({ users: { ...entry('FAILED', 'failed'), lastError: 'Legacy collection diagnostic' } }), { health })
    assert.match(h.text(), /collection needs review/)
    await h.click('Issue details')
    await h.click('Technical details')
    assert.match(h.text(), /Legacy collection diagnostic/)
    const close = h.document.querySelector('[aria-label="Close remediation drawer"]')
    await React.act(async () => close.click())
    assert.match(h.text(), /Active issues \(Not verified\)/)
    assert.doesNotMatch(h.text(), /0 actionable issues|Active issues \(0\)|Active issues0/)
  }
}))
