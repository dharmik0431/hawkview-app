// Mount the actual settings and directory pages. Only network, session, navigation,
// and unrelated dialogs/setup are controlled; page state, UI, and classifiers are real.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  test = require('node:test')
const ts = require('typescript'),
  React = require('react'),
  { JSDOM } = require('jsdom')
const dom = new JSDOM('<div id="root"></div>', {
  url: 'https://synthetic.invalid/tenants/synthetic/settings',
})
Object.assign(global, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
})
global.requestAnimationFrame = (cb) => setTimeout(cb, 0)
global.cancelAnimationFrame = clearTimeout
const { createRoot } = require('react-dom/client')
const base = path.resolve(__dirname, '..'),
  cache = new Map(),
  requests = [],
  refreshes = []
const session = { user: { id: 'synthetic-user', memberships: [] } },
  router = { push() {}, replace() {} }
const empty = () => null
let tenantRecord,
  tenants = [],
  activeSearch = 'tab=collection'
const queryClient = {
  fetchQuery: async ({ queryFn }) => queryFn(),
  invalidateQueries: async () => {},
}
const bundle = (status) => ({
  tenant: {
    id: 'synthetic',
    name: 'Synthetic Tenant',
    domain: 'synthetic.invalid',
    provider: 'microsoft',
  },
  sync: {
    users: {
      status,
      lastSuccessfulAt: null,
      lastError: status === 'failed' ? 'Synthetic USERS failure' : null,
    },
    signIns: {
      status,
      lastSuccessfulAt: null,
      lastError: status === 'failed' ? 'Synthetic SIGN_INS failure' : null,
    },
  },
  users: [],
  signIns: [],
  exchange: {},
  sharepoint: {},
  teams: {},
})
const api = {
  get: async (url) => {
    if (url === '/api/tenants/synthetic') return { bundle: bundle('failed') }
    if (url === '/api/tenants/microsoft/access-contract') return null
    throw Error('Unexpected GET ' + url)
  },
  post: (url) =>
    new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
}
// useTenantOperationalProjection forwards query.refetch unchanged. Exercise the
// installed QueryObserver contract: default refetch resolves an error result,
// retaining cached data, rather than rejecting when the query function fails.
const { QueryClient, QueryObserver } = require('@tanstack/react-query')
const refreshClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: Infinity } },
})
const refreshResults = []
let refreshKey = 0
const refetchProjection = async () => {
  const cached = { tenants: [tenantRecord] }
  const observer = new QueryObserver(refreshClient, {
    queryKey: ['tenants', 'synthetic', ++refreshKey],
    queryFn: () =>
      new Promise((resolve, reject) => refreshes.push({ resolve, reject })),
    initialData: cached,
    retry: false,
  })
  try {
    const result = await observer.refetch()
    refreshResults.push(result)
    return result
  } finally {
    observer.destroy()
    refreshClient.clear()
  }
}
function load(file) {
  if (cache.has(file)) return cache.get(file)
  const exports = {}
  cache.set(file, exports)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file, compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  new Function('require', 'exports', code)((name) => {
    if (name === 'next/navigation')
      return {
        useParams: () => ({ id: 'synthetic' }),
        useRouter: () => router,
        useSearchParams: () => new URLSearchParams(activeSearch),
      }
    if (name === 'next/link')
      return {
        __esModule: true,
        default: ({ children, ...props }) =>
          React.createElement('a', props, children),
      }
    if (name === '@/components/providers/auth-provider')
      return { useAuth: () => ({ session }) }
    if (name === '@tanstack/react-query')
      return { useQueryClient: () => queryClient }
    if (name === '@/lib/api/client') return { apiClient: api }
    if (name === '@/lib/api/hooks')
      return {
        useTenantOperationalProjection: () => ({
          tenant: tenantRecord,
          actionableHealth: load(path.join(base,'lib/attention/computeTenantAttention.ts')).tenantActionableHealthProjection(tenantRecord),
          refetch: refetchProjection,
        }),
        useTenants: () => ({
          data: { tenants },
          isLoading: false,
          isFetching: false,
          error: null,
          refetch: async () => {},
        }),
      }
    if (
      [
        '/tenant-issue-drawer',
        '/tenant-onboarding-dialog',
        '/exchange-readonly-setup',
      ].some((x) => name.endsWith(x))
    )
      return new Proxy(
        { __esModule: true, default: empty },
        { get: (o, k) => (k in o ? o[k] : empty) }
      )
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name)
    const target = name.startsWith('@/')
      ? path.join(base, name.slice(2))
      : path.resolve(path.dirname(file), name)
    const resolved = [target, target + '.tsx', target + '.ts'].find(
      fs.existsSync
    )
    assert.ok(resolved, 'resolve ' + name)
    return load(resolved)
  }, exports)
  return exports
}
const Settings = load(
  path.join(base, 'app/(protected)/tenants/[id]/settings/page.tsx')
).default
function readiness(state, reason) {
  return {
    version: 1,
    overallState: state,
    evaluatedAt: '2026-09-29T12:00:00Z',
    workloads: ['users', 'sign_ins'].map((key) => ({
      key,
      workload: key === 'users' ? 'Users' : 'Sign-ins',
      state,
      configuredCapability: 'CONFIGURED',
      permissionStatus: 'CONFIRMED',
      requiredPermissions: [],
      lastAttemptAt: '2026-09-29T12:00:00Z',
      lastSuccessfulAt: state === 'READY' ? '2026-09-29T12:00:00Z' : null,
      freshness: state === 'READY' ? 'CURRENT' : 'UNKNOWN',
      reasonCode: reason ? 'UPSTREAM_FAILURE' : null,
      reason,
      remediation: 'Review recorded results.',
      components: [],
    })),
  }
}
function setReadiness(state, reason) {
  tenantRecord = {
    id: 'synthetic',
    name: 'Synthetic Tenant',
    provider: 'microsoft',
    connectionStatus: 'connected',
    collectionReadiness: readiness(state, reason),
  }
}
const body = () => document.body.textContent
const button = (label) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label)
async function click(label) {
  const b = button(label)
  assert.ok(b, 'button ' + label)
  await React.act(async () => b.click())
}
async function mount(Page) {
  const root = createRoot(document.getElementById('root'))
  await React.act(async () => root.render(React.createElement(Page)))
  return root
}
async function unmount(root) {
  await React.act(async () => root.unmount())
}

