import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

/**
 * Reproduction for CODEX VERDICT 336c5492 on the password-update slice.
 *
 * The five findings, in the reviewer's order:
 *  1. a deferred update for identity A, completing after SIGNED_IN for B,
 *     calls global signOut on the NEW active account;
 *  2. a late initial getSession overwrites newer events in BOTH directions —
 *     a stale valid response re-enables submission after signout, a stale null
 *     disables it after genuine recovery;
 *  3. PASSWORD_RECOVERY with a null session still grants hasSession;
 *  4. signOut returning { error } is ignored (only the thrown shape is handled);
 *  5. the delayed redirect survives unmount and navigates afterwards.
 *
 * Assertions compare primitives, never DOM nodes: a failing assert.equal on a
 * jsdom element serializes parent -> document -> window and the process is
 * OOM-killed with SIGKILL instead of reporting the failure.
 *
 * HARNESS NOTE: jsdom globals are installed BEFORE react-dom is required, or
 * react-dom installs a legacy IE input polyfill that throws on focus and
 * ignores dispatched `input` events.
 */

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const ts = require('typescript')

const dom = new JSDOM('<main id="app"></main>', {
  url: 'https://console.hawkviewapp.com/reset-password',
})
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

const SOURCE = new URL('../../components/auth/update-password-form.tsx', import.meta.url)
const source = readFileSync(SOURCE, 'utf8')

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
    (name: string) => (name in dependencies ? dependencies[name] : require(name)),
    exports
  )
  return exports
}

type Options = {
  /** 'hold' leaves the initial probe pending so events can land first. */
  session?: 'present' | 'none' | 'hold'
  update?: 'ok' | 'hold' | 'hold-then-error'
  signOut?: 'ok' | 'returns-error' | 'emits-null'
}

