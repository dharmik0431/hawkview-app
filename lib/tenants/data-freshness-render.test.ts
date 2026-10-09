import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
const originalFetch = globalThis.fetch
before(() => { globalThis.fetch = async () => { throw new Error('External network forbidden') } })
after(() => { globalThis.fetch = originalFetch })
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
const require = createRequire(import.meta.url)
const React = require('react'), { JSDOM } = require('jsdom'), { createRoot } = require('react-dom/client'), ts = require('typescript')
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query')
const base = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const h = React.createElement, cache = new Map<string, any>()
const now = Date.parse('2026-09-30T16:00:00Z')
const at = (hours: number) => new Date(now - hours * 3600000).toISOString()
const SCOPE_A = 'identity:subject-a:organizations:org-1'
const SCOPE_B = 'identity:subject-b:organizations:org-1'
let tenantId = 'tenant-a', projection: any, bundleQuery: any, retries = 0
let cacheScope = SCOPE_A, clock = now
let sourceGet: (endpoint: string, init: any) => Promise<unknown>
let reads: Array<{ endpoint: string; init: any }> = []
const SOURCE = 'Microsoft Graph v1.0 /roleManagement/directory/roleAssignments'
function receipt(status = 'not-activated', count = 0, ageMs = 60_000, label = 'fixture') {
  const observation = status === 'current' || status === 'stale' ? {
    checkedAt: at(1), ageMs, observedCount: count,
    assignments: Array.from({ length: count }, (_, i) => ({ id: `${label}-${i}`, roleDisplayName: label, principalId: null, roleDefinitionId: null, directoryScopeId: '/', appScopeId: null })),
    verifiedCompleteEmpty: count === 0,
  } : null
  const pair = status === 'not-activated' ? ['ACTIVATION_EVIDENCE_UNAVAILABLE', 'REVIEW_SOURCE_CONTROL']
    : status === 'superseded' ? ['STORED_CONTENT_MISMATCH', 'REREAD_OR_REPORT']
    : status === 'never-collected' ? ['NO_COMPLETE_RECEIPT', 'AWAIT_NORMAL_COLLECTION']
    : status === 'stale' ? ['COMPLETE_OBSERVATION_STALE', 'AWAIT_NORMAL_COLLECTION']
    : [count ? 'COMPLETE_OBSERVATION_CURRENT' : 'COMPLETE_EMPTY_CURRENT', 'NONE']
  return { responseVersion: 'directory-role-results/v1', source: SOURCE, status, observation,
    health: { version: 1, reasonCode: pair[0], recoveryCode: pair[1] }, latestAttempt: { outcome: null, terminalAt: null } }
}
async function waitFor(predicate: () => boolean, message: string) {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
  assert.fail(`Timed out waiting for ${message}`)
}
function deferred() {
  let resolve!: (answer: unknown) => void
  const promise = new Promise<unknown>(done => { resolve = done })
  return { promise, resolve }
}
function load(file: string): any {
  if (cache.has(file)) return cache.get(file)
  const exports: any = {}; cache.set(file, exports)
  const js = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  new Function('require', 'exports', js)((name: string) => {
    if (name === '@/components/providers/auth-provider') return { useAuth: () => ({ cacheScope, isLoading: false }) }
    if (name === './client') return { apiClient: {
      get: async (endpoint: string, init: any) => {
        reads.push({ endpoint, init })
        assert.match(endpoint, /^\/api\/tenants\/[^/]+\/directory-roles\/results$/)
        assert.equal(init.cache, 'no-store'); assert.ok(init.signal)
        return sourceGet(endpoint, init)
      },
      post: () => { throw new Error('Freshness must not mutate') },
    } }
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
const { DirectoryRoleReceiptHealth } = load(resolve(base, 'components/tenant/directory-role-assignments-panel.tsx'))
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
  const originalNow = Date.now; clock = now; Date.now = () => clock
  cacheScope = SCOPE_A; reads = []; sourceGet = async () => receipt()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 2_000 } } })
  const root = createRoot(dom.window.document.getElementById('root')); reset()
  try { await run({
    render: async (element = h(Page)) => React.act(async () => root.render(h(QueryClientProvider, { client }, element))),
    doc: dom.window.document, text: () => dom.window.document.body.textContent,
    client, health: () => dom.window.document.querySelector('section[aria-label="Directory role receipt health"]'),
    resume: async (event = 'visibilitychange') => React.act(async () => { (event === 'focus' ? dom.window : dom.window.document).dispatchEvent(new dom.window.Event(event)) }),
  }) }
  finally { await React.act(async () => root.unmount()); await client.cancelQueries(); client.clear(); await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); Date.now = originalNow; for (const [key, descriptor] of Array.from(saved)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as any)[key]; dom.window.close() }
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


