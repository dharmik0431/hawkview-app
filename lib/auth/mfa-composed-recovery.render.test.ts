import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as mfaModule from './mfa.ts'
import * as dataIsolation from './data-isolation.ts'
import * as onboardingSync from './workspace-onboarding-sync.ts'
import * as onboarding from './workspace-onboarding.ts'

/**
 * Composed reproduction for CODEX VERDICT 9200192a (E2 findings on MFA v2).
 *
 * v2's recovery was tested with the gate rendered in isolation, where it
 * worked. In the real composition it does not exist: once verification
 * succeeds, refreshMfa() sets mfa.status to 'verified', so ProtectedRoute
 * stops rendering MfaAccessGate, falls through to its `!session` branch and
 * fires router.replace('/login'). Gate-local recovery state dies with the
 * unmount.
 *
 * These cases therefore render the REAL AuthProvider + ProtectedRoute + gate,
 * stubbing only the provider's outward boundary (supabase, apiClient, router).
 *
 * HARNESS NOTE: jsdom globals are installed BEFORE react-dom is required, or
 * react-dom installs a legacy IE input polyfill that throws on focus and
 * ignores dispatched `input` events.
 */

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const ts = require('typescript')

const dom = new JSDOM('<main id="app"></main>', { url: 'https://console.hawkviewapp.com/' })
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

const React = require('react')
const { createRoot } = require('react-dom/client')
const h = React.createElement

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const PROVIDER = read('../../components/providers/auth-provider.tsx')
const GATE = read('../../components/auth/mfa-access-gate.tsx')
const ROUTE = read('../../components/auth/protected-route.tsx')

