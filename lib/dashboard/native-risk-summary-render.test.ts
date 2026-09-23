import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as native from './hawkview-risk-summary.ts'
import * as microsoft from '../identity-risk/microsoft-risk-summary.ts'
import * as navigation from '../tenants/navigation.ts'
import { parseNativeRiskSummary } from '../api/native-risk-summary-parser.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { JSDOM } = require('jsdom')
const h = React.createElement
const icons = new Proxy({}, { get: () => () => null })
const passthrough = ({ children }: { children?: unknown }) => children
const box = ({ children }: { children?: unknown }) => h('div', null, children)
const button = ({ children, variant: _variant, ...props }: Record<string, unknown>) => h('button', props, children)
function compile(path: string, mocks: Record<string, unknown>) {
  const exports: Record<string, any> = {}
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  new Function('require', 'exports', js)((name: string) => mocks[name] ?? require(name), exports)
  return exports
}
const shared = {
  'lucide-react': icons,
  'next/navigation': { useRouter: () => ({ push: () => undefined }) },
  '@/components/ui/button': { Button: button },
  '@/components/ui/badge': { Badge: box },
  '@/components/ui/card': { Card: box, CardContent: box },
  '@/lib/dashboard/hawkview-risk-summary': native,
  '@/lib/identity-risk/microsoft-risk-summary': microsoft,
  '@/lib/tenants/navigation': navigation,
  '@/lib/attention/computeTenantAttention': { computeTenantAttention: () => [] },
}
const helpers = compile('../../components/dashboard/tenant-risk-matrix-helpers.ts', shared)
const matrix = compile('../../components/dashboard/tenant-risk-matrix.tsx', {
  ...shared,
  '@/lib/utils': { cn: (...values: unknown[]) => values.filter(Boolean).join(' ') },
  '@/components/ui/tooltip': { Tooltip: passthrough, TooltipProvider: passthrough, TooltipTrigger: passthrough, TooltipContent: () => null },
  './tenant-risk-matrix-helpers': helpers,
  './tenant-risk-matrix-drawer': { TenantRiskMatrixDrawer: () => null },
})
const { NativeRiskSummaryCard } = compile('../../components/dashboard/native-risk-summary-card.tsx', {
  ...shared, 'next/link': { default: ({ children, ...props }: Record<string, unknown>) => h('a', props, children) },
})

// Real producer and decoders, same realm as the parser. Only the database reader below is synthetic.
// Explicit dependency allowlist prevents this regression from importing a Prisma/provider runtime.
const coverageRecord = compile('../../backend/src/evaluation-core/coverage-record.ts', {})
const runCoverage = compile('../../backend/src/risky-users-wiring/run-coverage.ts', {
  '../evaluation-core/coverage-record.js': coverageRecord,
})
const runFindings = compile('../../backend/src/risky-users-wiring/run-findings.ts', {})
const persistedRun = compile('../../backend/src/risky-users-wiring/persist-run.ts', {
  './run-coverage.js': runCoverage, './run-findings.js': runFindings,
})
const runReader = compile('../../backend/src/risky-users-wiring/read-run.ts', {
  './persist-run.js': persistedRun, './run-coverage.js': runCoverage, './run-findings.js': runFindings,
})
const nativeProducer = compile('../../backend/src/risky-users-wiring/native-risk-summary.ts', {
  './read-run.js': runReader, './persist-run.js': persistedRun,
  '../tenants/service-sync-freshness.js': compile('../../backend/src/tenants/service-sync-freshness.ts', {}),
})

