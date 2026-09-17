import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as organizationContext from '../auth/workspace-organization-context.ts'
import * as contract from './preferences-contract.ts'
import * as scopedRequests from './scoped-request-guard.ts'

const require = createRequire(import.meta.url)
const React = require('react')
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const ts = require('typescript')
const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const preferences = (organizationId: string, minimumSeverity: contract.NotificationSeverity) => ({
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

const makeSession = (subject: string) => ({
  user: {
    id: subject,
    memberships: [ORG_A, ORG_B].map((id, index) => ({
      role: 'MSP_OWNER',
      status: 'ACTIVE',
      organization: {
        id,
        name: index ? 'Beta' : 'Alpha',
        status: 'ACTIVE',
        businessDomain: index ? 'beta.test' : 'alpha.test',
        timeZone: 'UTC',
      },
    })),
  },
})

test('Team notification preferences fence A-B-A and logout-return request completions', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://hawkview.invalid/admin/notifications' })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  let activeSession: ReturnType<typeof makeSession> | null = makeSession('user-1')
  let query = `organizationId=${ORG_A}`
  const prefGets: Record<string, ReturnType<typeof deferred<unknown>>[]> = { [ORG_A]: [], [ORG_B]: [] }
  const patches: Array<{ body: Record<string, unknown>; pending: ReturnType<typeof deferred<unknown>> }> = []
  const workspace = (organizationId: string) => ({ organization: { id: organizationId, name: organizationId === ORG_A ? 'Alpha' : 'Beta' }, canManage: true, canEditOrganization: true, members: [] })
  const apiClient = {
    get: (path: string, options?: { params?: { organizationId?: string } }) => {
      const organizationId = options?.params?.organizationId ?? ORG_A
      if (path === '/api/notifications/preferences') {
        const pending = deferred<unknown>()
        prefGets[organizationId].push(pending)
        return pending.promise
      }
      if (path === '/api/workspace/members') return Promise.resolve(workspace(organizationId))
      if (path === '/api/workspace/audit-logs') return Promise.resolve({ items: [] })
      if (path === '/api/tenants') return Promise.resolve({ tenants: [] })
      return Promise.resolve({})
    },
    patch: (path: string, body: Record<string, unknown>) => {
      if (path === '/api/notifications/preferences') {
        const pending = deferred<unknown>()
        patches.push({ body, pending })
        return pending.promise
      }
      return Promise.resolve({})
    },
    post: () => Promise.resolve({}),
    delete: () => Promise.resolve({}),
  }
  const exports: Record<string, unknown> = {}
  const compiled = ts.transpileModule(readFileSync(new URL('../../app/(protected)/settings/team/page.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const simple = (tag: string) => {
    function SimpleComponent({ children, ...props }: Record<string, unknown>) {
      return React.createElement(tag, props, children)
    }
    SimpleComponent.displayName = `Test${tag}`
    return SimpleComponent
  }
  const localRequire = (name: string) => {
    if (name === 'next/link') return { default: simple('a'), __esModule: true }
    if (name === 'next/navigation') return { useRouter: () => ({ push: () => undefined, replace: () => undefined }), useSearchParams: () => new URLSearchParams(query) }
    if (name === '@/lib/admin-tabs') return { adminTabs: ['overview', 'users', 'workspace', 'security', 'notifications', 'audit'] }
    if (name === '@/lib/api/client') return { apiClient }
    if (name === '@/lib/auth/workspace-admin-errors') return { workspaceAdminErrorMessage: (_error: unknown, fallback: string) => fallback }
    if (name === '@/lib/auth/workspace-member-invitation') return { canResendInvitation: () => false }
    if (name === '@/components/providers/auth-provider') return { useAuth: () => ({ identityUser: activeSession ? { id: activeSession.user.id } : null, session: activeSession, isLoading: false }) }
    if (name === '@/components/admin/organization-profile-editor') return { OrganizationProfileEditor: () => null }
    if (name === '@/components/ui/button') return { Button: ({ variant: _v, size: _s, ...props }: Record<string, unknown>) => React.createElement('button', props) }
    if (name === '@/components/ui/input') return { Input: simple('input') }
    if (name === '@/components/ui/label') return { Label: simple('label') }
    if (name === '@/components/ui/checkbox') return { Checkbox: ({ checked, onCheckedChange, ...props }: { checked?: boolean; onCheckedChange?: (checked: boolean) => void } & Record<string, unknown>) => React.createElement('input', { ...props, type: 'checkbox', checked, onChange: (event: { target: { checked: boolean } }) => onCheckedChange?.(event.target.checked) }) }
    if (name === '@/components/tenants/tenant-status-badge') return { getTenantDisplayStatus: () => ({ label: 'Unknown', tone: 'neutral' }) }
    if (name === '@/lib/auth/workspace-onboarding') return { organizationProfileFromWorkspace: () => null, workspaceOnboardingState: () => ({ state: 'unavailable' }) }
    if (name === '@/lib/auth/workspace-organization-context') return organizationContext
    if (name === '@/lib/auth/workspace-onboarding-sync') return {
      PassiveWorkspaceRefreshLimiter: class { allow() { return false } },
      WorkspaceChangeSignalGuard: class { accept() { return null } },
      subscribeWorkspaceChanges: () => () => undefined,
    }
    if (name === '@/lib/workspace/audit-evidence') return { workspaceAuditActorLabel: () => '', workspaceAuditMetadataRows: () => [], workspaceAuditSafeIdentifier: () => '', workspaceAuditTargetLabel: () => '' }
    if (name === '@/lib/notifications/preferences-contract') return contract
    if (name === '@/lib/notifications/scoped-request-guard') return scopedRequests
    return require(name)
  }
  new Function('require', 'exports', compiled)(localRequire, exports)
  const Page = (exports as { AdminPanelPage: React.ComponentType<{ initialTab: string }> }).AdminPanelPage
  const root = createRoot(dom.window.document.getElementById('root'))
  const severity = () => dom.window.document.querySelector('#admin-minimum-severity') as HTMLSelectElement
  const save = () => (Array.from(dom.window.document.querySelectorAll('button')) as HTMLButtonElement[]).find((button) => button.textContent?.includes('Save'))!
  try {
    await React.act(async () => root.render(React.createElement(Page, { initialTab: 'notifications' })))
    query = `organizationId=${ORG_B}`
    await React.act(async () => root.render(React.createElement(Page, { initialTab: 'notifications' })))
    await React.act(async () => prefGets[ORG_B][0].resolve(preferences(ORG_B, 'high')))
    query = `organizationId=${ORG_A}`
    await React.act(async () => root.render(React.createElement(Page, { initialTab: 'notifications' })))
    await React.act(async () => prefGets[ORG_A][1].resolve(preferences(ORG_A, 'info')))
    await React.act(async () => prefGets[ORG_A][0].resolve(preferences(ORG_A, 'low')))
    assert.equal(severity().value, 'info')

    await React.act(async () => {
      severity().value = 'critical'
      severity().dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    await React.act(async () => save().click())
    assert.deepEqual(patches[0].body, { organizationId: ORG_A, minimumSeverity: 'critical' })
    activeSession = null
    await React.act(async () => root.render(React.createElement(Page, { initialTab: 'notifications' })))
    activeSession = makeSession('user-1')
    await React.act(async () => root.render(React.createElement(Page, { initialTab: 'notifications' })))
    await React.act(async () => prefGets[ORG_A][2].resolve(preferences(ORG_A, 'medium')))
    await React.act(async () => patches[0].pending.resolve(preferences(ORG_A, 'critical')))
    assert.equal(severity().value, 'medium')
    assert.doesNotMatch(dom.window.document.body.textContent ?? '', /saved successfully/i)

    await React.act(async () => {
      severity().value = 'high'
      severity().dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    await React.act(async () => save().click())
    query = `organizationId=${ORG_B}`
    await React.act(async () => root.render(React.createElement(Page, { initialTab: 'notifications' })))
    assert.equal(prefGets[ORG_B].length, 2)
    await React.act(async () => prefGets[ORG_B][1].resolve(preferences(ORG_B, 'low')))
    await React.act(async () => patches[1].pending.reject(new Error('stale raw team error')))
    assert.equal(severity().value, 'low')
    assert.doesNotMatch(dom.window.document.body.textContent ?? '', /could not be verified/i)
  } finally {
    await React.act(async () => root.unmount())
    for (const [key, descriptor] of Array.from(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
