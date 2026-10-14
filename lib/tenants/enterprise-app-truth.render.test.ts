import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { enterpriseAppEnabled, reportedText, reportedYesNo } from './evidence-labels.ts'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { JSDOM } = require('jsdom')
const ts = require('typescript')
const h = React.createElement
const source = resolve('app/(protected)/tenants/[id]/components/sections/enterprise-apps-section.tsx')

function component(tag: string) {
  return ({ children, ...props }: any) => h(tag, props, children)
}

test('enterprise app list does not invent publisher, enabled state, or assignments', () => {
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
    if (name === '@/lib/tenants/dataset-age') return { servicePrincipalsAge: () => ({}) }
    if (name === '@/lib/tenants/evidence-labels') return { enterpriseAppEnabled, reportedText, reportedYesNo }
    if (name === '@/components/ui/card') return { Card: component('section'), CardContent: component('div') }
    if (name === '@/components/ui/badge') return { Badge: component('span') }
    if (name === '@/components/ui/input') return { Input: component('input') }
    if (name === '@/components/ui/button') return { Button: component('button') }
    return require(name)
  }, exports)
  const html = renderToStaticMarkup(h(exports.default, {
    bundle: { entra: { enterpriseApplications: [{ id: 'known-object', displayName: 'Example app' }] } },
  }))
  const doc = new JSDOM(html).window.document
  assert.match(doc.body.textContent ?? '', /1 app status not reported/)
  assert.match(doc.body.textContent ?? '', /1 publisher classification not reported/)
  const row = doc.querySelector('tbody tr')
  assert.ok(row)
  assert.match(row.textContent ?? '', /Example app/)
  assert.match(row.textContent ?? '', /Not reported/)
  assert.doesNotMatch(row.textContent ?? '', /Microsoft Services/)
  assert.doesNotMatch(row.textContent ?? '', /None/)
})