function directoryReadiness() {
  const raw: any = readiness()
  const role = { ...raw.workloads[0].datasets[0], key: 'entra_directory_roles', label: 'Directory role assignments', resourceTypes: ['DIRECTORY_ROLES'], permissions: [{ resource: 'MICROSOFT_GRAPH', name: 'RoleManagement.Read.Directory', type: 'APPLICATION', consentMode: 'DEFAULT', grantStatus: 'CONFIRMED' }] }
  const users = { ...raw.workloads[0].datasets[0], key: 'entra_users', label: 'User inventory', resourceTypes: ['USERS'] }
  raw.workloads.push({ ...raw.workloads[0], key: 'entra_directory', workload: 'Entra directory inventory', state: 'READY', datasets: [role, users], components: [
    { key: 'DIRECTORY_ROLES', label: 'directory roles', state: 'READY', lastSuccessfulAt: at(1), lastAttemptAt: at(1), reasonCode: null, reason: null },
    { key: 'USERS', label: 'users', state: 'READY', lastSuccessfulAt: at(1), lastAttemptAt: at(1), reasonCode: null, reason: null },
  ] })
  return raw
}

for (const status of ['not-activated', 'superseded', 'stale']) test(`real freshness page suppresses generic directory READY beside named ${status}`, async () => mounted(async ({ render, doc, health, text }) => {
  reset(directoryReadiness()); sourceGet = async () => receipt(status, 2, status === 'stale' ? 7_200_000 : 60_000)
  await render(); await waitFor(() => health()?.textContent.includes(status === 'not-activated' ? 'activation evidence' : status === 'superseded' ? 'verified content or count' : 'older than the one-hour'), status)
  const other = doc.querySelector('section[aria-label="Other directory inventory"]')
  assert.ok(other)
  assert.equal(doc.querySelector('section[aria-label="Entra directory inventory"]'), null)
  assert.doesNotMatch(other.textContent, /Directory role assignments|directory roles: Ready|Directory Roles/)
  assert.match(other.textContent, /Directory roles access requirements.*RoleManagement.Read.Directory/)
  assert.match(other.textContent, /User inventory.*Collection stateReady/)
  assert.match(other.textContent, /users: Ready/)
  // No parent state/clock/remediation remains; only other dataset and component evidence.
  assert.equal([...other.children].some((el: any) => el.tagName === 'P' && el.textContent === 'Ready'), false)
  assert.match(doc.querySelector('section[aria-label="Applications"]').textContent, /Collection stateReady/)
  assert.equal(health().querySelector('table'), null, 'compact health does not display the payload')
  assert.doesNotMatch(health().textContent, /switch on|switch off|within the one-hour|\bReady\b/i)
  assert.equal(reads.length, 1, 'only the named read is added')
  assert.equal(reads[0].endpoint, '/api/tenants/tenant-a/directory-roles/results')
  assert.match(text(), /App registrations/)
}))

test('non-split consumers retain generic directory readiness', async () => mounted(async ({ render, doc }) => {
  const { normalizeCollectionReadiness } = load(resolve(base, 'lib/tenants/collection-readiness.ts'))
  await render(h(DataFreshnessDetails, { readiness: normalizeCollectionReadiness(directoryReadiness()) }))
  const generic = doc.querySelector('section[aria-label="Entra directory inventory"]')
  assert.match(generic.textContent, /Directory role assignments.*Collection stateReady/)
  assert.match(generic.textContent, /directory roles: Ready/)
  assert.equal(reads.length, 0)
}))

test('receipt section survives unavailable generic details and snapshot bundle', async () => mounted(async ({ render, health, text }) => {
  projection.status = 'UNAVAILABLE'; bundleQuery.isError = true
  sourceGet = async () => ({ ...receipt('current'), latestAttempt: { outcome: 'FAILED', terminalAt: at(0) } })
  await render(); await waitFor(() => health()?.textContent.includes('Verified complete-empty'), 'verified empty')
  assert.match(text(), /Collection details unavailable.*Snapshot times unavailable/)
  assert.match(health().textContent, /Verified complete-empty.*most recent collection attempt failed/)
  assert.equal(health().querySelectorAll('time').length, 2)
  assert.equal(health().querySelector('a').getAttribute('href'), '/tenants/tenant-a/entra/overview')
  assert.equal(health().querySelectorAll('button').length, 1)
  assert.equal(health().querySelector('button').textContent, 'Re-read stored results')
}))

test('real scoped hook discards delayed A, admits B, and re-reads A on A→B→A', async () => mounted(async ({ render, health, client }) => {
  const oldA = deferred(); let aReads = 0
  sourceGet = async endpoint => endpoint.includes('/tenant-a/') && ++aReads === 1 ? oldA.promise : receipt('current', endpoint.includes('/tenant-a/') ? 3 : 2)
  await render(); await waitFor(() => reads.length === 1, 'A read')
  tenantId = 'tenant-b'; await render(); await waitFor(() => health()?.textContent.includes('2 directory role assignments'), 'B receipt')
  assert.equal(reads[0].init.signal.aborted, true, 'actual Query cancellation consumes its signal')
  await React.act(async () => { oldA.resolve(receipt('current', 99)); await Promise.resolve() })
  assert.doesNotMatch(health().textContent, /99 directory/)
  tenantId = 'tenant-a'; await render(); await waitFor(() => health()?.textContent.includes('3 directory role assignments'), 'new A receipt')
  assert.equal(aReads, 2)
  assert.equal(client.getQueryData(['directory-role-results', SCOPE_A, 'tenant-a']).observation.observedCount, 3)
}))

