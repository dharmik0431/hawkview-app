import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import test from 'node:test'

const nodeRequire = createRequire(import.meta.url)
const ts = nodeRequire('typescript')
const here = dirname(new URL(import.meta.url).pathname)
const repoRoot = resolvePath(here, '..', '..')

/** Compile and run the real source file, replacing only the named module boundaries. */
function loadModule(absPath: string, mocks: Record<string, unknown>, cache = new Map<string, any>()): any {
  const file = absPath.endsWith('.ts') || absPath.endsWith('.tsx') ? absPath : `${absPath}.ts`
  if (cache.has(file)) return cache.get(file)
  const source = readFileSync(file, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: file,
  })
  const moduleExports: Record<string, any> = {}
  const moduleObject = { exports: moduleExports }
  cache.set(file, moduleExports)
  const shimRequire = (specifier: string) => {
    if (specifier in mocks) return mocks[specifier]
    if (specifier.startsWith('@/')) return loadModule(resolvePath(repoRoot, specifier.slice(2)), mocks, cache)
    if (specifier.startsWith('.')) return loadModule(resolvePath(dirname(file), specifier), mocks, cache)
    return nodeRequire(specifier)
  }
  new Function('require', 'exports', 'module', outputText)(shimRequire, moduleExports, moduleObject)
  cache.set(file, moduleObject.exports)
  return moduleObject.exports
}

const HOOK_FILE = resolvePath(repoRoot, 'lib/api/pim-schedule-summary-hooks.ts')
const READY_SCOPE_A = 'identity:subject-A:organizations:org-1'
const READY_SCOPE_B = 'identity:subject-B:organizations:org-2'
const { isReadyDataScope } = loadModule(HOOK_FILE, {
  '@tanstack/react-query': { useQuery: () => ({}) },
  '@/components/providers/auth-provider': { useAuth: () => ({ cacheScope: '', isLoading: true }) },
  './client': { apiClient: { get: async () => ({}) } },
})
const ATTEMPT_ID = 'attempt-SENTINEL-8f21'
const CONTENT_DIGEST = 'digest-SENTINEL-abc123'

function observation(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: ATTEMPT_ID,
    scopeVersion: 'scope-SENTINEL-v97',
    committedAt: '2026-10-04T11:22:33.000Z',
    contentChangedAt: '2026-10-02T08:00:00.000Z',
    contentDigest: CONTENT_DIGEST,
    observedRecordCount: 4,
    ageMs: 172_800_000,
    traversalOutcome: 'EXHAUSTED',
    assurance: 'UNKNOWN',
    coverage: 'NOT_ESTABLISHED',
    ...overrides,
  }
}

function responseFor(plane: string, overrides: Record<string, unknown> = {}) {
  return {
    responseVersion: 'pim-schedule-summary/v1',
    plane,
    status: 'observed',
    lastCommitted: observation(),
    ...overrides,
  }
}

/** Runs the real hook with the real parser; only react-query, auth and the HTTP client are doubled. */
function runHook(options: {
  cacheScope?: string
  isLoading?: boolean
  customerTenantId?: string
  plane?: string
  get?: (endpoint: string, init?: any) => Promise<unknown>
}) {
  const calls: Array<{ endpoint: string; init: any }> = []
  let captured: any = null
  const mocks = {
    '@tanstack/react-query': {
      useQuery: (opts: any) => {
        captured = opts
        return { data: undefined, isPending: true }
      },
    },
    '@/components/providers/auth-provider': {
      useAuth: () => ({
        cacheScope: options.cacheScope ?? READY_SCOPE_A,
        isLoading: options.isLoading ?? false,
      }),
    },
    './client': {
      apiClient: {
        get: async (endpoint: string, init: any) => {
          calls.push({ endpoint, init })
          return options.get
            ? options.get(endpoint, init)
            : responseFor(options.plane ?? 'ACTIVE')
        },
      },
    },
  }
  const mod = loadModule(HOOK_FILE, mocks)
  mod.usePimScheduleSummary(options.customerTenantId ?? 'tenant-A', options.plane ?? 'ACTIVE')
  assert.ok(captured, 'the hook must configure a query')
  return { query: captured, calls }
}

