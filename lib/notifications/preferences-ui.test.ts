import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as contract from './preferences-contract.ts'
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

const preferences = (
  organizationId: string,
  minimumSeverity: contract.NotificationSeverity
) => ({
  id: `prefs-${organizationId}`,
  organizationId,
  securityEnabled: true,
  connectionEnabled: true,
  synchronizationEnabled: true,
  accountEnabled: true,
  inAppEnabled: true,
  emailEnabled: false,
  minimumSeverity,
  digestMode: 'off',
  canManagePolicy: true,
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
})

const session = (subject: string) => ({
  user: {
    id: subject,
    memberships: [
      { status: 'ACTIVE', organization: { id: 'org-a', name: 'Alpha', status: 'ACTIVE' } },
      { status: 'ACTIVE', organization: { id: 'org-b', name: 'Beta', status: 'ACTIVE' } },
    ],
  },
})

test('profile preferences keep the current workspace through delayed reads and writes all severity values', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://hawkview.invalid/profile/notifications',
  })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    })
  }

  let activeSession: ReturnType<typeof session> | null = session('user-1')
  let query = 'organizationId=org-a'
  const gets: Record<string, ReturnType<typeof deferred<unknown>>[]> = {
    'org-a': [],
    'org-b': [],
  }
  const patches: Array<{
    body: Record<string, unknown>
    pending: ReturnType<typeof deferred<unknown>>
  }> = []
  const notices: Array<Record<string, unknown>> = []
  const apiClient = {
    get: (_path: string, options: { params: { organizationId: string } }) => {
      const pending = deferred<unknown>()
      gets[options.params.organizationId].push(pending)
      return pending.promise
    },
    patch: (_path: string, body: Record<string, unknown>) => {
      const pending = deferred<unknown>()
      patches.push({ body, pending })
      return pending.promise
    },
  }
  const exports: Record<string, unknown> = {}
  const compiled = ts.transpileModule(
    readFileSync(
      new URL('../../app/(protected)/profile/notifications/page.tsx', import.meta.url),
      'utf8'
    ),
    {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }
  ).outputText
  const icon = () => React.createElement('span')
  const localRequire = (name: string) => {
    if (name === 'next/navigation') {
      return {
        useRouter: () => ({ replace: () => undefined }),
        useSearchParams: () => new URLSearchParams(query),
      }
    }
    if (name === 'lucide-react') return { Bell: icon, Loader2: icon, Mail: icon }
    if (name === '@/components/providers/auth-provider') {
      return { useAuth: () => ({ session: activeSession, isLoading: false }) }
    }
    if (name === '@/components/providers/notification-provider') {
      return { useNotifications: () => ({ notify: (notice: Record<string, unknown>) => notices.push(notice) }) }
    }
    if (name === '@/components/ui/button') {
      return {
        Button: ({ variant: _variant, size: _size, ...props }: Record<string, unknown>) =>
          React.createElement('button', props),
      }
    }
    if (name === '@/lib/api/client') return { apiClient }
    if (name === '@/lib/notifications/preferences-contract') return contract
    if (name === '@/lib/notifications/scoped-request-guard') return scopedRequests
    return require(name)
  }
  new Function('require', 'exports', compiled)(localRequire, exports)
  const Page = (exports as { default: React.ComponentType }).default
  const root = createRoot(dom.window.document.getElementById('root'))

  try {
    await React.act(async () => root.render(React.createElement(Page)))
    assert.equal(gets['org-a'].length, 1)

    query = 'organizationId=org-b'
    await React.act(async () => root.render(React.createElement(Page)))
    assert.equal(gets['org-b'].length, 1)
    await React.act(async () => gets['org-b'][0].resolve(preferences('org-b', 'high')))
    const severity = dom.window.document.querySelector('#minimum-severity') as HTMLSelectElement
    assert.ok(severity)
    assert.deepEqual(
      Array.from(severity.options).map((option) => option.value),
      ['info', 'low', 'medium', 'high', 'critical']
    )
    assert.equal(severity.value, 'high')

    await React.act(async () => {
      severity.value = 'critical'
      severity.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    const buttons = Array.from(
      dom.window.document.querySelectorAll('button')
    ) as HTMLButtonElement[]
    const save = buttons.find(
      (button) => button.textContent === 'Save my preferences'
    )
    assert.ok(save)
    await React.act(async () => save.click())
    assert.deepEqual(patches[0].body, {
      organizationId: 'org-b',
      minimumSeverity: 'critical',
    })

    query = 'organizationId=org-a'
    await React.act(async () => root.render(React.createElement(Page)))
    assert.equal(gets['org-a'].length, 2)
    await React.act(async () => gets['org-a'][1].resolve(preferences('org-a', 'info')))
    await React.act(async () => gets['org-a'][0].resolve(preferences('org-a', 'low')))
    assert.equal(
      (dom.window.document.querySelector('#minimum-severity') as HTMLSelectElement).value,
      'info',
      'old org A data must not revive after an A to B to A round trip'
    )
    await React.act(async () => patches[0].pending.resolve(preferences('org-b', 'critical')))
    assert.equal(
      (dom.window.document.querySelector('#minimum-severity') as HTMLSelectElement).value,
      'info'
    )
    assert.deepEqual(notices, [], 'stale save completion must not post a toast')

    const currentSeverity = dom.window.document.querySelector('#minimum-severity') as HTMLSelectElement
    await React.act(async () => {
      currentSeverity.value = 'high'
      currentSeverity.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    const currentButtons = Array.from(
      dom.window.document.querySelectorAll('button')
    ) as HTMLButtonElement[]
    const currentSave = currentButtons.find(
      (button) => button.textContent === 'Save my preferences'
    ) as HTMLButtonElement
    await React.act(async () => currentSave.click())
    assert.equal(patches.length, 2)
    activeSession = null
    await React.act(async () => root.render(React.createElement(Page)))
    assert.match(dom.window.document.body.textContent ?? '', /Workspace unavailable/)

    activeSession = session('user-1')
    await React.act(async () => root.render(React.createElement(Page)))
    assert.equal(gets['org-a'].length, 3)
    await React.act(async () => gets['org-a'][2].resolve(preferences('org-a', 'medium')))
    await React.act(async () => patches[1].pending.resolve(preferences('org-a', 'high')))
    assert.equal(
      (dom.window.document.querySelector('#minimum-severity') as HTMLSelectElement).value,
      'medium',
      'a pre-logout save must not revive after the same user and workspace return'
    )
    assert.deepEqual(notices, [])

    const returnedSeverity = dom.window.document.querySelector('#minimum-severity') as HTMLSelectElement
    await React.act(async () => {
      returnedSeverity.value = 'critical'
      returnedSeverity.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    await React.act(async () => {
      const returnedSave = (Array.from(dom.window.document.querySelectorAll('button')) as HTMLButtonElement[]).find((button) => button.textContent === 'Save my preferences')!
      returnedSave.click()
    })
    query = 'organizationId=org-b'
    await React.act(async () => root.render(React.createElement(Page)))
    assert.equal(gets['org-b'].length, 2)
    await React.act(async () => gets['org-b'][1].resolve(preferences('org-b', 'low')))
    await React.act(async () => patches[2].pending.reject(new Error('stale raw save error')))
    assert.equal(
      (dom.window.document.querySelector('#minimum-severity') as HTMLSelectElement).value,
      'low'
    )
    assert.deepEqual(notices, [], 'stale save rejection must not post an error toast')
  } finally {
    await React.act(async () => root.unmount())
    for (const [key, descriptor] of Array.from(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
