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
let nativeQueries: any[] = []
let microsoftQueries: any[] = []
let scope = 'synthetic'
let tenantQuery: any
let hook: any
const ids = ['tenant-a', 'tenant-b', 'tenant-c', 'tenant-d', 'tenant-e']
const calls: string[] = []
function queryForKey(key: readonly unknown[]) {
  assert.equal(key[1], scope)
  if (key[0] === 'tenants') return tenantQuery
  const index = ids.indexOf(key[2] as string)
  return key[3] === 'assessment'
    ? nativeQueries[index]
    : microsoftQueries[index]
}
const queryClient = {
  getQueryState(key: readonly unknown[]) {
    const query = queryForKey(key)
    return {
      data: query.data,
      status: query.isError ? 'error' : query.isLoading ? 'pending' : 'success',
      fetchStatus: query.isFetching || query.isLoading ? 'fetching' : 'idle',
    }
  },
  refetchQueries({ queryKey }: { queryKey: readonly unknown[] }) {
    return queryForKey(queryKey).refetch()
  },
}
const mocks: Record<string, any> = {
  '@/components/providers/auth-provider': {
    useAuth: () => ({ cacheScope: scope }),
  },
  './hooks': { useTenants: () => tenantQuery },
  './client': {
    apiClient: {
      get() {
        throw Error('Unexpected network')
      },
    },
  },
  '@tanstack/react-query': {
    useQueryClient: () => queryClient,
    useQueries: ({ queries }: any) =>
      queries.map((q: any) => {
        assert.equal(q.queryKey[1], scope)
        const i = ids.indexOf(q.queryKey[2])
        return q.queryKey[3] === 'assessment'
          ? nativeQueries[i]
          : microsoftQueries[i]
      }),
  },
}
const cache = new Map<string, any>()
function load(path: string): any {
  if (cache.has(path)) return cache.get(path)
  const exports: any = {}
  cache.set(path, exports)
  const js = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  new Function('require', 'exports', js)((name: string) => {
    if (mocks[name]) return mocks[name]
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name)
    const target = name.startsWith('@/')
      ? resolve(base, name.slice(2))
      : resolve(dirname(path), name)
    const file = [target, target + '.tsx', target + '.ts'].find((p) =>
      existsSync(p)
    )!
    return load(file)
  }, exports)
  if (path.endsWith('/fleet-risky-users-hooks.ts')) {
    const useFleet = exports.useFleetRiskyUsers
    exports.useFleetRiskyUsers = function useCapturedFleetRiskyUsers(
      selectedTenant: string
    ) {
      hook = useFleet(selectedTenant)
      return hook
    }
  }
  return exports
}
const Page = load(resolve(base, 'app/(protected)/risky-users/page.tsx')).default
const stamp = '2026-09-23T12:00:00.000Z'
function native(): any {
  return {
    version: 'hawkview-risky-users/v1',
    available: true,
    run: { windowStart: stamp, windowEnd: stamp, completedAt: stamp },
    collectors: [
      {
        source: 'GRAPH_SIGN_INS',
        status: 'SUCCESS',
        lastSuccessfulCollectionAt: stamp,
      },
    ],
    coverage: [
      {
        stream: 'GRAPH_SIGN_INS',
        coverage: { applies: 5, uninterpretedEvents: 0, notYetCitedEvents: 0 },
      },
    ],
    count: {
      accuracy: 'EXACT',
      value: 0,
      scope: {
        evidenceRequested: ['GRAPH_SIGN_INS'],
        covered: ['repeated-credential-failure'],
        notCovered: [],
      },
    },
    subjectsNamed: true,
    claim: { permitted: true },
    findings: { complete: true, items: [] },
  }
}
function microsoft(positive = false): any {
  return {
    ...syntheticRiskResponses().microsoftRiskyUsers,
    evaluatedAt: stamp,
    observedAt: stamp,
    users: positive
      ? [
          {
            id: 'ms-only',
            identityLabel: 'Microsoft-only synthetic identity',
            riskLevel: 'high',
            riskState: 'atRisk',
            riskDetail: null,
            observedAt: stamp,
            correlation: null,
          },
        ]
      : [],
    microsoftRiskSummary: {
      source: 'MICROSOFT_IDENTITY_PROTECTION',
      availability: 'AVAILABLE',
      completeness: 'COMPLETE',
      rawRecordCount: positive ? 1 : 0,
      observedActiveDistinctUserCount: positive ? 1 : 0,
      activeDistinctUserCount: positive ? 1 : 0,
      snapshotObservedAt: stamp,
      collectionSucceededAt: stamp,
      reasonCode: null,
    },
  }
}
function unavailable(reasonCode: string): any {
  return {
    ...microsoft(),
    status: 'UNAVAILABLE',
    capability: 'UNAVAILABLE',
    freshness: 'UNKNOWN',
    evaluatedAt: null,
    observedAt: null,
    limitation: 'Synthetic unavailable evidence',
    reasonCode,
    microsoftRiskSummary: {
      source: 'MICROSOFT_IDENTITY_PROTECTION',
      availability: 'UNAVAILABLE',
      completeness: 'UNKNOWN',
      rawRecordCount: null,
      observedActiveDistinctUserCount: null,
      activeDistinctUserCount: null,
      snapshotObservedAt: null,
      collectionSucceededAt: null,
      reasonCode: 'SOURCE_UNAVAILABLE',
    },
  }
}
function reset(count = 5) {
  calls.length = 0
  scope = 'synthetic'
  tenantQuery = {
    data: { tenants: ids.slice(0, count).map((id) => ({ id, name: id })) },
    isError: false,
    isLoading: false,
    isFetching: false,
    refetch: () => calls.push('tenants'),
  }
  nativeQueries = ids.map((id) => ({
    data: native(),
    refetch: () => calls.push(`native:${id}`),
  }))
  microsoftQueries = ids.map((id) => ({
    data: microsoft(),
    refetch: () => calls.push(`microsoft:${id}`),
  }))
}
async function mounted(
  run: (x: {
    render: () => Promise<void>
    body: () => string
    dom: any
  }) => Promise<void>,
  expandEvidence = true
) {
  reset()
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'https://synthetic.invalid',
  })
  const saved = new Map(
    ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]
    )
  )
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    })
  const oldNow = Date.now
  Date.now = () => Date.parse(stamp)
  const root = createRoot(dom.window.document.getElementById('root'))
  try {
    await run({
      render: async () => {
        await React.act(async () => root.render(React.createElement(Page)))
        const toggle = dom.window.document.querySelector('button[aria-controls="fleet-evidence-availability"]')
        if (expandEvidence && toggle?.getAttribute('aria-expanded') === 'false') await React.act(async () => toggle.click())
      },
      body: () => dom.window.document.body.textContent,
      dom,
    })
  } finally {
    await React.act(async () => root.unmount())
    Date.now = oldNow
    for (const [key, descriptor] of Array.from(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as any)[key]
    }
    dom.window.close()
  }
}
function reload(dom: any) {
  return [...dom.window.document.querySelectorAll('button')].find(
    (b: any) => b.textContent === 'Reload results'
  ) as any
}

