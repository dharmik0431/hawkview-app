import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

/**
 * The MFA challenge must not blame the user's code for a failure that happened
 * AFTER the provider accepted it, and must leave a usable way forward.
 *
 * A TOTP code is consumed by a successful verification, so once
 * `challengeAndVerify` returns without error the code cannot be reused. Two
 * distinct failures follow from that:
 *
 *  - reporting a post-verification failure as a bad code sends the user to
 *    retry with a code that cannot work (the original defect, d91adc83);
 *  - treating a refresh that RESOLVES NULL as success shows them nothing at
 *    all (E2, dfde70bb). The provider makes this the common shape:
 *    `refreshSession: () => Promise<HawkViewSession | null>` returns null on
 *    the unconfirmed-user path rather than rejecting.
 *
 * Recovery must therefore be reachable and must retry the REFRESH, never the
 * consumed verification, and must not survive an identity change.
 *
 * HARNESS NOTE, load-bearing: jsdom globals are installed BEFORE `react-dom`
 * is required. react-dom decides once, at module load, whether native `input`
 * events are supported; with no `window` present it concludes they are not and
 * installs a legacy IE value-watching polyfill that throws on
 * `activeElement.attachEvent` and ignores dispatched `input` events. Sibling
 * render tests require react-dom at top level and are unaffected only because
 * they click rather than type.
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

const SOURCE = new URL('../../components/auth/mfa-access-gate.tsx', import.meta.url)
const BAD_CODE = /code was not accepted/i

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

type Refresh = 'ok' | 'throw' | 'null'
type Outcome = { verify: 'accept' | 'reject'; refreshSession: Refresh }

async function mount(text: string, outcome: Outcome) {
  const container = dom.window.document.createElement('div')
  dom.window.document.getElementById('app')!.appendChild(container)

  const calls = { verify: 0, refreshMfa: 0, refreshSession: 0 }
  let identityToken = 'user-1:0'
  let refresh: Refresh = outcome.refreshSession
  const factors = [{ id: 'factor-1', friendlyName: 'Authenticator' }]

  const supabase = {
    auth: {
      mfa: {
        challengeAndVerify: async () => {
          calls.verify += 1
          // The provider ACCEPTS the code. From here the code is consumed.
          if (outcome.verify === 'accept') return { data: {}, error: null }
          return { data: null, error: new Error('Invalid TOTP code entered') }
        },
      },
    },
  }

  const auth = {
    mfa: { status: 'challenge-required', factors },
    refreshMfa: async () => {
      calls.refreshMfa += 1
    },
    refreshSession: async () => {
      calls.refreshSession += 1
      if (refresh === 'throw') throw new Error('session refresh failed')
      // The real provider returns null rather than rejecting on the
      // unconfirmed-user path. Resolving is NOT the same as succeeding.
      if (refresh === 'null') return null
      return { user: { id: 'user-1' } }
    },
    signOut: async () => {},
    // The gate captures this before its provider call and compares after, so a
    // verification dispatched for one account cannot refresh another's session.
    currentIdentityToken: () => identityToken,
  }

  const { MfaAccessGate } = compile(text, {
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '@/components/ui/button': {
      Button: ({ variant: _v, size: _s, asChild: _a, ...props }: any) => h('button', props),
    },
    '@/components/ui/input': {
      // autoFocus stripped: irrelevant to attribution, and it only adds a focus
      // event for the harness to cope with.
      Input: ({ autoFocus: _f, ...props }: any) => h('input', props),
    },
    '@/components/auth/mfa-enrollment': { MfaEnrollment: () => null },
    '@/components/providers/auth-provider': { useAuth: () => auth },
    '@/lib/auth/supabase': { supabase },
  }) as { MfaAccessGate: () => unknown }

  const root = createRoot(container)
  await React.act(async () => root.render(h(MfaAccessGate, {})))

  const input = () => container.querySelector('input') as HTMLInputElement
  const form = () => container.querySelector('form') as HTMLFormElement
  const text_ = () => container.textContent ?? ''
  const button = (label: RegExp) =>
    [...container.querySelectorAll('button')].find((n) =>
      label.test(n.textContent ?? '')
    ) as (HTMLButtonElement & { disabled: boolean }) | undefined
  // Deliberately NOT a loose /Continue/ match: the submit button reads "Verify
  // and continue", and matching it would make the recovery case assert against
  // the form it is supposed to bypass.
  const recovery = () =>
    [...container.querySelectorAll('button')].find(
      (n) => n.getAttribute('type') !== 'submit' && /retry/i.test(n.textContent ?? '')
    ) as (HTMLButtonElement & { disabled: boolean }) | undefined

  const type = async (value: string) => {
    const node = input()
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      'value'
    )!.set!
    await React.act(async () => {
      setter.call(node, value)
      node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }
  const submit = async () => {
    await React.act(async () => {
      form().dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    })
  }
  const click = async (node: Element) => {
    await React.act(async () => {
      node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
  }
  const rerender = async () => {
    await React.act(async () => root.render(h(MfaAccessGate, {})))
  }
  const teardown = async () => {
    await React.act(async () => root.unmount())
    container.remove()
  }
  return {
    input, form, button, recovery, text: text_, type, submit, click, rerender, teardown, calls, factors,
    setRefresh: (next: Refresh) => {
      refresh = next
    },
  }
}

const source = readFileSync(SOURCE, 'utf8')

test('PRECONDITION: the challenge form renders and a typed code reaches the provider', async () => {
  const g = await mount(source, { verify: 'accept', refreshSession: 'ok' })
  try {
    assert.ok(g.form(), 'the challenge form must render, or every case below is vacuous')
    await g.type('123456')
    assert.equal(g.input().value, '123456', 'the typed code must reach the controlled input')
    await g.submit()
    assert.equal(g.calls.verify, 1, 'submitting must reach the provider exactly once')
  } finally {
    await g.teardown()
  }
})

test('a REJECTING refresh after a successful verification is not blamed on the code', async () => {
  const g = await mount(source, { verify: 'accept', refreshSession: 'throw' })
  try {
    await g.type('123456')
    await g.submit()
    assert.equal(g.calls.refreshSession, 1, 'the refresh must have been attempted')
    assert.doesNotMatch(
      g.text(),
      BAD_CODE,
      'the code WAS accepted and is now consumed; reporting it as rejected sends the user to retry with a code that cannot work'
    )
  } finally {
    await g.teardown()
  }
})

test('a refresh RESOLVING NULL is a failure and must be reported, not passed over in silence', async () => {
  const g = await mount(source, { verify: 'accept', refreshSession: 'null' })
  try {
    await g.type('123456')
    await g.submit()
    assert.equal(g.calls.refreshSession, 1, 'the refresh must have been attempted')
    assert.doesNotMatch(g.text(), BAD_CODE, 'still not the user’s code')
    assert.match(
      g.text(),
      /could not finish signing you in/i,
      'a refresh that resolved null did not succeed; silence leaves the user with a consumed code and no explanation'
    )
  } finally {
    await g.teardown()
  }
})

// The gate-level recovery and identity-isolation cases that stood here were
// removed, not weakened: recovery no longer lives in this component. It lives
// in ProtectedRoute, which survives the gate being unmounted, and is covered by
// mfa-composed-recovery.render.test.ts against the real provider and route.

test('POSITIVE COUNTERPART: a genuine provider rejection is still reported as a bad code', async () => {
  const g = await mount(source, { verify: 'reject', refreshSession: 'ok' })
  try {
    await g.type('000000')
    await g.submit()
    assert.equal(g.calls.refreshSession, 0, 'a rejected code must not refresh the session')
    assert.match(
      g.text(),
      BAD_CODE,
      'a real rejection must still say so, or the fix has merely deleted the message'
    )
  } finally {
    await g.teardown()
  }
})

test('ASSURANCE: a post-verification refresh failure still leaves the gate closed', async () => {
  for (const refreshSession of ['throw', 'null'] as const) {
    const g = await mount(source, { verify: 'accept', refreshSession })
    try {
      await g.type('123456')
      await g.submit()
      assert.match(
        g.text(),
        /Multi-factor authentication is required/,
        `the gate must still be rendered (${refreshSession}); this fault must never become a bypass`
      )
    } finally {
      await g.teardown()
    }
  }
})
