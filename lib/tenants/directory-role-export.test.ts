import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import test, { before, after } from 'node:test'
const originalFetch = globalThis.fetch
// Nothing in an export may reach a network. A throwing fetch makes that a fact
// rather than an assumption.
before(() => { globalThis.fetch = async () => { throw new Error('External network forbidden') } })
after(() => { globalThis.fetch = originalFetch })
import {
  DIRECTORY_ROLE_EXPORT_FILENAME,
  DIRECTORY_ROLE_EXPORT_QUALIFICATION,
  DIRECTORY_ROLE_EXPORT_UNAVAILABLE,
  DIRECTORY_ROLE_EXPORT_VERSION,
  EXPORT_REFUSAL_COPY,
  EXPORT_REJECTION_COPY,
  EXPORT_TRANSPORT_COPY,
  emitDirectoryRoleExport,
  readDirectoryRoleExport,
  type DownloadHost,
} from './directory-role-export.ts'

const nodeRequire = createRequire(import.meta.url)
const ts = nodeRequire('typescript')
const React = nodeRequire('react')
const { createRoot } = nodeRequire('react-dom/client')
const { JSDOM } = nodeRequire('jsdom')
const act = React.act ?? nodeRequire('react-dom/test-utils').act
const repoRoot = resolvePath(dirname(new URL(import.meta.url).pathname), '..', '..')

const TENANT = 'tenant-A'
const RESPONSE_VERSION = 'directory-role-results/v1'
const SOURCE = 'Microsoft Graph v1.0 /roleManagement/directory/roleAssignments'
const ROW = {
  id: 'assignment-SENTINEL-1', principalId: 'principal-SENTINEL-1', roleDefinitionId: 'definition-1',
  roleDisplayName: 'Global Reader', directoryScopeId: '/', appScopeId: null,
}

const storedResults = (overrides: Record<string, unknown> = {}) => ({
  responseVersion: RESPONSE_VERSION,
  source: SOURCE,
  status: 'current',
  latestAttempt: { outcome: null, terminalAt: null },
  observation: {
    checkedAt: '2026-10-09T11:00:00.000Z', ageMs: 600_000, observedCount: 1,
    assignments: [ROW], verifiedCompleteEmpty: false,
  },
  ...overrides,
})

const envelope = (overrides: Record<string, unknown> = {}) => ({
  exportVersion: DIRECTORY_ROLE_EXPORT_VERSION,
  qualification: DIRECTORY_ROLE_EXPORT_QUALIFICATION,
  customerTenantId: TENANT,
  generatedAt: '2026-10-09T12:34:56.000Z',
  results: storedResults(),
  ...overrides,
})