test('the query is keyed by identity scope, tenant and plane together', () => {
  const a = runHook({ cacheScope: READY_SCOPE_A, customerTenantId: 'tenant-A', plane: 'ACTIVE' }).query
  const b = runHook({ cacheScope: READY_SCOPE_A, customerTenantId: 'tenant-A', plane: 'ELIGIBLE' }).query
  const c = runHook({ cacheScope: READY_SCOPE_A, customerTenantId: 'tenant-B', plane: 'ACTIVE' }).query
  const d = runHook({ cacheScope: READY_SCOPE_B, customerTenantId: 'tenant-A', plane: 'ACTIVE' }).query
  assert.deepEqual(a.queryKey, ['pim-schedule-summary', READY_SCOPE_A, 'tenant-A', 'ACTIVE'])
  const keys = [a, b, c, d].map((q) => JSON.stringify(q.queryKey))
  assert.equal(new Set(keys).size, 4, 'plane, tenant and identity must each change the cache key')
})

/** The scopes below are produced by the REAL provider helper, not invented for the test: an empty
 *  string is not one of the states that can occur. */
test('the readiness sentinels the real provider emits are all truthy, which is why truthiness is not the gate', () => {
  const dataIsolation = loadModule(resolvePath(repoRoot, 'lib/auth/data-isolation.ts'), {})
  const signedOut = dataIsolation.authDataScope(undefined, null)
  const bootstrapPending = dataIsolation.authDataScope('subject-A', { user: { memberships: [] } })
  const ready = dataIsolation.authDataScope('subject-A', {
    user: { memberships: [{ organization: { id: 'org-1' } }] },
  })
  assert.equal(signedOut, 'signed-out')
  assert.equal(bootstrapPending, 'identity:subject-A:bootstrap-pending')
  assert.equal(ready, 'identity:subject-A:organizations:org-1')
  for (const scope of [signedOut, bootstrapPending, ready]) {
    assert.equal(Boolean(scope), true, `${scope} is truthy, so Boolean(cacheScope) admits it`)
  }
  assert.equal(isReadyDataScope(signedOut), false)
  assert.equal(isReadyDataScope(bootstrapPending), false)
  assert.equal(isReadyDataScope(ready), true)
})

test('the query is disabled for signed-out, bootstrap-pending and still-loading contexts', () => {
  const cases: Array<[string, { cacheScope?: string; isLoading?: boolean; customerTenantId?: string }, boolean]> = [
    ['signed out', { cacheScope: 'signed-out' }, false],
    ['bootstrap pending', { cacheScope: 'identity:subject-A:bootstrap-pending' }, false],
    ['ready but still loading', { cacheScope: READY_SCOPE_A, isLoading: true }, false],
    ['ready with no tenant selected', { cacheScope: READY_SCOPE_A, customerTenantId: '' }, false],
    ['ready with a tenant', { cacheScope: READY_SCOPE_A }, true],
  ]
  for (const [label, options, expected] of cases) {
    const { query } = runHook({ customerTenantId: 'tenant-A', ...options })
    assert.equal(query.enabled, expected, label)
    // A disabled query must still be keyed correctly, never keyed on a placeholder.
    assert.equal(query.queryKey[1], options.cacheScope ?? READY_SCOPE_A)
  }
})

test('no retry loop and no polling interval are configured', () => {
  const { query } = runHook({})
  assert.equal(query.retry, false)
  assert.equal(query.staleTime, 60_000)
  assert.equal('refetchInterval' in query, false, 'this read-only panel must not poll')
  assert.equal('refetchIntervalInBackground' in query, false)
})

test('the request targets the authenticated summary route with the encoded tenant id, no-store and the abort signal', async () => {
  const controller = new AbortController()
  const { query, calls } = runHook({ customerTenantId: 'tenant-A', plane: 'ELIGIBLE' })
  await query.queryFn({ signal: controller.signal })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].endpoint, '/api/tenants/tenant-A/pim/schedules/ELIGIBLE/summary')
  assert.equal(calls[0].init.cache, 'no-store')
  assert.equal(calls[0].init.signal, controller.signal, 'the query signal must reach the client verbatim')
})

test('a path-hostile tenant id is encoded, never spliced into the route', async () => {
  const { query, calls } = runHook({ customerTenantId: '../../admin?x=1' })
  await query.queryFn({ signal: new AbortController().signal })
  assert.equal(calls[0].endpoint, '/api/tenants/..%2F..%2Fadmin%3Fx%3D1/pim/schedules/ACTIVE/summary')
  assert.equal(calls[0].endpoint.includes('../'), false)
  assert.equal(calls[0].endpoint.includes('?'), false)
})

