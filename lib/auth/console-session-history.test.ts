/** Parser contract plus the real mounted panel.
 *
 * Only the auth provider and the HTTP client are replaced. React, JSDOM and the
 * shipped component are real, because the behaviour under test — discarding a
 * reply that belongs to a superseded request or a previous identity, and never
 * leaving old rows on screen — lives in component lifecycle that a mocked render
 * result cannot reproduce. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import test from 'node:test'

import {
  CONSOLE_SESSION_HISTORY_LIMIT,
  describeSessionState,
  formatAsOfAge,
  parseConsoleSessionHistory,
  visibleForIdentity,
  type IdentityBoundPhase,
} from './console-session-history.ts'

const nodeRequire = createRequire(import.meta.url)
const ts = nodeRequire('typescript')
const React = nodeRequire('react')
const { createRoot } = nodeRequire('react-dom/client')
const { JSDOM } = nodeRequire('jsdom')
const act = React.act ?? nodeRequire('react-dom/test-utils').act
const repoRoot = resolvePath(dirname(new URL(import.meta.url).pathname), '..', '..')

const asOf = '2026-10-09T12:00:00.000Z'
const row = (over: Record<string, unknown> = {}) => ({
  authenticatedAt: '2026-10-09T11:00:00.000Z',
  idleExpiresAt: '2026-10-09T13:00:00.000Z',
  revokedAt: null,
  createdAt: '2026-10-09T11:00:00.000Z',
  state: 'idle-eligible',
  isCurrent: false,
  ...over,
})
const envelope = (over: Record<string, unknown> = {}) => ({
  responseVersion: 'console-session-history/v1',
  generatedAt: asOf,
  returned: 1,
  truncated: false,
  sessions: [row()],
  ...over,
})

test('accepts a well formed envelope and preserves every recorded field', () => {
  const parsed = parseConsoleSessionHistory(envelope())
  assert.ok(parsed)
  assert.equal(parsed.returned, 1)
  assert.equal(parsed.truncated, false)
  assert.deepEqual(parsed.sessions[0], row())
})

test('a readable response with zero sessions is not the same as unreadable', () => {
  const parsed = parseConsoleSessionHistory(envelope({ returned: 0, sessions: [] }))
  assert.ok(parsed, 'zero recorded sessions must parse')
  assert.equal(parsed.sessions.length, 0)
})

test('refuses anything it cannot fully validate', () => {
  const rejected: [string, unknown][] = [
    ['not an object', 'nope'],
    ['null', null],
    ['wrong version', envelope({ responseVersion: 'console-session-history/v2' })],
    ['missing version', envelope({ responseVersion: undefined })],
    ['unparseable generatedAt', envelope({ generatedAt: 'not-a-date' })],
    ['empty generatedAt', envelope({ generatedAt: '' })],
    ['non-boolean truncated', envelope({ truncated: 'yes' })],
    ['non-integer returned', envelope({ returned: 1.5 })],
    ['negative returned', envelope({ returned: -1, sessions: [] })],
    ['returned over the bound', envelope({ returned: CONSOLE_SESSION_HISTORY_LIMIT + 1 })],
    ['count disagrees with rows', envelope({ returned: 2 })],
    ['sessions not an array', envelope({ sessions: {} })],
    ['unknown state', envelope({ sessions: [row({ state: 'active' })] })],
    ['non-boolean isCurrent', envelope({ sessions: [row({ isCurrent: 'true' })] })],
    ['empty required date', envelope({ sessions: [row({ idleExpiresAt: '' })] })],
    ['unparseable required date', envelope({ sessions: [row({ createdAt: 'soon' })] })],
    ['unparseable nullable date', envelope({ sessions: [row({ revokedAt: 'maybe' })] })],
    ['two current sessions', envelope({
      returned: 2,
      sessions: [row({ isCurrent: true }), row({ isCurrent: true })],
    })],
  ]
  for (const [why, value] of rejected) {
    assert.equal(parseConsoleSessionHistory(value), null, `must refuse: ${why}`)
  }
})

test('truncation claimed with fewer than the maximum rows is contradictory', () => {
  assert.equal(parseConsoleSessionHistory(envelope({ truncated: true })), null)
  const full = Array.from({ length: CONSOLE_SESSION_HISTORY_LIMIT }, () => row())
  const parsed = parseConsoleSessionHistory(
    envelope({ truncated: true, returned: CONSOLE_SESSION_HISTORY_LIMIT, sessions: full })
  )
  assert.ok(parsed, 'a full page may legitimately be truncated')
})

test('state copy never implies online, and expired is never described as signed out', () => {
  assert.equal(describeSessionState('revoked'), 'Signed out')
  assert.equal(describeSessionState('expired'), 'Ended by inactivity')
  assert.equal(describeSessionState('idle-eligible'), 'Within its inactivity window')
  assert.equal(describeSessionState('unknown'), 'Not reconciled')
  for (const state of ['revoked', 'expired', 'idle-eligible', 'unknown'] as const) {
    assert.doesNotMatch(describeSessionState(state), /online|active now/i)
  }
})

test('ages are measured from the server sample and refuse to run backwards', () => {
  assert.equal(formatAsOfAge('2026-10-09T11:59:30.000Z', asOf), 'less than a minute')
  assert.equal(formatAsOfAge('2026-10-09T11:00:00.000Z', asOf), '1 hour')
  assert.equal(formatAsOfAge('2026-10-07T12:00:00.000Z', asOf), '2 days')
  // A record stamped after the reading is not given a negative age.
  assert.equal(formatAsOfAge('2026-10-09T12:00:30.000Z', asOf), null)
  assert.equal(formatAsOfAge('nonsense', asOf), null)
})

test('a phase produced for another identity is never visible', () => {
  // E1 finding 1, tested where it is observable. The mounted suite cannot prove
  // this: `act` flushes the clearing effect before any assertion runs, so the
  // offending frame never appears there and a mutation of the rule still
  // passes. Exercising the rule directly is what makes the control real.
  const readyForA: IdentityBoundPhase<string> = { kind: 'ready', token: 'A', history: 'A rows' }

  const sameIdentity = visibleForIdentity(readyForA, 'A')
  assert.deepEqual(sameIdentity, readyForA, 'the owning identity still sees its own rows')

  const switched = visibleForIdentity(readyForA, 'B')
  assert.equal(switched.kind, 'loading', 'another identity must see loading, not rows')
  assert.equal((switched as { token: string }).token, 'B')
  assert.ok(!('history' in switched), 'no previous history may survive the switch')

  // Signed out: nothing is attributable, so nothing is shown.
  assert.deepEqual(visibleForIdentity(readyForA, null), { kind: 'idle', token: null })

  // A failed read for the old identity must not leak either.
  const failedForA: IdentityBoundPhase<string> = { kind: 'unreadable', token: 'A' }
  assert.equal(visibleForIdentity(failedForA, 'B').kind, 'loading')

  // Returning to A must not resurrect a phase still tagged B.
  const loadingForB: IdentityBoundPhase<string> = { kind: 'loading', token: 'B' }
  const backToA = visibleForIdentity(loadingForB, 'A')
  assert.equal((backToA as { token: string }).token, 'A')
})

function makeLoader(mocks: Record<string, unknown>) {
  const cache = new Map<string, any>()
  const resolveFile = (base: string) => {
    for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
      try { readFileSync(candidate, 'utf8'); return candidate } catch { continue }
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

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

/** Mounts the real panel. `release` restores globals and is called before any
 * rethrow, so a fixture failure fails the test instead of leaving the JSDOM
 * window open and the process alive. */
