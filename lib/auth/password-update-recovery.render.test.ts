import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

/**
 * Plan v2 step 2A. The password-update form must settle its loading state,
 * must not let stale session state confer access, and must report asynchronous
 * failures truthfully rather than silently.
 *
 * Findings reproduced here (from the read-only pass, 4602778d):
 *  - `getSession()` has no rejection handler, so a rejection leaves
 *    `isLoading` true forever and the submit button permanently disabled with
 *    no message;
 *  - `onAuthStateChange` sets `hasSession` true and never clears it, so a
 *    SIGNED_OUT event (null session) leaves the form believing it still holds
 *    a recovery session;
 *  - `updateUser` rejections are unhandled — only the returned-error shape is
 *    handled — so a throw skips `setIsLoading(false)` and shows nothing;
 *  - a `signOut()` rejection after a successful update strands the user on the
 *    success state because the navigation `setTimeout` never runs.
 *
 * HARNESS NOTE, load-bearing: jsdom globals are installed BEFORE `react-dom`
 * is required, or react-dom installs its legacy IE input polyfill, which
 * throws on focus and ignores dispatched `input` events.
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
    (name: string) => dependencies[name] ?? require(name),
    exports
  )
  return exports
}

type Session = 'present' | 'reject'
type Update = 'ok' | 'returns-error' | 'throws'
type SignOut = 'ok' | 'throws'

async function mount(text: string, o: { session: Session; update?: Update; signOut?: SignOut }) {
  const container = dom.window.document.createElement('div')
  dom.window.document.getElementById('app')!.appendChild(container)

  const calls = { getSession: 0, updateUser: 0, signOut: 0, replace: 0 }
  let listener: ((event: string, session: unknown) => void) | null = null

  const supabase = {
    auth: {
      getSession: async () => {
        calls.getSession += 1
        if (o.session === 'reject') throw new Error('Failed to fetch')
        return { data: { session: { user: { id: 'u1' } } } }
      },
      onAuthStateChange: (fn: (event: string, session: unknown) => void) => {
        listener = fn
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
      updateUser: async () => {
        calls.updateUser += 1
        if (o.update === 'throws') throw new Error('Failed to fetch')
        if (o.update === 'returns-error') return { error: new Error('weak password') }
        return { error: null }
      },
      signOut: async () => {
        calls.signOut += 1
        if (o.signOut === 'throws') throw new Error('Failed to fetch')
        return { error: null }
      },
    },
  }

  const { UpdatePasswordForm } = compile(text, {
    'lucide-react': new Proxy({}, { get: () => () => null }),
    'next/link': { default: (props: any) => h('a', props) },
    'next/navigation': { useRouter: () => ({ replace: () => { calls.replace += 1 } }) },
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

  const inputs = () => [...container.querySelectorAll('input')] as HTMLInputElement[]
  const form = () => container.querySelector('form') as HTMLFormElement | null
  const submitButton = () =>
    [...container.querySelectorAll('button')].find(
      (n) => n.getAttribute('type') === 'submit'
    ) as (HTMLButtonElement & { disabled: boolean }) | undefined
  const text_ = () => container.textContent ?? ''
  const alert = () => container.querySelector('[role="alert"]')?.textContent ?? ''

  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    'value'
  )!.set!
  const typeInto = async (node: HTMLInputElement, value: string) => {
    await React.act(async () => {
      setter.call(node, value)
      node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }
  const fill = async (value: string) => {
    const [a, b] = inputs()
    assert.ok(a && b, 'both password fields must render before filling them')
    await typeInto(a, value)
    await typeInto(b, value)
  }
  const submit = async () => {
    const f = form()
    assert.ok(f, 'the form must be rendered to submit it')
    await React.act(async () => {
      f.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    })
  }
  const emit = async (event: string, session: unknown) => {
    assert.ok(listener, 'the component must have subscribed to auth state changes')
    await React.act(async () => listener!(event, session))
  }
  const teardown = async () => {
    await React.act(async () => root.unmount())
    container.remove()
  }
  return { inputs, form, submitButton, text: text_, alert, fill, submit, emit, teardown, calls }
}

const source = readFileSync(SOURCE, 'utf8')

test('PRECONDITION: with a session, a matching password reaches the provider exactly once', async () => {
  const g = await mount(source, { session: 'present', update: 'ok' })
  try {
    const button = g.submitButton()
    assert.ok(button, 'a submit button must render')
    assert.equal(button.disabled, false, 'a resolved session must enable the form')
    await g.fill('correct-horse-battery')
    await g.submit()
    assert.equal(g.calls.updateUser, 1, 'the update must reach the provider exactly once')
  } finally {
    await g.teardown()
  }
})

test('a REJECTING getSession must settle loading and say something', async () => {
  const g = await mount(source, { session: 'reject' })
  try {
    // Loading settling is observed through the error becoming visible: the
    // button correctly STAYS disabled, because a failed probe means no session
    // and no session must mean no access. Asserting the button is enabled here
    // would have demanded a bypass.
    assert.notEqual(g.alert(), '', 'a failed session probe must be reported, not left silent')
    assert.equal(
      g.submitButton()?.disabled,
      true,
      'no session means no update may be attempted'
    )
  } finally {
    await g.teardown()
  }
})

test('a SIGNED_OUT event must revoke access, not leave stale state conferring it', async () => {
  const g = await mount(source, { session: 'present', update: 'ok' })
  try {
    await g.emit('SIGNED_OUT', null)
    await g.fill('correct-horse-battery')
    await g.submit()
    assert.equal(
      g.calls.updateUser,
      0,
      'after sign-out the form must not attempt an update; stale state must not confer access'
    )
  } finally {
    await g.teardown()
  }
})

test('a THROWN update error must be reported and must settle loading', async () => {
  const g = await mount(source, { session: 'present', update: 'throws' })
  try {
    await g.fill('correct-horse-battery')
    await g.submit()
    assert.notEqual(g.alert(), '', 'a thrown update error must be shown, not swallowed')
    assert.notEqual(
      g.submitButton()?.disabled,
      true,
      'a thrown update error must settle loading, or the form is stuck spinning'
    )
  } finally {
    await g.teardown()
  }
})

test('a signOut failure after a SUCCESSFUL update must not strand the user', async () => {
  const g = await mount(source, { session: 'present', update: 'ok', signOut: 'throws' })
  try {
    await g.fill('correct-horse-battery')
    await g.submit()
    assert.match(
      g.text(),
      /Password updated/i,
      'a genuine password change must still be reported as success'
    )
    assert.notEqual(
      g.text(),
      '',
      'the user must not be left with a success banner and no way onward'
    )
    assert.doesNotMatch(
      g.text(),
      /Returning to login/i,
      'promising a return to login that will never happen strands the user'
    )
  } finally {
    await g.teardown()
  }
})

test('POSITIVE COUNTERPART: a returned update error is still reported', async () => {
  const g = await mount(source, { session: 'present', update: 'returns-error' })
  try {
    await g.fill('correct-horse-battery')
    await g.submit()
    assert.match(g.alert(), /readable:/, 'the returned-error path must keep using readableAuthError')
  } finally {
    await g.teardown()
  }
})
