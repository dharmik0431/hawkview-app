import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as idle from './idle-session.ts'
import * as isolation from './data-isolation.ts'
import * as mfa from './mfa.ts'
import * as sync from './workspace-onboarding-sync.ts'
import * as onboarding from './workspace-onboarding.ts'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const ts = require('typescript')
const dom = new JSDOM('<main></main>', { url: 'https://console.hawkviewapp.com', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
}
const React = require('react')
const { createRoot } = require('react-dom/client')
const h = React.createElement
function compile(path: string, dependencies: Record<string, any>) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { fileName: path, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, any> = {}
  new Function('require', 'exports', compiled)((name: string) => dependencies[name] ?? require(name), exports)
  return exports
}
const subject = '11111111-2222-4333-8444-555555555555'
const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const makeToken = (id = sessionId) => `x.${btoa(JSON.stringify({ sub: subject, session_id: id }))}.x`
const originalFetch = globalThis.fetch
const originalNow = Date.now

async function mount() {
  dom.window.localStorage.clear()
  let now = Date.parse('2026-10-08T13:00:00Z')
  Date.now = () => now
  let serverDeadline = now + 3600000
  let offline = false
  let current: any = { access_token: makeToken(), user: { id: subject, email: 'owner@example.com', email_confirmed_at: '2026-01-01' } }
  let listener: (event: string, session: any) => void = () => {}
  const calls: string[] = []
  const signOuts: unknown[] = []
  const routers: string[] = []
  let holdPrivate = false
  let releasePrivate: (() => void) | null = null
  const inputHandlers = new Map<string, EventListener>()
  const originalAdd = dom.window.document.addEventListener.bind(dom.window.document)
  dom.window.document.addEventListener = ((name: string, fn: EventListener, options: any) => {
    if (['pointerdown', 'pointermove', 'keydown', 'touchstart', 'touchmove', 'wheel', 'scroll'].includes(name)) inputHandlers.set(name, fn)
    return originalAdd(name, fn, options)
  }) as any
  globalThis.fetch = async (input, options) => {
    const path = new URL(String(input)).pathname
    calls.push(path)
    if (offline) throw new Error('offline')
    if (path === '/private' && holdPrivate) await new Promise<void>((resolve) => { releasePrivate = resolve })
    if (path.endsWith('/auth/session/end')) return new Response(JSON.stringify({ ended: true }))
    if (path.includes('/auth/session')) {
      if (now >= serverDeadline) return new Response(JSON.stringify({ code: 'SESSION_IDLE_EXPIRED' }), { status: 401 })
      if (path.endsWith('/activity')) serverDeadline = now + 3600000
      return new Response(JSON.stringify({ sessionId, serverNow: new Date(now).toISOString(), idleExpiresAt: new Date(serverDeadline).toISOString(), idleTimeoutSeconds: 3600, warningSeconds: 120 }), { headers: { 'Content-Type': 'application/json' } })
    }
    assert.equal(options?.headers && (options.headers as Record<string,string>).Authorization, `Bearer ${makeToken()}`)
    return new Response(JSON.stringify({
      user: { id: subject, email: 'owner@example.com', memberships: [] },
      workspaceOnboarding: { required: false, organizationId: null, organizationName: null, businessDomain: null, businessDomainVerification: 'UNVERIFIED_INFORMATIONAL', timeZone: null },
    }), { headers: { 'Content-Type': 'application/json' } })
  }
  const deps: Record<string, any> = {
    './idle-session': idle,
    '@/lib/auth/idle-session': idle,
    '@/lib/auth/data-isolation': isolation,
    '@/lib/auth/mfa': mfa,
    '@/lib/auth/workspace-onboarding-sync': sync,
    '@/lib/auth/workspace-onboarding': onboarding,
    '@/lib/config/public-runtime-config': { buildHawkViewApiUrl: (path: string) => new URL(path, 'https://api.example.com') },
    '@/lib/auth/supabase': { isSupabaseConfigured: true, supabase: { auth: {
      getSession: async () => ({ data: { session: current } }),
      onAuthStateChange: (fn: typeof listener) => { listener = fn; return { data: { subscription: { unsubscribe() {} } } } },
      signOut: async (options: unknown) => { signOuts.push(options); current = null; listener('SIGNED_OUT', null); return { error: null } },
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2', nextLevel: 'aal2' } }),
        listFactors: async () => ({ data: { totp: [{ id: 'factor' }] } }),
      },
    } } },
    'next/navigation': { useRouter: () => ({ replace: (path: string) => routers.push(path) }) },
    '@/components/auth/mfa-access-gate': { MfaAccessGate: () => h('div', null, 'MFA REQUIRED') },
    '@/components/auth/workspace-onboarding': { WorkspaceOnboardingGate: () => null, WorkspaceOnboardingUnavailable: () => h('div', null, 'UNAVAILABLE') },
  }
  const browser = compile('./idle-session-browser.ts', deps)
  deps['@/lib/auth/idle-session-browser'] = browser
  const api = compile('../api/client.ts', deps)
  deps['@/lib/api/client'] = api
  const provider = compile('../../components/providers/auth-provider.tsx', deps)
  deps['@/components/providers/auth-provider'] = provider
  deps['@/components/auth/idle-session-warning'] = compile('../../components/auth/idle-session-warning.tsx', deps)
  const route = compile('../../components/auth/protected-route.tsx', deps)
  const element = dom.window.document.createElement('div')
  dom.window.document.querySelector('main')!.appendChild(element)
  const root = createRoot(element)
  await React.act(async () => root.render(h(provider.AuthProvider, null, h(route.ProtectedRoute, null, h('div', null, 'PRIVATE TENANT DATA')))))
  await React.act(async () => listener('INITIAL_SESSION', current))
  const flush = async () => { for (let i = 0; i < 10; i++) await React.act(async () => { await Promise.resolve() }) }
  await flush()
  return {
    element, browser, api, calls, signOuts, routers, flush,
    advance: async (ms: number) => { now += ms; await React.act(async () => browser.idleSession.tick()); await flush() },
    offline: () => { offline = true },
    restoreStaleToken: () => { current = { access_token: makeToken(), user: { id: subject, email: 'owner@example.com', email_confirmed_at: '2026-01-01' } } },
    deferPrivate: () => { holdPrivate = true },
    releasePrivate: () => releasePrivate?.(),
    input: (name: string, trusted: boolean) => inputHandlers.get(name)?.({ isTrusted: trusted } as Event),
    emitRefresh: async () => { await React.act(async () => listener('TOKEN_REFRESHED', current)); await flush() },
    close: async () => { await React.act(async () => root.unmount()); element.remove(); Date.now = originalNow; globalThis.fetch = originalFetch; dom.window.document.addEventListener = originalAdd },
  }
}

