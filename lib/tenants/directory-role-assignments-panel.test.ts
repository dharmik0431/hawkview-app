import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import test from 'node:test'
import { parseDirectoryRoleResults } from './directory-role-results-view.ts'

const nodeRequire = createRequire(import.meta.url)
const ts = nodeRequire('typescript')
const React = nodeRequire('react')
const { createRoot } = nodeRequire('react-dom/client')
const { JSDOM } = nodeRequire('jsdom')
const act = React.act ?? nodeRequire('react-dom/test-utils').act
const repoRoot = resolvePath(dirname(new URL(import.meta.url).pathname), '..', '..')

const SCOPE_VERSION = 'scope-SENTINEL-v97'
const CONTENT_DIGEST = 'digest-SENTINEL-abc123'
const RAW_FAILURE = 'RAW-UPSTREAM-500-SENTINEL'

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


const RESPONSE_VERSION = 'directory-role-results/v1'
const SOURCE = 'Microsoft Graph v1.0 /roleManagement/directory/roleAssignments'
const ROW = {
  id: 'assignment-SENTINEL-1', principalId: 'principal-SENTINEL-1', roleDefinitionId: 'definition-1',
  roleDisplayName: 'Global Reader', directoryScopeId: '/', appScopeId: null,
}

/** Views come from the REAL parser, so a fixture the parser would refuse cannot be rendered. */
function view(status: string, observation: Record<string, unknown> | null, attempt: Record<string, unknown> = { outcome: null, terminalAt: null }) {
  const parsed = parseDirectoryRoleResults({
    responseVersion: RESPONSE_VERSION, source: SOURCE, status, observation, latestAttempt: attempt,
  })
  assert.ok(parsed, `fixture for ${status} must parse`)
  return parsed
}

const observed = (rows: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  checkedAt: '2026-10-07T05:00:00.000Z', ageMs: 600_000, observedCount: rows.length,
  assignments: rows, verifiedCompleteEmpty: rows.length === 0, ...extra,
})

type State = { data?: unknown; isPending?: boolean; isError?: boolean; isFetching?: boolean }

function renderPanel(state: State, customerTenantId = 'tenant-A') {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://hawkview.invalid' })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const refetches: string[] = []
  const asked: string[] = []
  const load = makeLoader({
    '@/lib/api/directory-role-results-hooks': {
      useDirectoryRoleResults: (tenantId: string) => {
        asked.push(tenantId)
        return {
          data: state.data, isPending: state.isPending ?? false, isError: state.isError ?? false,
          isFetching: state.isFetching ?? false,
          refetch: () => { refetches.push(tenantId); return Promise.resolve() },
        }
      },
    },
  })
  const { DirectoryRoleAssignmentsPanel } = load(resolvePath(repoRoot, 'components/tenant/directory-role-assignments-panel.tsx'))
  const container = dom.window.document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  act(() => { root.render(React.createElement(DirectoryRoleAssignmentsPanel, { customerTenantId })) })
  const cleanup = () => {
    act(() => root.unmount())
    for (const [key, descriptor] of Array.from(previous.entries())) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as any)[key]
    }
    dom.window.close()
  }
  return {
    container, text: () => container.textContent ?? '', refetches, asked, cleanup,
    buttons: () => Array.from(container.querySelectorAll('button')) as any[],
    click: (node: any) => act(() => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) }),
  }
}

test('an unactivated tenant says HawkView cannot vouch, and never shows a zero', () => {
  const panel = renderPanel({ data: view('not-activated', null) })
  try {
    const text = panel.text()
    assert.match(text, /not switched on for this tenant/)
    assert.match(text, /cannot vouch for any stored results/)
    // The named source string contains "v1.0", so a bare digit check would match the source line
    // rather than a count. Scope the check to the text that is not the source attribution.
    const claims = text.split(SOURCE).join(' ')
    assert.equal(/\b0\b|\bnone\b|No directory role assignments were found/i.test(claims), false,
      'an unactivated tenant must not read as an empty result')
  } finally { panel.cleanup() }
})

