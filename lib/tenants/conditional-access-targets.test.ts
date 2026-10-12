import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const ts = require('typescript'), React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { JSDOM } = require('jsdom')
const source = readFileSync(new URL('../../components/tenant/conditional-access-targets.tsx', import.meta.url), 'utf8')
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
const moduleObject = { exports: {} as any }
new Function('require', 'module', 'exports', output)(require, moduleObject, moduleObject.exports)
const Targets = moduleObject.exports.ConditionalAccessTargets
const render = (props: unknown) => new JSDOM(renderToStaticMarkup(React.createElement(Targets, props))).window.document.body

test('CA names are escaped text and selectors remain visible, including duplicate names', () => {
  const body = render({ ids: ['user-id', 'group-id'], targets: [
    { id: 'user-id', kind: 'User', name: 'Ops <Team>' }, { id: 'group-id', kind: 'Group', name: 'Ops <Team>' },
  ] })
  assert.equal(body.textContent, 'Ops <Team>user-idOps <Team>group-id')
  assert.equal(body.querySelector('team'), null)
})
test('old payloads and mismatched or missing display references retain exact selectors', () => {
  assert.equal(render({ ids: ['All', 'unknown-id'] }).textContent, 'Allunknown-id')
  assert.equal(render({ ids: ['correct-id'], targets: [{ id: 'wrong-id', name: 'Wrong name' }] }).textContent, 'correct-id')
  assert.equal(render({ ids: ['unresolved'], targets: [{ id: 'unresolved', name: null }] }).textContent, 'unresolved')
})