test('real provider, gate, API client and idle adapter: warning, accepted extension, expiry, local sign-out', async () => {
  const w = await mount()
  try {
    assert.match(w.element.textContent, /PRIVATE TENANT DATA/)
    assert.deepEqual(w.calls, ['/auth/session', '/auth/bootstrap'])
    await w.advance(58 * 60000)
    assert.match(w.element.textContent, /Your session is about to end/)
    await w.emitRefresh()
    assert.equal(w.calls.filter((p) => p.endsWith('/activity')).length, 0)
    const button = [...w.element.querySelectorAll('button')].find((el: any) => /Stay signed in/.test(el.textContent)) as HTMLButtonElement
    await React.act(async () => button.click())
    await w.flush()
    assert.doesNotMatch(w.element.textContent, /Your session is about to end/)
    await w.advance(60 * 60000)
    assert.doesNotMatch(w.element.textContent, /PRIVATE TENANT DATA/)
    assert.deepEqual(w.signOuts, [{ scope: 'local' }])
    assert.ok(w.routers.includes('/login'))
  } finally { await w.close() }
})

test('wake rechecks the session, hides protected data offline and expires at the accepted deadline', async () => {
  const w = await mount()
  try {
    await React.act(async () => w.browser.idleSession.suspend())
    assert.doesNotMatch(w.element.textContent, /PRIVATE TENANT DATA/)
    w.offline()
    await React.act(async () => { await assert.rejects(w.browser.idleSession.resume(), /offline/) })
    assert.match(w.element.textContent, /Retry session check/)
    assert.doesNotMatch(w.element.textContent, /PRIVATE TENANT DATA/)
    await w.advance(3600000)
    assert.equal(w.signOuts.length, 1)
  } finally { await w.close() }
})

test('ordinary API calls after local expiry are stopped before protected network access', async () => {
  const w = await mount()
  try {
    await w.advance(3600000)
    // Replaying the still-valid old token cannot bypass the local tombstone.
    w.restoreStaleToken()
    await React.act(async () => { await assert.rejects(w.api.apiClient.get('/private'), idle.IdleSessionError) })
    assert.equal(w.calls.filter((p) => p === '/auth/bootstrap').length, 1)
    assert.equal(w.calls.includes('/private'), false)
  } finally { await w.close() }
})

test('a successful API response arriving after expiry cannot expose its protected payload', async () => {
  const w = await mount()
  try {
    w.deferPrivate()
    const result = w.api.apiClient.get('/private')
    await w.flush()
    assert.ok(w.calls.includes('/private'))
    await w.advance(3600000)
    await React.act(async () => { w.releasePrivate(); await assert.rejects(result, idle.IdleSessionError) })
    assert.doesNotMatch(w.element.textContent, /PRIVATE TENANT DATA/)
  } finally { await w.close() }
})

test('input handlers report trusted human input, excluding synthetic input and programmatic scrolling', async () => {
  const w = await mount()
  try {
    await w.advance(30 * 60000)
    await React.act(async () => {
      w.input('keydown', false)
      w.input('scroll', true)
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    assert.equal(w.calls.filter((p) => p.endsWith('/activity')).length, 0)
    await React.act(async () => {
      w.input('keydown', true)
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    assert.equal(w.calls.filter((p) => p.endsWith('/activity')).length, 1)
    assert.equal(w.browser.idleSession.view().remainingSeconds, 3600)
  } finally { await w.close() }
})
