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
const RQ = require('@tanstack/react-query')
let client: any
const pending = new Map<string, any[]>()
function transport(key: string) {
  calls.push(key)
  return new Promise((resolve, reject) => {
    const list = pending.get(key) ?? []
    list.push({ resolve, reject })
    pending.set(key, list)
  })
}
function settle(key: string, value: any, fail = false) {
  const item = pending.get(key)?.shift()
  assert.ok(item, `pending ${key}`)
  if (fail) item.reject(new Error('synthetic rejected read'))
  else item.resolve(value)
}
function sourceKey(id: string, source: string) {
  return ['fleet-risky-users', scope, id, source]
}
function failQuery(key: any[]) {
  client
    .getQueryCache()
    .find({ queryKey: key, exact: true })
    .setState({
      status: 'error',
      error: new Error('synthetic failed read'),
      fetchStatus: 'idle',
    })
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

let scope = 'synthetic'
let hook: any
const ids = ['tenant-a', 'tenant-b', 'tenant-c', 'tenant-d', 'tenant-e']
const calls: string[] = []
const mocks: Record<string, any> = {
  '@/components/providers/auth-provider': {
    useAuth: () => ({ cacheScope: scope }),
  },
  './hooks': {
    useTenants: () =>
      RQ.useQuery({
        queryKey: ['tenants', scope],
        queryFn: () => transport('tenants'),
        retry: false,
        staleTime: 300_000,
      }),
  },
  './client': {
    apiClient: {
      get(path: string) {
        const match = path.match(/tenants\/([^/]+)\/(.*)/)!
        return transport(
          `${scope}:${match[1]}:${match[2] === 'risky-users/assessment' ? 'native' : 'ms'}`
        )
      },
    },
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
  pending.clear()
  scope = 'synthetic'
  client = new RQ.QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        retryOnMount: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        gcTime: Infinity,
      },
    },
  })
  client.setQueryData(['tenants', scope], {
    tenants: ids.slice(0, count).map((id) => ({ id, name: id })),
  })
  for (const id of ids.slice(0, count)) {
    client.setQueryData(sourceKey(id, 'assessment'), native())
    client.setQueryData(sourceKey(id, 'microsoft-risky-users'), microsoft())
  }
}
async function mounted(
  run: (x: {
    render: () => Promise<void>
    body: () => string
    dom: any
    renderSync: () => void
    unmountSync: () => void
  }) => Promise<void>
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
        await React.act(async () =>
          root.render(
            React.createElement(
              RQ.QueryClientProvider,
              { client },
              React.createElement(Page)
            )
          )
        )
      },
      renderSync: () =>
        require('react-dom').flushSync(() =>
          root.render(
            React.createElement(
              RQ.QueryClientProvider,
              { client },
              React.createElement(Page)
            )
          )
        ),
      unmountSync: () => require('react-dom').flushSync(() => root.unmount()),
      body: () => dom.window.document.body.textContent,
      dom,
    })
  } finally {
    await React.act(async () => root.unmount())
    client.clear()
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

test('real observers: mixed source targeting, rapid clicks, inflight guard, settlement and remaining error', async () =>
  mounted(async ({ render, dom, body }) => {
    failQuery(sourceKey(ids[0], 'assessment'))
    failQuery(sourceKey(ids[1], 'microsoft-risky-users'))
    client.setQueryData(
      sourceKey(ids[2], 'microsoft-risky-users'),
      unavailable('LICENSE_REQUIRED')
    )
    await render()
    assert.equal(calls.length, 0)
    assert.ok(reload(dom))
    await React.act(async () => {
      reload(dom).click()
      reload(dom).click()
      hook.reloadFailedResults()
      await flush()
    })
    assert.deepEqual(calls, [
      'synthetic:tenant-a:native',
      'synthetic:tenant-b:ms',
    ])
    await React.act(async () => {
      hook.reloadFailedResults()
      await flush()
    })
    assert.equal(calls.length, 2)
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    assert.match(body(), /Loading results/)
    await React.act(async () => {
      settle(calls[0], native())
      settle(calls[1], null, true)
      await new Promise((r) => setTimeout(r, 20))
    })
    assert.equal(hook.tenantStatuses[0].nativeSource, 'READY')
    assert.equal(hook.tenantStatuses[1].microsoftSource, 'READ_FAILED')
    await React.act(async () => {
      hook.reloadFailedResults()
      await flush()
    })
    assert.deepEqual(calls, [
      'synthetic:tenant-a:native',
      'synthetic:tenant-b:ms',
      'synthetic:tenant-b:ms',
    ])
    await React.act(async () => {
      settle('synthetic:tenant-b:ms', microsoft())
      await new Promise((r) => setTimeout(r, 20))
    })
    assert.equal(reload(dom), undefined)
    assert.match(body(), /Microsoft reports a license requirement/)
  }))
test('real observers: failed enumeration targets enumeration only, preserves unknown denominator and guards inflight', async () =>
  mounted(async ({ render, body, dom }) => {
    failQuery(['tenants', scope])
    failQuery(sourceKey(ids[0], 'assessment'))
    await render()
    assert.equal(calls.length, 0)
    assert.match(body(), /Coverage is unknown/)
    assert.doesNotMatch(body(), /\d+ of \d+ tenants/)
    await React.act(async () => {
      reload(dom).click()
      hook.reloadFailedResults()
      await flush()
    })
    assert.deepEqual(calls, ['tenants'])
    await React.act(async () => {
      hook.reloadFailedResults()
      await flush()
    })
    assert.deepEqual(calls, ['tenants'])
    await React.act(async () => {
      settle('tenants', { tenants: ids.map((id) => ({ id, name: id })) })
      await new Promise((r) => setTimeout(r, 20))
    })
    assert.equal(hook.enumerationKnown, true)
    assert.equal(calls.length, 1)
    await React.act(async () => {
      hook.reloadFailedResults()
      await flush()
    })
    assert.deepEqual(calls, ['tenants', 'synthetic:tenant-a:native'])
  }))
test('real observers: an old selection handler invoked AFTER selection change is rejected', async () =>
  mounted(async ({ render, dom }) => {
    failQuery(sourceKey(ids[0], 'assessment'))
    failQuery(sourceKey(ids[1], 'assessment'))
    await render()
    const old = hook.reloadFailedResults
    await React.act(async () => {
      const select = dom.window.document.querySelector('select')
      select.value = ids[1]
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    await React.act(async () => {
      old()
      await flush()
    })
    assert.deepEqual(calls, [])
    await React.act(async () => {
      hook.reloadFailedResults()
      await flush()
    })
    assert.deepEqual(calls, ['synthetic:tenant-b:native'])
  }))
test('ACCEPTANCE: queued reload must revalidate selection immediately before dispatch', async () =>
  mounted(async ({ render, dom }) => {
    failQuery(sourceKey(ids[0], 'assessment'))
    await render()
    await React.act(async () => {
      hook.reloadFailedResults()
      require('react-dom').flushSync(() => {
        const select = dom.window.document.querySelector('select')
        select.value = ids[1]
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
      await flush()
    })
    assert.deepEqual(
      calls,
      [],
      'tenant-a dispatch must be cancelled after selecting tenant-b before microtask'
    )
  }))
test('ACCEPTANCE: queued reload must revalidate organization immediately before dispatch', async () =>
  mounted(async ({ render, renderSync }) => {
    failQuery(sourceKey(ids[0], 'assessment'))
    await render()
    await React.act(async () => {
      hook.reloadFailedResults()
      scope = 'other-org'
      client.setQueryData(['tenants', scope], {
        tenants: ids.map((id) => ({ id, name: id })),
      })
      for (const id of ids) {
        client.setQueryData(sourceKey(id, 'assessment'), native())
        client.setQueryData(sourceKey(id, 'microsoft-risky-users'), microsoft())
      }
      renderSync()
      await flush()
    })
    assert.deepEqual(
      calls,
      [],
      'old observer must not dispatch through transport after auth scope changed'
    )
  }))
test('ACCEPTANCE: queued reload must not dispatch after unmount', async () =>
  mounted(async ({ render, unmountSync }) => {
    failQuery(sourceKey(ids[0], 'assessment'))
    await render()
    await React.act(async () => {
      hook.reloadFailedResults()
      unmountSync()
      await flush()
    })
    assert.deepEqual(calls, [], 'unmounted hook must cancel deferred dispatch')
  }))

test('real observers: scope-change no-click control causes no failed-source dispatch', async () =>
  mounted(async ({ render, renderSync }) => {
    failQuery(sourceKey(ids[0], 'assessment'))
    await render()
    const old = hook.reloadFailedResults
    await React.act(async () => {
      scope = 'other-org'
      client.setQueryData(['tenants', scope], {
        tenants: ids.map((id) => ({ id, name: id })),
      })
      for (const id of ids) {
        client.setQueryData(sourceKey(id, 'assessment'), native())
        client.setQueryData(sourceKey(id, 'microsoft-risky-users'), microsoft())
      }
      renderSync()
      old()
      await flush()
    })
    assert.deepEqual(calls, [])
  }))
test('ACCEPTANCE: settled recovered observer must not refetch again before React notification', async () =>
  mounted(async ({ render }) => {
    failQuery(sourceKey(ids[0], 'assessment'))
    await render()
    await React.act(async () => {
      hook.reloadFailedResults()
      await flush()
      assert.deepEqual(calls, ['synthetic:tenant-a:native'])
      settle('synthetic:tenant-a:native', native())
      for (let i = 0; i < 60; i++) await Promise.resolve()
      assert.equal(
        client.getQueryState(sourceKey(ids[0], 'assessment')).status,
        'success'
      )
      hook.reloadFailedResults()
      await flush()
    })
    assert.deepEqual(
      calls,
      ['synthetic:tenant-a:native'],
      'recovered actual query is not a failed request even before React sees success'
    )
  }))

for (const transition of [
  'recovered',
  'removed tenant',
  'failed enumeration',
] as const) {
  test(`queued reload checks live cache after ${transition} before React notification`, async () =>
    mounted(async ({ render }) => {
      const key = sourceKey(ids[0], 'assessment')
      failQuery(key)
      await render()
      await React.act(async () => {
        hook.reloadFailedResults()
        if (transition === 'recovered') client.setQueryData(key, native())
        else if (transition === 'removed tenant')
          client.setQueryData(['tenants', scope], {
            tenants: ids.slice(1).map((id) => ({ id, name: id })),
          })
        else failQuery(['tenants', scope])
        await flush()
      })
      assert.deepEqual(calls, [])
    }))
}
