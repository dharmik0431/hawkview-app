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

const HOOK_FILE = resolvePath(repoRoot, 'lib/api/directory-role-results-hooks.ts')
const READY_A = 'identity:subject-A:organizations:org-1'
const READY_B = 'identity:subject-B:organizations:org-2'
const SOURCE = 'Microsoft Graph v1.0 /roleManagement/directory/roleAssignments'

const answer = (o: Record<string, unknown> = {}) => ({
  responseVersion: 'directory-role-results/v1', source: SOURCE, status: 'never-collected',
  observation: null, latestAttempt: { outcome: null, terminalAt: null }, ...o,
})

function runHook(options: { cacheScope?: string; isLoading?: boolean; customerTenantId?: string; get?: (endpoint: string, init?: any) => Promise<unknown> }) {
  const calls: Array<{ endpoint: string; init: any }> = []
  let captured: any = null
  const mod = loadModule(HOOK_FILE, {
    '@tanstack/react-query': { useQuery: (opts: any) => { captured = opts; return { data: undefined, isPending: true } } },
    '@/components/providers/auth-provider': {
      useAuth: () => ({ cacheScope: options.cacheScope ?? READY_A, isLoading: options.isLoading ?? false }),
    },
    './client': {
      apiClient: {
        get: async (endpoint: string, init: any) => {
          calls.push({ endpoint, init })
          return options.get ? options.get(endpoint, init) : answer()
        },
      },
    },
  })
  mod.useDirectoryRoleResults(options.customerTenantId ?? 'tenant-A')
  assert.ok(captured, 'the hook must configure a query')
  return { query: captured, calls }
}

test('the query is keyed by identity scope and tenant, and gated on real readiness', () => {
  const a = runHook({}).query
  assert.deepEqual(a.queryKey, ['directory-role-results', READY_A, 'tenant-A'])
  const keys = [
    runHook({}).query, runHook({ cacheScope: READY_B }).query, runHook({ customerTenantId: 'tenant-B' }).query,
  ].map((q) => JSON.stringify(q.queryKey))
  assert.equal(new Set(keys).size, 3)

  for (const [label, options, expected] of [
    ['signed out', { cacheScope: 'signed-out' }, false],
    ['bootstrap pending', { cacheScope: 'identity:subject-A:bootstrap-pending' }, false],
    ['still loading', { isLoading: true }, false],
    ['no tenant', { customerTenantId: '' }, false],
    ['ready', {}, true],
  ] as Array<[string, Record<string, unknown>, boolean]>) {
    assert.equal(runHook(options).query.enabled, expected, label)
  }
})

test('no polling and no automatic retry are configured', () => {
  const { query } = runHook({})
  assert.equal(query.retry, false)
  assert.equal(query.staleTime, 60_000)
  assert.equal('refetchInterval' in query, false)
})

test('the request is tenant-scoped, no-store, and carries the abort signal', async () => {
  const controller = new AbortController()
  const { query, calls } = runHook({ customerTenantId: 'tenant-A' })
  await query.queryFn({ signal: controller.signal })
  assert.equal(calls[0].endpoint, '/api/tenants/tenant-A/directory-roles/results')
  assert.equal(calls[0].init.cache, 'no-store')
  assert.equal(calls[0].init.signal, controller.signal)

  const hostile = runHook({ customerTenantId: '../../admin?x=1' })
  await hostile.query.queryFn({ signal: controller.signal })
  assert.equal(hostile.calls[0].endpoint.includes('../'), false)
  assert.equal(hostile.calls[0].endpoint.includes('?'), false)
})

test('an unreadable answer fails the query rather than reading as nothing collected', async () => {
  for (const body of [{ nope: true }, answer({ responseVersion: 'directory-role-results/v2' }), answer({ status: 'collected' }), answer({ status: 'current' })]) {
    const { query } = runHook({ get: async () => body })
    await assert.rejects(() => query.queryFn({ signal: new AbortController().signal }), (error: Error) => {
      assert.match(error.message, /unsupported directory role result/)
      return true
    })
  }
})

test("a delayed answer for a previous identity or tenant never becomes the current query's data", async () => {
  const { QueryClient } = nodeRequire('@tanstack/react-query')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } } })
  const previous = runHook({ cacheScope: READY_A, customerTenantId: 'tenant-A' }).query
  const current = runHook({ cacheScope: READY_B, customerTenantId: 'tenant-B' }).query
  assert.notDeepEqual(previous.queryKey, current.queryKey)

  let settleSlow: (v: unknown) => void = () => undefined
  const slow = new Promise((res) => { settleSlow = res })
  let currentFetches = 0
  const previousFetch = client.fetchQuery({ queryKey: previous.queryKey, queryFn: () => slow })
  const currentFetch = client.fetchQuery({
    queryKey: current.queryKey,
    queryFn: async () => { currentFetches += 1; return { marker: 'current-tenant-B' } },
  })
  assert.deepEqual(await currentFetch, { marker: 'current-tenant-B' })
  assert.equal(currentFetches, 1)

  settleSlow({ marker: 'previous-tenant-A' })
  await previousFetch
  assert.deepEqual(client.getQueryData(current.queryKey), { marker: 'current-tenant-B' })
  assert.deepEqual(client.getQueryData(previous.queryKey), { marker: 'previous-tenant-A' })
  client.clear()
})

test('the hook and its panel issue no write and trigger no collection', () => {
  const emitted = (p: string) => {
    const { outputText } = ts.transpileModule(readFileSync(p, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, removeComments: true },
      fileName: p,
    })
    return outputText
  }
  for (const file of [HOOK_FILE, resolvePath(repoRoot, 'components/tenant/directory-role-assignments-panel.tsx')]) {
    const code = emitted(file)
    for (const forbidden of ['useMutation', 'apiClient.post', 'apiClient.put', 'apiClient.patch', 'apiClient.delete', 'refetchInterval', 'activateRoleScope']) {
      assert.equal(code.includes(forbidden), false, `${file} must not use ${forbidden}`)
    }
  }
})