async function mountPanel() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://console.invalid/profile/security',
  })
  const priorWindow = (globalThis as any).window
  const priorDocument = (globalThis as any).document
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const priorActFlag = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as any).window = dom.window
  ;(globalThis as any).document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

  const pending: Pending[] = []
  // E1: recording only `signalAborted` asserted my own bookkeeping, never the
  // request. The endpoint and options are kept so the tests can check what the
  // panel actually asked for.
  const calls: { endpoint: string; options: any; signalAborted: () => boolean }[] = []
  let identityToken = 'identity-A'
  let signedIn = true
  let loading = false

  const auth = {
    useAuth: () => ({
      session: signedIn ? { user: { id: 'user-A' } } : null,
      isLoading: loading,
      currentIdentityToken: () => identityToken,
    }),
  }
  const api = {
    apiClient: {
      get: (endpoint: string, options: any) => {
        calls.push({ endpoint, options, signalAborted: () => Boolean(options?.signal?.aborted) })
        return new Promise((resolve, reject) => pending.push({ resolve, reject }))
      },
    },
  }
  // The panel's first act after admitting a reply is to parse it. Spying on the
  // parser — delegating to the real one — is the only way a mounted test can see
  // that an inadmissible reply was dropped: React 18 silently discards a state
  // update into an unmounted tree, so an empty container proves nothing.
  const parsed: unknown[] = []
  const history = {
    describeSessionState,
    formatAsOfAge,
    visibleForIdentity,
    parseConsoleSessionHistory: (payload: unknown) => {
      parsed.push(payload)
      return parseConsoleSessionHistory(payload)
    },
  }
  const load = makeLoader({
    '@/components/providers/auth-provider': auth,
    '@/lib/api/client': api,
    '@/lib/auth/console-session-history': history,
  })

  let root: any
  const release = () => {
    try { if (root) act(() => root.unmount()) } catch { /* already torn down */ }
    if (priorWindow === undefined) delete (globalThis as any).window
    else (globalThis as any).window = priorWindow
    if (priorDocument === undefined) delete (globalThis as any).document
    else (globalThis as any).document = priorDocument
    if (priorNavigator) Object.defineProperty(globalThis, 'navigator', priorNavigator)
    else delete (globalThis as any).navigator
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = priorActFlag
    dom.window.close()
  }

  try {
    const { ConsoleSessionHistoryPanel } = load(
      resolvePath(repoRoot, 'components/auth/console-session-history-panel')
    )
    const container = dom.window.document.getElementById('root')!
    root = createRoot(container)
    await act(async () => { root.render(React.createElement(ConsoleSessionHistoryPanel)) })
    return {
      text: () => container.textContent ?? '',
      container,
      pending,
      calls,
      parsed,
      release,
      settle: async (value: unknown) => { pending.shift()!.resolve(value); await act(async () => {}) },
      failNext: async (error: unknown) => { pending.shift()!.reject(error); await act(async () => {}) },
      /** Settles a specific open request, so a reply can arrive out of order. */
      settleAt: async (index: number, value: unknown) => {
        pending.splice(index, 1)[0].resolve(value); await act(async () => {})
      },
      /** Unmounts without tearing down JSDOM, so a test can observe what
       * unmounting does rather than only perform it in cleanup. */
      unmount: async () => {
        const current = root; root = null
        await act(async () => { current.unmount() })
      },
      /** Drives the provider's readiness, which is what a session refresh or a
       * sign-in check does in production. */
      setReadiness: async (value: boolean) => {
        loading = !value
        await act(async () => { root.render(React.createElement(ConsoleSessionHistoryPanel)) })
      },
      switchIdentity: async (token: string) => {
        identityToken = token
        await act(async () => { root.render(React.createElement(ConsoleSessionHistoryPanel)) })
      },
      signOut: async () => {
        signedIn = false
        await act(async () => { root.render(React.createElement(ConsoleSessionHistoryPanel)) })
      },
      refresh: async () => {
        const buttons = Array.from(container.querySelectorAll('button')) as any[]
        const button = buttons.find(element => (element.textContent ?? '').includes('Refresh'))
        assert.ok(button, 'the refresh control must be present')
        await act(async () => {
          button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
      },
    }
  } catch (error) {
    release()
    throw error
  }
}

test('mounted: a successful read renders recorded rows and the server as-of time', async () => {
  const panel = await mountPanel()
  try {
    assert.match(panel.text(), /Reading your recorded sessions/)
    await panel.settle(envelope({ sessions: [row({ isCurrent: true })] }))
    assert.match(panel.text(), /Within its inactivity window/)
    assert.match(panel.text(), /this browser/)
    assert.match(panel.text(), /As of 2026-10-09T12:00:00\.000Z/)
    // The limitation copy must survive a successful render.
    assert.match(panel.text(), /no address, device or authentication method/)
  } finally { panel.release() }
})

test('mounted: an unreadable payload fails closed and never reads as empty', async () => {
  const panel = await mountPanel()
  try {
    await panel.settle({ responseVersion: 'console-session-history/v2' })
    assert.match(panel.text(), /cannot read your session history/)
    assert.doesNotMatch(panel.text(), /No sessions are recorded/)
  } finally { panel.release() }
})

test('mounted: a transport error fails closed, not to an empty list', async () => {
  const panel = await mountPanel()
  try {
    await panel.failNext(new Error('network down'))
    assert.match(panel.text(), /cannot read your session history/)
    assert.doesNotMatch(panel.text(), /No sessions are recorded/)
  } finally { panel.release() }
})

test('mounted: zero recorded sessions is stated as nothing recorded, not as a failure', async () => {
  const panel = await mountPanel()
  try {
    await panel.settle(envelope({ returned: 0, sessions: [] }))
    assert.match(panel.text(), /No sessions are recorded/)
    assert.doesNotMatch(panel.text(), /cannot read/)
  } finally { panel.release() }
})

test('mounted: truncation is disclosed rather than silently capped', async () => {
  const panel = await mountPanel()
  try {
    const full = Array.from({ length: CONSOLE_SESSION_HISTORY_LIMIT }, () => row())
    await panel.settle(envelope({ truncated: true, returned: CONSOLE_SESSION_HISTORY_LIMIT, sessions: full }))
    assert.match(panel.text(), /50 most recent recorded sessions/)
  } finally { panel.release() }
})

test('mounted: old rows are not left on screen while a replacement is loading', async () => {
  const panel = await mountPanel()
  try {
    await panel.settle(envelope({ sessions: [row({ state: 'revoked' })] }))
    assert.match(panel.text(), /Signed out/)
    await panel.refresh()
    // A stale table during replacement is worse than an honest spinner.
    assert.doesNotMatch(panel.text(), /Signed out/)
    assert.match(panel.text(), /Reading your recorded sessions/)
  } finally { panel.release() }
})

test('mounted: a refresh replaces the previous result rather than merging it', async () => {
  const panel = await mountPanel()
  try {
    await panel.settle(envelope({ sessions: [row({ state: 'revoked' })] }))
    await panel.refresh()
    assert.equal(panel.pending.length, 1, 'the refresh issued a new request')
    // This settles the refresh's own request. It does NOT witness a late prior
    // reply — the first request was already resolved above — which is why the
    // genuinely late case is a separate test below.
    await panel.settle(envelope({ sessions: [row({ state: 'expired' })] }))
    assert.match(panel.text(), /Ended by inactivity/)
    assert.doesNotMatch(panel.text(), /Signed out/)
  } finally { panel.release() }
})

test('mounted: A to B to A cannot paint the first identity’s rows', async () => {
  const panel = await mountPanel()
  try {
    assert.equal(panel.pending.length, 1)
    await panel.switchIdentity('identity-B')
    await panel.switchIdentity('identity-A')
    // The original in-flight reply now belongs to a superseded request even
    // though the identity token matches again.
    const stale = panel.pending.shift()!
    stale.resolve(envelope({ sessions: [row({ state: 'revoked' })] }))
    await panel.settle(envelope({ returned: 0, sessions: [] }))
    assert.doesNotMatch(panel.text(), /Signed out/)
    // E1: without this the test ends having painted nothing at all, so a panel
    // that discarded *every* reply would pass it. The current A request must
    // still be open, and its reply must be the one that renders.
    assert.equal(panel.pending.length, 1, 'the second A read is still open')
    await panel.settle(envelope({ sessions: [row({ state: 'expired' })] }))
    assert.match(panel.text(), /Ended by inactivity/, 'the current A reply paints')
  } finally { panel.release() }
})

test('mounted: signing out clears rows and aborts the in-flight read', async () => {
  const panel = await mountPanel()
  try {
    await panel.settle(envelope({ sessions: [row({ state: 'revoked' })] }))
    await panel.refresh()
    await panel.signOut()
    assert.equal(panel.text(), '', 'the panel renders nothing once signed out')
    assert.ok(panel.calls.some(call => call.signalAborted()), 'the in-flight read was aborted')
  } finally { panel.release() }
})

test('mounted: visible rows vanish on the switching render, not an effect later', async () => {
  // E1 finding 1. The earlier A→B→A test started from an in-flight request, so
  // it never exercised the case that leaks: rows already on screen when the
  // account changes. Suppression must happen during the switching render.
  const panel = await mountPanel()
  try {
    await panel.settle(envelope({ sessions: [row({ state: 'revoked' })] }))
    assert.match(panel.text(), /Signed out/, 'account A rows are visible')

    await panel.switchIdentity('identity-B')
    assert.doesNotMatch(panel.text(), /Signed out/, 'A’s rows must not survive the switch')
    assert.match(panel.text(), /Reading your recorded sessions/)

    // A pending replacement must not restore A's rows either.
    assert.doesNotMatch(panel.text(), /Signed out/)
    // Nor may a failed replacement fall back to them.
    await panel.failNext(new Error('replacement failed'))
    assert.match(panel.text(), /cannot read your session history/)
    assert.doesNotMatch(panel.text(), /Signed out/)

    // Returning to A must still re-read rather than reuse the old render.
    await panel.switchIdentity('identity-A')
    assert.doesNotMatch(panel.text(), /Signed out/)
  } finally { panel.release() }
})

test('mounted: an unknown row never asserts a confirmed sign-out', async () => {
  // E1 finding 5. A future or contradictory revocation is exactly what the
  // server refused to confirm; the row must not state it as fact.
  const panel = await mountPanel()
  try {
    await panel.settle(envelope({
      sessions: [row({ state: 'unknown', revokedAt: '2026-10-09T23:00:00.000Z' })],
    }))
    assert.match(panel.text(), /Not reconciled/)
    assert.match(panel.text(), /Unconfirmed sign-out recorded as 2026-10-09T23:00:00\.000Z/)
    assert.doesNotMatch(panel.text(), /Signed out 2026-10-09T23:00:00\.000Z/)
  } finally { panel.release() }
})

test('mounted: rows tied on every timestamp still render distinctly', async () => {
  // E1 finding 5, second half: the previous key was derived from timestamps, so
  // legitimately tied rows collided. Replacement must also be clean.
  const panel = await mountPanel()
  try {
    const tied = [row({ state: 'revoked', revokedAt: '2026-10-09T11:30:00.000Z' }),
                  row({ state: 'revoked', revokedAt: '2026-10-09T11:30:00.000Z' })]
    await panel.settle(envelope({ returned: 2, sessions: tied }))
    assert.equal(panel.container.querySelectorAll('[class*="border-t"]').length, 2)
    await panel.refresh()
    await panel.settle(envelope({ returned: 1, sessions: [row({ state: 'expired' })] }))
    assert.match(panel.text(), /Ended by inactivity/)
    assert.doesNotMatch(panel.text(), /Signed out/)
  } finally { panel.release() }
})

test('mounted: a stale error after identity change does not overwrite the new state', async () => {
  const panel = await mountPanel()
  try {
    await panel.settle(envelope({ returned: 0, sessions: [] }))
    assert.match(panel.text(), /No sessions are recorded/)
    await panel.refresh()
    await panel.switchIdentity('identity-B')
    const stale = panel.pending.shift()!
    stale.reject(new Error('late failure'))
    await act(async () => {})
    assert.doesNotMatch(panel.text(), /cannot read your session history/)
  } finally { panel.release() }
})

test('mounted: the read asks for the history endpoint, uncached, with its own abort signal', async () => {
  // E1: the double previously recorded only whether a signal later aborted,
  // which is an assertion about the double. A panel that requested the wrong
  // path, omitted no-store or passed no signal at all would have passed.
  const panel = await mountPanel()
  try {
    assert.equal(panel.calls.length, 1, 'mounting issues exactly one read')
    const [first] = panel.calls
    assert.equal(first.endpoint, '/auth/session/history')
    // This pins what the panel asks for, not the guarantee: `lib/api/client.ts`
    // spreads the caller's options and then sets `cache: 'no-store'` after the
    // spread, so every request is uncached whatever the panel passes. Asserted
    // anyway, because a panel that stopped asking would be relying on that
    // client detail silently.
    assert.equal(first.options.cache, 'no-store')
    // The signal is not belt-and-braces: the client composes it with its own
    // timeout via AbortSignal.any, so omitting it leaves nothing but the timeout
    // able to cancel an in-flight read.
    assert.ok(first.options.signal instanceof AbortSignal, 'an AbortSignal must be supplied')
    assert.equal(first.signalAborted(), false, 'the signal is live while the read is in flight')

    await panel.settle(envelope({ sessions: [row()] }))
    await panel.refresh()
    assert.equal(panel.calls.length, 2, 'refreshing issues a second read')
    const [, second] = panel.calls
    assert.equal(second.endpoint, '/auth/session/history')
    assert.equal(second.options.cache, 'no-store')
    assert.ok(second.options.signal instanceof AbortSignal)
    // A shared controller would make one abort cancel an unrelated later read.
    assert.notEqual(second.options.signal, first.options.signal, 'each read gets its own controller')
  } finally { panel.release() }
})

test('mounted: unmounting with a read in flight aborts it, and a late success is dropped', async () => {
  const panel = await mountPanel()
  try {
    // Positive control first: the spy demonstrably records an admitted reply in
    // this very test, so the zero delta asserted below cannot come from a spy
    // that never fires.
    await panel.settle(envelope({ sessions: [row({ state: 'expired' })] }))
    assert.equal(panel.parsed.length, 1, 'an admitted reply is parsed')

    await panel.refresh()
    assert.equal(panel.pending.length, 1, 'the refresh read is in flight')
    await panel.unmount()
    assert.equal(panel.calls[1].signalAborted(), true, 'unmounting aborts the in-flight read')

    await panel.settle(envelope({ sessions: [row({ state: 'revoked' })] }))
    // The decisive assertion. An empty container would be true either way —
    // ReactDOM empties it on unmount and then discards the stale update — so the
    // witness is that the reply was never even processed.
    assert.equal(panel.parsed.length, 1, 'the post-unmount reply was never processed')
    // Kept only as a sanity check on ReactDOM's own unmount contract; it is not
    // evidence about the panel.
    assert.equal(panel.container.textContent, '')
  } finally { panel.release() }
})

test('mounted: unmounting with a read in flight swallows a late failure', async () => {
  // The witness with teeth is the absence of an unhandled rejection: the read is
  // fired as `void load()`, so a rejection the component does not handle escapes
  // the process. What this test CANNOT witness is the admissibility guard on the
  // failure path — nothing observable follows it, and React 18 discards the
  // resulting state update in silence. That gap is stated in the report rather
  // than papered over with a container assertion that cannot fail.
  const unhandled: unknown[] = []
  const record = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', record)
  const panel = await mountPanel()
  try {
    assert.equal(panel.pending.length, 1)
    await panel.unmount()
    assert.equal(panel.calls[0].signalAborted(), true, 'unmounting aborts the in-flight read')
    await panel.failNext(new Error('reply arrived after unmount'))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(unhandled, [], 'a late failure must be handled, not escape the component')
  } finally { panel.release(); process.off('unhandledRejection', record) }
})

test('mounted: losing readiness while a read is pending aborts it and discards its reply', async () => {
  const panel = await mountPanel()
  try {
    assert.equal(panel.pending.length, 1)
    await panel.setReadiness(false)
    assert.equal(panel.text(), '', 'nothing is rendered while readiness is lost')
    assert.equal(panel.calls[0].signalAborted(), true, 'the pending read is aborted on readiness loss')

    await panel.setReadiness(true)
    assert.equal(panel.calls.length, 2, 'regaining readiness issues a fresh read')
    // The reply to the pre-loss request arrives only now. Readiness returned and
    // the identity never changed, so nothing but the generation guard stops it.
    await panel.settle(envelope({ sessions: [row({ state: 'revoked' })] }))
    assert.doesNotMatch(panel.text(), /Signed out/, 'the pre-loss reply must not paint')
    await panel.settle(envelope({ sessions: [row({ state: 'expired' })] }))
    assert.match(panel.text(), /Ended by inactivity/, 'the post-restore reply paints')
  } finally { panel.release() }
})

test('mounted: a prior reply arriving after a newer one has painted does not overwrite it', async () => {
  // E1: the test formerly named "a superseded reply" settled its first request
  // before refreshing, so no late prior reply ever existed. The refresh control
  // is disabled while loading — deliberately — so the only way to hold two
  // same-identity reads open at once is a readiness transition.
  const panel = await mountPanel()
  try {
    await panel.setReadiness(false)
    await panel.setReadiness(true)
    assert.equal(panel.pending.length, 2, 'the pre-loss read is still open alongside the new one')

    // Newest reply first: it paints.
    await panel.settleAt(1, envelope({ sessions: [row({ state: 'expired' })] }))
    assert.match(panel.text(), /Ended by inactivity/)

    // Now the genuinely late prior reply, with content chosen to be visible if
    // it ever won.
    await panel.settleAt(0, envelope({ sessions: [row({ state: 'revoked' })] }))
    assert.match(panel.text(), /Ended by inactivity/, 'the newer result survives')
    assert.doesNotMatch(panel.text(), /Signed out/, 'the late prior reply must not overwrite it')
  } finally { panel.release() }
})
