// Adapted from independent HAW38 QA: real page/state/overview, controlled API promises,
// navigation and auth boundaries. Unrelated section components are stubbed. No network.
const fs = require('fs'),
  path = require('path'),
  assert = require('node:assert/strict'),
  test = require('node:test'),
  ts = require('typescript'),
  React = require('react'),
  { JSDOM } = require('jsdom'),
  { createRoot } = require('react-dom/client')
const base = path.resolve(__dirname, '..'),
  cache = new Map()
let tenant = 'a',
  scope = 'account1'
const readiness = {}
const requests = []
const refetch = async () => {}
const router = { push() {}, replace() {} }
const blank = () => null
const api = {
  get: (url) =>
    new Promise((resolve, reject) =>
      requests.push({ method: 'GET', url, resolve, reject })
    ),
  post: (url) =>
    new Promise((resolve, reject) =>
      requests.push({ method: 'POST', url, resolve, reject })
    ),
}
function load(file) {
  if (cache.has(file)) return cache.get(file)
  const out = {}
  cache.set(file, out)
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  new Function('require', 'exports', js)((name) => {
    if (name === 'next/navigation')
      return {
        useParams: () => ({ id: tenant }),
        usePathname: () => `/tenants/${tenant}/overview`,
        useRouter: () => router,
        useSearchParams: () => new URLSearchParams(),
      }
    if (name === 'next/link')
      return {
        __esModule: true,
        default: ({ children, ...p }) => React.createElement('a', p, children),
      }
    if (name === '@/lib/api/client') return { apiClient: api }
    if (name === '@/lib/api/hooks')
      return {
        useTenantOperationalProjection: () => ({
          actionableHealth: { status: 'VERIFIED', items: [] },
          tenant: { collectionReadiness: readiness[tenant] },
          tenants: [],
          refetch,
        }),
      }
    if (name === '@/components/providers/auth-provider')
      return { useAuth: () => ({ cacheScope: scope }) }
    if (name === '@/components/providers/feature-flag-provider')
      return { useFeatureFlags: () => ({ identityRiskUi: false }) }
    if (
      name.includes('/sections/') ||
      name === './settings/page' ||
      name.includes('identity-risk/') ||
      name === './components/tenant-blade' ||
      name === './components/tenant-breadcrumb'
    )
      return new Proxy(
        { __esModule: true, default: blank },
        { get: (o, k) => (k in o ? o[k] : blank) }
      )
    if (name === 'react-simple-maps' || name === 'd3-geo')
      return new Proxy({}, { get: () => blank })
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name)
    const target = name.startsWith('@/')
      ? path.join(base, name.slice(2))
      : path.resolve(path.dirname(file), name)
    const f = [target, target + '.tsx', target + '.ts'].find(fs.existsSync)
    return load(f)
  }, out)
  return out
}
const Page = load(
  path.join(base, 'app/(protected)/tenants/[id]/page.tsx')
).default
function bundle(id, label) {
  return {
    tenant: {
      id,
      name: label,
      displayName: label,
      domain: `${id}.invalid`,
      provider: 'microsoft',
      status: 'connected',
    },
    users: [],
    signIns: [],
    exchange: {},
    sharepoint: {},
    teams: {},
    sync: {
      users: {
        status: 'failed',
        lastSuccessfulAt: null,
        lastError: `${label} failure`,
        outcomeProjection: {
          version: 1,
          resourceType: 'USERS',
          execution: 'UNKNOWN',
          recordedOutcome: {
            kind: 'FAILED',
            basis: 'STORED_STATUS',
            relation: 'LATEST_RECORDED',
          },
          lastAttemptAt: null,
          reasonCode: null,
        },
      },
    },
  }
}
test('real page deferred GET/POST completion remains tenant scoped', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'https://synthetic.invalid',
  })
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })
  global.requestAnimationFrame = (cb) => cb()
  const root = createRoot(document.getElementById('root'))
  const render = async () =>
    React.act(async () => root.render(React.createElement(Page)))
  const text = () => document.body.textContent
  const resolve = async (req, b) =>
    React.act(async () => req.resolve({ bundle: b }))
  const click = async () => {
    const b = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Sync Now'
    )
    assert.ok(b)
    await React.act(async () => b.click())
  }
  try {
    await render()
    const getA = requests.at(-1)
    assert.equal(getA.url, '/api/tenants/a')
    tenant = 'b'
    await render()
    const getB = requests.at(-1)
    assert.equal(getB.url, '/api/tenants/b')
    await resolve(getB, bundle('b', 'B tenant'))
    assert.match(text(), /B tenant/)
    await resolve(getA, bundle('a', 'A tenant'))
    assert.doesNotMatch(text(), /A tenant/)
    tenant = 'a'
    await render()
    assert.match(text(), /A tenant/)
    await click()
    const postA = requests.at(-1)
    assert.equal(postA.method, 'POST')
    assert.match(text(), /Synchronization request pending/)
    assert.match(text(), /Finding total unavailable/)
    tenant = 'b'
    await render()
    assert.doesNotMatch(text(), /Synchronization request pending|A tenant/)
    await resolve(postA, bundle('a', 'A refreshed'))
    assert.doesNotMatch(
      text(),
      /A refreshed|Synchronization request pending|Sync completed successfully/
    )
    await click()
    const postB = requests.at(-1)
    await resolve(postB, bundle('b', 'B refreshed'))
    const completedText = text()
    assert.match(text(), /Finding total unavailable/)
    for (const [name, sync, expected] of [
      [
        'partial',
        {
          signIns: {
            status: 'running',
            lastSuccessfulAt: '2026-09-29T12:00:00.000Z',
            lastError: 'Limited source',
            outcomeProjection: {
              version: 1,
              resourceType: 'SIGN_INS',
              execution: 'UNKNOWN',
              recordedOutcome: {
                kind: 'LIMITED_COLLECTION_RECORDED',
                basis: 'RECOGNIZED_RETURN_PATH',
                relation: 'RETAINED_OR_CURRENT',
              },
              lastAttemptAt: null,
              reasonCode: 'sign-ins-non-premium-fallback-active',
            },
          },
        },
        /Finding total unavailable/,
      ],
      [
        'unknown',
        {
          users: {
            status: 'running',
            lastSuccessfulAt: null,
            lastError: null,
            outcomeProjection: {
              version: 1,
              resourceType: 'USERS',
              execution: 'UNKNOWN',
              recordedOutcome: {
                kind: 'UNKNOWN',
                basis: 'UNCLASSIFIED',
                relation: 'UNKNOWN',
              },
              lastAttemptAt: null,
              reasonCode: null,
            },
          },
        },
        /Finding total unavailable/,
      ],
      [
        'failed',
        {
          users: {
            status: 'failed',
            lastSuccessfulAt: null,
            lastError: 'Independent failure',
          },
        },
        /Finding total unavailable/,
      ],
    ]) {
      tenant = 'post-' + name
      await render()
      const data = bundle(tenant, name + ' tenant')
      data.sync = sync
      await resolve(requests.at(-1), data)
      await click()
      const pending = requests.at(-1)
      assert.equal(pending.method, 'POST')
      assert.match(text(), /Synchronization request pending/)
      await resolve(pending, data)
      assert.match(text(), expected)
      assert.match(
        text(),
        /Synchronization request completed\. Review the recorded collection results below\./
      )
      assert.doesNotMatch(
        text(),
        /Sync completed successfully|Collecting Microsoft 365|Synchronization in progress/
      )
      console.log('PASS actual deferred POST returning ' + name)
    }
    const unknown = {
      availability: 'UNVERIFIED',
      observedAt: null,
      reasonCode: null,
      reason: null,
    }
    readiness.c = {
      workloads: [
        {
          key: 'sign-ins',
          workload: 'Sign-ins',
          state: 'READY',
          configuredCapability: 'CONFIGURED',
          permissionStatus: 'CONFIRMED',
          freshness: 'CURRENT',
          remediation: 'Review evidence',
        },
      ],
      evidence: {
        version: 1,
        signIns: {
          availability: 'CURRENT_LIMITED',
          coverage: 'LIMITED',
          selectedSource: 'OFFICE_365_ACTIVITY_FEED',
          observedAt: '2026-09-29T12:00:00Z',
          reasonCode: 'SIGN_IN_FALLBACK_ACTIVE',
          reason: 'Audit selected',
        },
        riskyIdentities: {
          ...unknown,
          count: null,
          selectedSource: 'MICROSOFT_IDENTITY_PROTECTION',
        },
        conditionalAccess: {
          ...unknown,
          count: null,
          selectedSource: 'MICROSOFT_GRAPH',
        },
        securityDefaults: {
          ...unknown,
          enabled: null,
          selectedSource: 'MICROSOFT_GRAPH',
        },
      },
    }
    tenant = 'c'
    await render()
    const c = bundle('c', 'C tenant')
    c.exchange = {}
    c.sync = {
      signIns: {
        status: 'running',
        lastSuccessfulAt: null,
        lastError: 'Nonselected Graph error',
      },
    }
    delete c.syncFreshness
    delete c.tenant.syncFreshness
    delete c.tenant.initialSync
    await resolve(requests.at(-1), c)
    assert.match(text(), /Finding total unavailable/)
    assert.match(text(), /Finding total unavailable/)
    assert.doesNotMatch(
      text(),
      /Nonselected Graph error|Collecting Microsoft 365|Synchronization in progress/
    )
    await click()
    const oldAccountPost = requests.at(-1)
    scope = 'account2'
    await render()
    assert.doesNotMatch(text(), /Synchronization request pending|C tenant/)
    const newAccountGet = requests.at(-1)
    await resolve(newAccountGet, bundle('c', 'New account tenant'))
    await resolve(oldAccountPost, bundle('c', 'Old account completion'))
    assert.doesNotMatch(
      text(),
      /Old account completion|Synchronization request pending/
    )
    assert.match(text(), /New account tenant/)
    console.log(
      'PASS lifecycle checkpoints: late GET, A->B->A, fail+pending, late POST, selected audit precedence, account switch'
    )
    assert.doesNotMatch(
      completedText,
      /Sync completed successfully\./,
      'An HTTP response containing FAILED must not claim sync completed successfully'
    )
    assert.match(
      completedText,
      /Synchronization request completed\. Review the recorded collection results below\./
    )
  } finally {
    await React.act(async () => root.unmount())
    dom.window.close()
  }
})