test('a valid answer becomes a view model that carries no internal identifier', async () => {
  const { query } = runHook({ plane: 'ACTIVE' })
  const view = await query.queryFn({ signal: new AbortController().signal })
  assert.equal(view.status, 'observed')
  assert.equal(view.plane, 'ACTIVE')
  assert.equal(view.lastObservation.observedRecordCount, 4)
  const serialised = JSON.stringify(view)
  assert.equal(serialised.includes(ATTEMPT_ID), false)
  assert.equal(serialised.includes(CONTENT_DIGEST), false)
})

test('an unreadable or mismatched answer fails the query instead of reading as no observations', async () => {
  const cases: Array<[string, unknown]> = [
    ['malformed envelope', { nope: true }],
    ['unsupported version', responseFor('ACTIVE', { responseVersion: 'pim-schedule-summary/v2' })],
    ['another plane', responseFor('ELIGIBLE')],
    ['unknown status', responseFor('ACTIVE', { status: 'collecting' })],
    ['observed with no observation', responseFor('ACTIVE', { lastCommitted: null })],
    ['non-finite count', responseFor('ACTIVE', { lastCommitted: observation({ observedRecordCount: Number.POSITIVE_INFINITY }) })],
  ]
  for (const [label, body] of cases) {
    const { query } = runHook({ plane: 'ACTIVE', get: async () => body })
    await assert.rejects(
      () => query.queryFn({ signal: new AbortController().signal }),
      (error: Error) => {
        assert.match(error.message, /unsupported PIM schedule summary/)
        // Product-facing failure text must not carry the raw answer.
        assert.equal(error.message.includes('SENTINEL'), false)
        assert.equal(error.message.includes('status'), false)
        return true
      },
      label
    )
  }
})

test('a transport failure propagates unchanged and is never degraded to an empty summary', async () => {
  const sentinel = new Error('RAW-UPSTREAM-500-SENTINEL')
  const { query } = runHook({ get: async () => { throw sentinel } })
  await assert.rejects(() => query.queryFn({ signal: new AbortController().signal }), (error: unknown) => {
    assert.equal(error, sentinel, 'the hook must not swallow the failure')
    return true
  })
})

test('an aborted request rejects rather than resolving to stale or empty data', async () => {
  const controller = new AbortController()
  const { query } = runHook({
    get: async (_endpoint, init) => {
      controller.abort()
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError', signal: init.signal })
    },
  })
  await assert.rejects(() => query.queryFn({ signal: controller.signal }), (error: any) => {
    assert.equal(error.name, 'AbortError')
    assert.equal(error.signal, controller.signal)
    return true
  })
})

// ---------------------------------------------------------------------------
// The scope-switch property, proven against the installed react-query cache.
// ---------------------------------------------------------------------------

function deferred() {
  let settle: (value: unknown) => void = () => undefined
  const promise = new Promise((res) => { settle = res })
  return { promise, settle }
}

function viewOf(client: any, key: unknown[]) {
  return client.getQueryData(key)
}

test('a delayed answer for a previous identity or tenant never becomes the current query\'s data', async () => {
  const { QueryClient } = nodeRequire('@tanstack/react-query')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } } })
  const previous = runHook({ cacheScope: READY_SCOPE_A, customerTenantId: 'tenant-A' }).query
  const current = runHook({ cacheScope: READY_SCOPE_B, customerTenantId: 'tenant-B' }).query
  assert.notDeepEqual(previous.queryKey, current.queryKey)

  const slow = deferred()
  const fast = deferred()
  let currentFetches = 0

  const previousFetch = client.fetchQuery({ queryKey: previous.queryKey, queryFn: () => slow.promise })
  const currentFetch = client.fetchQuery({
    queryKey: current.queryKey,
    queryFn: () => { currentFetches += 1; return fast.promise },
  })

  fast.settle({ marker: 'current-tenant-B' })
  assert.deepEqual(await currentFetch, { marker: 'current-tenant-B' })
  assert.equal(currentFetches, 1, 'the current query must issue its own request, not reuse another scope\'s')
  assert.deepEqual(viewOf(client, current.queryKey), { marker: 'current-tenant-B' })

  // The previous identity's request now lands, after the switch.
  slow.settle({ marker: 'previous-tenant-A' })
  await previousFetch
  assert.deepEqual(viewOf(client, current.queryKey), { marker: 'current-tenant-B' }, 'the late answer must not surface here')
  assert.deepEqual(viewOf(client, previous.queryKey), { marker: 'previous-tenant-A' }, 'it belongs to its own key')
  client.clear()
})

