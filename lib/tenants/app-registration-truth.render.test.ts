import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { applicationAudience, reportedText } from './evidence-labels.ts'

const require = createRequire(import.meta.url)
const React = require('react')
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const ts = require('typescript')
const h = React.createElement
const source = resolve('app/(protected)/tenants/[id]/components/sections/app-registrations-section.tsx')

function component(tag: string) {
  return ({ children, ...props }: any) => h(tag, props, children)
}

test('application list and detail do not classify missing audience, owner, credential, or permission evidence', async () => {
  const output = ts.transpileModule(readFileSync(source, 'utf8'), {
    fileName: source,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const exports: any = {}
  new Function('require', 'exports', output)((name: string) => {
    if (name === '@/components/tenant/section-freshness') return { DatasetEmptyState: () => null }
    if (name === '@/lib/tenants/dataset-age') return { applicationsAge: () => ({}) }
    if (name === '@/lib/tenants/evidence-labels') return { applicationAudience, reportedText }
    if (name === '@/components/ui/card') return { Card: component('section'), CardContent: component('div') }
    if (name === '@/components/ui/badge') return { Badge: component('span') }
    if (name === '@/components/ui/input') return { Input: component('input') }
    if (name === '@/components/ui/button') return { Button: component('button') }
    return require(name)
  }, exports)
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://fixture.invalid' })
  const previous: Record<string, PropertyDescriptor | undefined> = {}
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous[key] = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(document.getElementById('root'))
  try {
    await React.act(async () => root.render(h(exports.default, {
      bundle: { entra: { appRegistrations: [{ id: 'registration-1', displayName: 'Example registration' }] } },
    })))
    const row = document.querySelector('tbody tr')
    assert.ok(row)
    assert.match(row.textContent ?? '', /Example registration/)
    assert.match(row.textContent ?? '', /Not reported/)
    assert.doesNotMatch(row.textContent ?? '', /Single tenant|None/)
    await React.act(async () => row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    const detail = document.querySelector('.fixed.inset-0')
    assert.ok(detail)
    assert.match(detail.textContent ?? '', /Credential metadata not reported/)
    assert.match(detail.textContent ?? '', /API permission requests not reported/)
    assert.match(detail.textContent ?? '', /Owner roster not reported/)
    assert.doesNotMatch(detail.textContent ?? '', /No credentials defined|No owners assigned/)
  } finally {
    await React.act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