test('auth scope transition with a delayed response never shows prior identity evidence', async () => mounted(async ({ render, health, client }) => {
  const oldIdentity = deferred()
  sourceGet = async () => cacheScope === SCOPE_A ? oldIdentity.promise : receipt('current', 4)
  await render(); await waitFor(() => reads.length === 1, 'first identity read')
  cacheScope = SCOPE_B; await render(); await waitFor(() => health()?.textContent.includes('4 directory role assignments'), 'new identity receipt')
  await React.act(async () => { oldIdentity.resolve(receipt('current', 88)); await Promise.resolve() })
  assert.doesNotMatch(health().textContent, /88 directory/)
  assert.equal(reads[0].init.signal.aborted, true)
  assert.equal(client.getQueryData(['directory-role-results', SCOPE_B, 'tenant-a']).observation.observedCount, 4)
  cacheScope = 'signed-out'; await render(); assert.doesNotMatch(health().textContent, /4 directory role/)
  assert.equal(reads.length, 2, 'unready auth scope issues no request')
}))

test('real retained-data error withholds evidence; retry makes only a results read', async () => mounted(async ({ render, health, client }) => {
  let fail = false
  sourceGet = async () => { if (fail) throw Error('PRIVATE-ERROR'); return receipt('current', 6) }
  await render(); await waitFor(() => health()?.textContent.includes('6 directory role assignments'), 'initial result')
  fail = true; await React.act(async () => { await client.refetchQueries() })
  await waitFor(() => health()?.textContent.includes('These results are unavailable'), 'read failure')
  assert.ok(client.getQueryData(['directory-role-results', SCOPE_A, 'tenant-a']), 'real cache retains data')
  assert.doesNotMatch(health().textContent, /6 directory|PRIVATE-ERROR|Verified complete/)
  fail = false
  await React.act(async () => { health().querySelector('button').click() })
  await waitFor(() => health()?.textContent.includes('6 directory role assignments'), 'retry result')
  assert.equal(reads.length, 3)
  assert.ok(reads.every(read => read.endpoint === '/api/tenants/tenant-a/directory-roles/results' && read.init.cache === 'no-store'))
}))

test('real cache acceptance clock survives remount, visibility and same-age replacement', async () => mounted(async ({ render, health, client, resume }) => {
  sourceGet = async () => receipt('current', 1, 59 * 60_000)
  const compact = () => h(DirectoryRoleReceiptHealth, { customerTenantId: 'tenant-a' })
  await render(compact()); await waitFor(() => health()?.textContent.includes('59 minutes old'), 'first response')
  const key = ['directory-role-results', SCOPE_A, 'tenant-a']
  const accepted = client.getQueryState(key).dataUpdatedAt
  await render(h('div'))
  clock += 30_000; await render(compact())
  assert.equal(client.getQueryState(key).dataUpdatedAt, accepted, 'fresh cached remount does not reset acceptance')
  assert.equal(reads.length, 1)
  clock += 30_001; await resume('visibilitychange')
  assert.match(health().textContent, /older than the one-hour/)
  assert.doesNotMatch(health().textContent, /within the one-hour/)
  assert.equal(reads.length, 1, 'visibility ageing itself collects and fetches nothing')
  await React.act(async () => { await client.refetchQueries() })
  await waitFor(() => health()?.textContent.includes('within the one-hour'), 'same numeric age replacement')
  assert.equal(client.getQueryState(key).dataUpdatedAt, clock)
  assert.equal(client.getQueryState(key).data.observation.ageMs, 59 * 60_000)
  assert.equal(reads.length, 2)
  assert.match(health().textContent, /59 minutes old/)
  assert.doesNotMatch(health().textContent, /Showing the last completed collection/)
}))


test('a cached near-boundary receipt remounts stale before its hook refetch window', async () => mounted(async ({ render, health, client }) => {
  sourceGet = async () => receipt('current', 0, 3_599_000)
  const compact = () => h(DirectoryRoleReceiptHealth, { customerTenantId: 'tenant-a' })
  await render(compact()); await waitFor(() => health()?.textContent.includes('within the one-hour'), 'initial current empty')
  const accepted = client.getQueryState(['directory-role-results', SCOPE_A, 'tenant-a']).dataUpdatedAt
  await render(h('div')); clock += 2_000; await render(compact())
  assert.equal(reads.length, 1, 'remount reuses actual fresh cache')
  assert.equal(client.getQueryState(['directory-role-results', SCOPE_A, 'tenant-a']).dataUpdatedAt, accepted)
  assert.match(health().textContent, /older than the one-hour.*Verified complete-empty/)
  assert.doesNotMatch(health().textContent, /within the one-hour/)
}))
