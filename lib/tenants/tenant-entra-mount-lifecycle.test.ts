/** Mount the shipped tenant page through overview -> results panel -> collection control.
 * Only framework navigation, auth/feature context and HTTP/data edges are supplied by this fixture;
 * React reconciliation and the control's TanStack Query lifecycle remain real. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const React = require('react')
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query')
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '../..')

function makeLoader(mocks: Record<string, unknown>) {
  const cache = new Map<string, any>()
  const load = (base: string): any => {
    let file = ''
    let source = ''
    for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
      try { source = readFileSync(candidate, 'utf8'); file = candidate; break } catch { continue }
    }
    assert.ok(file, `Cannot resolve ${base}`)
    if (cache.has(file)) return cache.get(file)
    const moduleObject = { exports: {} as any }
    cache.set(file, moduleObject.exports)
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
      },
      fileName: file,
    })
    const localRequire = (specifier: string) => {
      if (specifier in mocks) return mocks[specifier]
      const local = specifier.startsWith('@/') ? resolve(repoRoot, specifier.slice(2))
        : specifier.startsWith('.') ? resolve(dirname(file), specifier) : null
      if (local && local in mocks) return mocks[local]
      return local ? load(local) : require(specifier)
    }
    new Function('require', 'exports', 'module', outputText)(localRequire, moduleObject.exports, moduleObject)
    cache.set(file, moduleObject.exports)
    return moduleObject.exports
  }
  return load
}

const scopeA = 'identity:subject-A:organizations:org-1'
const scopeB = 'identity:subject-B:organizations:org-1'
const off = () => ({ enabled: false, expected: {
  configurationRevision: 'G', connectionIncarnation: 'C', scopeIncarnation: 'S',
  scopeVersion: 'directory-role-assignments/v1',
} })
const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 0)) })
async function waitFor(predicate: () => boolean, description: string) {
  for (let turn = 0; turn < 80; turn++) {
    if (predicate()) return
    await settle()
  }
  assert.fail(`Timed out waiting for ${description}`)
}

test('same-tenant workspace updates preserve the Entra control; pending reads and scope changes stay guarded', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://hawkview.invalid', pretendToBeVisual: true,
  })
  // The page imports the map library for another tab; JSDOM lacks its import-time Blob URL API.
  const blobUrls: string[] = []
  dom.window.URL.createObjectURL = (blob: Blob) => {
    const url = URL.createObjectURL(blob)
    blobUrls.push(url)
    return url
  }
  const globals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 2_000 }, mutations: { retry: false, gcTime: 2_000 },
  } })
  const container = dom.window.document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  const AuthContext = React.createContext(null)
  let tenantId = 'tenant-A'
  let scope = scopeA
  const searchParams = new URLSearchParams()
  const router = { push: () => assert.fail('Unexpected navigation'), replace: () => assert.fail('Unexpected redirect') }
  const tenant = (id: string) => ({
    id, name: id, domain: `${id}.invalid`, provider: 'microsoft',
    status: 'healthy', secureScore: 0, licenseCount: 0, domains: [],
  })
  const tenants = [tenant('tenant-A'), tenant('tenant-B')]
  const refetchProjection = async () => {}
  const reads: Array<{ scope: string; tenant: string }> = []
  const writes: string[] = []
  const unexpectedReads: string[] = []
  let holdControlRead = false
  let releaseRead: (() => void) | undefined
  class ApiError extends Error {
    status = 503
    code = null
  }
  const apiClient = {
    get: async (endpoint: string) => {
      const match = /^\/api\/tenants\/([^/]+)(.*)$/.exec(endpoint)
      if (match?.[2] === '') return { bundle: {
        tenant: tenants.find((item) => item.id === match[1]), users: [], signIns: [],
        exchange: {}, sharepoint: {}, teams: {}, sync: {}, entra: {},
      } }
      if (match?.[2] === '/collection/directory-roles/control') {
        reads.push({ scope, tenant: match[1] })
        if (holdControlRead) await new Promise<void>((resolveRead) => { releaseRead = resolveRead })
        return off()
      }
      // Unrelated stored-result panels render their ordinary unavailable state. Their components
      // and hooks are real too; no collection, provider, or network request leaves this test.
      if (match && (/^\/pim\/schedules\/(ACTIVE|ELIGIBLE)\/summary$/.test(match[2])
        || match[2] === '/directory-roles/results')) throw new ApiError('Fixture: unavailable stored results')
      unexpectedReads.push(endpoint)
      throw new ApiError('Unexpected fixture request')
    },
    post: async (endpoint: string) => { writes.push(endpoint); throw new Error('No write is allowed in this test') },
  }
  const load = makeLoader({
    'next/navigation': {
      useParams: () => ({ id: tenantId }), usePathname: () => `/tenants/${tenantId}/entra/overview`,
      useSearchParams: () => searchParams, useRouter: () => router,
    },
    'next/link': { __esModule: true, default: ({ children, ...props }: any) => React.createElement('a', props, children) },
    '@/components/providers/auth-provider': { useAuth: () => React.useContext(AuthContext) },
    '@/components/providers/feature-flag-provider': { useFeatureFlags: () => ({ identityRiskUi: false }) },
    '@/lib/api/hooks': { useTenantOperationalProjection: (id: string) => ({
      actionableHealth: null, tenant: tenants.find((item) => item.id === id), tenants, refetch: refetchProjection,
    }) },
    [resolve(repoRoot, 'lib/api/client')]: { apiClient, ApiError },
  })
  const currentIdentityToken = () => scope
  const session = { user: { memberships: [{ role: 'MSP_OWNER' }] } }
  const button = () => Array.from(container.querySelectorAll('button'))
    .find((item) => /switch on collection/i.test(item.textContent ?? ''))
  try {
    const Page = load(resolve(repoRoot, 'app/(protected)/tenants/[id]/page.tsx')).default
    const render = () => React.act(() => root.render(
      React.createElement(QueryClientProvider, { client },
        React.createElement(AuthContext.Provider, {
          value: { cacheScope: scope, isLoading: false, session, currentIdentityToken },
        }, React.createElement(Page))),
    ))
    render()
    await waitFor(() => Boolean(button()) && client.isFetching() === 0, 'confirmed OFF control in real Entra overview')
    assert.ok(container.querySelector('#entra-tabpanel-overview'), 'real Entra route mounted')
    assert.match(container.textContent ?? '', /switched off for this tenant/i)
    const originalButton = button()!
    const initialReads = reads.length
    assert.ok(initialReads > 0, 'the mounted control completed a real query')

    // A provider render with the SAME identity and tenant makes the real workspace render again.
    // The original nested component replaces the control DOM and performs another stale read.
    render()
    await waitFor(() => Boolean(button()) && client.isFetching() === 0, 'settled same-context workspace update')
    await settle()
    const keptControl = button() === originalButton && originalButton.isConnected
    t.diagnostic(`Same-context update: control retained=${keptControl}; control reads ${initialReads}->${reads.length}; writes=${writes.length}`)
    assert.ok(keptControl, 'ordinary parent render must not remount the collection-control subtree')
    assert.equal(reads.length, initialReads, 'ordinary parent render must not issue another control read')

    const collapse = container.querySelector('button[aria-label="Collapse tenant navigation"]')
    assert.ok(collapse, 'real workspace collapse action is available')
    React.act(() => { collapse.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    await waitFor(() => Boolean(container.querySelector('button[aria-label="Expand tenant navigation"]')),
      'workspace-local collapse state to update')
    await settle()
    assert.equal(button(), originalButton, 'workspace-local state update also preserves the control')
    assert.equal(reads.length, initialReads, 'navigation collapse does not refetch collection state')

    holdControlRead = true
    let refetch: Promise<unknown> | undefined
    React.act(() => { refetch = client.refetchQueries({ queryKey: ['directory-role-control', scope, tenantId], exact: true }) })
    await waitFor(() => Boolean(releaseRead) && !button(), 'action withheld during real pending refetch')
    assert.doesNotMatch(container.textContent ?? '', /switched off for this tenant/i, 'pending read cannot restate stale OFF')
    holdControlRead = false
    await React.act(async () => { releaseRead!(); await refetch })
    await waitFor(() => Boolean(button()), 'action restored only after refetch succeeds')

    const beforeTenant = button()!
    tenantId = 'tenant-B'
    render()
    await waitFor(() => Boolean(button()) && client.isFetching() === 0, 'new tenant control')
    assert.equal(beforeTenant.isConnected, false, 'tenant boundary still deliberately remounts')
    assert.deepEqual(reads.at(-1), { scope: scopeA, tenant: 'tenant-B' })
    const beforeIdentity = button()!
    scope = scopeB
    render()
    await waitFor(() => Boolean(button()) && client.isFetching() === 0, 'new identity control')
    assert.equal(beforeIdentity.isConnected, false, 'account boundary still deliberately remounts')
    assert.deepEqual(reads.at(-1), { scope: scopeB, tenant: 'tenant-B' })
    assert.equal(reads.length, initialReads + 3, 'one explicit refetch and one read per changed boundary')
    assert.deepEqual(writes, [], 'render, refetch, and scope changes never activate collection')
    assert.deepEqual(unexpectedReads, [])
  } finally {
    releaseRead?.()
    await React.act(async () => { root.unmount(); await client.cancelQueries() })
    client.clear()
    await settle()
    for (const [key, descriptor] of Array.from(globals.entries())) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as any)[key]
    }
    dom.window.close()
    blobUrls.forEach((url) => URL.revokeObjectURL(url))
  }
})
