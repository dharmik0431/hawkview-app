import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { parseMailboxInvestigation } from './mailbox-investigation.ts'

const require = createRequire(import.meta.url)
const React = require('react')
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const ts = require('typescript')

test('mailbox UI waits for explicit click, announces progress/result, hides identity and safely handles errors', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://hawkview.invalid' })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  let calls = 0
  let resolve: (value: unknown) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  let signal: AbortSignal | undefined
  const exports: Record<string, any> = {}
  const source = readFileSync(new URL('../../components/identity-risk/mailbox-investigation.tsx', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const localRequire = (name: string) => {
    if (name === '@/components/ui/button') return { Button: ({ variant: _variant, size: _size, ...props }: any) => React.createElement('button', props) }
    if (name === 'next/link') return { default: ({ prefetch: _prefetch, ...props }: any) => React.createElement('a', props), __esModule: true }
    if (name === '@/lib/api/mailbox-investigation') return { parseMailboxInvestigation }
    if (name === '@/lib/api/client') return { apiClient: { get: (_path: string, options: { signal: AbortSignal }) => { calls++; signal = options.signal; return new Promise((yes, no) => { resolve = yes; reject = no }) } } }
    return require(name)
  }
  new Function('require', 'exports', compiled)(localRequire, exports)
  const root = createRoot(dom.window.document.getElementById('root'))
  const click = (text: string) => {
    const button = Array.from(dom.window.document.querySelectorAll('button')).find((item: any) => item.textContent === text) as HTMLButtonElement | undefined
    assert.ok(button)
    button.click()
  }
  try {
    await React.act(async () => root.render(React.createElement(exports.MailboxInvestigation, { tenantId: 'tenant-1', findingId: 'finding-1' })))
    assert.equal(calls, 0)
    await React.act(async () => click('Investigate affected mailbox'))
    assert.equal(calls, 1)
    assert.match(dom.window.document.body.textContent, /Checking current authorized inventory/)
    assert.equal(dom.window.document.querySelector('[aria-busy]')?.getAttribute('aria-busy'), 'true')
    await React.act(async () => resolve({ version: 1, status: 'AVAILABLE', mailbox: { id: 'mailbox-1', label: 'Approved mailbox', observedAt: new Date(Date.now() - 1000).toISOString(), inventoryPath: '/tenants/tenant-1/exchange' } }))
    assert.match(dom.window.document.body.textContent, /Approved mailbox/)
    assert.equal(dom.window.document.querySelector('a')?.getAttribute('href'), '/tenants/tenant-1/exchange')
    await React.act(async () => click('Hide mailbox details'))
    assert.doesNotMatch(dom.window.document.body.textContent, /Approved mailbox/)
    await React.act(async () => click('Investigate affected mailbox'))
    await React.act(async () => reject(new Error('raw SECRET provider failure')))
    assert.match(dom.window.document.querySelector('[role="alert"]')?.textContent ?? '', /could not be loaded/)
    assert.doesNotMatch(dom.window.document.body.textContent, /SECRET/)
    await React.act(async () => click('Investigate affected mailbox'))
    await React.act(async () => resolve({ version: 1, status: 'UNAVAILABLE', mailbox: null }))
    assert.match(dom.window.document.body.textContent, /unavailable or insufficient/)
    await React.act(async () => click('Investigate affected mailbox'))
    await React.act(async () => root.unmount())
    assert.equal(signal?.aborted, true)
  } finally {
    for (const [key, descriptor] of Array.from(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
