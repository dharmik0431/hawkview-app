import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { reportedText } from './evidence-labels.ts'

const require = createRequire(import.meta.url)
const React = require('react')
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const ts = require('typescript')
const h = React.createElement
const source = resolve('app/(protected)/tenants/[id]/components/sections/licenses-section.tsx')

function component(tag: string) {
  return ({ children, ...props }: any) => h(tag, props, children)
}

test('license assignment drawer reports each account state instead of calling every assignee active', async () => {
  const output = ts.transpileModule(readFileSync(source, 'utf8'), {
    fileName: source,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const exports: any = {}
  new Function('require', 'exports', output)((name: string) => {
    if (name === '@/lib/tenants/evidence-labels') return { reportedText }
    if (name === '@/components/ui/card') return { Card: component('section'), CardContent: component('div') }
    if (name === '@/components/ui/badge') return { Badge: component('span') }
    if (name === '@/components/ui/input') return { Input: component('input') }
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
    const license = { skuId: 'sku-1', skuPartNumber: 'SKU1', friendlyName: 'Product One', used: 3, total: 4 }
    const assigned = (id: string, name: string, status?: string) => ({ id, displayName: name, status, licenses: [{ skuId: 'sku-1' }] })
    await React.act(async () => root.render(h(exports.default, {
      licenseRows: [license],
      users: [assigned('disabled', 'Disabled User', 'Disabled'), assigned('unknown', 'Unreported User'), assigned('enabled', 'Enabled User', 'Enabled')],
      syncCompleted: true,
    })))
    const inventoryRow = document.querySelector('tbody tr')
    assert.ok(inventoryRow)
    await React.act(async () => inventoryRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    const drawer = document.querySelector('.fixed.inset-0')
    assert.ok(drawer)
    assert.match(drawer.textContent ?? '', /Account status/)
    const rows = Array.from(drawer.querySelectorAll('tbody tr'))
    const status = (name: string) => rows.find((row) => row.textContent?.includes(name))?.querySelector('td:last-child')?.textContent
    assert.equal(status('Disabled User'), 'Disabled')
    assert.equal(status('Unreported User'), 'Not reported')
    assert.equal(status('Enabled User'), 'Enabled')
    assert.doesNotMatch(drawer.textContent ?? '', /Active/)
  } finally {
    await React.act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
