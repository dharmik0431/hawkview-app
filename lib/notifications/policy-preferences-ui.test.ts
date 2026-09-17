import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as dispositions from '../alerts/dispositions.ts'
import * as dispositionReader from '../alerts/read-dispositions.ts'
import * as settingsView from '../alerts/settings-view.ts'
import * as scopedRequests from './scoped-request-guard.ts'

const require = createRequire(import.meta.url)
const React = require('react')
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const ts = require('typescript')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const policy = (organizationId: string, title: string, disposition = 'ACT_NOW') => ({
  organizationId,
  canManagePolicy: true,
  unrecognisedKeys: [],
  capabilities: {
    version: 1,
    readState: 'AVAILABLE',
    policyWriterRole: 'MSP_OWNER',
    supportedDigestModes: ['off'],
    channels: {
      inApp: { supported: true, availability: 'AVAILABLE' },
      email: { supported: true, availability: 'DISABLED', reason: 'SENDER_OFF' },
    },
  },
  dispositions: [
    {
      alertTypeId: 'security.suspected_credential_attack',
      title,
      category: 'Security',
      catalogueSeverity: 'ACT_NOW',
      disposition,
      mapped: true,
      capability: {
        intakeWiring: 'MAPPED',
        producerSupport: 'PROVEN',
        observedInput: 'NO_OPEN_FINDING',
        editable: true,
        reason: 'READY',
      },
    },
  ],
})

const policySession = {
  user: {
    id: 'user-1',
    memberships: [
      { status: 'ACTIVE', organization: { id: 'org-a', name: 'Alpha', status: 'ACTIVE' } },
      { status: 'ACTIVE', organization: { id: 'org-b', name: 'Beta', status: 'ACTIVE' } },
    ],
  },
}

