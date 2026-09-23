import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import test from 'node:test'
import { syntheticRiskResponses } from './test-fixtures.ts'
const require = createRequire(import.meta.url)
const React = require('react')
const { JSDOM } = require('jsdom')
const { createRoot } = require('react-dom/client')
const ts = require('typescript')
const base = resolve(dirname(new URL(import.meta.url).pathname), '../..')
let nativeQuery: any; let microsoftQuery: any; let scope = 'synthetic'
const mocks: Record<string, any> = {
  '@/components/providers/auth-provider': { useAuth: () => ({ cacheScope: scope }) },
  './hooks': { useTenants: () => ({ data: { tenants: [{ id: 'tenant-a', name: 'Synthetic tenant' }] }, refetch() {} }) },
  './client': { apiClient: { get() { throw Error('Unexpected network') } } },
  '@tanstack/react-query': { useQueries: ({ queries }: any) => [queries[0].queryKey[3] === 'assessment' ? nativeQuery : microsoftQuery] },
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
    const file = [target, target + '.tsx', target + '.ts'].find(p => existsSync(p))!
    return load(file)
  }, exports)
  return exports
}
const Page = load(resolve(base, 'app/(protected)/risky-users/page.tsx')).default
const stamp = '2026-09-23T12:00:00.000Z'
function native(): any {
  return { version: 'hawkview-risky-users/v1', available: true,
    run: { windowStart: stamp, windowEnd: stamp, completedAt: stamp },
    collectors: [{ source: 'GRAPH_SIGN_INS', status: 'SUCCESS', lastSuccessfulCollectionAt: stamp }],
    coverage: [{ stream: 'GRAPH_SIGN_INS', coverage: { applies: 5, uninterpretedEvents: 0, notYetCitedEvents: 0 } }],
    count: { accuracy: 'EXACT', value: 0, scope: { evidenceRequested: ['GRAPH_SIGN_INS'], covered: ['repeated-credential-failure'], notCovered: [] } },
    subjectsNamed: true, claim: { permitted: true }, findings: { complete: true, items: [] } }
}
function microsoft(positive = false): any {
  return { ...syntheticRiskResponses().microsoftRiskyUsers, evaluatedAt: stamp, observedAt: stamp,
    users: positive ? [{ id: 'ms-only', identityLabel: 'Microsoft-only synthetic identity', riskLevel: 'high', riskState: 'atRisk', riskDetail: null, observedAt: stamp, correlation: null }] : [],
    microsoftRiskSummary: { source: 'MICROSOFT_IDENTITY_PROTECTION', availability: 'AVAILABLE', completeness: 'COMPLETE', rawRecordCount: positive ? 1 : 0,
      observedActiveDistinctUserCount: positive ? 1 : 0, activeDistinctUserCount: positive ? 1 : 0, snapshotObservedAt: stamp, collectionSucceededAt: stamp, reasonCode: null } }
}
test('actual payload → hook → page and drawer: clean, incomplete, Microsoft-only, retained and mounted expiry', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.invalid' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const originalNow = Date.now; let now = Date.parse(stamp); Date.now = () => now
  let tick: () => void = () => {}; dom.window.setInterval = ((callback: () => void) => { tick = callback; return 1 }) as any
  const root = createRoot(dom.window.document.getElementById('root'))
  const render = async (n: any, m: any) => { nativeQuery = { data: n }; microsoftQuery = { data: m }; await React.act(async () => root.render(React.createElement(Page))) }
  const body = () => dom.window.document.body.textContent ?? ''
  try {
    await render(native(), microsoft())
    assert.match(body(), /No users require review/)
    now += 2 * 60 * 60 * 1000 + 1
    await React.act(async () => tick())
    assert.match(body(), /coverage is incomplete/)
    assert.doesNotMatch(body(), /No users require review/)
    now = Date.parse(stamp); await React.act(async () => tick())
    await render(null, microsoft(true))
    assert.match(body(), /Microsoft-only synthetic identity/)
    assert.match(body(), /Current evidence/)
    const truncated = microsoft(); truncated.microsoftRiskSummary.rawRecordCount = 2; truncated.microsoftRiskSummary.activeDistinctUserCount = 2; truncated.microsoftRiskSummary.observedActiveDistinctUserCount = 2
    await render(native(), truncated)
    assert.match(body(), /coverage is incomplete/)
    assert.match(body(), /incomplete lists may omit other positives/)
    assert.match(body(), /Microsoft reports 2 identities; 0 details shown/)
    const nativeTruncated = native(); nativeTruncated.count.value = 7
    await render(nativeTruncated, microsoft())
    assert.match(body(), /HawkView reports 7 identities; 0 details shown/)
    await render(null, microsoft(true))
    let open = Array.from(dom.window.document.querySelectorAll('button')).find((button: any) => /Investigate/.test(button.textContent)) as any
    await React.act(async () => open.click())
    assert.match(body(), /Current evidence/)
    now += 37 * 60 * 60 * 1000
    await React.act(async () => tick())
    assert.match(body(), /Historical evidence/)
    assert.match(body(), /Retained risk report/)
    assert.doesNotMatch(body(), /Current evidence/)
    scope = 'different-account'
    await render(null, microsoft(true))
    assert.doesNotMatch(body(), /Retained risk report/, 'scope switch must close the drawer even for same row id')
    now = Date.parse(stamp); await React.act(async () => tick())
    const stale = microsoft(true); stale.status = 'STALE'; stale.freshness = 'STALE'; stale.limitation = 'Retained snapshot'
    await render(null, stale)
    assert.match(body(), /Historical evidence/)
    const investigate = Array.from(dom.window.document.querySelectorAll('button')).find((button: any) => /Investigate/.test(button.textContent)) as any
    assert.ok(investigate)
    await React.act(async () => investigate.click())
    assert.match(body(), /Retained risk report/)
    assert.match(body(), /Its present risk state is not confirmed/)
    assert.doesNotMatch(body(), /Current evidence/)
  } finally {
    await React.act(async () => root.unmount()); Date.now = originalNow
    for (const [key, descriptor] of Array.from(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key] }
    dom.window.close()
  }
})
