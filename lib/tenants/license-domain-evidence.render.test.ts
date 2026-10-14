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

test('domain card uses only the observed Microsoft verified-domain collection', async () => {
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
  const card = () => {
    const heading = Array.from(document.querySelectorAll('div')).find(
      (element) => element.textContent?.trim() === 'Tenant Domains'
    )
    const element = heading?.parentElement?.parentElement
    assert.ok(element)
    return element.textContent ?? ''
  }
  const render = async (bundle: any) => {
    await React.act(async () => root.render(h(exports.default, {
      licenseRows: [], syncCompleted: true,
      tenant: { domain: 'onboarding.example', domains: ['onboarding.example'] },
      bundle,
    })))
  }

  try {
    await render({ tenant: { domains: [] }, sync: { domains: { status: 'never-synced', lastSuccessfulAt: null } } })
    assert.match(card(), /Awaiting domain collection/)
    assert.match(card(), /No successful Microsoft domain collection recorded/)
    assert.doesNotMatch(card(), /verified of|1 verified domain/)

    await render({ tenant: { domains: [] }, sync: { domains: { status: 'succeeded', lastSuccessfulAt: '2026-10-14T00:00:00Z' } } })
    assert.match(card(), /No verified domains reported/)
    assert.match(card(), /From the last successful Microsoft domain collection/)
    assert.doesNotMatch(card(), /verified of/)

    await render({
      tenant: { domains: ['one.example', 'two.example', 'three.example'] },
      sync: { domains: { status: 'succeeded', lastSuccessfulAt: '2026-10-14T00:00:00Z' } },
      dns: { byDomain: { 'two.example': { status: 'failed' } } },
    })
    assert.match(card(), /3 verified domains reported/)
    assert.match(card(), /From the last successful Microsoft domain collection/)
    assert.doesNotMatch(card(), /verified of|2 verified domains/)

    await render({
      tenant: { domains: ['one.example', 'two.example'] },
      sync: { domains: { status: 'failed', lastSuccessfulAt: '2026-10-01T00:00:00Z' } },
    })
    assert.match(card(), /2 verified domains reported/)
    assert.match(card(), /From the last successful Microsoft domain collection/)

    await render({ tenant: {}, sync: { domains: { status: 'succeeded', lastSuccessfulAt: '2026-10-14T00:00:00Z' } } })
    assert.match(card(), /Not reported/)
  } finally {
    await React.act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
