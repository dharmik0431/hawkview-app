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
  const calls: { signalAborted: () => boolean }[] = []
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
      get: (_endpoint: string, options: any) => {
        calls.push({ signalAborted: () => Boolean(options?.signal?.aborted) })
        return new Promise((resolve, reject) => pending.push({ resolve, reject }))
      },
    },
  }
  const load = makeLoader({
    '@/components/providers/auth-provider': auth,
    '@/lib/api/client': api,
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
      release,
      settle: async (value: unknown) => { pending.shift()!.resolve(value); await act(async () => {}) },
      failNext: async (error: unknown) => { pending.shift()!.reject(error); await act(async () => {}) },
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

test('mounted: a superseded reply is discarded when a newer request is in flight', async () => {
  const panel = await mountPanel()
  try {
    await panel.settle(envelope({ sessions: [row({ state: 'revoked' })] }))
    await panel.refresh()
    assert.equal(panel.pending.length, 1, 'the refresh issued a new request')
    // Resolve the NEW request with distinguishable content, then the old one.
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
