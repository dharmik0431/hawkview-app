import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as enrollment from './mfa-enrollment.ts'

/**
 * Regression cover for a defect E2 reproduced in review: cancelling an
 * enrollment awaited `onCancel` outside any `finally`, so a rejecting callback
 * left `busy` set and permanently disabled the only button on the screen.
 *
 * `onCancel` really can reject — `components/auth/mfa-access-gate.tsx` passes
 * `async () => { await refreshMfa() }`, which awaits session and factor work.
 * So this is reachable from the product, not only from a test.
 */

const require = createRequire(import.meta.url)
const React = require('react')
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const ts = require('typescript')
const h = React.createElement

const SOURCE = new URL('../../components/auth/mfa-enrollment.tsx', import.meta.url)
const QR = 'data:image/svg+xml;utf-8,<svg/>'
const SECRET = 'JBSWY3DPEHPK3PXP'

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

async function mount(text: string) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'https://console.hawkviewapp.com/profile/security',
  })
  // An array rather than a Map: iterating a Map needs a higher compiler target
  // than this project builds with.
  const restore: Array<[string, PropertyDescriptor | undefined]> = []
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)])
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  const factors: Array<{ id: string; friendly_name: string; status: string; factor_type: string }> = []
  const supabase = {
    auth: {
      mfa: {
        listFactors: async () => ({ data: { all: [...factors], totp: [] }, error: null }),
        unenroll: async ({ factorId }: { factorId: string }) => {
          const index = factors.findIndex((f) => f.id === factorId)
          if (index >= 0) factors.splice(index, 1)
          return { error: null }
        },
        enroll: async ({ friendlyName }: { friendlyName: string }) => {
          const id = 'factor-' + (factors.length + 1)
          factors.push({ id, friendly_name: friendlyName, status: 'unverified', factor_type: 'totp' })
          return { data: { id, totp: { qr_code: QR, secret: SECRET } }, error: null }
        },
        challengeAndVerify: async () => ({ error: null }),
      },
    },
  }

  const { MfaEnrollment } = compile(text, {
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '@/components/ui/button': {
      Button: ({ variant: _v, size: _s, asChild: _a, ...props }: any) => h('button', props),
    },
    '@/components/ui/input': { Input: (props: any) => h('input', props) },
    '@/lib/auth/supabase': { supabase },
    '@/lib/auth/mfa-enrollment': enrollment,
  }) as { MfaEnrollment: (props: unknown) => unknown }

  const root = createRoot(dom.window.document.getElementById('root'))
  // Rejects exactly as an awaited refreshMfa() would on a provider failure.
  const onCancel = async () => {
    throw new Error('refreshMfa failed')
  }
  await React.act(async () => root.render(h(MfaEnrollment, { onComplete: () => {}, onCancel })))

  const button = (label: RegExp) =>
    [...dom.window.document.querySelectorAll('button')].find((node) =>
      label.test(node.textContent ?? '')
    ) as (HTMLButtonElement & { disabled: boolean }) | undefined
  const click = async (node: Element) => {
    await React.act(async () => {
      node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
  }
  const teardown = () => {
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
  return { dom, button, click, teardown, factors }
}

const source = readFileSync(SOURCE, 'utf8')

test('a rejecting onCancel leaves the enrollment screen usable', async () => {
  const h1 = await mount(source)
  try {
    const start = h1.button(/Set up authenticator/)
    assert.ok(start, 'the start button should render before enrollment')
    await h1.click(start)
    assert.ok(h1.button(/Verify and enable/), 'enrollment should have begun')

    const cancel = h1.button(/Cancel/)
    assert.ok(cancel, 'cancel should be offered during enrollment')
    await h1.click(cancel)

    const restarted = h1.button(/Set up authenticator/)
    assert.ok(restarted, 'cancelling should return to the start screen')
    assert.equal(restarted.disabled, false,
      'a rejecting onCancel must not leave the only button on the screen disabled')
    assert.match(h1.dom.window.document.body.textContent ?? '', /could not be completed/,
      'the failure must be visible rather than silent')
  } finally {
    h1.teardown()
  }
})

test('NEGATIVE CONTROL: removing the finally reinstates the permanent lockout', async () => {
  // Without this the test above could pass against a component that never
  // became busy at all, and the regression would be uncovered.
  const stranded = source.replace(
    /\} finally \{\n\s*\/\/ onCancel is declared async[\s\S]*?setBusy\(false\)\n\s*\}/,
    '}'
  )
  assert.notEqual(stranded, source, 'the mutation did not apply; this control proves nothing')

  const h2 = await mount(stranded)
  try {
    await h2.click(h2.button(/Set up authenticator/)!)
    await h2.click(h2.button(/Cancel/)!)
    const restarted = h2.button(/Set up authenticator/)
    assert.ok(restarted, 'the mutated build should still return to the start screen')
    assert.equal(restarted.disabled, true,
      'the control must observe the stranded button, or it is not testing the guard')
  } finally {
    h2.teardown()
  }
})

test('cancelling clears the abandoned factor server-side even as onCancel fails', async () => {
  const h3 = await mount(source)
  try {
    await h3.click(h3.button(/Set up authenticator/)!)
    assert.equal(h3.factors.length, 1, 'enrollment should have created a factor')
    await h3.click(h3.button(/Cancel/)!)
    assert.equal(h3.factors.length, 0,
      'the unverified factor must be removed, or the next enrollment conflicts again')
  } finally {
    h3.teardown()
  }
})
