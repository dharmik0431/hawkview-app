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

async function mount(text: string, onCompleteRejects = false) {
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
  const unenrolled: string[] = []
  const inputProps: { current: any } = { current: null }
  const supabase = {
    auth: {
      mfa: {
        listFactors: async () => ({ data: { all: [...factors], totp: [] }, error: null }),
        unenroll: async ({ factorId }: { factorId: string }) => {
          unenrolled.push(factorId)
          const index = factors.findIndex((f) => f.id === factorId)
          if (index >= 0) factors.splice(index, 1)
          return { error: null }
        },
        enroll: async ({ friendlyName }: { friendlyName: string }) => {
          const id = 'factor-' + (factors.length + 1)
          factors.push({ id, friendly_name: friendlyName, status: 'unverified', factor_type: 'totp' })
          return { data: { id, totp: { qr_code: QR, secret: SECRET } }, error: null }
        },
        // Mirrors the provider: a successful verification flips the factor to
        // verified BEFORE the caller's onComplete is given control.
        challengeAndVerify: async ({ factorId }: { factorId: string }) => {
          const f = factors.find((x) => x.id === factorId)
          if (f) f.status = 'verified'
          return { error: null }
        },
      },
    },
  }

  const { MfaEnrollment } = compile(text, {
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '@/components/ui/button': {
      Button: ({ variant: _v, size: _s, asChild: _a, ...props }: any) => h('button', props),
    },
    // Captured so the code field can be driven at the component boundary.
    // A DOM-level value set does not reach React's controlled state here.
    '@/components/ui/input': {
      Input: (props: any) => {
        inputProps.current = props
        return h('input', props)
      },
    },
    '@/lib/auth/supabase': { supabase },
    '@/lib/auth/mfa-enrollment': enrollment,
  }) as { MfaEnrollment: (props: unknown) => unknown }

  const root = createRoot(dom.window.document.getElementById('root'))
  // Rejects exactly as an awaited refreshMfa() would on a provider failure.
  const onCancel = async () => {
    throw new Error('refreshMfa failed')
  }
  const onComplete = async () => {
    if (onCompleteRejects) throw new Error('refreshMfa failed')
  }
  await React.act(async () => root.render(h(MfaEnrollment, { onComplete, onCancel })))

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
  const type = async (value: string) => {
    await React.act(async () => {
      inputProps.current?.onChange({ target: { value } })
    })
  }
  return { dom, button, click, type, teardown, factors, unenrolled }
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

/**
 * E2 reproduced this trace identically on base 1d514255 and on v2:
 *   enroll -> verify:verified -> onComplete:rejected -> unenroll:<verified factor>
 * A successful verification followed by a failing refresh left the screen
 * looking like a pending enrollment, so Cancel deleted the authenticator the
 * user had just set up. Pre-existing, not introduced by the enrollment work.
 */
test('a verified factor is never deleted when the post-verification refresh fails', async () => {
  const h = await mount(source, true)
  try {
    await h.click(h.button(/Set up authenticator/)!)
    await h.type('123456')
    await h.click(h.button(/Verify and enable/)!)

    assert.equal(h.factors[0]?.status, 'verified', 'the provider must have confirmed the factor')
    assert.match(h.dom.window.document.body.textContent ?? '', /authenticator is set up/,
      'a failed refresh must read as success-plus-warning, not as a failed verification')
    assert.equal(h.button(/Cancel/), undefined,
      'Cancel must be withdrawn once the factor exists, or it invites destroying it')

    // Even if cancellation is reached by another route, nothing may be deleted.
    await h.click(h.button(/Set up authenticator/) ?? h.button(/Verify and enable/)!)
    assert.deepEqual(h.unenrolled, [], 'no unenroll may be issued against a verified factor')
    assert.equal(h.factors.filter((f) => f.status === 'verified').length, 1)
  } finally {
    h.teardown()
  }
})

test('NEGATIVE CONTROL: without the guard the verified factor is destroyed', async () => {
  // Restores the pre-fix behaviour in memory: verification success is no longer
  // recorded before onComplete, so a rejection falls into the verification
  // catch and the factor stays cancellable.
  const regressed = source
    .replace(/      setEnrolled\(true\)\n      try \{\n        await onComplete\(\)\n      \} catch \{\n        setError\(\n[\s\S]*?\n        \)\n      \}/, '      await onComplete()')
    .replace('if (supabase && !enrolled) {', 'if (supabase) {')
    .replace(/\{!enrolled && \(\n(\s+)<Button/, '{true && (\n$1<Button')
  assert.notEqual(regressed, source, 'the mutation did not apply; this control proves nothing')

  const h = await mount(regressed, true)
  try {
    await h.click(h.button(/Set up authenticator/)!)
    await h.type('123456')
    await h.click(h.button(/Verify and enable/)!)
    const cancel = h.button(/Cancel/)
    assert.ok(cancel, 'the regressed build should still offer Cancel — that is the defect')
    await h.click(cancel)
    assert.ok(h.unenrolled.length > 0,
      'the control must observe the verified factor being deleted, or it is not testing the guard')
  } finally {
    h.teardown()
  }
})
