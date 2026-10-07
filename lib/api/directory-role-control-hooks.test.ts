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

const HOOK_FILE = resolvePath(repoRoot, 'lib/api/directory-role-control-hooks.ts')
const READY_A = 'identity:subject-A:organizations:org-1'

/** Mirrors the server's own ApiError: status and code are what the hook classifies on. */
class FakeApiError extends Error {
  status: number
  code: string | null
  constructor(status: number, message: string, code: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

const EXPECTED_A = {
  configurationRevision: 'cfg-A',
  connectionIncarnation: 'conn-A',
  scopeIncarnation: 'scope-A',
  scopeVersion: 'directory-role-assignments/v1',
}
const EXPECTED_B = {
  configurationRevision: 'cfg-B',
  connectionIncarnation: 'conn-B',
  scopeIncarnation: 'scope-B',
  scopeVersion: 'directory-role-assignments/v1',
}

type Harness = {
  cacheScope?: string
  customerTenantId?: string
  /** Seeded cache, keyed by the stringified query key the hook itself builds. */
  cached?: Array<{ key: readonly unknown[]; value: unknown }>
  get?: (endpoint: string, init: any) => Promise<unknown>
  post?: (endpoint: string, body: any) => Promise<unknown>
}

function harness(options: Harness = {}) {
  const gets: Array<{ endpoint: string; init: any }> = []
  const posts: Array<{ endpoint: string; body: any }> = []
  const invalidated: string[] = []
  const written: Array<{ key: string; value: unknown }> = []
  const store = new Map<string, unknown>()
  for (const entry of options.cached ?? []) store.set(JSON.stringify(entry.key), entry.value)

  let query: any = null
  let mutation: any = null
  const queryClient = {
    getQueryData: (key: readonly unknown[]) => store.get(JSON.stringify(key)),
    setQueryData: (key: readonly unknown[], value: unknown) => {
      store.set(JSON.stringify(key), value)
      written.push({ key: JSON.stringify(key), value })
    },
    invalidateQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      invalidated.push(JSON.stringify(queryKey))
      return Promise.resolve()
    },
  }

  const mod = loadModule(HOOK_FILE, {
    '@tanstack/react-query': {
      useQuery: (opts: any) => { query = opts; return { data: undefined, isPending: true } },
      useMutation: (opts: any) => { mutation = opts; return { mutate: () => {}, isPending: false } },
      useQueryClient: () => queryClient,
    },
    '@/components/providers/auth-provider': {
      useAuth: () => ({ cacheScope: options.cacheScope ?? READY_A, isLoading: false }),
    },
    './client': {
      ApiError: FakeApiError,
      apiClient: {
        get: async (endpoint: string, init: any) => {
          gets.push({ endpoint, init })
          return options.get ? options.get(endpoint, init) : { enabled: false, expected: EXPECTED_A }
        },
        post: async (endpoint: string, body: any) => {
          posts.push({ endpoint, body })
          if (options.post) return options.post(endpoint, body)
          return { enabled: body.enabled, expected: EXPECTED_A }
        },
      },
    },
  })

  const tenant = options.customerTenantId ?? 'tenant-A'
  mod.useDirectoryRoleControl(tenant)
  mod.useSetDirectoryRoleControl(tenant)
  assert.ok(query, 'the read hook must configure a query')
  assert.ok(mutation, 'the write hook must configure a mutation')
  return { mod, query, mutation, gets, posts, invalidated, written, store, tenant }
}

const keyFor = (tenant: string, scope = READY_A) =>
  JSON.stringify(['directory-role-control', scope, tenant])

test('an explicit action posts exactly the expectation the server reported, unaltered', async () => {
  const h = harness({ cached: [{ key: ['directory-role-control', READY_A, 'tenant-A'], value: { enabled: false, expected: EXPECTED_A } }] })
  await h.mutation.mutationFn({ enabled: true })
  assert.equal(h.posts.length, 1)
  assert.equal(h.posts[0].endpoint, '/api/tenants/tenant-A/collection/directory-roles/control')
  assert.equal(h.posts[0].body.enabled, true)
  assert.deepEqual(h.posts[0].body.expected, EXPECTED_A)
})

test('without a cached context the write is refused locally and nothing is sent', async () => {
  const h = harness()
  await assert.rejects(() => h.mutation.mutationFn({ enabled: true }))
  assert.equal(h.posts.length, 0, 'no expectation may be invented to make a write possible')
})

test('a write never carries another tenant’s expectation', async () => {
  // Only tenant-B's context is cached; the hook was built for tenant-A.
  const h = harness({
    customerTenantId: 'tenant-A',
    cached: [{ key: ['directory-role-control', READY_A, 'tenant-B'], value: { enabled: true, expected: EXPECTED_B } }],
  })
  await assert.rejects(() => h.mutation.mutationFn({ enabled: false }))
  assert.equal(h.posts.length, 0)
})

test('the read and the write both refuse automatic retry', () => {
  const h = harness()
  assert.equal(h.query.retry, false)
  assert.equal(h.mutation.retry, false)
})

test('a conflicting write is classified as a conflict and is not resent', async () => {
  const h = harness({
    cached: [{ key: ['directory-role-control', READY_A, 'tenant-A'], value: { enabled: false, expected: EXPECTED_A } }],
    post: async () => { throw new FakeApiError(409, 'changed', 'DIRECTORY_CONTROL_STALE') },
  })
  await assert.rejects(() => h.mutation.mutationFn({ enabled: true }))
  assert.equal(h.posts.length, 1, 'exactly one attempt: the authority-changing action is never replayed')
  assert.equal(h.mod.classifyControlFailure(new FakeApiError(409, 'changed'), 'write'), 'conflict')
  h.mutation.onError?.(new FakeApiError(409, 'changed'))
  assert.ok(h.invalidated.includes(keyFor('tenant-A')), 'the stale context must be dropped')
  assert.equal(h.posts.length, 1, 'recovery re-reads; it does not recapture and resend')
})

test('a 409 on read is unavailable, not a conflict, and 403 is forbidden on both', () => {
  const h = harness()
  assert.equal(h.mod.classifyControlFailure(new FakeApiError(409, 'x'), 'read'), 'unavailable')
  assert.equal(h.mod.classifyControlFailure(new FakeApiError(403, 'x'), 'read'), 'forbidden')
  assert.equal(h.mod.classifyControlFailure(new FakeApiError(403, 'x'), 'write'), 'forbidden')
  assert.equal(h.mod.classifyControlFailure(new FakeApiError(400, 'x'), 'write'), 'rejected')
  assert.equal(h.mod.classifyControlFailure(new Error('offline'), 'read'), 'error')
})

test('success writes the server answer in and invalidates this tenant’s results only', async () => {
  const h = harness({ cached: [{ key: ['directory-role-control', READY_A, 'tenant-A'], value: { enabled: false, expected: EXPECTED_A } }] })
  const next = await h.mutation.mutationFn({ enabled: true })
  h.mutation.onSuccess?.(next)
  assert.equal((h.store.get(keyFor('tenant-A')) as any).enabled, true)
  assert.ok(h.invalidated.includes(JSON.stringify(['directory-role-results', READY_A, 'tenant-A'])))
  assert.ok(!h.invalidated.some((k) => k.includes('tenant-B')), 'another tenant’s screen is untouched')
})

test('an unreadable answer fails instead of reporting a disabled opt-in', async () => {
  const h = harness({ get: async () => ({ enabled: 'yes', expected: EXPECTED_A }) })
  await assert.rejects(() => h.query.queryFn({ signal: undefined }))
})

test('the read is scoped to the identity and tenant together and sends no-store', async () => {
  const h = harness({ customerTenantId: 'tenant-A' })
  assert.deepEqual(h.query.queryKey, ['directory-role-control', READY_A, 'tenant-A'])
  await h.query.queryFn({ signal: undefined })
  assert.equal(h.gets[0].init.cache, 'no-store')
})