function producerRow(id = 'synthetic-a', value = 4, at = '2026-09-15T11:00:00.000Z') {
  return {
    organizationId: 'synthetic-org', customerTenantId: id, readLimitExceeded: false,
    collectorStatus: 'IDLE' as string | null, collectorLastSuccessfulAt: at as string | null,
    completedAt: at, windowStart: '2026-09-01T00:00:00.000Z', windowEnd: at,
    expiresAt: '2026-12-01T00:00:00.000Z',
    evaluationCoverage: { version: 'hawkview-run-coverage/v1', streams: [{ stream: 'GRAPH_SIGN_INS', coverage: {
      version: 'hawkview-coverage/v1', collectionScope: { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' },
      applies: 10, doesNotApply: {}, notYetCited: {}, unknown: {}, unprocessable: {},
    } }] },
    evaluationFindings: {
      version: 'hawkview-run-findings/v1', complete: true, claim: { permitted: true },
      count: { accuracy: 'EXACT', value, scope: { evidenceRequested: ['GRAPH_INTERACTIVE_ONLY'], setAside: [], covered: ['synthetic-detector'], notCovered: [] } },
      items: Array.from({ length: value }, (_, index) => ({ detectorId: 'synthetic-detector', subject: { kind: 'DIRECTORY_USER', userRef: `private-user-${index}` },
        signals: [{ signal: 'SYNTHETIC_SIGNAL', count: 1, latest: null, capped: false }] })),
      sources: [{ source: 'GRAPH_SIGN_INS', status: 'SUCCESS', lastSuccessfulCollectionAt: at }],
    },
  }
}
async function produced(rows: ReturnType<typeof producerRow>[], totalTenants = rows.length) {
  const raw = await nativeProducer.readNativeRiskSummary({ $queryRawUnsafe: async () => rows }, {
    totalTenants, tenants: rows.map((row) => ({ id: row.customerTenantId, organizationId: row.organizationId, gate: null })),
  }, new Date('2026-09-15T12:00:00.000Z'))
  const parsed = parseNativeRiskSummary(raw)
  assert.ok(parsed, JSON.stringify(raw))
  return parsed
}
function fixture(value = 7): native.NativeRiskSummaryResponse {
  return {
    contractVersion: 'hawkview-native-risk-summary/v1', source: 'HAWKVIEW_NATIVE_ASSESSMENT', countUnit: 'TENANT_USER_IDENTITIES',
    generatedAt: '2026-09-15T12:00:00.000Z',
    fleet: { availability: 'AVAILABLE', accuracy: 'EXACT', distinctUserCount: value, assessedTenants: 1, totalTenants: 1, enumeratedTenants: 1, scopeComplete: true, limitations: [] },
    tenants: [{ tenantId: 'synthetic-a', availability: 'AVAILABLE', accuracy: 'EXACT', distinctUserCount: value, evaluatedAt: '2026-09-15T11:00:00.000Z', windowStart: '2026-09-08T11:00:00.000Z', windowEnd: '2026-09-15T11:00:00.000Z', complete: true, limitations: [] }],
  }
}
function documentFor(component: unknown, props: Record<string, unknown>) {
  return new JSDOM(renderToStaticMarkup(h(component, props))).window.document
}
function cardProps(value: native.NativeRiskSummaryResponse, state: 'SUCCESS' | 'ERROR' | 'LOADING' = 'SUCCESS') {
  return { risk: native.summarizeHawkViewPortfolioRisk(value.fleet, state), requestState: state, onRetry: () => undefined }
}
const tenant = { id: 'synthetic-a', name: 'Synthetic tenant', status: 'active', connectionStatus: 'connected', provider: 'microsoft', riskyUsersCount: 987, riskyIdentityCount: 987, missingPermissions: [], attention: [] }

test('compact primary card shows only title, truthful count and one subtitle with native navigation', () => {
  for (const count of [7, 12, 0]) {
    const document = documentFor(NativeRiskSummaryCard, cardProps(fixture(count)))
    assert.equal(document.querySelector('a')?.getAttribute('href'), '/risky-users')
    assert.equal(document.querySelector('[aria-live]')?.textContent, String(count))
    assert.match(document.body.textContent, /1 of 1 tenants assessed/)
    assert.equal(document.body.textContent, `HawkView Risky Users${count}1 of 1 tenants assessed`)
    assert.doesNotMatch(document.body.textContent, /Microsoft|Users are counted|Summary checked/)
    assert.equal(document.querySelector('time'), null)
    assert.match(document.querySelector('a')?.className, /focus-visible:ring-2/)
    assert.equal(document.querySelector('a')?.getAttribute('tabindex'), null)
    assert.doesNotMatch(document.body.textContent, /987|all safe|all clear/i)
  }
})

test('partial rendered count and accessible label say at least; failed/loading cached totals and clocks are withheld', () => {
  const value = fixture()
  Object.assign(value.fleet, { availability: 'PARTIAL', accuracy: 'AT_LEAST' })
  const document = documentFor(NativeRiskSummaryCard, cardProps(value))
  assert.equal(document.querySelector('[aria-live]')?.textContent, '≥7')
  assert.match(document.querySelector('a')?.getAttribute('aria-label'), /At least 7/)
  assert.equal(document.body.textContent, 'HawkView Risky Users≥71 of 1 tenants assessed')
  for (const state of ['ERROR', 'LOADING'] as const) {
    const document = documentFor(NativeRiskSummaryCard, cardProps(fixture(), state))
    assert.equal(document.querySelector('[aria-live]')?.textContent, state === 'ERROR' ? 'Unavailable' : 'Loading')
    assert.equal(document.querySelector('time'), null)
    assert.equal(document.querySelector('a button'), null)
    assert.equal(document.querySelector('a')?.getAttribute('aria-busy'), String(state === 'LOADING'))
    assert.equal(Boolean(document.querySelector('[role=alert]')), state === 'ERROR')
    assert.doesNotMatch(document.body.textContent, /1 of 1|Summary checked|Microsoft|≥7/)
    assert.match(document.body.textContent, state === 'ERROR' ? /Counts unavailable/ : /Checking assessment/)
  }
})

test('unavailable and withheld zero stay unavailable in the compact card without extra detail', () => {
  for (const availability of ['UNAVAILABLE', 'PARTIAL'] as const) {
    const value = fixture(0)
    Object.assign(value.fleet, { availability, accuracy: 'NOT_AVAILABLE', distinctUserCount: null })
    const document = documentFor(NativeRiskSummaryCard, cardProps(value))
    assert.equal(document.querySelector('[aria-live]')?.textContent, 'Not available')
    assert.equal(document.body.textContent, 'HawkView Risky UsersNot available1 of 1 tenants assessed')
    assert.doesNotMatch(document.body.textContent, /all clear|all safe|Summary checked|Microsoft/i)
  }
})

test('compact card uses adjacent KPI padding and natural height without clipping or fixed height', () => {
  const source = readFileSync(new URL('../../components/dashboard/native-risk-summary-card.tsx', import.meta.url), 'utf8')
  const dashboard = readFileSync(new URL('../../app/(protected)/dashboard/page.tsx', import.meta.url), 'utf8')
  assert.match(source, /CardContent className="p-5"/)
  assert.match(source, /flex min-w-0 flex-col gap-2/)
  assert.match(source, /block flex-1 rounded-2xl/)
  assert.match(dashboard, /grid gap-4 md:grid-cols-2 lg:grid-cols-4/)
  assert.doesNotMatch(source, /overflow-hidden|line-clamp|truncate|(?:min-|max-)?h-\[/)
})

test('matrix desktop and mobile render native counts with assessment clocks; never borrow Microsoft/legacy counts', () => {
  for (const count of [7, 0]) {
    const value = fixture(count)
    const document = documentFor(matrix.TenantRiskMatrix, { tenants: [tenant], nativeRiskByTenant: new Map([[tenant.id, value.tenants[0]]]) })
    assert.equal(document.querySelectorAll('details > summary').length, 2)
    assert.equal(document.querySelectorAll(`time[datetime="${value.tenants[0].evaluatedAt}"]`).length, 2)
    assert.match(document.body.textContent, /Evidence window:/)
    assert.doesNotMatch(document.body.textContent, /987|all safe|all clear/i)
    if (count === 0) assert.match(document.body.textContent, /0 in assessed scope/)
    else assert.equal(document.querySelectorAll('[aria-label="7"]').length, 2)
  }
})

test('actual native producer -> strict parser -> card and both matrix layouts qualify retained evidence', async () => {
  for (const limitation of ['STALE_ASSESSMENT', 'SOURCE_FRESHNESS_UNKNOWN', 'SOURCE_UNAVAILABLE']) {
    for (const count of [0, 4]) {
      const row = producerRow('synthetic-a', count, limitation === 'STALE_ASSESSMENT' ? '2026-09-10T11:00:00.000Z' : undefined)
      if (limitation === 'SOURCE_FRESHNESS_UNKNOWN') row.collectorLastSuccessfulAt = null
      if (limitation === 'SOURCE_UNAVAILABLE') row.collectorStatus = 'FAILED'
      const value = await produced([row])
      assert.ok(value.fleet.limitations.includes(limitation))
      assert.equal(value.fleet.distinctUserCount, count || null)
      assert.equal(value.fleet.assessedTenants, 1, 'historical decoded assessment is not current coverage')
      const card = documentFor(NativeRiskSummaryCard, cardProps(value))
      assert.equal(card.querySelector('[aria-live]')?.textContent, count ? '≥4 observed' : 'Not available')
      assert.match(card.body.textContent, /Includes older or unconfirmed assessments/)
      assert.match(card.querySelector('a')?.getAttribute('aria-label'), /unconfirmed/)
      const document = documentFor(matrix.TenantRiskMatrix, { tenants: [tenant], nativeRiskByTenant: new Map([[tenant.id, value.tenants[0]]]) })
      const labels = [...document.querySelectorAll('p')].filter((p: any) => p.textContent === 'Saved assessment; current risk unconfirmed.')
      assert.equal(labels.length, 2)
      assert.ok(labels.every((p: any) => p.closest('details') === null), 'qualification visible outside collapsed details')
      assert.equal(document.querySelectorAll(`time[datetime="${row.completedAt}"]`).length, 2)
      assert.doesNotMatch(document.body.textContent, /0 in assessed scope|current HawkView finding|from the current HawkView assessment|all clear|all safe|private-user/)
      if (count) assert.equal(document.querySelectorAll('[aria-label*="observed in a saved assessment"]').length, 2)
    }
  }
})

test('actual producer mixed fleet retains observed totals, fresh zero control, and scope cap qualification', async () => {
  const fresh = await produced([producerRow('synthetic-a', 0)])
  assert.equal(fresh.fleet.accuracy, 'EXACT')
  assert.equal(documentFor(NativeRiskSummaryCard, cardProps(fresh)).querySelector('[aria-live]')?.textContent, '0')
  const mixed = await produced([producerRow('synthetic-a', 4, '2026-09-10T11:00:00.000Z'), producerRow('synthetic-b', 2)])
  assert.equal(mixed.fleet.distinctUserCount, 6)
  assert.equal(mixed.fleet.accuracy, 'AT_LEAST')
  const presentation = native.summarizeHawkViewPortfolioRisk(mixed.fleet, 'SUCCESS')
  assert.match(presentation.detail, /not a lower bound on current risky users/)
  assert.match(documentFor(NativeRiskSummaryCard, cardProps(mixed)).body.textContent, /≥6 observed/)
  const capped = await produced(Array.from({ length: 100 }, (_, index) => producerRow(`synthetic-${index}`, 1, '2026-09-10T11:00:00.000Z')), 101)
  assert.match(native.summarizeHawkViewPortfolioRisk(capped.fleet, 'SUCCESS').detail, /limited to 100 tenants/)
  for (const state of ['LOADING', 'ERROR'] as const) {
    const document = documentFor(NativeRiskSummaryCard, cardProps(mixed, state))
    assert.doesNotMatch(document.body.textContent, /≥6|Includes older|observed/)
  }
})

test('actual producer stale withheld assessment preserves original clocks and both reasons', async () => {
  const row = producerRow('synthetic-a', 0, '2026-09-10T11:00:00.000Z')
  Object.assign(row.evaluationFindings.count, { accuracy: 'NOT_AVAILABLE', value: null })
  const value = await produced([row])
  assert.deepEqual(value.fleet.limitations, ['COUNT_WITHHELD', 'STALE_ASSESSMENT'])
  assert.equal(value.fleet.assessedTenants, 1)
  assert.equal(value.tenants[0].evaluatedAt, row.completedAt)
  const document = documentFor(NativeRiskSummaryCard, cardProps(value))
  assert.equal(document.querySelector('[aria-live]')?.textContent, 'Not available')
  assert.match(document.body.textContent, /Includes older or unconfirmed assessments/)
})

test('matrix cached counts disappear on loading and error, and unknown sorts last in either direction', () => {
  const value = fixture()
  const summaries = new Map([[tenant.id, value.tenants[0]]])
  const unknown = { ...tenant, id: 'synthetic-b', name: 'A unknown' }
  for (const state of ['ERROR', 'LOADING'] as const) {
    const document = documentFor(matrix.TenantRiskMatrix, { tenants: [tenant], nativeRiskByTenant: summaries, nativeRiskRequestState: state })
    assert.equal(document.querySelector('[aria-label="7"]'), null)
    assert.equal(document.querySelector('time'), null)
    assert.match(document.body.textContent, state === 'ERROR' ? /Could not load/ : /Loading/)
    const sorted = matrix.sortTenantRiskMatrixTenants([tenant, unknown], 'users_at_risk', 'desc', summaries, state)
    assert.equal(sorted[0].id, unknown.id, 'withheld counts do not affect sorting')
  }
  for (const direction of ['asc', 'desc']) {
    assert.equal(matrix.sortTenantRiskMatrixTenants([unknown, tenant], 'users_at_risk', direction, summaries)[1].id, unknown.id)
  }
})

test('retry is a separate keyboard-focusable button and invokes only the supplied retry callback', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.invalid' })
  const previous = { window: globalThis.window, document: globalThis.document }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = require('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root'))
  let calls = 0
  try {
    await React.act(async () => root.render(h(NativeRiskSummaryCard, { ...cardProps(fixture(), 'ERROR'), onRetry: () => calls++ })))
    const retry = dom.window.document.querySelector('button')
    const link = dom.window.document.querySelector('a')
    link.focus()
    assert.equal(dom.window.document.activeElement, link)
    assert.equal(link.getAttribute('href'), '/risky-users')
    retry.focus()
    assert.equal(dom.window.document.activeElement, retry)
    await React.act(async () => retry.click())
    assert.equal(calls, 1)
    assert.equal(retry.closest('a'), null)
  } finally {
    await React.act(async () => root.unmount())
    Object.assign(globalThis, previous)
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  }
})

