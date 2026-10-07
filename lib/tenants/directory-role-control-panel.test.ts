import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import test from 'node:test'
import { parseDirectoryRoleControl } from './directory-role-control-view.ts'

const nodeRequire = createRequire(import.meta.url)
const ts = nodeRequire('typescript')
const React = nodeRequire('react')
const { createRoot } = nodeRequire('react-dom/client')
const { JSDOM } = nodeRequire('jsdom')
const act = React.act ?? nodeRequire('react-dom/test-utils').act
const repoRoot = resolvePath(dirname(new URL(import.meta.url).pathname), '..', '..')

/** Compile and run real source, replacing only the named module boundaries. */
function makeLoader(mocks: Record<string, unknown>) {
  const cache = new Map<string, any>()
  const resolveFile = (base: string) => {
    for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
      try {
        readFileSync(candidate, 'utf8')
        return candidate
      } catch {
        continue
      }
    }
    throw new Error(`cannot resolve ${base}`)
  }
  const load = (basePath: string): any => {
    const file = resolveFile(basePath)
    if (cache.has(file)) return cache.get(file)
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
      fileName: file,
    })
    const moduleObject = { exports: {} as Record<string, any> }
    cache.set(file, moduleObject.exports)
    const shimRequire = (specifier: string) => {
      if (specifier in mocks) return mocks[specifier]
      if (specifier.startsWith('@/')) return load(resolvePath(repoRoot, specifier.slice(2)))
      if (specifier.startsWith('.')) return load(resolvePath(dirname(file), specifier))
      return nodeRequire(specifier)
    }
    new Function('require', 'exports', 'module', outputText)(shimRequire, moduleObject.exports, moduleObject)
    cache.set(file, moduleObject.exports)
    return moduleObject.exports
  }
  return load
}

class ApiError extends Error {
  status: number
  code: string | null
  constructor(status: number, message: string, code: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** The REAL classifier from the shipped hook module, so the panel's copy is driven by the same
 * status mapping the write path uses — not by a second one written for the test. */
const realHooks = makeLoader({
  '@tanstack/react-query': { useQuery: () => ({}), useMutation: () => ({}), useQueryClient: () => ({}) },
  '@/components/providers/auth-provider': { useAuth: () => ({ cacheScope: '', isLoading: false }) },
  './client': { ApiError, apiClient: {} },
})(resolvePath(repoRoot, 'lib/api/directory-role-control-hooks.ts'))

const FULL = {
  configurationRevision: '2f2d9a3c-0000-4000-8000-000000000001',
  connectionIncarnation: '2f2d9a3c-0000-4000-8000-000000000002',
  scopeIncarnation: '2f2d9a3c-0000-4000-8000-000000000003',
  scopeVersion: 'directory-role-assignments/v1',
}
const NO_CONTEXT = {
  configurationRevision: null, connectionIncarnation: null, scopeIncarnation: null, scopeVersion: null,
}

/** Control fixtures come from the REAL parser, so a shape the parser refuses cannot be rendered. */
function control(enabled: boolean, expected: Record<string, unknown> = FULL) {
  const parsed = parseDirectoryRoleControl({ enabled, expected })
  assert.ok(parsed, 'fixture must parse')
  return parsed
}

type ReadState = { data?: unknown; isPending?: boolean; isError?: boolean; error?: unknown }
type WriteState = { isPending?: boolean; isError?: boolean; error?: unknown }

function renderControl(options: {
  read: ReadState
  write?: WriteState
  roles?: string[]
  customerTenantId?: string
}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>',
    { url: 'https://hawkview.invalid', pretendToBeVisual: true })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  const mutations: Array<{ tenantId: string; enabled: boolean }> = []
  const askedRead: string[] = []
  const askedWrite: string[] = []
  let current = options.read
  const writeState = options.write ?? {}
  const tenantId = options.customerTenantId ?? 'tenant-A'

  const load = makeLoader({
    '@/lib/api/directory-role-control-hooks': {
      classifyControlFailure: realHooks.classifyControlFailure,
      useDirectoryRoleControl: (id: string) => {
        askedRead.push(id)
        return {
          data: current.data, isPending: current.isPending ?? false,
          isError: current.isError ?? false, error: current.error,
        }
      },
      useSetDirectoryRoleControl: (id: string) => {
        askedWrite.push(id)
        return {
          mutate: (input: { enabled: boolean }) => { mutations.push({ tenantId: id, enabled: input.enabled }) },
          isPending: writeState.isPending ?? false,
          isError: writeState.isError ?? false,
          error: writeState.error,
        }
      },
    },
    '@/components/providers/auth-provider': {
      useAuth: () => ({
        session: { user: { memberships: (options.roles ?? ['MSP_OWNER']).map((role) => ({ role })) } },
      }),
    },
  })
  const { DirectoryRoleControl } = load(resolvePath(repoRoot, 'components/tenant/directory-role-control.tsx'))
  const container = dom.window.document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  const render = (id: string) =>
    act(() => { root.render(React.createElement(DirectoryRoleControl, { customerTenantId: id })) })
  render(tenantId)

  return {
    text: () => container.textContent ?? '',
    buttons: () => Array.from(container.querySelectorAll('button')) as any[],
    click: (node: any) =>
      act(() => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) }),
    mutations,
    askedRead,
    askedWrite,
    /** Switch the screen to another tenant, as route navigation does. */
    switchTenant: (id: string, next: ReadState) => { current = next; render(id) },
    cleanup: () => {
      act(() => root.unmount())
      for (const [key, descriptor] of Array.from(previous.entries())) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete (globalThis as any)[key]
      }
      dom.window.close()
    },
  }
}