test('policy page fences A-B-A reads and prevents refresh during an in-flight save', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://hawkview.invalid/settings/alerts' })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  let query = 'organizationId=org-a'
  let activeSession: typeof policySession | null = policySession
  const gets: Record<string, ReturnType<typeof deferred<unknown>>[]> = { 'org-a': [], 'org-b': [] }
  const patches: ReturnType<typeof deferred<unknown>>[] = []
  const patchScopes: string[] = []
  const apiClient = {
    get: (_path: string, options: { params: { organizationId: string } }) => {
      const pending = deferred<unknown>()
      gets[options.params.organizationId].push(pending)
      return pending.promise
    },
    patch: (_path: string, _body: unknown, options: { params: { organizationId: string } }) => {
      const pending = deferred<unknown>()
      patches.push(pending)
      patchScopes.push(options.params.organizationId)
      return pending.promise
    },
  }
  const exports: Record<string, unknown> = {}
  const compiled = ts.transpileModule(readFileSync(new URL('../../app/(protected)/settings/alerts/page.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const simple = (tag: string) => {
    function SimpleComponent({ children, ...props }: Record<string, unknown>) {
      return React.createElement(tag, props, children)
    }
    SimpleComponent.displayName = `Test${tag}`
    return SimpleComponent
  }
  const icon = () => React.createElement('span')
  const localRequire = (name: string) => {
    if (name === 'next/navigation') return { useRouter: () => ({ replace: () => undefined }), useSearchParams: () => new URLSearchParams(query) }
    if (name === 'lucide-react') return { AlertTriangle: icon, BellRing: icon, Loader2: icon, RefreshCcw: icon, Shield: icon }
    if (name === '@/components/providers/auth-provider') return { useAuth: () => ({ session: activeSession, isLoading: false }) }
    if (name === '@/components/ui/button') return { Button: ({ variant: _v, size: _s, ...props }: Record<string, unknown>) => React.createElement('button', props) }
    if (name === '@/components/ui/card') return { Card: simple('section'), CardContent: simple('div'), CardDescription: simple('p'), CardHeader: simple('header'), CardTitle: simple('h2') }
    if (name === '@/components/alerts/disposition-row') {
      return {
        DispositionRow: ({ row, save, onChoose }: { row: dispositions.AlertDispositionRow; save: { kind: string }; onChoose: (row: dispositions.AlertDispositionRow, next: dispositions.AlertDisposition) => void }) =>
          React.createElement('div', null,
            React.createElement('span', { 'data-testid': 'policy-title' }, `${row.title}:${row.disposition}:${save.kind}`),
            React.createElement('button', { onClick: () => onChoose(row, row.disposition === 'ACT_TODAY' ? 'ACT_NOW' : 'ACT_TODAY') }, 'Change urgency')
          ),
      }
    }
    if (name === '@/lib/api/client') return { apiClient }
    if (name === '@/lib/alerts/dispositions') return dispositions
    if (name === '@/lib/alerts/read-dispositions') return dispositionReader
    if (name === '@/lib/alerts/settings-view') return settingsView
    if (name === '@/lib/notifications/scoped-request-guard') return scopedRequests
    return require(name)
  }
  new Function('require', 'exports', compiled)(localRequire, exports)
  const Page = (exports as { default: React.ComponentType }).default
  const Host = ({ queryValue }: { queryValue: string }) => {
    query = queryValue
    return React.createElement(Page)
  }
  const root = createRoot(dom.window.document.getElementById('root'))
  try {
    await React.act(async () => root.render(React.createElement(Host, { queryValue: query })))
    query = 'organizationId=org-b'
    await React.act(async () => root.render(React.createElement(Host, { queryValue: query })))
    await React.act(async () => gets['org-b'][0].resolve(policy('org-b', 'B current')))
    query = 'organizationId=org-a'
    await React.act(async () => root.render(React.createElement(Host, { queryValue: query })))
    await React.act(async () => gets['org-a'][1].resolve(policy('org-a', 'A current')))
    await React.act(async () => gets['org-a'][0].resolve(policy('org-a', 'A stale')))
    assert.match(dom.window.document.body.textContent ?? '', /A current/)
    assert.doesNotMatch(dom.window.document.body.textContent ?? '', /A stale/)

    const buttons = Array.from(
      dom.window.document.querySelectorAll('button')
    ) as HTMLButtonElement[]
    const choose = buttons.find(
      (button) => button.textContent === 'Change urgency'
    ) as HTMLButtonElement
    await React.act(async () => choose.click())
    assert.equal(patches.length, 1)
    assert.deepEqual(patchScopes, ['org-a'])
    const retry = buttons.find(
      (button) => button.textContent?.includes('Retry')
    ) as HTMLButtonElement
    assert.equal(retry.disabled, true)
    retry.click()
    assert.equal(gets['org-a'].length, 2, 'disabled refresh must not start a conflicting GET')
    await React.act(async () => patches[0].resolve(policy('org-a', 'A saved', 'ACT_TODAY')))
    assert.match(dom.window.document.body.textContent ?? '', /A saved:ACT_TODAY:SAVED/)

    const secondChoose = (Array.from(
      dom.window.document.querySelectorAll('button')
    ) as HTMLButtonElement[]).find(
      (button) => button.textContent === 'Change urgency'
    )!
    await React.act(async () => secondChoose.click())
    assert.equal(patches.length, 2)
    query = 'organizationId=org-b'
    await React.act(async () => root.render(React.createElement(Host, { queryValue: query })))
    assert.equal(gets['org-b'].length, 2)
    await React.act(async () => gets['org-b'][1].resolve(policy('org-b', 'B after error')))
    await React.act(async () => patches[1].reject(new Error('stale raw policy error')))
    assert.match(dom.window.document.body.textContent ?? '', /B after error/)
    assert.doesNotMatch(dom.window.document.body.textContent ?? '', /could not verify the saved/i)

    const returnedChoose = (Array.from(
      dom.window.document.querySelectorAll('button')
    ) as HTMLButtonElement[]).find(
      (button) => button.textContent === 'Change urgency'
    )!
    await React.act(async () => returnedChoose.click())
    assert.equal(patches.length, 3)
    activeSession = null
    await React.act(async () => root.render(React.createElement(Host, { queryValue: query })))
    assert.match(dom.window.document.body.textContent ?? '', /Workspace unavailable/)
    activeSession = policySession
    await React.act(async () => root.render(React.createElement(Host, { queryValue: query })))
    assert.equal(gets['org-b'].length, 3)
    await React.act(async () => gets['org-b'][2].resolve(policy('org-b', 'B after return')))
    await React.act(async () => patches[2].resolve(policy('org-b', 'B stale save', 'ACT_TODAY')))
    assert.match(dom.window.document.body.textContent ?? '', /B after return/)
    assert.doesNotMatch(dom.window.document.body.textContent ?? '', /B stale save/)
  } finally {
    await React.act(async () => root.unmount())
    for (const [key, descriptor] of Array.from(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