test('never-collected and verified-complete-empty are different sentences', () => {
  const never = renderPanel({ data: view('never-collected', null) })
  try {
    assert.match(never.text(), /No directory role results collected yet\./)
    assert.equal(never.text().includes('No directory role assignments were found'), false)
  } finally { never.cleanup() }

  const empty = renderPanel({ data: view('current', observed([])) })
  try {
    assert.match(empty.text(), /No directory role assignments were found in this tenant\./)
    assert.match(empty.text(), /Checked /)
  } finally { empty.cleanup() }
})

test('observed rows render identifiers, with an id as a valid name fallback', () => {
  const panel = renderPanel({ data: view('current', observed([ROW, { ...ROW, id: 'assignment-2', roleDisplayName: null }])) })
  try {
    const text = panel.text()
    assert.match(text, /Global Reader/)
    assert.match(text, /principal-SENTINEL-1/)
    assert.match(text, /assignment-SENTINEL-1/)
    assert.match(text, /definition-1/)
    // The rows themselves must claim nothing about privilege. The panel's introduction DENIES such
    // a claim, and a whole-panel search would match that denial rather than any assertion — so the
    // check is scoped to the table and the denial is asserted separately where it belongs.
    const table = panel.container.querySelector('table')?.textContent ?? ''
    assert.ok(table.includes('Global Reader'))
    for (const forbidden of [/effective privilege/i, /\badministrators?\b/i, /\bpeople\b/i, /has access/i]) {
      assert.equal(forbidden.test(table), false, String(forbidden))
    }
    assert.match(text, /not a statement about effective privilege/)
  } finally { panel.cleanup() }
})

test('superseded reports the connection change instead of showing stale rows as current', () => {
  const panel = renderPanel({ data: view('superseded', null) })
  try {
    assert.match(panel.text(), /connection changed after these results were stored/)
    assert.equal(panel.text().includes('assignment-SENTINEL-1'), false)
  } finally { panel.cleanup() }
})

test('a failed attempt is reported beside a kept result, never instead of it', () => {
  const panel = renderPanel({ data: view('current', observed([ROW]), { outcome: 'FAILED', terminalAt: '2026-10-07T05:30:00.000Z' }) })
  try {
    const text = panel.text()
    assert.match(text, /assignment-SENTINEL-1/)
    assert.match(text, /most recent collection attempt failed/)
    assert.equal(text.includes('No directory role assignments were found'), false)
  } finally { panel.cleanup() }
})

test('stale keeps its own stored clock and labels itself as the last completed collection', () => {
  const panel = renderPanel({ data: view('stale', observed([ROW], { ageMs: 7_200_000 })) })
  try {
    assert.match(panel.text(), /Showing the last completed collection/)
    assert.match(panel.text(), /2 hours old/)
  } finally { panel.cleanup() }
})

test('an unreadable answer is an error with a retry, not an empty result', () => {
  const panel = renderPanel({ isError: true })
  try {
    assert.match(panel.text(), /These results are unavailable right now\./)
    assert.equal(panel.text().includes('No directory role results collected yet'), false)
    assert.deepEqual(panel.buttons().map((b) => (b.textContent ?? '').trim()), ['Try again'])
    panel.click(panel.buttons()[0])
    assert.deepEqual(panel.refetches, ['tenant-A'])
  } finally { panel.cleanup() }
})

test('the panel asks for the tenant it was given, and renders nothing without one', () => {
  const withTenant = renderPanel({ isPending: true }, 'tenant-route-id')
  try {
    assert.deepEqual(withTenant.asked, ['tenant-route-id'])
    assert.match(withTenant.text(), /Loading stored results/)
  } finally { withTenant.cleanup() }

  const none = renderPanel({ isPending: true }, '')
  try {
    assert.equal(none.container.innerHTML, '')
  } finally { none.cleanup() }
})