test('an off tenant with a current context offers exactly one explicit enable action', () => {
  const ui = renderControl({ read: { data: control(false) } })
  try {
    const buttons = ui.buttons()
    assert.equal(buttons.length, 1, 'one action, not an on/off pair that invites a blind toggle')
    assert.match(buttons[0].textContent ?? '', /switch on/i)
    assert.match(ui.text(), /switched off for this tenant/i)
    assert.equal(ui.mutations.length, 0, 'nothing is written without an explicit click')
    ui.click(buttons[0])
    assert.deepEqual(ui.mutations, [{ tenantId: 'tenant-A', enabled: true }])
  } finally { ui.cleanup() }
})

test('the mounted panel states that enabling does not collect anything', () => {
  const ui = renderControl({ read: { data: control(false) } })
  try {
    assert.match(ui.text(), /does not collect anything now/i)
    assert.doesNotMatch(ui.text(), /effective privilege/i)
  } finally { ui.cleanup() }
})

test('disable stays clickable when opt-in is on but the context is gone', () => {
  const ui = renderControl({ read: { data: control(true, NO_CONTEXT) } })
  try {
    const buttons = ui.buttons()
    assert.equal(buttons.length, 1)
    assert.match(buttons[0].textContent ?? '', /switch off/i)
    assert.equal(buttons[0].disabled, false, 'withdrawing consent must not need a usable connection')
    ui.click(buttons[0])
    assert.deepEqual(ui.mutations, [{ tenantId: 'tenant-A', enabled: false }])
  } finally { ui.cleanup() }
})

test('an off tenant without a current context offers no action and says why', () => {
  const ui = renderControl({ read: { data: control(false, NO_CONTEXT) } })
  try {
    assert.equal(ui.buttons().length, 0)
    assert.match(ui.text(), /no current connection or configuration/i)
  } finally { ui.cleanup() }
})

test('a conflicted write says nothing was changed and offers no automatic retry', () => {
  const ui = renderControl({
    read: { data: control(false) },
    write: { isError: true, error: new ApiError(409, 'changed', 'DIRECTORY_CONTROL_STALE') },
  })
  try {
    assert.match(ui.text(), /nothing was changed/i)
    assert.match(ui.text(), /choose again/i)
    assert.equal(ui.mutations.length, 0, 'the failed action is never re-sent by the panel itself')
  } finally { ui.cleanup() }
})

test('a pending write blocks a second submission of the same action', () => {
  const ui = renderControl({ read: { data: control(false) }, write: { isPending: true } })
  try {
    const button = ui.buttons()[0]
    assert.equal(button.disabled, true)
    ui.click(button)
    assert.equal(ui.mutations.length, 0)
  } finally { ui.cleanup() }
})

test('a forbidden read reports the role limit and offers no action', () => {
  const ui = renderControl({ read: { isError: true, error: new ApiError(403, 'no') } })
  try {
    assert.match(ui.text(), /role cannot change/i)
    assert.equal(ui.buttons().length, 0)
  } finally { ui.cleanup() }
})

test('an unavailable read never renders as switched off', () => {
  const ui = renderControl({ read: { isError: true, error: new ApiError(409, 'gone') } })
  try {
    assert.match(ui.text(), /cannot read this collection setting/i)
    assert.doesNotMatch(ui.text(), /switched off for this tenant/i)
    assert.equal(ui.buttons().length, 0)
  } finally { ui.cleanup() }
})

test('a technician sees no control at all', () => {
  const ui = renderControl({ read: { data: control(true) }, roles: ['MSP_TECHNICIAN'] })
  try {
    assert.equal(ui.text(), '')
    assert.equal(ui.buttons().length, 0)
  } finally { ui.cleanup() }
})

test('switching tenants re-asks for the new tenant and acts only on it', () => {
  const ui = renderControl({ read: { data: control(true) } })
  try {
    ui.switchTenant('tenant-B', { data: control(false) })
    assert.equal(ui.askedRead.at(-1), 'tenant-B')
    assert.equal(ui.askedWrite.at(-1), 'tenant-B')
    const button = ui.buttons()[0]
    assert.match(button.textContent ?? '', /switch on/i, 'the new tenant’s own state is shown')
    ui.click(button)
    assert.deepEqual(ui.mutations, [{ tenantId: 'tenant-B', enabled: true }],
      'the action is bound to the tenant on screen, never the previous one')
  } finally { ui.cleanup() }
})