test('overview diagnostic link lands on existing collection tab with retained optional detail and unchanged workload diagnostics', async () => {
 setReadiness('FAILED_TRANSIENT','Existing workload failure details')
 const p=load(path.join(base,'backend/src/tenants/attention-provenance.ts'))
 tenantRecord.attention=[
  {key:'ops',label:'Retained collector failure',why:'Retained failure explanation',severity:'critical',provenance:p.collectorAttentionProvenance('USERS','HAWKVIEW_INTERNAL_FAILURE')},
  {key:'old',label:'Unclassified historical record',why:'Historical diagnostic retained',severity:'high'},
 ]
 const root=await mount(Settings)
 try {
  const selected=document.querySelector('[role=tab][data-state=active]');assert.match(selected.textContent,/Collection/)
  const summary=[...document.querySelectorAll('summary')].find(x=>x.textContent==='Collection and unclassified evidence details')
  assert.ok(summary,'discoverable native disclosure');assert.equal(summary.parentElement.open,false)
  await React.act(async()=>summary.click());assert.equal(summary.parentElement.open,true)
  assert.match(summary.parentElement.textContent,/Retained collector failure/);assert.match(summary.parentElement.textContent,/Recorded owner: HawkView operations/)
  assert.match(summary.parentElement.textContent,/Unclassified historical record/);assert.match(summary.parentElement.textContent,/Responsibility not established/)
  assert.match(summary.parentElement.textContent,/Synthetic USERS failure/)
  const expand=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Expand details for Users');assert.ok(expand)
  await React.act(async()=>expand.click());assert.match(body(),/Diagnostic Reason/);assert.match(body(),/Existing workload failure details/)
  assert.equal(requests.length,0,'reading diagnostics never triggers an action')
  if(process.env.HAW38_VISUAL_OUT) fs.writeFileSync(path.join(process.env.HAW38_VISUAL_OUT,'settings-details.html'),'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="styles.css"><style>body{font-family:Arial,sans-serif}</style></head><body class="bg-slate-50"><main class="mx-auto max-w-7xl p-4">'+document.getElementById('root').innerHTML+'</main></body></html>')
 } finally {await unmount(root);refreshClient.clear();dom.window.close()}
})
