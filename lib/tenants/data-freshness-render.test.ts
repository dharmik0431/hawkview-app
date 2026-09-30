import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
const require = createRequire(import.meta.url)
const React = require('react'), { JSDOM } = require('jsdom'), { createRoot } = require('react-dom/client'), ts = require('typescript')
const base = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const h = React.createElement, cache = new Map<string, any>()
const now = Date.parse('2026-09-30T16:00:00Z')
const at = (hours: number) => new Date(now - hours * 3600000).toISOString()
let tenantId = 'tenant-a', projection: any, bundleQuery: any, retries = 0
function load(file: string): any {
  if (cache.has(file)) return cache.get(file)
  const exports: any = {}; cache.set(file, exports)
  const js = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  new Function('require', 'exports', js)((name: string) => {
    if (name === 'next/navigation') return { useParams: () => ({ id: tenantId }) }
    if (name === 'next/link') return { __esModule: true, default: ({ children, ...props }: any) => h('a', props, children) }
    if (name === '@/components/providers/feature-flag-provider') return { useFeatureFlags: () => ({ identityRiskUi: false }) }
    if (name === '@/lib/api/hooks') return { useTenantOperationalProjection: () => projection, useTenantBundle: () => bundleQuery }
    if (name === '@/components/identity-risk/risky-users-overview-row') return { RiskyUsersOverviewRow: () => { throw Error('Feature disabled') } }
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name)
    const path = name.startsWith('@/') ? resolve(base, name.slice(2)) : resolve(dirname(file), name)
    return load([path, path + '.tsx', path + '.ts'].find(existsSync)!)
  }, exports)
  return exports
}
const Page = load(resolve(base, 'app/(protected)/tenants/[id]/data-freshness/page.tsx')).default
const { DataFreshnessDetails } = load(resolve(base, 'components/tenant/data-freshness-details.tsx'))
const { DataFreshnessLink } = load(resolve(base, 'components/tenant/data-freshness-link.tsx'))
const { datasetCadence } = load(resolve(base, 'lib/tenants/dataset-cadence.ts'))
const { datasetAge } = load(resolve(base, 'lib/tenants/dataset-age.ts'))
function readiness(observedAt: any = at(16), state = 'READY') {
  const dataset = { key: 'app_registrations', label: 'App registrations', tier: 'CORE', state, permissionStatus: 'CONFIRMED', permissions: [{ resource: 'MICROSOFT_GRAPH', name: 'Application.Read.All', type: 'APPLICATION', consentMode: 'DEFAULT', grantStatus: 'CONFIRMED' }], permissionMatch: 'ALL', evidenceMode: 'RESOURCE_STATE', licensePrerequisite: { kind: 'NONE', state: 'NOT_REQUIRED' }, fallbackDatasetKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['APPLICATIONS'], endpointPatterns: [], documentationUrl: 'https://learn.microsoft.com/graph/api/application-list', lastAttemptAt: at(1), lastSuccessfulAt: observedAt, freshness: 'CURRENT', reasonCode: state === 'READY' ? null : 'APPLICATION_ACCESS_DENIED', reason: state === 'READY' ? null : 'Microsoft denied application inventory access.', remediation: 'Confirm Application.Read.All admin consent.' }
  return { accessContractVersion: 1, overallState: state, workloads: [{ key: 'apps', workload: 'Applications', state, configuredCapability: 'CONFIGURED', permissionStatus: 'CONFIRMED', freshness: 'CURRENT', remediation: 'Review application access.', datasets: [dataset] }] }
}
function reset(value = readiness()) {
  tenantId = 'tenant-a'; retries = 0
  projection = { status: 'READY', tenant: { id: tenantId, name: 'Contoso', collectionReadiness: value }, refetch: () => { retries++ } }
  bundleQuery = { data: { bundle: { tenant: { id: tenantId }, sync: { applications: { lastSuccessfulAt: at(16) }, groups: { lastSuccessfulAt: at(5) }, licenses: { lastSuccessfulAt: at(2) } }, licenses: { rows: [] } } }, isLoading: false, isError: false, refetch: () => { retries++ } }
}
async function mounted(run: (ctx: any) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.invalid' })
  const saved = new Map(['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, value })
  const originalNow = Date.now; Date.now = () => now
  const root = createRoot(dom.window.document.getElementById('root')); reset()
  try { await run({ render: async (element = h(Page)) => React.act(async () => root.render(element)), doc: dom.window.document, text: () => dom.window.document.body.textContent }) }
  finally { await React.act(async () => root.unmount()); Date.now = originalNow; for (const [key, descriptor] of Array.from(saved)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as any)[key]; dom.window.close() }
}
for (const [hours, expected] of [[16, 'within'], [24, 'due'], [24 + 1 / 3600000, 'overdue'], [27, 'overdue']] as const) test(`daily source rendered boundary ${hours}h`, async () => mounted(async ({ render, doc }) => {
  reset(readiness(at(hours))); await render()
  const article = [...doc.querySelectorAll('article')].find((el: any) => el.querySelector('h3')?.textContent === 'App registrations') as any
  assert.ok(article); assert.match(article.textContent, /Expected daily \(24 hours\)/)
  assert.equal(/Outdated/.test(article.textContent), expected === 'overdue')
  assert.equal(/Collection due/.test(article.textContent), expected === 'due')
  assert.ok(article.querySelector(`time[datetime="${at(hours)}"]`))
  assert.match(article.textContent, expected === 'within' ? /Next due:/ : expected === 'due' ? /Due now:/ : /Due since:/)
  assert.doesNotMatch(article.textContent, /Next action:|retry collection|26 hours/)
  assert.ok(article.querySelector('details summary'))
}))
for (const observedAt of [null, 'invalid', '2026-02-30T00:00:00Z', at(-1)]) test(`unknown/future collection ${observedAt}`, async () => mounted(async ({ render, doc }) => {
  reset(readiness(observedAt)); await render()
  const article = doc.querySelector('section[aria-label="Applications"] article')
  assert.match(article.textContent, /Update time unavailable/)
  assert.doesNotMatch(article.textContent, /Outdated|Collection due|Next due:/)
}))
test('recent success never erases exact failure, permission, license and recovery details', async () => mounted(async ({ render, doc }) => {
  const raw = readiness(at(1), 'BLOCKED_PERMISSION')
  raw.workloads[0].datasets[0].permissionStatus = 'MISSING'; raw.workloads[0].datasets[0].permissions[0].grantStatus = 'MISSING'
  raw.workloads[0].datasets[0].licensePrerequisite = { kind: 'ENTRA_ID_P2', state: 'NOT_LICENSED' }
  reset(raw); await render()
  const article = doc.querySelector('section[aria-label="Applications"] article')
  assert.match(article.textContent, /Updated 1 hour ago/)
  assert.match(article.textContent, /Microsoft denied application inventory access/)
  assert.match(article.textContent, /APPLICATION_ACCESS_DENIED/)
  assert.match(article.textContent, /Application.Read.All: Missing/)
  assert.match(article.textContent, /Entra Id P2 · Not Licensed/)
  assert.match(article.textContent, /Next action: Confirm Application.Read.All admin consent/)
}))
test('tenant switch, retained failed reads, loading, malformed contract and retry never reveal other tenant data', async () => mounted(async ({ render, doc, text }) => {
  await render(); assert.match(text(), /Contoso|App registrations/)
  tenantId = 'tenant b/c'; await render(); assert.doesNotMatch(text(), /Contoso|Updated 16 hours ago|Applications/)
  assert.equal(doc.querySelector('a').getAttribute('href'), '/tenants/tenant%20b%2Fc/overview')
  tenantId = 'tenant-a'; projection.status = 'UNAVAILABLE'; bundleQuery.isError = true; await render()
  assert.doesNotMatch(text(), /Contoso|Updated 16 hours ago|Applications/)
  await React.act(async () => [...doc.querySelectorAll('button')].find((el: any) => el.textContent === 'Retry collection details').click()); assert.equal(retries, 1)
  projection.status = 'LOADING'; bundleQuery.isLoading = true; await render(); assert.match(text(), /Loading collection details/); assert.doesNotMatch(text(), /Contoso|Updated 16 hours ago/)
  reset(); projection.tenant.collectionReadiness = { accessContractVersion: 9, workloads: [] }; await render(); assert.match(text(), /Collection details unavailable/)
  reset(); await render(); assert.match(text(), /Contoso/)
}))
test('inventory clocks retain independent sources on the dedicated page', async () => mounted(async ({ render, doc }) => {
  await render(h(DataFreshnessDetails, { bundle: bundleQuery.data.bundle }))
  const articles = [...doc.querySelectorAll('article')]
  for (const [source, stamp] of [['App registrations', at(16)], ['Groups', at(5)], ['License inventory', at(2)]]) {
    const article: any = articles.find((el: any) => el.querySelector('h3')?.textContent === source)
    assert.ok(article.querySelector(`time[datetime="${stamp}"]`))
  }
  assert.match(doc.body.textContent, /License activityUpdate time unavailable/)
}))
test('navigation remains tenant encoded, visible and keyboard reachable', async () => mounted(async ({ render, doc }) => {
  await render(h(DataFreshnessLink, { tenantId: 'a/b c' }))
  const link = doc.querySelector('a'); assert.equal(link.textContent, 'Data freshness'); assert.equal(link.getAttribute('href'), '/tenants/a%2Fb%20c/data-freshness')
  link.focus(); assert.equal(doc.activeElement, link)
  await render(h(DataFreshnessLink, { tenantId: 'tenant-b' })); assert.equal(doc.querySelector('a').getAttribute('href'), '/tenants/tenant-b/data-freshness')
}))
test('daily mappings include optional Exchange admin configuration; activity is never treated as daily', () => {
  assert.equal(datasetCadence(['EXCHANGE_MAILBOX_CONFIGURATION']).dueAfterMs, 86400000)
  for (const resource of ['SIGN_INS', 'AUDIT_LOGS', 'M365_AUDIT', 'FUTURE_RESOURCE']) assert.equal(datasetCadence([resource]).outdatedAfterMs, null)
  assert.equal(datasetAge({ source: 'Activity', observedAt: at(6) }, now).outdated, true)
})
test('all primary module age strips stay relocated and Sync headers link to freshness', () => {
  const sections = ['app-registrations', 'enterprise-apps', 'entra-overview', 'entra', 'exchange', 'groups', 'licenses', 'license-activity', 'sharepoint', 'signins', 'dns']
  for (const section of sections) assert.doesNotMatch(readFileSync(resolve(base, `app/(protected)/tenants/[id]/components/sections/${section}-section.tsx`), 'utf8'), /<SectionFreshness|Data coverage & freshness/, section)
  for (const file of ['app/(protected)/tenants/[id]/page.tsx', 'app/(protected)/tenants/[id]/components/sections/exchange-section.tsx', 'app/(protected)/tenants/[id]/components/sections/sharepoint-section.tsx']) assert.match(readFileSync(resolve(base, file), 'utf8'), /<DataFreshnessLink tenantId=/)
  assert.doesNotMatch(readFileSync(resolve(base, 'app/(protected)/tenants/[id]/components/module-header.tsx'), 'utf8'), /Coverage:|Freshness:/)
})

test('mixed source page remains readable with access detail available on demand', async () => mounted(async ({ render, doc, text }) => {
  const raw = readiness(at(16))
  const denied = readiness(at(25), 'BLOCKED_PERMISSION').workloads[0].datasets[0]
  denied.key = 'group_inventory'; denied.label = 'Groups'; denied.resourceTypes = ['GROUPS']
  denied.reason = 'GroupMember.Read.All has not been granted.'; denied.remediation = 'Ask a Microsoft administrator to grant GroupMember.Read.All.'
  raw.workloads[0].datasets.push(denied)
  reset(raw); await render()
  assert.match(text(), /Expected daily/); assert.match(text(), /GroupMember.Read.All has not been granted/)
  assert.equal(doc.querySelectorAll('h1').length, 1)
  for (const details of doc.querySelectorAll('details')) assert.equal(details.open, false)
  if (process.env.HAW38_VISUAL_OUT) writeFileSync(resolve(process.env.HAW38_VISUAL_OUT, 'data-freshness.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="styles.css"></head><body class="bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">' + doc.getElementById('root').innerHTML + '</body></html>')
}))

test('actual page reads the API bundle envelope and rejects a mismatched snapshot tenant', async () => mounted(async ({ render, doc }) => {
  await render()
  const snapshots = () => [...doc.querySelectorAll('section')].find((section: any) => section.querySelector('h2')?.textContent === 'Displayed inventory snapshots') as any
  assert.ok(snapshots().querySelector(`time[datetime="${at(5)}"]`), 'Groups snapshot must appear from data.bundle')
  bundleQuery.data.bundle.tenant.id = 'other-tenant'; await render()
  assert.match(snapshots().textContent, /Snapshot times unavailable/)
  assert.equal(snapshots().querySelector('time'), null)
  bundleQuery.data.bundle.tenant.id = tenantId; await render()
  assert.ok(snapshots().querySelector(`time[datetime="${at(5)}"]`))
}))
