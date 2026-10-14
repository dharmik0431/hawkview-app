import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { licenseAuditOutcome } from './evidence-labels.ts'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { JSDOM } = require('jsdom')
const ts = require('typescript')
const h = React.createElement
const source = resolve('app/(protected)/tenants/[id]/components/sections/license-activity-section.tsx')

function component(tag: string) {
  return ({ children, ...props }: any) => h(tag, props, children)
}

function render(events: any[]) {
  const output = ts.transpileModule(readFileSync(source, 'utf8'), {
    fileName: source,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const exports: any = {}
  new Function('require', 'exports', output)((name: string) => {
    if (name === '@/components/tenant/section-freshness') return { DatasetEmptyState: () => null }
    if (name === '@/lib/tenants/dataset-age') return { licenseActivityAge: () => ({}) }
    if (name === '@/lib/tenants/evidence-labels') return { licenseAuditOutcome }
    if (name === '@/components/ui/card') return { Card: component('section'), CardContent: component('div') }
    if (name === '@/components/ui/badge') return { Badge: component('span') }
    if (name === '@/components/ui/input') return { Input: component('input') }
    return require(name)
  }, exports)
  const html = renderToStaticMarkup(h(exports.default, { events }))
  return new JSDOM(html).window.document
}

test('license activity renders missing and ambiguous results neutrally, not as successful changes', () => {
  const doc = render([
    { id: 'missing', action: 'Product added' },
    { id: 'ambiguous', action: 'Product removed', status: 'Pending' },
    { id: 'failed', action: 'Assigned', status: 'Unsuccessful' },
  ])
  const rows = Array.from(doc.querySelectorAll('tbody tr')) as HTMLTableRowElement[]
  assert.equal(rows.length, 3)
  assert.match(rows[0]?.textContent ?? '', /Date not reported/)
  assert.match(rows[0]?.textContent ?? '', /Result not reported/)
  assert.match(rows[0]?.querySelector('td:last-child span')?.className ?? '', /bg-slate-50/)
  assert.match(rows[1]?.textContent ?? '', /Pending/)
  assert.match(rows[1]?.querySelector('td:last-child span')?.className ?? '', /bg-slate-50/)
  assert.match(rows[2]?.textContent ?? '', /Unsuccessful/)
  assert.match(rows[2]?.querySelector('td:last-child span')?.className ?? '', /bg-red-50/)
})