test('regression control: with the scope dropped from the key, the late previous answer does surface as current', async () => {
  const { QueryClient } = nodeRequire('@tanstack/react-query')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } } })
  // The same scenario, keyed the way the implementation deliberately does NOT key it.
  const scopelessKey = ['pim-schedule-summary', 'ACTIVE']
  const slow = deferred()
  const fast = deferred()
  let currentFetches = 0

  const previousFetch = client.fetchQuery({ queryKey: scopelessKey, queryFn: () => slow.promise })
  const currentFetch = client.fetchQuery({
    queryKey: scopelessKey,
    queryFn: () => { currentFetches += 1; return fast.promise },
  })

  fast.settle({ marker: 'current-tenant-B' })
  slow.settle({ marker: 'previous-tenant-A' })
  const currentResult = await currentFetch
  await previousFetch

  assert.equal(currentFetches, 0, 'control: the current request was folded into the previous scope\'s in-flight one')
  assert.deepEqual(currentResult, { marker: 'previous-tenant-A' }, 'control: the current consumer received the previous tenant\'s data')
  assert.deepEqual(viewOf(client, scopelessKey), { marker: 'previous-tenant-A' })
  client.clear()
})

test('cancelling a previous scope\'s query leaves no data behind and does not disturb the current one', async () => {
  const { QueryClient } = nodeRequire('@tanstack/react-query')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } } })
  const previous = runHook({ cacheScope: READY_SCOPE_A, customerTenantId: 'tenant-A' }).query
  const current = runHook({ cacheScope: READY_SCOPE_B, customerTenantId: 'tenant-B' }).query
  const slow = deferred()

  const previousFetch = client.fetchQuery({ queryKey: previous.queryKey, queryFn: () => slow.promise }).catch((error: any) => error)
  await client.cancelQueries({ queryKey: previous.queryKey })
  slow.settle({ marker: 'previous-tenant-A' })
  await previousFetch

  assert.equal(viewOf(client, previous.queryKey), undefined, 'a cancelled fetch must leave no data')
  await client.fetchQuery({ queryKey: current.queryKey, queryFn: async () => ({ marker: 'current-tenant-B' }) })
  assert.deepEqual(viewOf(client, current.queryKey), { marker: 'current-tenant-B' })
  client.clear()
})

/** Emitted JavaScript with comments removed, so prose mentioning a forbidden call cannot pass or fail
 * this check — only code can. */
function emittedCode(absPath: string) {
  const { outputText } = ts.transpileModule(readFileSync(absPath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      removeComments: true,
    },
    fileName: absPath,
  })
  assert.equal(outputText.includes('//'), false, 'comments must be stripped for this check to mean anything')
  return outputText
}

/** The state combination the panel must survive: react-query keeps the previous successful data on
 *  the query while reporting an error, so a consumer that renders `data` whenever it exists shows a
 *  stale observation as the current one. This test establishes the combination is real. */
test('a failed refetch leaves the previous successful data on the query alongside the error', async () => {
  const { QueryClient } = nodeRequire('@tanstack/react-query')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } } })
  const key = ['pim-schedule-summary', READY_SCOPE_A, 'tenant-A', 'ACTIVE']
  await client.fetchQuery({ queryKey: key, queryFn: async () => ({ marker: 'first-success' }) })
  assert.deepEqual(client.getQueryData(key), { marker: 'first-success' })

  const forbidden = new Error('forbidden')
  await client.fetchQuery({ queryKey: key, queryFn: async () => { throw forbidden } }).catch(() => undefined)
  const state = client.getQueryCache().find({ queryKey: key })?.state
  assert.equal(state?.status, 'error')
  assert.equal(state?.error, forbidden)
  assert.deepEqual(state?.data, { marker: 'first-success' }, 'the stale observation is still on the query')
  client.clear()
})

test('the hook and its panel issue no write and trigger no collection', () => {
  const hookSource = emittedCode(HOOK_FILE)
  const panelSource = emittedCode(resolvePath(repoRoot, 'components/tenant/pim-schedule-observations-panel.tsx'))
  // The hook's own prose says 'NO refetchInterval'; that must not be what satisfies this check.
  assert.equal(readFileSync(HOOK_FILE, 'utf8').includes('refetchInterval'), true)
  for (const [label, source] of [['hook', hookSource], ['panel', panelSource]] as const) {
    for (const forbidden of ['useMutation', 'apiClient.post', 'apiClient.put', 'apiClient.patch', 'apiClient.delete', 'refetchInterval']) {
      assert.equal(source.includes(forbidden), false, `${label} must not use ${forbidden}`)
    }
  }
  assert.ok(hookSource.includes("apiClient.get"), 'the hook reads the summary API')
})