/** Compile and run real source, replacing only the named module boundaries. */
function makeLoader(mocks: Record<string, unknown>) {
  const cache = new Map<string, any>()
  const resolveFile = (base: string) => {
    for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
      try { readFileSync(candidate, 'utf8'); return candidate } catch { continue }
    }
    throw new Error(`cannot resolve ${base}`)
  }
  const load = (basePath: string): any => {
    const file = resolveFile(basePath)
    if (cache.has(file)) return cache.get(file)
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
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

// ------------------------------------------------------------- envelope parser

test('a well formed envelope is accepted and carries the received payload verbatim', () => {
  const raw = envelope()
  const read = readDirectoryRoleExport(raw, { customerTenantId: TENANT })
  assert.equal(read.ok, true)
  if (!read.ok) return
  assert.equal(read.view.customerTenantId, TENANT)
  assert.equal(read.view.generatedAt.toISOString(), '2026-10-09T12:34:56.000Z')
  assert.equal(read.view.results.observation?.observedCount, 1)
  // The saved bytes are the payload as received, not a projection of the view.
  assert.deepEqual(JSON.parse(read.view.body), raw)
  assert.match(read.view.body, /derived-stored-directory-snapshot/)
  assert.match(read.view.body, /assignment-SENTINEL-1/)
})

test('a stale export is accepted and keeps the server’s own qualification', () => {
  const read = readDirectoryRoleExport(
    envelope({ results: storedResults({ status: 'stale' }) }), { customerTenantId: TENANT }
  )
  assert.equal(read.ok, true)
  if (read.ok) assert.equal(read.view.results.status, 'stale')
})

test('a verified-complete-empty export is a success, not an empty failure', () => {
  const read = readDirectoryRoleExport(envelope({
    results: storedResults({
      observation: {
        checkedAt: '2026-10-09T11:00:00.000Z', ageMs: 600_000, observedCount: 0,
        assignments: [], verifiedCompleteEmpty: true,
      },
    }),
  }), { customerTenantId: TENANT })
  assert.equal(read.ok, true)
  if (!read.ok) return
  assert.equal(read.view.results.observation?.verifiedCompleteEmpty, true)
  assert.equal(read.view.results.observation?.observedCount, 0)
})

test('anything the client cannot fully validate is rejected rather than saved in part', () => {
  const cases: [string, unknown, string][] = [
    ['not an object', 'export', 'ENVELOPE_UNREADABLE'],
    ['null', null, 'ENVELOPE_UNREADABLE'],
    ['an array', [envelope()], 'ENVELOPE_UNREADABLE'],
    ['a foreign export version', envelope({ exportVersion: 'directory-role-export/v2' }), 'VERSION_UNEXPECTED'],
    ['no export version', envelope({ exportVersion: undefined }), 'VERSION_UNEXPECTED'],
    ['a missing qualification', envelope({ qualification: undefined }), 'QUALIFICATION_UNEXPECTED'],
    ['a reworded qualification', envelope({ qualification: 'provider-original' }), 'QUALIFICATION_UNEXPECTED'],
    ['a blank tenant', envelope({ customerTenantId: '' }), 'ENVELOPE_UNREADABLE'],
    ['a numeric tenant', envelope({ customerTenantId: 7 }), 'ENVELOPE_UNREADABLE'],
    ['another tenant', envelope({ customerTenantId: 'tenant-B' }), 'TENANT_MISMATCH'],
    ['an unreadable generation time', envelope({ generatedAt: 'whenever' }), 'GENERATION_TIME_UNREADABLE'],
    ['a blank generation time', envelope({ generatedAt: '' }), 'GENERATION_TIME_UNREADABLE'],
    ['a numeric generation time', envelope({ generatedAt: 0 }), 'GENERATION_TIME_UNREADABLE'],
    ['absent results', envelope({ results: undefined }), 'RESULTS_UNREADABLE'],
    ['results of a foreign version', envelope({ results: storedResults({ responseVersion: 'v9' }) }), 'RESULTS_UNREADABLE'],
    ['results with no observation key', envelope({ results: { responseVersion: RESPONSE_VERSION, source: SOURCE, status: 'current', latestAttempt: { outcome: null, terminalAt: null } } }), 'RESULTS_UNREADABLE'],
  ]
  for (const [label, raw, rejection] of cases) {
    const read = readDirectoryRoleExport(raw, { customerTenantId: TENANT })
    assert.equal(read.ok, false, label)
    if (!read.ok) assert.equal(read.rejection, rejection, label)
  }
})

test('the tenant guard compares against the tenant actually asked about', () => {
  // The same payload is fine for its own tenant and refused for another, so the
  // check cannot be satisfied by the envelope agreeing with itself.
  const raw = envelope({ customerTenantId: 'tenant-B' })
  assert.equal(readDirectoryRoleExport(raw, { customerTenantId: 'tenant-B' }).ok, true)
  const wrong = readDirectoryRoleExport(raw, { customerTenantId: TENANT })
  assert.equal(wrong.ok, false)
  if (!wrong.ok) assert.equal(wrong.rejection, 'TENANT_MISMATCH')
})

test('every rejection has finite copy that says nothing was saved', () => {
  for (const [rejection, copy] of Object.entries(EXPORT_REJECTION_COPY)) {
    assert.match(copy, /nothing was saved/, rejection)
    assert.doesNotMatch(copy, /try again|retry|temporar/i, rejection)
  }
  assert.doesNotMatch(EXPORT_REFUSAL_COPY, /try again|retry/i)
  assert.match(EXPORT_TRANSPORT_COPY, /Nothing was saved/)
})

// ---------------------------------------------------------------- download

function recordingHost() {
  const created: { url: string; blob: Blob }[] = []
  const revoked: string[] = []
  const anchors: { href: string; download: string; clicked: number; removed: number }[] = []
  let sequence = 0
  const host: DownloadHost = {
    createObjectURL: (blob: Blob) => {
      const url = `blob:recorded/${++sequence}`
      created.push({ url, blob })
      return url
    },
    revokeObjectURL: (url: string) => { revoked.push(url) },
    anchor: () => {
      const element = { href: '', download: '', clicked: 0, removed: 0 }
      anchors.push(element)
      return {
        get href() { return element.href }, set href(value: string) { element.href = value },
        get download() { return element.download }, set download(value: string) { element.download = value },
        click: () => { element.clicked++ },
        remove: () => { element.removed++ },
      } as never
    },
  }
  return { host, created, revoked, anchors }
}

test('the download writes the exact bytes as JSON under the constant filename', async () => {
  const { host, created, revoked, anchors } = recordingHost()
  const body = JSON.stringify(envelope(), null, 2)
  emitDirectoryRoleExport(body, host)
  assert.equal(created.length, 1)
  assert.equal(created[0].blob.type, 'application/json')
  assert.equal(await created[0].blob.text(), body)
  assert.equal(anchors.length, 1)
  assert.equal(anchors[0].download, DIRECTORY_ROLE_EXPORT_FILENAME)
  assert.equal(anchors[0].href, created[0].url)
  assert.equal(anchors[0].clicked, 1, 'saved exactly once')
  assert.equal(anchors[0].removed, 1, 'the anchor does not accumulate in the document')
  assert.deepEqual(revoked, [created[0].url], 'the object URL is released')
})

test('the object URL is released even when the save itself throws', () => {
  const { host, created, revoked } = recordingHost()
  const exploding: DownloadHost = {
    ...host,
    anchor: () => ({ href: '', download: '', click: () => { throw new Error('save refused') }, remove: () => {} }),
  }
  assert.throws(() => emitDirectoryRoleExport('{}', exploding), /save refused/)
  // A leaked blob URL pins the whole payload in memory for the document's life.
  assert.equal(created.length, 1)
  assert.deepEqual(revoked, [created[0].url])
})

// ------------------------------------------------------------- mounted button

function renderButton() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://hawkview.invalid', pretendToBeVisual: true })
  const created: { url: string; blob: Blob }[] = []
  const revoked: string[] = []
  let sequence = 0
  // Sourced from the document's own window by browserDownloadHost, so no global
  // is mutated to make this observable.
  ;(dom.window as any).URL = {
    createObjectURL: (blob: Blob) => { const url = `blob:mounted/${++sequence}`; created.push({ url, blob }); return url },
    revokeObjectURL: (url: string) => { revoked.push(url) },
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  const pending: Pending[] = []
  const calls: { endpoint: string; options: any }[] = []
  let identityToken = 'identity-A'
  let signedIn = true
  let loading = false
  let tenant = TENANT

  const load = makeLoader({
    '@/components/providers/auth-provider': {
      useAuth: () => ({
        session: signedIn ? { user: { id: 'user-A' } } : null,
        isLoading: loading,
        currentIdentityToken: () => identityToken,
      }),
    },
    '@/lib/api/client': {
      apiClient: {
        get: (endpoint: string, options: any) => {
          calls.push({ endpoint, options })
          return new Promise((resolve, reject) => pending.push({ resolve, reject }))
        },
      },
    },
  })

  let root: any
  const release = () => {
    try { if (root) act(() => root.unmount()) } catch { /* releasing must not mask the real error */ }
    for (const [key, descriptor] of Array.from(previous.entries())) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as any)[key]
    }
    dom.window.close()
  }

  try {
    const { DirectoryRoleExportButton } = load(
      resolvePath(repoRoot, 'components/tenant/directory-role-export-button.tsx')
    )
    const target = dom.window.document.getElementById('root') as HTMLElement
    root = createRoot(target)
    const paint = () => act(() => {
      root.render(React.createElement(DirectoryRoleExportButton, { customerTenantId: tenant }))
    })
    paint()
    const container = target
    const control = () => Array.from(container.querySelectorAll('button'))
      .find(node => (node.textContent ?? '').includes('Download stored results')) as any
    return {
      container, calls, pending, created, revoked, release,
      text: () => container.textContent ?? '',
      control,
      disabled: () => Boolean(control()?.disabled),
      click: async () => {
        await act(async () => {
          control().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
      },
      settle: async (value: unknown) => { pending.shift()!.resolve(value); await act(async () => {}) },
      settleAt: async (index: number, value: unknown) => {
        pending.splice(index, 1)[0].resolve(value); await act(async () => {})
      },
      failNext: async (error: unknown) => { pending.shift()!.reject(error); await act(async () => {}) },
      switchIdentity: async (token: string) => { identityToken = token; await act(async () => { paint() }) },
      switchTenant: async (next: string) => { tenant = next; await act(async () => { paint() }) },
      signOut: async () => { signedIn = false; await act(async () => { paint() }) },
      setLoading: async (value: boolean) => { loading = value; await act(async () => { paint() }) },
      unmount: async () => { const current = root; root = null; await act(async () => { current.unmount() }) },
    }
  } catch (error) {
    release()
    throw error
  }
}

const refusal = () => Object.assign(new Error('refused'), { status: 409, code: DIRECTORY_ROLE_EXPORT_UNAVAILABLE })

test('mounted: nothing is requested until the control is explicitly clicked', async () => {
  const panel = await renderButton()
  try {
    assert.equal(panel.calls.length, 0, 'mounting must not download anything')
    assert.match(panel.text(), /not provider-original data/)
    assert.equal(panel.disabled(), false)
    await panel.click()
    assert.equal(panel.calls.length, 1)
    assert.equal(panel.calls[0].endpoint, `/tenants/${TENANT}/directory-roles/export`)
    assert.equal(panel.calls[0].options.cache, 'no-store')
    assert.ok(panel.calls[0].options.signal instanceof AbortSignal)
    assert.equal(panel.disabled(), true, 'disabled while the read is in flight')
  } finally { panel.release() }
})

test('mounted: a valid export is saved once, with the object URL released', async () => {
  const panel = await renderButton()
  try {
    await panel.click()
    await panel.settle(envelope())
    assert.equal(panel.created.length, 1, 'exactly one file')
    assert.equal(await panel.created[0].blob.text(), JSON.stringify(envelope(), null, 2))
    assert.deepEqual(panel.revoked, [panel.created[0].url])
    assert.match(panel.text(), /Saved the stored observation/)
    assert.equal(panel.disabled(), false, 'the control is usable again')
  } finally { panel.release() }
})

test('mounted: a server refusal is a finite message and no file', async () => {
  const panel = await renderButton()
  try {
    await panel.click()
    await panel.failNext(refusal())
    assert.equal(panel.created.length, 0, 'a refusal is never downloadable')
    assert.equal(panel.text().includes(EXPORT_REFUSAL_COPY), true)
    assert.doesNotMatch(panel.text(), /try again|retry/i)
  } finally { panel.release() }
})

test('mounted: a transport failure is distinguished from a refusal, and saves nothing', async () => {
  const panel = await renderButton()
  try {
    await panel.click()
    await panel.failNext(Object.assign(new Error('offline'), { status: 0, code: null }))
    assert.equal(panel.created.length, 0)
    assert.equal(panel.text().includes(EXPORT_TRANSPORT_COPY), true)
    assert.equal(panel.text().includes(EXPORT_REFUSAL_COPY), false)
  } finally { panel.release() }
})

test('mounted: an envelope the parser refuses produces a message and no file', async () => {
  for (const [raw, rejection] of [
    [envelope({ qualification: 'provider-original' }), 'QUALIFICATION_UNEXPECTED'],
    [envelope({ customerTenantId: 'tenant-B' }), 'TENANT_MISMATCH'],
    [envelope({ results: storedResults({ responseVersion: 'v9' }) }), 'RESULTS_UNREADABLE'],
    ['not-an-envelope', 'ENVELOPE_UNREADABLE'],
  ] as const) {
    const panel = await renderButton()
    try {
      await panel.click()
      await panel.settle(raw)
      assert.equal(panel.created.length, 0, rejection)
      assert.equal(panel.text().includes(EXPORT_REJECTION_COPY[rejection as never]), true, rejection)
    } finally { panel.release() }
  }
})

test('mounted: an account change while a read is pending cannot download the earlier reply', async () => {
  const panel = await renderButton()
  try {
    await panel.click()
    await panel.switchIdentity('identity-B')
    await panel.settle(envelope())
    assert.equal(panel.created.length, 0, 'the previous account’s export must not be saved')
    assert.doesNotMatch(panel.text(), /Saved the stored observation/)
  } finally { panel.release() }
})

test('mounted: A to B to A cannot download the first A reply', async () => {
  const panel = await renderButton()
  try {
    await panel.click()
    await panel.switchIdentity('identity-B')
    await panel.switchIdentity('identity-A')
    // The token matches again, so only the request generation distinguishes it.
    await panel.settle(envelope())
    assert.equal(panel.created.length, 0)
    // A fresh click still works, and that reply is saved.
    await panel.click()
    await panel.settle(envelope())
    assert.equal(panel.created.length, 1)
  } finally { panel.release() }
})

test('mounted: a tenant change while a read is pending cannot download the earlier tenant', async () => {
  const panel = await renderButton()
  try {
    await panel.click()
    await panel.switchTenant('tenant-B')
    await panel.settle(envelope())
    assert.equal(panel.created.length, 0, 'tenant A’s export must not be saved under tenant B')
    await panel.click()
    assert.equal(panel.calls[1].endpoint, '/tenants/tenant-B/directory-roles/export')
    await panel.settle(envelope({ customerTenantId: 'tenant-B' }))
    assert.equal(panel.created.length, 1)
  } finally { panel.release() }
})

test('mounted: a stale error after an account change does not overwrite the new state', async () => {
  const panel = await renderButton()
  try {
    await panel.click()
    await panel.switchIdentity('identity-B')
    await panel.failNext(refusal())
    assert.equal(panel.text().includes(EXPORT_REFUSAL_COPY), false, 'a stale error is discarded too')
    assert.equal(panel.created.length, 0)
  } finally { panel.release() }
})

test('mounted: unmounting with a read pending aborts it and saves nothing', async () => {
  const panel = await renderButton()
  try {
    await panel.click()
    assert.equal(panel.calls[0].options.signal.aborted, false)
    await panel.unmount()
    assert.equal(panel.calls[0].options.signal.aborted, true, 'unmount aborts the in-flight read')
    await panel.settle(envelope())
    assert.equal(panel.created.length, 0, 'a late reply after unmount saves nothing')
  } finally { panel.release() }
})

test('mounted: signing out or losing readiness disables the control and discards the reply', async () => {
  const panel = await renderButton()
  try {
    await panel.click()
    await panel.setLoading(true)
    assert.equal(panel.calls[0].options.signal.aborted, true, 'the pending read is aborted')
    assert.equal(panel.disabled(), true, 'not ready means not clickable')
    await panel.setLoading(false)
    await panel.settle(envelope())
    assert.equal(panel.created.length, 0, 'the pre-loss reply is discarded')

    await panel.signOut()
    assert.equal(panel.disabled(), true)
  } finally { panel.release() }
})

test('mounted: a second click supersedes the first read, and only one file is saved', async () => {
  const panel = await renderButton()
  try {
    await panel.click()
    await panel.settle(envelope())
    assert.equal(panel.created.length, 1)
    // The control is disabled during a read, so a second request can only be
    // issued once the first has settled; the superseded reply is still refused.
    await panel.click()
    assert.equal(panel.pending.length, 1)
    await panel.settle(envelope())
    assert.equal(panel.created.length, 2, 'each completed click saves its own file')
    assert.equal(panel.revoked.length, 2, 'every object URL is released')
  } finally { panel.release() }
})