function compile(text: string, dependencies: Record<string, unknown>) {
  const exports: Record<string, any> = {}
  const compiled = ts.transpileModule(text, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  new Function('require', 'exports', compiled)(
    (name: string) => {
      if (name in dependencies) return dependencies[name]
      return require(name)
    },
    exports
  )
  return exports
}

type Bootstrap = 'ok' | 'fail' | 'defer'

function world(options: { bootstrap: Bootstrap; assurance?: 'aal1' | 'aal2' }) {
  const calls = { bootstrap: 0, getSession: 0, verify: 0, replace: [] as string[] }
  let deferVerify = false
  let releaseVerify: (() => void) | null = null
  let deferFactors = false
  let releaseFactors: (() => void) | null = null
  let subject = 'user-A'
  let bootstrapMode = options.bootstrap
  const listeners: Array<(event: string, session: unknown) => void> = []

  const user = () => ({
    id: subject,
    email: `${subject}@example.com`,
    email_confirmed_at: '2026-01-01T00:00:00Z',
  })
  const supabase = {
    auth: {
      getSession: async () => {
        calls.getSession += 1
        return { data: { session: { user: user() } }, error: null }
      },
      onAuthStateChange: (fn: (event: string, session: unknown) => void) => {
        listeners.push(fn)
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
      signOut: async () => ({ error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: {
            currentLevel: options.assurance === 'aal1' ? 'aal1' : 'aal2',
            nextLevel: 'aal2',
          },
          error: null,
        }),
        listFactors: async () => (deferFactors
          ? new Promise((resolve) => {
              releaseFactors = () =>
                resolve({
                  data: {
                    totp: [
                      {
                        id: `factor-${subject}`,
                        friendly_name: 'Authenticator',
                        created_at: null,
                        updated_at: null,
                      },
                    ],
                  },
                  error: null,
                })
            })
          : {
          data: {
            totp: [
              {
                id: `factor-${subject}`,
                friendly_name: 'Authenticator',
                created_at: null,
                updated_at: null,
              },
            ],
          },
          error: null,
        }),
        challengeAndVerify: async () => {
          calls.verify += 1
          if (deferVerify) {
            await new Promise<void>((resolve) => {
              releaseVerify = resolve
            })
          }
          return { data: {}, error: null }
        },
      },
    },
  }
  let release: (() => void) | null = null
  const apiClient = {
    get: async () => ({}),
    post: async () => {
      calls.bootstrap += 1
      if (bootstrapMode === 'defer') {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      if (bootstrapMode === 'fail') throw new Error('HAWKVIEW_SESSION_UNAVAILABLE')
      // The shape ProtectedRoute actually requires to render children:
      // workspaceOnboardingState must be 'ready' with required === false.
      // Every nullable field is explicitly null, which is the valid form.
      return {
        user: { ...user(), memberships: [] },
        workspaceOnboarding: {
          required: false,
          organizationId: null,
          organizationName: null,
          businessDomain: null,
          businessDomainVerification: 'UNVERIFIED_INFORMATIONAL',
          timeZone: null,
        },
      }
    },
  }

  return {
    calls,
    supabase,
    apiClient,
    router: { replace: (href: string) => calls.replace.push(href) },
    setBootstrap: (mode: Bootstrap) => {
      bootstrapMode = mode
    },
    setSubject: (next: string) => {
      subject = next
    },
    release: () => {
      release?.()
      release = null
    },
    deferVerification: () => {
      deferVerify = true
    },
    deferFactorRead: () => {
      deferFactors = true
    },
    releaseFactorRead: () => {
      deferFactors = false
      releaseFactors?.()
      releaseFactors = null
    },
    releaseVerification: () => {
      releaseVerify?.()
      releaseVerify = null
    },
    emit: (event: string) => {
      for (const fn of listeners) fn(event, { user: user() })
    },
  }
}

async function mountComposed(w: ReturnType<typeof world>) {
  const container = dom.window.document.createElement('div')
  dom.window.document.getElementById('app')!.appendChild(container)

  const shared: Record<string, unknown> = {
    // This suite isolates the existing MFA/recovery contract. The idle suite
    // composes this same provider with real session-deadline enforcement.
    '@/lib/auth/idle-session': { idleIdentity: () => null },
    '@/lib/auth/idle-session-browser': {
      observeIdleIdentity: () => true,
      attachIdleSessionEvents: () => () => {},
      idleSession: {
        view: () => ({ phase: 'active', sessionId: null, remainingSeconds: 3600, verificationFailed: false }),
        subscribe: () => () => {}, onExpired: () => () => {},
        expire: () => {}, activity: async () => {}, resume: async () => {},
      },
    },
    '@/components/auth/idle-session-warning': { IdleSessionWarning: () => null },
    '@/lib/auth/supabase': { supabase: w.supabase, isSupabaseConfigured: () => true },
    '@/lib/api/client': { apiClient: w.apiClient, USER_ACTION: {} },
    '@/lib/auth/mfa': mfaModule,
    '@/lib/auth/data-isolation': dataIsolation,
    '@/lib/auth/workspace-onboarding-sync': onboardingSync,
    '@/lib/auth/workspace-onboarding': onboarding,
    'next/navigation': { useRouter: () => w.router },
    'next/link': { default: (props: any) => h('a', props) },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '@/components/ui/button': {
      Button: ({ variant: _v, size: _s, asChild: _a, ...props }: any) => h('button', props),
    },
    '@/components/ui/input': { Input: ({ autoFocus: _f, ...props }: any) => h('input', props) },
    '@/components/ui/label': { Label: (props: any) => h('label', props) },
    '@/components/auth/mfa-enrollment': { MfaEnrollment: () => null },
    '@/components/auth/workspace-onboarding': {
      WorkspaceOnboardingGate: () => h('div', null, 'onboarding'),
      WorkspaceOnboardingUnavailable: () => h('div', null, 'onboarding unavailable'),
    },
  }

  const provider = compile(PROVIDER, shared)
  shared['@/components/providers/auth-provider'] = provider
  const gate = compile(GATE, shared)
  shared['@/components/auth/mfa-access-gate'] = gate
  const route = compile(ROUTE, shared)

  let childMounts = 0
  const Child = () => {
    React.useEffect(() => {
      childMounts += 1
    }, [])
    return h('div', null, 'PROTECTED CONTENT')
  }

  const root = createRoot(container)
  await React.act(async () =>
    root.render(
      h(provider.AuthProvider, null, h(route.ProtectedRoute, null, h(Child, null)))
    )
  )

  // The provider bootstraps only from onAuthStateChange, and its callback
  // defers the bootstrap through queueMicrotask, so the event and several
  // flushes are both required before the tree settles.
  await React.act(async () => w.emit('INITIAL_SESSION'))
  for (let i = 0; i < 6; i++) await React.act(async () => { await Promise.resolve() })

  const text = () => container.textContent ?? ''
  const buttons = () => [...container.querySelectorAll('button')] as HTMLButtonElement[]
  const recovery = () =>
    buttons().find(
      (n) => n.getAttribute('type') !== 'submit' && /retry/i.test(n.textContent ?? '')
    )
  const hasRecovery = () => recovery() !== undefined
  const click = async (node: Element) => {
    await React.act(async () => {
      node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    for (let i = 0; i < 6; i++) await React.act(async () => { await Promise.resolve() })
  }
  const flush = async () => {
    for (let i = 0; i < 6; i++) await React.act(async () => { await Promise.resolve() })
  }
  const emit = async (event: string) => {
    await React.act(async () => w.emit(event))
    await flush()
  }
  const typeCode = async (value: string) => {
    const node = container.querySelector('input') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      'value'
    )!.set!
    await React.act(async () => {
      setter.call(node, value)
      node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }
  const submitCode = async () => {
    const form = container.querySelector('form') as HTMLFormElement
    await React.act(async () => {
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    })
    await flush()
  }
  const teardown = async () => {
    await React.act(async () => root.unmount())
    container.remove()
  }
  return { container, text, buttons, recovery, hasRecovery, click, flush, emit, typeCode, submitCode, teardown, childMounts: () => childMounts }
}

test('P1: a bootstrap failure after verification keeps recovery reachable and does not redirect', async () => {
  const w = world({ bootstrap: 'fail' })
  const g = await mountComposed(w)
  try {
    assert.equal(w.calls.bootstrap, 1, 'the bootstrap must have been attempted')
    assert.ok(g.recovery(), 'a refresh-only recovery control must survive the real route lifecycle')
    assert.deepEqual(
      w.calls.replace,
      [],
      'a verified factor with a failed bootstrap must not be sent to /login; the consumed code cannot be reused'
    )
    assert.equal(g.childMounts(), 0, 'ASSURANCE: protected content must stay blocked throughout')
  } finally {
    await g.teardown()
  }
})

test('composed failure -> retry -> success mounts protected content exactly once', async () => {
  const w = world({ bootstrap: 'fail' })
  const g = await mountComposed(w)
  try {
    assert.ok(g.recovery(), 'recovery must be present before it can be retried')
    w.setBootstrap('ok')
    // Re-query: React may have replaced the node between render passes, and a
    // click dispatched on a detached node reaches nothing.
    await g.click(g.recovery()!)
    assert.equal(g.childMounts(), 1, 'a successful retry must admit the user exactly once')
    assert.equal(g.hasRecovery(), false, 'recovery must disappear once it has succeeded')
  } finally {
    await g.teardown()
  }
})

test('P3: overlapping retries are refused; one guarded in-flight recovery', async () => {
  const w = world({ bootstrap: 'fail' })
  const g = await mountComposed(w)
  try {
    const retry = g.recovery()
    assert.ok(retry)
    const before = w.calls.bootstrap
    w.setBootstrap('defer')
    await React.act(async () => {
      retry.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      retry.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await g.flush()
    assert.equal(
      w.calls.bootstrap - before,
      1,
      'two presses must produce ONE bootstrap, not two concurrent refreshes'
    )
    const live = g.recovery()
    assert.equal(live?.disabled, true, 'the control must be disabled while a recovery is in flight')
    w.release()
    await g.flush()
  } finally {
    await g.teardown()
  }
})

test("P2: identity A's failure is not offered as identity B's recovery", async () => {
  const w = world({ bootstrap: 'fail' })
  const g = await mountComposed(w)
  try {
    assert.equal(g.hasRecovery(), true, 'identity A should have a pending recovery')

    // B's own bootstrap SUCCEEDS. Any recovery still on screen can therefore
    // only be A's, which is the stale-state defect rather than B's own.
    w.setSubject('user-B')
    w.setBootstrap('ok')
    await g.emit('SIGNED_IN')

    assert.equal(
      g.hasRecovery(),
      false,
      "identity A's failed bootstrap must not survive into identity B's session"
    )
    assert.equal(g.childMounts(), 1, 'identity B bootstrapped cleanly and should be admitted')
  } finally {
    await g.teardown()
  }
})

test('POSITIVE CONTROL: a successful bootstrap admits the user with no recovery surface', async () => {
  const w = world({ bootstrap: 'ok' })
  const g = await mountComposed(w)
  try {
    assert.equal(g.childMounts(), 1, 'protected content must mount exactly once')
    assert.equal(g.hasRecovery(), false, 'no recovery surface on the healthy path')
    assert.deepEqual(w.calls.replace, [], 'no redirect on the healthy path')
  } finally {
    await g.teardown()
  }
})

test("E2-1: an older identity's running retry must not block the new identity's recovery", async () => {
  const w = world({ bootstrap: 'fail' })
  const g = await mountComposed(w)
  try {
    assert.equal(g.hasRecovery(), true, "identity A should have a pending recovery")
    w.setBootstrap('defer')
    await g.click(g.recovery()!)

    // Switch to B while A's retry is still in flight; B's own bootstrap fails.
    w.setSubject('user-B')
    w.setBootstrap('fail')
    await g.emit('SIGNED_IN')

    const retry = g.recovery()
    assert.ok(retry, "identity B must be offered its own recovery")
    assert.equal(
      retry.disabled,
      false,
      "B must not inherit A's busy state; retry ownership is per generation"
    )

    // A's overlapping finally lands afterwards and must not clear B's lock.
    const before = w.calls.bootstrap
    await g.click(retry)
    w.release()
    await g.flush()
    assert.ok(w.calls.bootstrap > before, "B's own retry must actually run")
  } finally {
    await g.teardown()
  }
})

test('E2-2: a pending verification must not refresh a new identity', async () => {
  const w = world({ bootstrap: 'ok', assurance: 'aal1' })
  const g = await mountComposed(w)
  try {
    assert.ok(g.container.querySelector('form'), 'the challenge gate must render at aal1')
    w.deferVerification()
    await g.typeCode('123456')
    await g.submitCode()
    assert.equal(w.calls.verify, 1, "A's verification must be in flight")

    w.setSubject('user-B')
    await g.emit('SIGNED_IN')
    const readsBefore = w.calls.getSession

    // A's verification completes only now, after the identity changed.
    w.releaseVerification()
    await g.flush()

    assert.equal(
      w.calls.getSession,
      readsBefore,
      "a verification dispatched for A must not drive session reads for B"
    )
  } finally {
    await g.teardown()
  }
})

test('E2-3: an account switch DURING refreshMfa must not start refreshSession', async () => {
  const w = world({ bootstrap: 'ok', assurance: 'aal1' })
  const g = await mountComposed(w)
  try {
    assert.ok(g.container.querySelector('form'), 'the challenge gate must render at aal1')
    // Hold refreshMfa open so the switch lands BETWEEN the gate's two awaits.
    w.deferFactorRead()
    await g.typeCode('123456')
    await g.submitCode()
    assert.equal(w.calls.verify, 1, "A's verification must have been accepted")

    w.setSubject('user-B')
    await g.emit('SIGNED_IN')
    const bootstrapsBefore = w.calls.bootstrap

    // A's refreshMfa settles only now, after the identity already changed.
    w.releaseFactorRead()
    await g.flush()

    assert.equal(
      w.calls.bootstrap,
      bootstrapsBefore,
      "the abandoned attempt must stop between refreshMfa and refreshSession, not bootstrap B"
    )
  } finally {
    await g.teardown()
  }
})

// NOTE ON THIS CASE'S STRENGTH: it asserts true properties, but it is NOT the
// evidence for the generation-bound refreshMfa fix — it passes against the v5
// provider as well, because this fixture's synthetic switch does not reproduce
// the stale assurance commit. The discriminating evidence is E2's
// state-observation.cjs, which records currentMfa/currentIdentity/navigation.
// Treat this as a guard, not as a control.
test('E2-4: A-B-A ends challenge-required with no redirect (guard, not a control)', async () => {
  const w = world({ bootstrap: 'ok', assurance: 'aal1' })
  const g = await mountComposed(w)
  try {
    w.deferFactorRead()
    await g.typeCode('123456')
    await g.submitCode()

    w.setSubject('user-B')
    await g.emit('SIGNED_IN')
    w.setSubject('user-A')
    await g.emit('SIGNED_IN')

    w.releaseFactorRead()
    await g.flush()

    // A stale assurance response must not commit verified for the new A
    // generation: the read count alone cannot see this.
    assert.ok(
      g.container.querySelector('form'),
      'the new A generation must still be challenged, not silently marked verified'
    )
    assert.deepEqual(w.calls.replace, [], 'and must not be redirected to /login')
    assert.equal(g.childMounts(), 0, 'ASSURANCE: protected content stays blocked')
  } finally {
    await g.teardown()
  }
})