async function mount(o: Options) {
  const container = dom.window.document.createElement('div')
  dom.window.document.getElementById('app')!.appendChild(container)

  const calls = {
    updateUser: 0,
    signOut: 0,
    replace: [] as string[],
    signOutFor: [] as string[],
  }
  let activeSubject = 'A'
  let listener: ((event: string, session: unknown) => void) | null = null
  let releaseSession: ((value: unknown) => void) | null = null
  let releaseUpdate: (() => void) | null = null
  let deferSignOut = false
  let releaseSignOut: (() => void) | null = null

  const sessionFor = (subject: string) => ({
    user: { id: `user-${subject}`, email_confirmed_at: '2026-01-01T00:00:00Z' },
  })

  const supabase = {
    auth: {
      getSession: async () => {
        if (o.session === 'hold') {
          return new Promise((resolve) => {
            releaseSession = resolve
          })
        }
        return { data: { session: o.session === 'none' ? null : sessionFor('A') } }
      },
      onAuthStateChange: (fn: (event: string, session: unknown) => void) => {
        listener = fn
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
      updateUser: async () => {
        calls.updateUser += 1
        if (o.update === 'hold' || o.update === 'hold-then-error') {
          await new Promise<void>((resolve) => {
            releaseUpdate = resolve
          })
        }
        if (o.update === 'hold-then-error') return { error: new Error('weak password') }
        return { error: null }
      },
      signOut: async () => {
        calls.signOut += 1
        if (deferSignOut) {
          await new Promise<void>((resolve) => {
            releaseSignOut = resolve
          })
        }
        // Which account a global signOut actually ends is whoever is active
        // NOW, not whoever the continuation believed it was acting for.
        calls.signOutFor.push(activeSubject)
        if (o.signOut === 'returns-error') return { error: new Error('signout refused') }
        if (o.signOut === 'emits-null') {
          listener?.('SIGNED_OUT', null)
          return { error: null }
        }
        return { error: null }
      },
    },
  }

  const { UpdatePasswordForm } = compile(source, {
    'lucide-react': new Proxy({}, { get: () => () => null }),
    'next/link': { default: (props: any) => h('a', props) },
    'next/navigation': {
      useRouter: () => ({ replace: (href: string) => calls.replace.push(href) }),
    },
    '@/components/ui/button': {
      Button: ({ variant: _v, size: _s, asChild: _a, ...props }: any) => h('button', props),
    },
    '@/components/ui/input': { Input: ({ autoFocus: _f, ...props }: any) => h('input', props) },
    '@/components/ui/label': { Label: (props: any) => h('label', props) },
    '@/lib/auth/supabase': { supabase },
    '@/lib/auth/auth-errors': { readableAuthError: (e: unknown) => `readable: ${String(e)}` },
  }) as { UpdatePasswordForm: () => unknown }

  const root = createRoot(container)
  await React.act(async () => root.render(h(UpdatePasswordForm, {})))

  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await React.act(async () => { await Promise.resolve() })
  }
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    'value'
  )!.set!
  const inputs = () => [...container.querySelectorAll('input')] as HTMLInputElement[]
  const submitDisabled = () => {
    const button = [...container.querySelectorAll('button')].find(
      (n) => n.getAttribute('type') === 'submit'
    ) as HTMLButtonElement | undefined
    return button ? button.disabled : null
  }
  const fill = async (value: string) => {
    for (const node of inputs()) {
      await React.act(async () => {
        setter.call(node, value)
        node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    }
  }
  const submit = async () => {
    const form = container.querySelector('form')
    assert.ok(form, 'the form must be rendered to submit it')
    await React.act(async () => {
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    })
    await flush()
  }
  const emit = async (event: string, subject: string | null) => {
    assert.ok(listener, 'the component must have subscribed to auth state changes')
    if (subject) activeSubject = subject
    await React.act(async () => listener!(event, subject ? sessionFor(subject) : null))
    await flush()
  }
  const unmount = async () => {
    await React.act(async () => root.unmount())
  }
  return {
    calls,
    flush,
    fill,
    submit,
    emit,
    unmount,
    submitDisabled,
    text: () => container.textContent ?? '',
    alert: () => container.querySelector('[role="alert"]')?.textContent ?? '',
    isLoadingShown: () => {
      const button = [...container.querySelectorAll('button')].find(
        (n) => n.getAttribute('type') === 'submit'
      ) as HTMLButtonElement | undefined
      return button ? button.disabled : null
    },
    releaseSession: async (subject: string | null) => {
      releaseSession?.({ data: { session: subject ? sessionFor(subject) : null } })
      await flush()
    },
    releaseUpdate: async () => {
      releaseUpdate?.()
      await flush()
    },
    deferSignOut: () => {
      deferSignOut = true
    },
    releaseSignOut: async () => {
      releaseSignOut?.()
      await flush()
    },
    teardown: async () => {
      await React.act(async () => root.unmount())
      container.remove()
    },
  }
}

test("1. a deferred update for A must not sign out identity B", async () => {
  const g = await mount({ session: 'present', update: 'hold' })
  try {
    await g.fill('correct-horse-battery')
    await g.submit()
    assert.equal(g.calls.updateUser, 1, 'the update must have been dispatched for A')

    // The active account changes while A's update is still in flight.
    await g.emit('SIGNED_IN', 'B')
    await g.releaseUpdate()

    assert.deepEqual(
      g.calls.signOutFor,
      [],
      "A's abandoned continuation must not sign out whoever is active now"
    )
  } finally {
    await g.teardown()
  }
})

test('2a. a late initial getSession must not re-enable submission after SIGNED_OUT', async () => {
  const g = await mount({ session: 'hold' })
  try {
    await g.emit('SIGNED_OUT', null)
    assert.equal(g.submitDisabled(), true, 'sign-out must disable submission')
    // The initial probe, dispatched before the event, resolves afterwards.
    await g.releaseSession('A')
    assert.equal(
      g.submitDisabled(),
      true,
      'a stale initial probe must not overwrite a newer SIGNED_OUT'
    )
  } finally {
    await g.teardown()
  }
})

test('2b. a late initial getSession must not disable submission after genuine recovery', async () => {
  const g = await mount({ session: 'hold' })
  try {
    await g.emit('PASSWORD_RECOVERY', 'A')
    assert.equal(g.submitDisabled(), false, 'a real recovery session must enable submission')
    await g.releaseSession(null)
    assert.equal(
      g.submitDisabled(),
      false,
      'a stale null probe must not overwrite a newer genuine recovery'
    )
  } finally {
    await g.teardown()
  }
})

test('3. PASSWORD_RECOVERY with a NULL session is not session authority', async () => {
  const g = await mount({ session: 'none' })
  try {
    await g.emit('PASSWORD_RECOVERY', null)
    assert.equal(
      g.submitDisabled(),
      true,
      'an event label without a session must not grant the ability to update a password'
    )
    await g.fill('correct-horse-battery')
    await g.submit()
    assert.equal(g.calls.updateUser, 0, 'no update may be attempted without session authority')
  } finally {
    await g.teardown()
  }
})

test('4. a signOut that RETURNS an error is handled, not ignored', async () => {
  const g = await mount({ session: 'present', signOut: 'returns-error' })
  try {
    await g.fill('correct-horse-battery')
    await g.submit()
    assert.match(g.text(), /Password updated/i, 'the genuine update must stay truthful')
    assert.doesNotMatch(
      g.text(),
      /Returning to login/i,
      'a refused signout must not promise a navigation'
    )
    assert.deepEqual(g.calls.replace, [], 'and must not perform one')
  } finally {
    await g.teardown()
  }
})

test('5. the delayed redirect must not survive unmount', async () => {
  const g = await mount({ session: 'present' })
  try {
    await g.fill('correct-horse-battery')
    await g.submit()
    await g.unmount()
    await new Promise((resolve) => setTimeout(resolve, 1400))
    assert.deepEqual(
      g.calls.replace,
      [],
      'an unmounted form must not navigate; its timer has to be cancelled'
    )
  } finally {
    await g.teardown()
  }
})

test('POSITIVE COUNTERPART: success stays visible when its own signout emits null', async () => {
  const g = await mount({ session: 'present', signOut: 'emits-null' })
  try {
    await g.fill('correct-horse-battery')
    await g.submit()
    assert.equal(g.calls.updateUser, 1, 'exactly one update')
    assert.match(
      g.text(),
      /Password updated/i,
      'the password really did change; its own signout emitting null must not erase that'
    )
  } finally {
    await g.teardown()
  }
})

test('L1: a pending update completing AFTER unmount must not dispatch signOut', async () => {
  const g = await mount({ session: 'present', update: 'hold' })
  try {
    await g.fill('correct-horse-battery')
    await g.submit()
    assert.equal(g.calls.updateUser, 1, 'the update must be in flight')
    await g.unmount()
    await g.releaseUpdate()
    assert.equal(
      g.calls.signOut,
      0,
      'an unmounted form must not sign anyone out; lifetime is not covered by the generation alone'
    )
  } finally {
    await g.teardown()
  }
})

test('L2: an identity switch during a pending signOut must not redirect the new account', async () => {
  const g = await mount({ session: 'present', update: 'ok' })
  try {
    g.deferSignOut()
    await g.fill('correct-horse-battery')
    await g.submit()
    assert.equal(g.calls.signOut, 1, "A's signout must be in flight")
    await g.emit('SIGNED_IN', 'B')
    await g.releaseSignOut()
    await new Promise((resolve) => setTimeout(resolve, 1400))
    assert.deepEqual(g.calls.replace, [], "A's completion must not navigate B")
  } finally {
    await g.teardown()
  }
})

test('L3: unmount during a pending signOut must not schedule a NEW timer afterwards', async () => {
  const g = await mount({ session: 'present', update: 'ok' })
  try {
    g.deferSignOut()
    await g.fill('correct-horse-battery')
    await g.submit()
    await g.unmount()
    await g.releaseSignOut()
    await new Promise((resolve) => setTimeout(resolve, 1400))
    assert.deepEqual(
      g.calls.replace,
      [],
      'clearing existing timers is not enough; a timer created after cleanup must never exist'
    )
  } finally {
    await g.teardown()
  }
})

test("L4: a returned update error from A must not be published on B, nor write loading", async () => {
  const g = await mount({ session: 'present', update: 'hold-then-error' })
  try {
    await g.fill('correct-horse-battery')
    await g.submit()
    await g.emit('SIGNED_IN', 'B')
    await g.releaseUpdate()
    assert.equal(g.alert(), '', "A's returned error must not be published on B's screen")
  } finally {
    await g.teardown()
  }
})