test('five complete native assessments with Microsoft license/permission limitations stay separate and do not offer reload', async () =>
  mounted(async ({ render, body, dom }) => {
    for (const [reason, copy] of [
      ['LICENSE_REQUIRED', 'Microsoft reports a license requirement'],
      ['MISSING_PERMISSION', 'Microsoft reports missing permission'],
    ]) {
      microsoftQueries = ids.map((id) => ({
        data: unavailable(reason),
        refetch: () => calls.push(id),
      }))
      await render()
      assert.match(
        body(),
        /HawkView assessments: 5 of 5 tenants have complete current evidence/
      )
      assert.match(
        body(),
        /Microsoft risk evidence: 0 of 5 tenants have complete current evidence/
      )
      assert.ok(body().includes(copy))
      assert.ok(hook.tenantStatuses.every((t: any) => t.status !== 'SUCCESS'))
      assert.equal(reload(dom), undefined)
      assert.doesNotMatch(
        body(),
        /Retry failed tenants|could not be fully assessed|5 of 5 tenants.*not assessed|No users require review/
      )
      assert.equal(calls.length, 0)
    }
  }))
test('mixed source request failures reload only failed reads; inflight reads and old scope callbacks cannot fire', async () =>
  mounted(async ({ render, dom, body }) => {
    nativeQueries[0].isError = true
    microsoftQueries[1].isError = true
    microsoftQueries[2].data = unavailable('LICENSE_REQUIRED')
    nativeQueries[3].isLoading = true
    await render()
    assert.match(body(), /Results could not be loaded/)
    assert.match(body(), /Loading results/)
    await React.act(async () => reload(dom).click())
    assert.deepEqual(calls, ['native:tenant-a', 'microsoft:tenant-b'])
    calls.length = 0
    nativeQueries[0].isFetching = true
    microsoftQueries[1].isFetching = true
    await render()
    assert.equal(reload(dom), undefined)
    hook.reloadFailedResults()
    assert.equal(calls.length, 0)
    const old = hook.reloadFailedResults
    scope = 'other-org'
    nativeQueries = ids.map((id) => ({
      data: native(),
      refetch: () => calls.push(`other:${id}`),
    }))
    microsoftQueries = ids.map((id) => ({
      data: microsoft(),
      refetch: () => calls.push(`other:${id}`),
    }))
    nativeQueries[0].isError = true
    await render()
    old()
    assert.equal(calls.length, 0)
    await React.act(async () => reload(dom).click())
    assert.deepEqual(calls, ['other:tenant-a'])
  }))
