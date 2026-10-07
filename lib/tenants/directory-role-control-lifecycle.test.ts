/** Regressions for the three v2 defects, driving the REAL installed TanStack Query client and the
 * shipped hook and component. Only the auth provider and the HTTP client are replaced; `useQuery`,
 * `useMutation`, `QueryClient` and its cache lifecycle are the real library, because every one of
 * these defects lived in library behavior that a mocked hook result cannot reproduce. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import test from 'node:test'

const nodeRequire = createRequire(import.meta.url)
const ts = nodeRequire('typescript')
const React = nodeRequire('react')
const { createRoot } = nodeRequire('react-dom/client')
const { JSDOM } = nodeRequire('jsdom')
const { QueryClient, QueryClientProvider } = nodeRequire('@tanstack/react-query')
const act = React.act ?? nodeRequire('react-dom/test-utils').act
const repoRoot = resolvePath(dirname(new URL(import.meta.url).pathname), '..', '..')

function makeLoader(mocks: Record<string, unknown>) {
  const cache = new Map<string, any>()
  const resolveFile = (base: string) => {
    for (const c of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
      try { readFileSync(c, 'utf8'); return c } catch { continue }
    }
    throw new Error(`cannot resolve ${base}`)
  }
  const load = (basePath: string): any => {
    const file = resolveFile(basePath)
    if (cache.has(file)) return cache.get(file)
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
      },
      fileName: file,
    })
    const moduleObject = { exports: {} as Record<string, any> }
    cache.set(file, moduleObject.exports)
    const shimRequire = (specifier: string) => {
      if (specifier in mocks) return mocks[specifier]
      if (specifier.startsWith('@/')) return load(resolvePath(repoRoot, specifier.slice(2)))
      if (specifier.startsWith('.')) return load(resolvePath(dirname(file), specifier))
      return nodeRequire(specifier)
    }
    new Function('require', 'exports', 'module', outputText)(shimRequire, moduleObject.exports, moduleObject)
    cache.set(file, moduleObject.exports)
    return moduleObject.exports
  }
  return load
}

class ApiError extends Error {
  status: number
  code: string | null
  constructor(status: number, message: string, code: string | null = null) {
    super(message); this.name = 'ApiError'; this.status = status; this.code = code
  }
}

const SCOPE_A = 'identity:subject-A:organizations:org-1'
const EXPECTED = {
  configurationRevision: 'G', connectionIncarnation: 'C', scopeIncarnation: 'S',
  scopeVersion: 'directory-role-assignments/v1',
}
const answer = (enabled: boolean) => ({ enabled, expected: { ...EXPECTED } })
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

/** Advances the real query client until `predicate` holds, instead of guessing how many microtask
 * turns its async work needs. A fixed number of settles made this suite fail in a different place on
 * each run; the condition is what the test actually means, so wait for the condition. */
async function waitFor(predicate: () => boolean, what: string, turns = 40) {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return
    await settle()
  }
  assert.fail(`timed out waiting for ${what}`)
}

function environment() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>',
    { url: 'https://hawkview.invalid', pretendToBeVisual: true })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  return {
    dom,
    restore: () => {
      for (const [key, d] of Array.from(previous.entries())) {
        if (d) Object.defineProperty(globalThis, key, d); else delete (globalThis as any)[key]
      }
      dom.window.close()
    },
  }
}

