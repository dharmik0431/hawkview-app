import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import * as investigateNavigation from '../tenants/investigate-navigation.ts'

const require = createRequire(import.meta.url)
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const ts = require('typescript')

let pushed: string[] = []

function compileModal() {
  const exports: Record<string, unknown> = {}
  const source = readFileSync(
    new URL('../../components/dashboard/alert-details-modal.tsx', import.meta.url),
    'utf8',
  )
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const Icon = (props: Record<string, unknown>) => React.createElement('svg', props)
  const icons = new Proxy({}, { get: () => Icon })
  const Button = React.forwardRef(
    ({ variant: _variant, size: _size, children, ...props }: Record<string, unknown>, ref: unknown) =>
      React.createElement('button', { ...props, ref }, children),
  )
  Button.displayName = 'TestButton'
  new Function('require', 'exports', compiled)(
    (name: string) => ({
      react: React,
      'next/navigation': { useRouter: () => ({ push: (value: string) => pushed.push(value) }) },
      'lucide-react': icons,
      '@/components/ui/button': { Button },
      '@/lib/utils': { cn: (...values: unknown[]) => values.filter(Boolean).join(' ') },
      '@/lib/tenants/investigate-navigation': investigateNavigation,
    }[name] ?? require(name)),
    exports,
  )
  return exports.AlertDetailsModal as (props: Record<string, unknown>) => unknown
}

const AlertDetailsModal = compileModal()
const tenantA = '11111111-1111-4111-8111-111111111111'
const tenantB = '22222222-2222-4222-8222-222222222222'

async function clickPrimary(actionUrl: string) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  pushed = []
  const root = createRoot(dom.window.document.getElementById('root'))
  try {
    await act(async () => {
      root.render(React.createElement(AlertDetailsModal, {
        isOpen: true,
        onClose: () => undefined,
        item: {
          tenantId: tenantA,
          tenantName: 'Tenant A',
          tenantDomain: 'a.example',
          provider: 'microsoft',
          metricLabel: 'Risk evidence',
          metricValue: 'Not reported',
          item: {
            key: 'risky-identities',
            label: 'Review Microsoft risk',
            severity: 'high',
            why: 'Microsoft risk evidence requires review.',
            actionUrl,
          },
        },
      }))
    })
    const buttons = Array.from(dom.window.document.querySelectorAll('button'))
    const primary = buttons.find((button) => /go (?:fix|investigate) it/i.test(button.textContent ?? ''))
    assert.ok(primary)
    await act(async () => primary.click())
    return pushed[0]
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    Object.assign(globalThis, previous)
  }
}

test('AlertDetailsModal accepts only canonical routes for the alert tenant', async () => {
  assert.equal(await clickPrimary(`/tenants/${tenantA}/risky-users`), `/tenants/${tenantA}/risky-users`)
  assert.equal(
    await clickPrimary(`/tenants/${tenantA}/settings?section=sync&resource=M365_AUDIT`),
    `/tenants/${tenantA}/settings?section=sync&resource=M365_AUDIT`,
  )
})

test('AlertDetailsModal falls back for foreign and hostile destinations', async () => {
  const fallback = `/tenants/${tenantA}/settings`
  for (const actionUrl of [
    `/tenants/${tenantB}/risky-users`,
    `/tenants/${tenantB}/settings`,
    '/tenants/not-a-uuid/risky-users',
    'https://example.test/tenants/anything',
    '//example.test/tenants/anything',
    `/tenants/${tenantA}%2f..%2f${tenantB}/risky-users`,
    `/tenants/${tenantA}/risky-users\u0000`,
  ]) assert.equal(await clickPrimary(actionUrl), fallback, actionUrl)
})