test('enumeration errors with retained tenants withhold every denominator and reload only enumeration', async () =>
  mounted(async ({ render, body, dom }) => {
    tenantQuery.isError = true
    nativeQueries[0].isError = true
    await render()
    assert.match(body(), /Tenant scope unconfirmed/)
    assert.match(body(), /Coverage is unknown/)
    assert.doesNotMatch(body(), /\d+ of \d+ tenants|No users require review/)
    await React.act(async () => reload(dom).click())
    assert.deepEqual(calls, ['tenants'])
    calls.length = 0
    tenantQuery.isFetching = true
    await render()
    assert.equal(reload(dom), undefined)
    hook.reloadFailedResults()
    assert.equal(calls.length, 0)
    tenantQuery = {
      ...tenantQuery,
      data: undefined,
      isError: false,
      isLoading: true,
      isFetching: true,
    }
    await render()
    assert.match(body(), /Confirming the tenant list/)
    assert.doesNotMatch(body(), /0 of 0/)
    tenantQuery = {
      ...tenantQuery,
      data: { tenants: [] },
      isLoading: false,
      isFetching: false,
    }
    await render()
    assert.match(body(), /No tenants are in scope/)
  }))
test('retained positives, stale/unknown evidence and delivered-count gaps remain visible without retrying successful reads', async () =>
  mounted(async ({ render, body, dom }) => {
    const stale = microsoft(true)
    stale.status = 'STALE'
    stale.freshness = 'STALE'
    stale.limitation = 'Retained synthetic evidence'
    microsoftQueries[0].data = stale
    nativeQueries[1].data.run.completedAt = '2026-09-01T12:00:00.000Z'
    nativeQueries[2].data = {
      version: 'hawkview-risky-users/v1',
      available: false,
      because: 'NO_RUN',
    }
    nativeQueries[3].data = {
      version: 'hawkview-risky-users/v1',
      available: false,
      because: 'EVALUATION_DISABLED',
    }
    nativeQueries[4].data.count.value = 2
    await render()
    assert.match(body(), /Historical evidence/)
    assert.match(dom.window.document.querySelector('[role="img"]').getAttribute('aria-label'), /tenant-a: Microsoft risk evidence is older/)
    assert.match(body(), /Microsoft-only synthetic identity/)
    assert.match(body(), /No assessment or collection result is available/)
    assert.match(body(), /Assessment is not enabled/)
    assert.match(body(), /Evidence or delivered user details are incomplete/)
    assert.match(body(), /2 identities; 0 details shown/)
    assert.equal(reload(dom), undefined)
    nativeQueries[2].data = native()
    nativeQueries[2].data.collectors[0].lastSuccessfulCollectionAt = null
    microsoftQueries[3].data = unavailable('SOURCE_UNAVAILABLE')
    await render()
    assert.match(
      body(),
      /Evidence freshness or validity could not be confirmed/
    )
    assert.match(body(), /Source evidence is unavailable/)
    assert.ok(hook.tenantStatuses.every((t: any) => t.status !== 'SUCCESS'))
    assert.doesNotMatch(body(), /No users require review/)
  }))