/** Mounts the SHIPPED component inside a real QueryClientProvider. */
function mountPanel(options: {
  get: () => Promise<unknown>
  post?: (body: any) => Promise<unknown>
  identity?: () => string
}) {
  const env = environment()
  const gets: number[] = []
  const reads: Array<{ endpoint: string; init: any }> = []
  const posts: any[] = []
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  const load = makeLoader({
    '@/components/providers/auth-provider': {
      useAuth: () => ({
        cacheScope: SCOPE_A, isLoading: false,
        currentIdentityToken: options.identity ?? (() => 'subject-A:1'),
        session: { user: { memberships: [{ role: 'MSP_OWNER' }] } },
      }),
    },
    './client': {
      ApiError,
      apiClient: {
        get: async (endpoint: string, init: any) => {
          gets.push(Date.now()); reads.push({ endpoint, init }); return options.get()
        },
        post: async (_endpoint: string, body: any) => {
          posts.push(body)
          if (!options.post) return answer(body.enabled)
          return options.post(body)
        },
      },
    },
  })
  const { DirectoryRoleControl } = load(resolvePath(repoRoot, 'components/tenant/directory-role-control.tsx'))
  const container = env.dom.window.document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  const tree = React.createElement(QueryClientProvider, { client },
    React.createElement(DirectoryRoleControl, { customerTenantId: 'tenant-A' }))

  return {
    client,
    gets,
    reads,
    posts,
    text: () => container.textContent ?? '',
    buttons: () => Array.from(container.querySelectorAll('button')) as any[],
    button: (re: RegExp) =>
      (Array.from(container.querySelectorAll('button')) as any[])
        .find((b) => re.test(b.textContent ?? '')),
    render: () => act(() => { root.render(tree) }),
    click: (node: any) =>
      act(() => { node.dispatchEvent(new env.dom.window.MouseEvent('click', { bubbles: true })) }),
    /** Drains this test's own work before releasing the globals. Without it a pending refetch or
     * mutation callback from one test can run while the NEXT test's window/document are installed,
     * which made the suite fail in a different place on each run. */
    cleanup: async () => {
      await act(async () => { root.unmount() })
      await client.cancelQueries()
      client.unmount()
      client.clear()
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      env.restore()
    },
  }
}

test('defect 1: a committed write with a lost response is reported as unconfirmed, not as a no-op', async () => {
  let committed = false
  // After the write, the follow-up read fails too. This is the state that must be presented
  // honestly and that PERSISTS: the outcome is unknown and we cannot yet confirm it. (A follow-up
  // read that SUCCEEDS resolves the uncertainty, which the next test covers — asserting on that
  // transient here is what made this case flaky.)
  const ui = mountPanel({
    get: async () => {
      if (committed) throw new ApiError(503, 'unavailable')
      return answer(false)
    },
    post: async () => {
      // The server applied the change; only the response is lost. This is the exact shape of Root's
      // counterexample, and it is indistinguishable from a successful write at the client.
      committed = true
      throw new TypeError('Response connection lost after server commit')
    },
  })
  try {
    ui.render()
    await waitFor(() => /switched off for this tenant/i.test(ui.text()), 'the first confirmed read')
    ui.click(ui.button(/switch on/i))
    await waitFor(() => /could not confirm/i.test(ui.text()), 'the unconfirmed-outcome state')

    assert.equal(committed, true)
    assert.equal(ui.posts.length, 1, 'sent once, never resent')
    assert.match(ui.text(), /could not confirm/i)
    assert.match(ui.text(), /may or may not have been applied/i)
    assert.doesNotMatch(ui.text(), /Nothing was changed/i,
      'the v1 defect: asserting a no-op after a possible commit')
    assert.doesNotMatch(ui.text(), /switched off for this tenant/i,
      'the stale pre-write state must not be restated')
    assert.equal(ui.button(/switch on|switch off/i), undefined, 'no action until a fresh read')
    assert.ok(ui.button(/re-read setting/i), 'recovery is a read')
  } finally { await ui.cleanup() }
})

test('defect 1: re-reading after an unconfirmed write resolves the state from the server', async () => {
  let enabled = false
  // The automatic re-read that follows a failed write fails once, so the uncertainty is observable
  // rather than transient; the user's explicit re-read then succeeds. Waiting on the automatic read
  // to lose a race is what made this flaky.
  let autoReadFailures = 0
  const ui = mountPanel({
    get: async () => {
      if (enabled && autoReadFailures < 1) { autoReadFailures += 1; throw new ApiError(503, 'later') }
      return answer(enabled)
    },
    post: async () => { enabled = true; throw new TypeError('lost') },
  })
  try {
    ui.render()
    await waitFor(() => ui.button(/switch on/i) !== undefined, 'the enable action')
    ui.click(ui.button(/switch on/i))
    await waitFor(() => /could not confirm/i.test(ui.text()), 'the unconfirmed-outcome state')

    await waitFor(() => ui.button(/re-read setting/i) !== undefined, 'the re-read action')
    ui.click(ui.button(/re-read setting/i))
    // The server says it did apply, and only now does the panel state a setting again.
    await waitFor(() => /switched on for this tenant/i.test(ui.text()), 'the resolved setting')
    assert.doesNotMatch(ui.text(), /could not confirm/i)
    assert.equal(ui.posts.length, 1, 'the authority-changing request was never replayed')
  } finally { await ui.cleanup() }
})