test('batch hook is organization-cache scoped, cancellable, no-store, bounded to one request and rejects malformed responses', async () => {
  let scope = 'synthetic-owner-a'
  let raw: unknown = fixture()
  const calls: unknown[][] = []
  const { useNativeRiskSummary } = compile('../api/native-risk-summary-hooks.ts', {
    '@tanstack/react-query': { useQuery: (options: unknown) => options },
    '@/components/providers/auth-provider': { useAuth: () => ({ cacheScope: scope }) },
    './client': { apiClient: { get: async (...args: unknown[]) => { calls.push(args); return raw } } },
    './native-risk-summary-parser': { parseNativeRiskSummary },
  })
  const query = useNativeRiskSummary()
  assert.deepEqual(query.queryKey, ['native-risk-summary', scope])
  assert.equal(query.retry, false)
  assert.equal(query.refetchInterval, 60_000)
  const signal = new AbortController().signal
  assert.deepEqual(await query.queryFn({ signal }), fixture())
  assert.deepEqual(calls, [['/api/risky-users/summary', { signal, cache: 'no-store' }]])
  scope = 'synthetic-owner-b'
  assert.notDeepEqual(useNativeRiskSummary().queryKey, query.queryKey)
  raw = { providerDebug: 'SYNTHETIC_PRIVATE_DIAGNOSTIC' }
  await assert.rejects(query.queryFn({ signal }), { message: 'HawkView returned an unsupported risk summary.' })
})