test('complete exactzero is distinct from unavailable; identity references remain tenant-scoped', async () =>
  mounted(async ({ render, body }) => {
    await render()
    assert.match(body(), /No users require review/)
    assert.ok(
      hook.tenantStatuses.every(
        (t: any) => t.nativeSource === 'READY' && t.microsoftSource === 'READY'
      )
    )
    microsoftQueries = ids.map((id) => ({
      data: microsoft(true),
      refetch: () => calls.push(id),
    }))
    await render()
    assert.equal(hook.fleetRows.length, 5)
    assert.equal(new Set(hook.fleetRows.map((r: any) => r.id)).size, 5)
    microsoftQueries[0].isError = true
    await render()
    assert.equal(hook.fleetRows.length, 5)
    assert.equal(
      hook.fleetRows.find((r: any) => r.tenantId === 'tenant-a').evidenceState,
      'UNKNOWN'
    )
    assert.equal(
      hook.fleetRows.find((r: any) => r.tenantId === 'tenant-b').evidenceState,
      'CURRENT'
    )
  }))

test('reload guards rapid re-entry until settlement, then targets only remaining failed selected-tenant reads', async () =>
  mounted(async ({ render, dom }) => {
    let settle: () => void = () => undefined
    nativeQueries[0].isError = true
    microsoftQueries[1].isError = true
    nativeQueries[0].refetch = () => {
      calls.push('native:tenant-a')
      return new Promise<void>((resolve) => {
        settle = resolve
      })
    }
    await render()
    await React.act(async () => {
      reload(dom).click()
      reload(dom).click()
      hook.reloadFailedResults()
    })
    assert.deepEqual(calls, ['native:tenant-a', 'microsoft:tenant-b'])
    calls.length = 0
    await React.act(async () => hook.reloadFailedResults())
    assert.deepEqual(calls, ['microsoft:tenant-b'])
    calls.length = 0
    nativeQueries[0].isError = false
    await React.act(async () => settle())
    await render()
    const select = dom.window.document.querySelector('select')
    const old = hook.reloadFailedResults
    await React.act(async () => {
      select.value = 'tenant-a'
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    assert.equal(reload(dom), undefined)
    old()
    await Promise.resolve()
    assert.equal(calls.length, 0)
    await React.act(async () => {
      select.value = 'tenant-b'
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    await React.act(async () => reload(dom).click())
    assert.deepEqual(calls, ['microsoft:tenant-b'])
  }))

test('compact evidence disclosure defaults closed; button activation preserves details and Escape restores focus', async () => mounted(async ({ render, dom }) => {
  nativeQueries[0].isError = true
  microsoftQueries[1].data = unavailable('LICENSE_REQUIRED')
  await render()
  const document = dom.window.document
  const toggle = document.querySelector('button[aria-controls="fleet-evidence-availability"]')
  const panel = document.getElementById(toggle.getAttribute('aria-controls'))
  assert.equal(toggle.type, 'button') // Native Enter/Space and assistive activation semantics.
  assert.equal(toggle.tabIndex, 0)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.match(toggle.getAttribute('aria-label'), /Show evidence availability and analysis limitations/)
  assert.ok(toggle.className.includes('text-slate-600'))
  assert.match(document.querySelector('[role="img"]').getAttribute('aria-label'), /HawkView assessment results could not be loaded/)
  assert.equal(toggle.querySelector('svg').getAttribute('aria-hidden'), 'true')
  assert.equal(panel.hidden, true)
  assert.ok(panel.contains(reload(dom)))
  assert.equal(panel.querySelector('h2').id, panel.getAttribute('aria-labelledby'))
  const details = panel.textContent
  assert.match(details, /HawkView assessments: 4 of 5/)
  assert.match(details, /Microsoft risk evidence: 4 of 5/)
  assert.match(details, /Results could not be loaded/)
  assert.match(details, /Microsoft reports a license requirement/)
  toggle.focus()
  await React.act(async () => toggle.click())
  assert.equal(panel.hidden, false)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.equal(document.activeElement, toggle)
  assert.equal(panel.textContent, details)
  assert.equal(calls.length, 0, 'Opening the disclosure never reloads or collects')
  reload(dom).focus()
  await React.act(async () => reload(dom).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  assert.equal(panel.hidden, true)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(document.activeElement, toggle)
  // Keyboard/assistive activation reaches the native button's click handler.
  await React.act(async () => toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 0 })))
  assert.equal(panel.hidden, false)
  assert.equal(panel.textContent, details)
  await React.act(async () => reload(dom).click())
  assert.deepEqual(calls, ['native:tenant-a'])
  await React.act(async () => toggle.click())
  assert.equal(panel.hidden, true)
}, false))

test('disclosure remains discoverable for complete, unknown and empty scope without inventing success', async () => mounted(async ({ render, dom }) => {
  await render()
  const toggle = dom.window.document.querySelector('button[aria-controls="fleet-evidence-availability"]')
  const panel = dom.window.document.getElementById('fleet-evidence-availability')
  assert.equal(panel.hidden, true)
  assert.equal(toggle.getAttribute('aria-label'), 'Show evidence availability and analysis limitations')
  assert.ok(toggle.querySelector('svg').classList.contains('lucide-info'))
  tenantQuery.isError = true
  await render()
  assert.equal(panel.hidden, true)
  assert.match(toggle.getAttribute('aria-label'), /analysis limitations/)
  assert.ok(toggle.querySelector('svg').classList.contains('lucide-info'))
  assert.match(dom.window.document.querySelector('[role="img"]').getAttribute('aria-label'), /tenant list could not be loaded/)
  await React.act(async () => toggle.click())
  assert.match(panel.textContent, /Coverage is unknown/)
  assert.doesNotMatch(panel.textContent, /\d+ of \d+ tenants/)
  tenantQuery.isError = false
  tenantQuery.data = { tenants: [] }
  await render()
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.equal(toggle.getAttribute('aria-label'), 'Hide evidence availability and analysis limitations')
  assert.equal(reload(dom), undefined)
}, false))


test('fresh connected lower bounds and unmatched records are informational; operational warnings remain independent', async () => mounted(async ({ render, dom, body }) => {
  tenantQuery.data.tenants.forEach((tenant: any) => { tenant.status = 'active'; tenant.connectionStatus = 'connected' })
  const n = nativeQueries[0].data
  n.count.accuracy = 'AT_LEAST'; n.count.value = 5
  n.claim = { permitted: false, withheld: [{ stream: 'GRAPH_SIGN_INS', because: 'UNINTERPRETED_EVENTS' }] }
  n.findings.complete = false
  microsoftQueries[0].data = microsoft(true)
  Object.assign(microsoftQueries[0].data.microsoftRiskSummary, { availability: 'PARTIAL', completeness: 'PARTIAL', activeDistinctUserCount: null, reasonCode: 'PARTIAL_RECORDS' })
  await render()
  const warning = () => dom.window.document.querySelector('[role="img"]')
  assert.equal(warning(), null)
  assert.equal(hook.tenantStatuses[0].nativeSource, 'INCOMPLETE')
  assert.match(body(), /At least 5/i)
  assert.match(body(), /events HawkView did not interpret/)
  assert.match(body(), /assessment completed 2026-09-23/)
  assert.match(body(), /Microsoft risk records without a usable directory identity: 1/)
  assert.match(body(), /Microsoft-only synthetic identity/)
  assert.notEqual(hook.tenantStatuses[0].status, 'SUCCESS')
  assert.equal(reload(dom), undefined)
  for (const reason of ['LICENSE_REQUIRED', 'MISSING_PERMISSION', 'SOURCE_UNAVAILABLE']) {
    microsoftQueries[1].data = unavailable(reason)
    await render()
    assert.equal(warning(), null)
  }
  tenantQuery.data.tenants[1].status = 'disconnected'
  tenantQuery.data.tenants[2].connectionStatus = 'revoked'
  nativeQueries[3].data.run.completedAt = '2026-09-01T12:00:00.000Z'
  microsoftQueries[4].isError = true
  await render()
  assert.match(warning().getAttribute('aria-label'), /tenant-b: Tenant is disconnected/)
  assert.match(warning().getAttribute('aria-label'), /tenant-c: Tenant connection is revoked/)
  assert.match(warning().getAttribute('aria-label'), /tenant-d: HawkView evidence is older/)
  assert.match(warning().getAttribute('aria-label'), /tenant-e: Microsoft risk results could not be loaded/)
  assert.match(body(), /At least 5/i)
  assert.match(body(), /Microsoft-only synthetic identity/)
  assert.equal(calls.length, 0)
}))

test('pending, unconfirmed and generic unavailable states never imply operational failure or healthy connection', async () => mounted(async ({ render, dom, body }) => {
  tenantQuery.data.tenants[0].connectionStatus = 'pending-consent'
  nativeQueries[0].isLoading = true
  nativeQueries[1].data = null
  nativeQueries[2].data.collectors[0].lastSuccessfulCollectionAt = null
  microsoftQueries[3].data = unavailable('SOURCE_UNAVAILABLE')
  await render()
  assert.equal(dom.window.document.querySelector('[role="img"]'), null)
  assert.match(body(), /awaiting consent/)
  assert.match(body(), /connection status is unconfirmed/)
  assert.doesNotMatch(body(), /Tenant is disconnected|connection is reported connected|No users require review/)
  assert.equal(reload(dom), undefined)
}))


test('explicit collection and connection failures warn outside the collapsed disclosure without offering successful-read reloads', async () => mounted(async ({ render, dom }) => {
  const warning = () => dom.window.document.querySelector('[role="img"]')
  const panel = () => dom.window.document.getElementById('fleet-evidence-availability')
  microsoftQueries[0].data = unavailable('COLLECTION_FAILED')
  await render()
  assert.equal(panel().hidden, true)
  assert.match(warning().getAttribute('aria-label'), /tenant-a: Microsoft risky-user collection reports failure/)
  assert.equal(warning().closest('[hidden]'), null)
  assert.equal(reload(dom), undefined)
  microsoftQueries[0].data = microsoft()
  nativeQueries[1].data.collectors[0].status = 'FAILED'
  await render()
  assert.match(warning().getAttribute('aria-label'), /tenant-b: A selected HawkView evidence collector reports failure/)
  assert.equal(panel().hidden, true)
  nativeQueries[1].data.collectors[0].status = 'SUCCESS'
  tenantQuery.data.tenants[2].connectionStatus = 'error'
  await render()
  assert.match(warning().getAttribute('aria-label'), /tenant-c: Tenant connection reports an error; its cause is not established here/)
  assert.equal(panel().hidden, true)
  assert.equal(reload(dom), undefined)
  assert.equal(calls.length, 0)
}, false))

test('collection-not-succeeded needs a validated failure status; pending, unknown, licensing and malformed data do not invent failure', async () => mounted(async ({ render, dom }) => {
  const warning = () => dom.window.document.querySelector('[role="img"]')
  for (const status of ['UNAVAILABLE', 'NOT_EVALUATED', 'ERROR']) {
    const dto = unavailable('SOURCE_UNAVAILABLE')
    delete dto.reasonCode
    dto.status = status
    dto.microsoftRiskSummary.reasonCode = 'COLLECTION_NOT_SUCCEEDED'
    microsoftQueries[0].data = dto
    await render()
    assert.equal(dom.window.document.getElementById('fleet-evidence-availability').hidden, true)
    if (status === 'ERROR') assert.match(warning().getAttribute('aria-label'), /Microsoft risky-user collection reports failure/)
    else assert.equal(warning(), null)
    assert.equal(reload(dom), undefined)
  }
  for (const reason of ['LICENSE_REQUIRED', 'MISSING_PERMISSION', 'WAITING_FOR_COLLECTION', 'SOURCE_UNAVAILABLE']) {
    microsoftQueries[0].data = unavailable(reason)
    for (const status of ['RUNNING', 'PENDING', 'UNKNOWN']) {
      nativeQueries[0].data.collectors[0].status = status
      await render()
      assert.equal(warning(), null)
    }
  }
  for (const reason of ['LICENSE_REQUIRED', 'MISSING_PERMISSION']) {
    microsoftQueries[0].data = { ...unavailable(reason), status: 'ERROR' }
    await render()
    assert.equal(warning(), null, 'A named optional availability limitation remains informational')
  }
  microsoftQueries[0].data = { ...unavailable('SOURCE_UNAVAILABLE'), status: 'ERROR' }
  await render()
  assert.match(warning().getAttribute('aria-label'), /Microsoft risk source reports an error; its cause is not established here/)
  assert.doesNotMatch(warning().getAttribute('aria-label'), /collection reports failure/)
  const malformed = unavailable('COLLECTION_FAILED')
  malformed.catalogVersion = 'unsupported'
  microsoftQueries[0].data = malformed
  nativeQueries[0].data.collectors.push({ ...nativeQueries[0].data.collectors[0], status: 'FAILED' })
  await render()
  assert.equal(warning(), null, 'Malformed envelopes and ambiguous duplicate collectors do not establish a collection failure')
  assert.equal(calls.length, 0)
}, false))

test('optional availability has no aggregate warning or opt-out claim; unavailable zero stays unknown on desktop and mobile', async () => mounted(async ({ render, dom, body }) => {
  const document = dom.window.document
  for (const reason of ['MISSING_PERMISSION', 'LICENSE_REQUIRED', 'WAITING_FOR_COLLECTION', 'SOURCE_UNAVAILABLE']) {
    microsoftQueries = ids.map(() => ({ data: unavailable(reason) }))
    await render()
    assert.equal(document.getElementById('fleet-evidence-availability').hidden, true)
    assert.equal(document.querySelector('[role="img"]'), null)
    assert.doesNotMatch(body(), /Evidence Incomplete|complete evidence for \d+ of|Complete evidence from both sources|incomplete combined evidence|coverage is incomplete|opted out|Not enabled/i)
    assert.match(body(), /0 users shown/)
    assert.match(body(), /HawkView assessments: 5 of 5 tenants/)
    assert.match(body(), /Microsoft risk evidence: 0 of 5 tenants/)
    assert.ok(hook.tenantStatuses.every((tenant: any) => tenant.status === 'UNAVAILABLE'))
    assert.doesNotMatch(body(), /No users require review|Both sources have complete/)
    const emptyTitles = [...document.querySelectorAll('h3, p')].filter((node: any) => node.textContent === 'No matching users shown') as any[]
    assert.equal(emptyTitles.length, 2, 'Desktop and mobile retain the same unknown empty state')
    for (const title of emptyTitles) {
      const container = title.closest('td') ?? title.parentElement
      assert.ok(container.querySelector('.lucide-info'))
      assert.equal(container.querySelector('.lucide-triangle-alert, .lucide-shield-check'), null)
      assert.match(container.textContent, /does not establish that there are no risky users/)
    }
    assert.equal(reload(dom), undefined)
  }
  assert.equal(calls.length, 0)
}, false))

test('explicit disabled assessment stays informational; a 403 read is never inferred to be chosen opt-out', async () => mounted(async ({ render, dom, body }) => {
  nativeQueries[0].data = { version: 'hawkview-risky-users/v1', available: false, because: 'NOT_ENABLED_FOR_TENANT' }
  await render()
  assert.equal(hook.tenantStatuses[0].nativeSource, 'DISABLED')
  assert.match(body(), /Assessment is not enabled/)
  assert.equal(dom.window.document.querySelector('[role="img"]'), null)
  assert.doesNotMatch(body(), /opted out|user chose|sync fail/i)
  nativeQueries[0].data = native()
  microsoftQueries[1] = { isError: true, error: { status: 403 }, refetch: () => calls.push('microsoft:tenant-b') }
  await render()
  assert.equal(hook.tenantStatuses[1].microsoftSource, 'READ_FAILED')
  assert.match(dom.window.document.querySelector('[role="img"]').getAttribute('aria-label'), /tenant-b: Microsoft risk results could not be loaded/)
  assert.doesNotMatch(body(), /Assessment is not enabled|opted out|user chose|collection reports failure/i)
  await React.act(async () => reload(dom).click())
  assert.deepEqual(calls, ['microsoft:tenant-b'])
}))

test('tenant switching changes the empty-result claim without changing fleet source coverage', async () => mounted(async ({ render, dom, body }) => {
  microsoftQueries[1].data = unavailable('MISSING_PERMISSION')
  await render()
  const select = dom.window.document.querySelector('select')
  const choose = async (value: string) => React.act(async () => {
    select.value = value
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  await choose('tenant-a')
  assert.match(body(), /No users match the selected filters/)
  assert.match(body(), /Microsoft risk evidence: 4 of 5 tenants/)
  await choose('tenant-b')
  assert.match(body(), /No matching users shown/)
  assert.match(body(), /does not establish that there are no risky users/)
  assert.doesNotMatch(body(), /No users match the selected filters|No users require review|coverage is incomplete/)
  assert.match(body(), /Microsoft reports missing permission: 1 tenanttenant-b/)
  assert.equal(dom.window.document.querySelector('[role="img"]'), null)
  assert.equal(calls.length, 0)
}))