test('defect 2: cached data retained across a failed refetch is not presented as current', async () => {
  let fail = false
  const ui = mountPanel({ get: async () => { if (fail) throw new ApiError(500, 'down'); return answer(false) } })
  try {
    ui.render()
    await waitFor(() => /switched off for this tenant/i.test(ui.text()), 'the first confirmed read')

    fail = true
    await act(async () => { await ui.client.refetchQueries() })
    await waitFor(() => /cannot read this collection setting/i.test(ui.text()), 'the read failure')

    // The real library keeps `data` here and reports isError with isPending false — the v1 defect.
    const state = ui.client.getQueryState(['directory-role-control', SCOPE_A, 'tenant-A'])
    assert.ok(state?.data, 'precondition: TanStack retained the stale answer')
    assert.equal(state?.status, 'error')

    assert.equal(ui.button(/switch on|switch off/i), undefined, 'no stale action may remain live')
    assert.doesNotMatch(ui.text(), /switched off for this tenant/i)
    assert.match(ui.text(), /cannot read this collection setting/i)
  } finally { await ui.cleanup() }
})

test('defect 2: a refused write does not claim the current setting is shown until a fresh read lands', async () => {
  let release: (() => void) | null = null
  const ui = mountPanel({
    get: async () => {
      if (release) await new Promise<void>((r) => { release = r })
      return answer(false)
    },
    post: async () => { throw new ApiError(409, 'changed', 'DIRECTORY_CONTROL_STALE') },
  })
  try {
    ui.render()
    await waitFor(() => ui.button(/switch on/i) !== undefined, 'the enable action')
    release = () => {}
    ui.click(ui.button(/switch on/i))
    await waitFor(() => /was not changed/i.test(ui.text()), 'the refusal message')

    assert.match(ui.text(), /was not changed/i, 'a 409 proves no apply, so this wording is honest')
    assert.doesNotMatch(ui.text(), /current setting is shown/i, 'the v1 copy claimed this too early')
    assert.doesNotMatch(ui.text(), /switched off for this tenant/i)
    assert.equal(ui.button(/switch on|switch off/i), undefined)
    assert.equal(ui.posts.length, 1)
  } finally { await ui.cleanup() }
})

test('defect 3: a completion from an obsolete identity generation writes nothing', async () => {
  let generation = 1
  let resolvePost: ((v: unknown) => void) | null = null
  const ui = mountPanel({
    get: async () => answer(false),
    post: async () => new Promise((r) => { resolvePost = r }),
    identity: () => `subject-A:${generation}`,
  })
  const key = ['directory-role-control', SCOPE_A, 'tenant-A']
  try {
    ui.render()
    await waitFor(() => ui.button(/switch on/i) !== undefined, 'the enable action')
    ui.click(ui.button(/switch on/i))
    await waitFor(() => resolvePost !== null, 'the write to be in flight')

    // A -> B -> A: the cache is cleared on each transition and A is read again. The cache SCOPE
    // string is identical on return, so only the generation distinguishes the two visits.
    ui.client.clear()
    generation = 3
    ui.client.setQueryData(key, answer(false))
    const fresh = ui.client.getQueryState(key)?.dataUpdatedAt

    await act(async () => { resolvePost?.(answer(true)); await new Promise((r) => setTimeout(r, 0)) })

    const after = ui.client.getQueryState(key)
    // The completion carried enabled=true; the new visit's own read says false. A mounted observer
    // legitimately refetches after clear(), so the test asserts the VALUE is never the obsolete
    // one rather than that the entry was never rewritten by any writer.
    assert.equal((after?.data as any)?.enabled, false,
      'the obsolete completion must not repopulate the new visit’s cache')
    assert.ok((after?.dataUpdatedAt ?? 0) >= (fresh ?? 0))
  } finally { await ui.cleanup() }
})