test('dashboard renders native summary even when the independent tenant directory is loading, failed or empty', () => {
  for (const directory of [
    { isLoading: true }, { isError: true }, { data: { tenants: [] } },
  ]) {
    const { default: Page } = compile('../../app/(protected)/dashboard/page.tsx', {
      ...shared,
      '@/lib/api/hooks': { useTenants: () => ({ ...directory, refetch: () => undefined }) },
      '@/lib/api/native-risk-summary-hooks': { useNativeRiskSummary: () => ({ data: fixture(), refetch: () => undefined }) },
      '@/components/dashboard/native-risk-summary-card': { NativeRiskSummaryCard },
      '@/components/dashboard/tenant-risk-matrix': matrix,
      '@/components/dashboard/tenant-risk-matrix-helpers': helpers,
      '@/components/ui/input': { Input: () => null },
      '@/components/dashboard/alert-details-modal': { AlertDetailsModal: () => null },
      '@/lib/tenants/investigate-navigation': { investigateDestination: () => '/tenants' },
      '@/lib/dashboard/queue-summary': { queueSummary: () => ({}) },
      '@/components/common/loading-state': { LoadingState: () => h('p', null, 'Directory loading') },
      '@/components/common/error-state': { ErrorState: () => h('p', null, 'Directory failed') },
      '@/components/common/empty-state': { EmptyState: ({ title }: { title: string }) => h('p', null, title) },
    })
    const document = documentFor(Page, {})
    assert.equal(document.querySelector('[aria-live]')?.textContent, '7')
    assert.equal(document.querySelector('a')?.getAttribute('href'), '/risky-users')
    assert.doesNotMatch(document.body.textContent, /No managed tenants/)
  }
})
