import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import test from 'node:test'
import { nativeRiskyUsersFixture } from './risky-users-ui-native-fixtures.ts'
import { adaptMicrosoftRiskyUsersResponse } from './adapter.ts'
import { syntheticRiskResponses } from './test-fixtures.ts'
const require = createRequire(import.meta.url)
const React = require('react')
const { JSDOM } = require('jsdom')
const { createRoot } = require('react-dom/client')
const ts = require('typescript')
const base = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const reads: Record<string, any> = {}
const cache = new Map<string, any>()
function load(path: string): any {
  if (cache.has(path)) return cache.get(path)
  const exports: any = {}
  cache.set(path, exports)
  const js = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  new Function('require', 'exports', js)((name: string) => {
    if (name === './risky-users-assessment-hooks') return { useNativeRiskyUsersRead: (tenantId: string) => reads[tenantId] }
    if (name === 'next/link') return { __esModule: true, default: ({ children, ...props }: any) => React.createElement('a', props, children) }
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name)
    const target = name.startsWith('@/') ? resolve(base, name.slice(2)) : resolve(dirname(path), name)
    return load([target, target + '.tsx', target + '.ts'].find(p => existsSync(p))!)
  }, exports)
  return exports
}
const { RiskyUsersOverviewRow } = load(resolve(base, 'components/identity-risk/risky-users-overview-row.tsx'))
const { TenantOverview } = load(resolve(base, 'app/(protected)/tenants/[id]/components/tenant-overview.tsx'))
const { deriveTenantWorkspaceDisplay } = load(resolve(base, 'lib/tenant-workspace-state.ts'))
function read() {
  return {
    nativeView: nativeRiskyUsersFixture(), assessmentLoading: false, assessmentRequestError: false,
    assessmentContractError: false, microsoftView: adaptMicrosoftRiskyUsersResponse(syntheticRiskResponses().microsoftRiskyUsers),
    microsoftLoading: false, cacheScope: 'synthetic', retryAssessment() {}, retryMicrosoft() {},
  }
}
async function mounted(run: (h: { render: (id: string, value: any, details?: boolean) => Promise<void>; row: () => any; text: () => string; dom: any }) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.invalid' })
  const saved = new Map(['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const root = createRoot(dom.window.document.getElementById('root'))
  const row = () => dom.window.document.querySelector('section[aria-labelledby="risky-users-overview-heading"]')
  try {
    await run({
      render: async (id, value, details = false) => {
        reads[id] = value
        const data = { tenant: { id, status: 'connected' }, users: [], signIns: [], exchange: {}, sharepoint: {}, teams: {}, sync: {} }
        const display = deriveTenantWorkspaceDisplay(data)
        await React.act(async () => root.render(React.createElement(TenantOverview, {
          bundle: data, display, onOpenModule() {}, riskyUsers: React.createElement(RiskyUsersOverviewRow, { tenantId: id, showCollectionDetails: details }),
        })))
      }, row, text: () => row().textContent, dom,
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
function compact(row: any, id: string) {
  assert.match(row.className, /flex flex-wrap items-center/)
  assert.match(row.className, /px-4 py-2\.5 text-sm/)
  assert.equal(row.querySelectorAll('h2').length, 1)
  assert.equal(row.querySelectorAll('a').length, 1)
  const link = row.querySelector('a')
  assert.equal(link.textContent, 'Review risky users')
  assert.equal(link.getAttribute('href'), `/tenants/${encodeURIComponent(id)}/risky-users`)
  assert.equal(row.querySelectorAll('ul, ol, table, details, button').length, 0)
  assert.doesNotMatch(row.innerHTML, /text-\[34px\]|text-\[20px\]|h-11|p-5|truncate|line-clamp/)
  assert.doesNotMatch(row.textContent, /What HawkView did find|Not covered by this number|Every reason it gave|all.clear|all users are safe/i)
}

test('compact overview keeps exact zero scoped and a positive count reviewable across tenants', async () => mounted(async h => {
  const a = read()
  await h.render('tenant-a', a)
  assert.match(h.text(), /1 identified/)
  assert.match(h.text(), /HawkView checks only/)
  compact(h.row(), 'tenant-a')
  const b = read(); b.nativeView.count.value = 0; b.nativeView.findings = []
  await h.render('tenant b/c', b)
  assert.match(h.text(), /0 identified/)
  assert.match(h.text(), /HawkView checks only/)
  assert.doesNotMatch(h.text(), /1 identified/)
  compact(h.row(), 'tenant b/c')
  assert.equal(h.row().querySelector('time'), null)
}))

test('compact overview distinguishes unknown, withheld, loading, read failure and unreadable response', async () => mounted(async h => {
  for (const [name, setup, expected] of [
    ['unknown', (r: any) => { r.nativeView = null }, /Finding total unavailable/],
    ['withheld', (r: any) => { r.nativeView.count.accuracy = 'NOT_AVAILABLE'; r.nativeView.count.value = null; r.nativeView.withheld = [{ stream: null, because: 'NEVER_COLLECTED' }] }, /Finding total unavailable/],
    ['loading', (r: any) => { r.assessmentLoading = true; r.nativeView = null }, /Loading assessment/],
    ['read-error', (r: any) => { r.assessmentRequestError = true }, /Not available — assessment request failed/],
    ['contract-error', (r: any) => { r.assessmentContractError = true }, /Not available — assessment response unreadable/],
  ] as const) {
    const value = read(); setup(value)
    await h.render(name, value)
    assert.match(h.text(), expected)
    assert.doesNotMatch(h.text(), /0 identified|1 identified/)
    compact(h.row(), name)
  }
}))

test('compact lower-bound and zero summaries retain coverage, findings and list warnings without expanding details', async () => mounted(async h => {
  const lower = read(); lower.nativeView.count.accuracy = 'AT_LEAST'; lower.nativeView.count.value = 4
  await h.render('lower', lower)
  assert.match(h.text(), /At least 4 identified/)
  assert.doesNotMatch(h.text(), /Coverage incomplete/)
  assert.doesNotMatch(h.text(), /Partial findings list/)
  compact(h.row(), 'lower')
  const zero = read(); zero.nativeView.count.value = 0; zero.nativeView.findings[0].subject.kind = 'MAILBOX'
  zero.nativeView.count.notCovered = [{ detectorId: 'external-mailbox-forwarding', because: 'DETECTOR_FAILED' }]
  await h.render('zero', zero)
  assert.match(h.text(), /0 identified/)
  assert.match(h.text(), /Findings present/)
  assert.doesNotMatch(h.text(), /Coverage incomplete/)
  compact(h.row(), 'zero')
  const missing = read(); missing.nativeView.findings = []
  await h.render('missing', missing)
  assert.match(h.text(), /1 identified/)
  assert.doesNotMatch(h.text(), /Findings list unavailable/)
}))

test('compact row preserves explicit stale and error warnings without turning another source into the HawkView count', async () => mounted(async h => {
  const stale = read(); stale.nativeView.count.value = 0; stale.nativeView.findings = []
  stale.microsoftView.meta.status = 'STALE'; stale.microsoftView.meta.freshness = 'STALE'
  await h.render('stale', stale)
  assert.match(h.text(), /0 identified/)
  assert.doesNotMatch(h.text(), /Microsoft evidence stale/)
  compact(h.row(), 'stale')
  const failed = read(); failed.microsoftView.meta.status = 'ERROR'
  await h.render('failed', failed)
  assert.match(h.text(), /1 identified/)
  assert.doesNotMatch(h.text(), /Microsoft evidence read failed/)
  compact(h.row(), 'failed')
}))

test('tenant overview routes to the compact row and detailed findings remain on the dedicated page', () => {
  const page = readFileSync(resolve(base, 'app/(protected)/tenants/[id]/page.tsx'), 'utf8')
  assert.match(page, /<RiskyUsersOverviewRow tenantId=\{resolvedTenantId\} \/>/)
  assert.doesNotMatch(page, /RiskyUsersCountCard/)
  assert.match(page, /<RiskyUsersSection tenantId=\{resolvedTenantId\} \/>/)
  const detail = readFileSync(resolve(base, 'components/identity-risk/risky-users-section.tsx'), 'utf8')
  assert.match(detail, /count\.caption/)
  assert.match(detail, /count\.known\.map/)
  assert.match(detail, /count\.gaps\.map/)
})

function positiveMicrosoft() {
  const wire = syntheticRiskResponses().microsoftRiskyUsers
  wire.users = [{ id: 'ms-1', identityLabel: 'Synthetic Microsoft identity', riskLevel: 'high', riskState: 'atRisk', riskDetail: null, observedAt: wire.observedAt }]
  const result = adaptMicrosoftRiskyUsersResponse(wire)
  assert.ok((result.users?.length ?? 0) > 0, 'Fixture must contain actual adapted Microsoft records')
  return result
}

test('pending Microsoft read retains a settled native lower bound, coverage, list warning and timestamp', async () => mounted(async h => {
  const value = read()
  value.microsoftLoading = true
  value.nativeView.count.accuracy = 'AT_LEAST'
  value.nativeView.count.value = 3
  value.nativeView.count.notCovered = [{ detectorId: 'external-mailbox-forwarding', because: 'DETECTOR_FAILED' }]
  await h.render('native-settled', value)
  assert.match(h.text(), /At least 3 identified/)
  assert.doesNotMatch(h.text(), /Coverage incomplete/)
  assert.doesNotMatch(h.text(), /Partial findings list/)
  assert.match(h.text(), /HawkView checks only/)
  assert.doesNotMatch(h.text(), /Loading Microsoft evidence/)
  assert.doesNotMatch(h.text(), /Loading assessment|Microsoft evidence unavailable/)
  assert.equal(h.row().querySelector('time'), null)
  compact(h.row(), 'native-settled')
}))

test('pending native read retains settled Microsoft positive records and its explicit stale warning', async () => mounted(async h => {
  const value: any = read()
  value.assessmentLoading = true
  value.nativeView = null
  value.microsoftView = positiveMicrosoft()
  value.microsoftView.meta.status = 'STALE'
  value.microsoftView.meta.freshness = 'STALE'
  await h.render('microsoft-settled', value)
  assert.match(h.text(), /Loading assessment/)
  assert.match(h.text(), /Microsoft risk records available/)
  assert.doesNotMatch(h.text(), /Microsoft evidence stale/)
  assert.doesNotMatch(h.text(), /0 identified|1 identified|Loading Microsoft evidence/)
  compact(h.row(), 'microsoft-settled')
}))

test('pending same-source retained data is not promoted to a current count or available Microsoft records', async () => mounted(async h => {
  const pendingNative = read()
  pendingNative.assessmentLoading = true
  pendingNative.nativeView.count.value = 9
  pendingNative.microsoftView = positiveMicrosoft()
  await h.render('pending-native-cache', pendingNative)
  assert.match(h.text(), /Loading assessment/)
  assert.match(h.text(), /Microsoft risk records available/)
  assert.doesNotMatch(h.text(), /9 identified|HawkView checks only/)
  assert.equal(h.row().querySelector('time'), null)

  const pendingMicrosoft = read()
  pendingMicrosoft.microsoftLoading = true
  pendingMicrosoft.microsoftView = positiveMicrosoft()
  pendingMicrosoft.microsoftView.meta.status = 'STALE'
  pendingMicrosoft.microsoftView.meta.freshness = 'STALE'
  await h.render('pending-ms-cache', pendingMicrosoft)
  assert.match(h.text(), /1 identified/)
  assert.doesNotMatch(h.text(), /Loading Microsoft evidence/)
  assert.doesNotMatch(h.text(), /Microsoft risk records available|Microsoft evidence stale/)

  const both = read(); both.assessmentLoading = true; both.microsoftLoading = true
  await h.render('both-pending', both)
  assert.match(h.text(), /Loading assessment/)
  assert.doesNotMatch(h.text(), /Loading Microsoft evidence/)
  assert.doesNotMatch(h.text(), /identified|Microsoft risk records available/)
}))

test('opt-in freshness page retains coverage, list, source warnings and assessment time', async () => mounted(async h => {
  const value = read(); value.nativeView.count.accuracy = 'AT_LEAST'; value.nativeView.count.value = 4
  value.microsoftView.meta.status = 'STALE'; value.microsoftView.meta.freshness = 'STALE'
  await h.render('details-tenant', value, true)
  assert.match(h.text(), /At least 4 identified/)
  assert.match(h.text(), /Coverage incomplete|Partial findings list/)
  assert.match(h.text(), /Microsoft evidence stale/)
  assert.ok(h.row().querySelector('time'))
  compact(h.row(), 'details-tenant')
  await h.render('details-tenant', value)
  assert.doesNotMatch(h.text(), /Coverage incomplete|Partial findings list|Microsoft evidence stale/)
  assert.equal(h.row().querySelector('time'), null)
}))