test('defect 3: an older completion does not overwrite newer same-key data in one generation', async () => {
  let resolvePost: ((v: unknown) => void) | null = null
  // The server itself moves to enabled=true, so a legitimate refetch yields true and ONLY the stale
  // completion could put false back. Without this the fixture could not tell the two apart.
  let served = false
  const ui = mountPanel({
    get: async () => answer(served),
    post: async () => new Promise((r) => { resolvePost = r }),
  })
  const key = ['directory-role-control', SCOPE_A, 'tenant-A']
  try {
    ui.render()
    await waitFor(() => ui.button(/switch on/i) !== undefined,
      'the enable action after a confirmed read')
    ui.click(ui.button(/switch on/i))
    await waitFor(() => resolvePost !== null, 'the write to be in flight')

    // A newer read lands for the same key while the write is still in flight.
    served = true
    await act(async () => { ui.client.setQueryData(key, answer(true)); await Promise.resolve() })
    const newer = ui.client.getQueryState(key)?.dataUpdatedAt

    await act(async () => { resolvePost?.(answer(false)); await new Promise((r) => setTimeout(r, 0)) })
    await waitFor(() => !ui.client.isMutating(), 'the stale completion to finish')

    const after = ui.client.getQueryState(key)
    assert.equal((after?.data as any)?.enabled, true,
      'the older completion must not put its stale value back')
    assert.ok((after?.dataUpdatedAt ?? 0) >= (newer ?? 0))
  } finally { await ui.cleanup() }
})

test('a successful write still applies, invalidates and shows the server’s answer', async () => {
  let enabled = false
  const ui = mountPanel({
    get: async () => answer(enabled),
    post: async (body: any) => { enabled = body.enabled; return answer(body.enabled) },
  })
  try {
    ui.render(); await settle()
    await waitFor(() => ui.button(/switch on/i) !== undefined, 'the enable action')
    ui.click(ui.button(/switch on/i))
    await waitFor(() => /switched on for this tenant/i.test(ui.text()), 'the applied setting')
    assert.equal(ui.button(/switch off/i) !== undefined, true, 'disable is now the offered action')
  } finally { await ui.cleanup() }
})

test('disable survives a successful read reporting enabled with no configuration or connection', async () => {
  const ui = mountPanel({
    get: async () => ({
      enabled: true,
      expected: { configurationRevision: null, connectionIncarnation: null, scopeIncarnation: null, scopeVersion: null },
    }),
  })
  try {
    ui.render()
    await waitFor(() => /switched on for this tenant/i.test(ui.text()), 'the confirmed read')
    assert.ok(ui.button(/switch off/i), 'revocation must not depend on a usable connection')
  } finally { await ui.cleanup() }
})

/* Assertions carried over from the retired mocked-hook harnesses. Those harnesses could no longer
   run the shipped write hook once it held React state, and they are what passed 28/28 in v1 while
   missing all three defects — so these are re-established against the real library instead. */

test('the write echoes the server’s expectation verbatim to this tenant’s own endpoint', async () => {
  const ui = mountPanel({ get: async () => answer(false) })
  try {
    ui.render()
    await waitFor(() => ui.button(/switch on/i) !== undefined, 'the enable action')
    ui.click(ui.button(/switch on/i))
    await waitFor(() => ui.posts.length === 1, 'the write')
    assert.deepEqual(ui.posts[0], { enabled: true, expected: EXPECTED })
  } finally { await ui.cleanup() }
})

test('the read is identity-and-tenant scoped and sends no-store', async () => {
  const ui = mountPanel({ get: async () => answer(false) })
  try {
    ui.render()
    await waitFor(() => ui.client.getQueryData(['directory-role-control', SCOPE_A, 'tenant-A']) !== undefined,
      'the control cached under its identity+tenant key')
    assert.equal(ui.reads[0]?.endpoint, '/api/tenants/tenant-A/collection/directory-roles/control')
    assert.equal(ui.reads[0]?.init?.cache, 'no-store')
  } finally { await ui.cleanup() }
})

test('an unreadable answer is a read failure, never a reported opt-in of off', async () => {
  const ui = mountPanel({ get: async () => ({ enabled: 'yes', expected: EXPECTED }) })
  try {
    ui.render()
    await waitFor(() => /cannot read this collection setting/i.test(ui.text()), 'the read failure')
    assert.doesNotMatch(ui.text(), /switched off for this tenant/i)
    assert.equal(ui.button(/switch on|switch off/i), undefined)
  } finally { await ui.cleanup() }
})
