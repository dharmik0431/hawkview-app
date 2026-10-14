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

function loader(mocks: Record<string, unknown>) {
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
      }, fileName: file,
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

const settled = () => React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

async function mounted(
  sync: { lastSuccessfulAt: string | null; outcomeProjection?: { recordedOutcome: { kind: string } } } | null,
  firstRole: string,
  check: (container: HTMLElement, dom: any) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://hawkview.invalid', pretendToBeVisual: true,
  })
  dom.window.URL.createObjectURL = () => 'blob:synthetic'
  const globals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const tenantId = 'role-truth-test-tenant'
  const tenant = { id: tenantId, name: 'Synthetic', domain: 'example.invalid', provider: 'microsoft',
    status: 'healthy', secureScore: 0, licenseCount: 0, domains: [] }
  const user = (id: string, role: string) => ({
    id, name: id, email: `${id}@example.invalid`, type: 'Member', role,
    status: 'Enabled', mfa: 'Unknown', mfaRegistration: 'Unknown',
    authMethods: [], licenses: [], groups: [], devices: [],
  })
  const bundle = { tenant, users: [user('reader', firstRole), user('ordinary', '')],
    signIns: [], exchange: {}, sharepoint: {}, teams: {}, entra: {},
    sync: { directoryRoles: sync }, }
  const unexpectedWrites: string[] = []
  class ApiError extends Error { status = 503; code = null }
  const apiClient = {
    get: async (endpoint: string) => {
      if (endpoint === `/api/tenants/${tenantId}`) return { bundle }
      throw new ApiError(`Fixture: ${endpoint} unavailable`)
    },
    post: async (endpoint: string) => { unexpectedWrites.push(endpoint); throw Error('No writes allowed') },
  }
  const AuthContext = React.createContext(null)
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 2_000 }, mutations: { retry: false, gcTime: 2_000 },
  } })
  const searchParams = new URLSearchParams()
  const router = { push: () => assert.fail('Unexpected navigation'),
    replace: () => assert.fail('Unexpected redirect') }
  const tenants = [tenant]
  const refetchProjection = async () => {}
  const page = loader({
    'next/navigation': { useParams: () => ({ id: tenantId }),
      usePathname: () => `/tenants/${tenantId}/entra/users`,
      useSearchParams: () => searchParams,
      useRouter: () => router },
    'next/link': { __esModule: true, default: ({ children, ...props }: any) => React.createElement('a', props, children) },
    '@/components/providers/auth-provider': { useAuth: () => React.useContext(AuthContext) },
    '@/components/providers/feature-flag-provider': { useFeatureFlags: () => ({ identityRiskUi: false }) },
    '@/lib/api/hooks': { useTenantOperationalProjection: () => ({
      actionableHealth: null, tenant, tenants, refetch: refetchProjection,
    }) },
    [resolve(repoRoot, 'lib/api/client')]: { apiClient, ApiError },
  })(resolve(repoRoot, 'app/(protected)/tenants/[id]/page.tsx')).default
  const container = dom.window.document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  try {
    React.act(() => root.render(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, {
      value: { cacheScope: `role-truth-${firstRole}-${sync?.lastSuccessfulAt ?? 'never'}`,
        isLoading: false, session: { user: { memberships: [{ role: 'MSP_OWNER' }] } },
        currentIdentityToken: () => 'role-truth-identity' },
    }, React.createElement(page)))))
    for (let attempt = 0; attempt < 50 && !container.querySelector('#entra-tabpanel-users tbody'); attempt++) await settled()
    assert.ok(container.querySelector('#entra-tabpanel-users tbody'), 'real users table mounted')
    await check(container, dom)
    assert.deepEqual(unexpectedWrites, [])
  } finally {
    await React.act(async () => { root.unmount(); await client.cancelQueries() })
    client.clear()
    for (const [key, descriptor] of Array.from(globals.entries())) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

function roleSelect(container: HTMLElement) {
  const select = Array.from(container.querySelectorAll('select')).find((element) =>
    Array.from(element.options).some((option) => option.textContent === 'Stored direct role'))
  assert.ok(select, 'direct-role filter exists')
  return select
}

async function filter(container: HTMLElement, dom: any, value: string) {
  const select = roleSelect(container)
  await React.act(async () => {
    select.value = value
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
}

function rows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('#entra-tabpanel-users tbody tr'))
    .filter((row) => row.textContent?.includes('@example.invalid'))
}

function rowFor(container: HTMLElement, user: string) {
  const row = rows(container).find((item) => item.textContent?.includes(`${user}@example.invalid`))
  assert.ok(row, `${user} row exists`)
  return row
}

async function openUserDrawer(container: HTMLElement, dom: any, user: string, expectedRole: RegExp) {
  await React.act(async () => {
    rowFor(container, user).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  const close = container.querySelector('button[title="Close"]')
  assert.ok(close, 'real user drawer opened')
  assert.match(close.closest('.fixed')?.textContent ?? '', expectedRole)
  await React.act(async () => {
    close.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}

test('never-collected role evidence reaches the users table, drawer and unavailable filter', async () => {
  await mounted(null, 'Global Administrator', async (container, dom) => {
    assert.match(rowFor(container, 'reader').textContent ?? '', /Role data not collected/)
    await openUserDrawer(container, dom, 'reader', /Direct role: Not collected/)
    await filter(container, dom, 'unknown')
    assert.equal(rows(container).length, 2, 'unobserved roles must enter the unavailable bucket')
    await filter(container, dom, 'reported')
    assert.equal(rows(container).length, 0, 'historical names without proof must not enter stored-role filter')
  })
})

test('successful empty and non-admin direct roles use distinct filters without admin claims', async () => {
  await mounted({ lastSuccessfulAt: '2026-10-12T12:00:00Z' }, 'Directory Readers', async (container, dom) => {
    assert.match(rowFor(container, 'reader').textContent ?? '', /Directory Readers/)
    assert.match(rowFor(container, 'ordinary').textContent ?? '', /No direct role reported/)
    await openUserDrawer(container, dom, 'reader', /Direct role: Directory Readers/)
    assert.doesNotMatch(roleSelect(container).textContent ?? '', /Administrators/)
    await filter(container, dom, 'reported')
    assert.equal(rows(container).length, 1)
    assert.match(rowFor(container, 'reader').textContent ?? '', /Directory Readers/)
    await filter(container, dom, 'none')
    assert.equal(rows(container).length, 1)
    assert.match(rows(container)[0].textContent ?? '', /No direct role reported/)
  })
})

test('historical direct roles remain last reported after a failed refresh', async () => {
  await mounted({ lastSuccessfulAt: '2026-10-11T12:00:00Z',
    outcomeProjection: { recordedOutcome: { kind: 'FAILED' } } }, 'Global Administrator',
  async (container, dom) => {
    assert.match(rowFor(container, 'reader').textContent ?? '', /Global Administrator/)
    assert.match(rowFor(container, 'reader').textContent ?? '', /Last reported · latest refresh failed/)
    await openUserDrawer(container, dom, 'reader', /Direct role: Global Administrator/)
    await filter(container, dom, 'reported')
    assert.equal(rows(container).length, 1)
  })
})
