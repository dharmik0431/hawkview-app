import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import test from 'node:test'
import { parsePimPlaneSummary } from './pim-schedule-summary-view.ts'

const nodeRequire = createRequire(import.meta.url)
const ts = nodeRequire('typescript')
const React = nodeRequire('react')
const { createRoot } = nodeRequire('react-dom/client')
const { JSDOM } = nodeRequire('jsdom')
const act = React.act ?? nodeRequire('react-dom/test-utils').act
const repoRoot = resolvePath(dirname(new URL(import.meta.url).pathname), '..', '..')

const ATTEMPT_ID = 'attempt-SENTINEL-8f21'
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

function observationPayload(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: ATTEMPT_ID,
    scopeVersion: SCOPE_VERSION,
    committedAt: '2026-10-04T11:22:33.000Z',
    contentChangedAt: '2026-10-02T08:00:00.000Z',
    contentDigest: CONTENT_DIGEST,
    observedRecordCount: 4,
    ageMs: 172_800_000,
    traversalOutcome: 'EXHAUSTED',
    assurance: 'UNKNOWN',
    coverage: 'NOT_ESTABLISHED',
    ...overrides,
  }
}

/** Views are produced by the real parser from real-shaped API payloads. */
function view(plane: string, status: string, observation: Record<string, unknown> | null) {
  const parsed = parsePimPlaneSummary(plane as any, {
    responseVersion: 'pim-schedule-summary/v1',
    plane,
    status,
    lastCommitted: observation,
  })
  assert.ok(parsed, `fixture for ${plane}/${status} must parse`)
  return parsed
}

type PlaneState = { data?: unknown; isPending?: boolean; isError?: boolean; isFetching?: boolean }

/** Renders the real panel with the real Button, icons and class helper; only the query hook is doubled. */
function renderPanel(states: Record<string, PlaneState>, customerTenantId = 'tenant-A') {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://hawkview.invalid' })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const refetches: string[] = []
  const asked: Array<{ customerTenantId: string; plane: string }> = []
  const load = makeLoader({
    '@/lib/api/pim-schedule-summary-hooks': {
      usePimScheduleSummary: (tenantId: string, plane: string) => {
        asked.push({ customerTenantId: tenantId, plane })
        const state = states[plane] ?? { isPending: true }
        return {
          data: state.data,
          isPending: state.isPending ?? false,
          isError: state.isError ?? false,
          isFetching: state.isFetching ?? false,
          refetch: () => { refetches.push(plane); return Promise.resolve() },
        }
      },
    },
  })
  const { PimScheduleObservationsPanel } = load(resolvePath(repoRoot, 'components/tenant/pim-schedule-observations-panel.tsx'))
  const container = dom.window.document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  act(() => {
    root.render(React.createElement(PimScheduleObservationsPanel, { customerTenantId }))
  })
  const cardFor = (label: string) => {
    const heading = Array.from(container.querySelectorAll('p')).find((node: any) => node.textContent === label)
    assert.ok(heading, `card "${label}" must be rendered`)
    return (heading as any).parentElement as HTMLElement
  }
  const buttons = () => Array.from(container.querySelectorAll('button')) as any[]
  const click = (node: any) => act(() => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  const cleanup = () => {
    act(() => root.unmount())
    for (const [key, descriptor] of Array.from(previous.entries())) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as any)[key]
    }
    dom.window.close()
  }
  return { container, text: () => container.textContent ?? '', cardFor, buttons, click, refetches, asked, cleanup }
}

const ACTIVE_LABEL = 'Active assignments'
const ELIGIBLE_LABEL = 'Eligible assignments'

test('both planes are requested for the route tenant and shown independently', () => {
  const panel = renderPanel({ ACTIVE: { isPending: true }, ELIGIBLE: { isPending: true } }, 'tenant-route-id')
  try {
    assert.deepEqual(panel.asked, [
      { customerTenantId: 'tenant-route-id', plane: 'ACTIVE' },
      { customerTenantId: 'tenant-route-id', plane: 'ELIGIBLE' },
    ])
    assert.match(panel.cardFor(ACTIVE_LABEL).textContent ?? '', /Loading observations/)
    assert.match(panel.cardFor(ELIGIBLE_LABEL).textContent ?? '', /Loading observations/)
  } finally {
    panel.cleanup()
  }
})

test('never-collected reads as plain copy with no zero count', () => {
  const panel = renderPanel({
    ACTIVE: { data: view('ACTIVE', 'never-collected', null) },
    ELIGIBLE: { isPending: true },
  })
  try {
    const card = panel.cardFor(ACTIVE_LABEL).textContent ?? ''
    assert.match(card, /No PIM observations collected yet\./)
    assert.equal(/\d/.test(card.replace(ACTIVE_LABEL, '')), false, 'never-collected must show no number')
    assert.equal(card.includes('Coverage not yet verified'), false, 'nothing was observed, so there is no coverage claim')
  } finally {
    panel.cleanup()
  }
})

test('an observed collection with zero records is distinct from never-collected and keeps its stored time', () => {
  const panel = renderPanel({
    ACTIVE: { data: view('ACTIVE', 'observed', observationPayload({ observedRecordCount: 0 })) },
    ELIGIBLE: { data: view('ELIGIBLE', 'never-collected', null) },
  })
  try {
    const observed = panel.cardFor(ACTIVE_LABEL).textContent ?? ''
    const never = panel.cardFor(ELIGIBLE_LABEL).textContent ?? ''
    assert.match(observed, /No schedule records were observed in this collection\./)
    assert.match(observed, /Collected /)
    assert.match(observed, /Coverage not yet verified\. This is what HawkView observed, not a confirmed complete list\./)
    assert.match(never, /No PIM observations collected yet\./)
    assert.notEqual(observed, never)
  } finally {
    panel.cleanup()
  }
})

test('observed records are reported as observed schedule records, never as people or privilege', () => {
  const panel = renderPanel({
    ACTIVE: { data: view('ACTIVE', 'observed', observationPayload({ observedRecordCount: 4 })) },
    ELIGIBLE: { data: view('ELIGIBLE', 'observed', observationPayload({ observedRecordCount: 1 })) },
  })
  try {
    assert.match(panel.cardFor(ACTIVE_LABEL).textContent ?? '', /4 schedule records observed\./)
    assert.match(panel.cardFor(ELIGIBLE_LABEL).textContent ?? '', /1 schedule record observed\./)
    // The counts themselves must never be described as people, administrators or privilege.
    for (const label of [ACTIVE_LABEL, ELIGIBLE_LABEL]) {
      const card = panel.cardFor(label).textContent ?? ''
      for (const forbidden of [/\badministrators?\b/i, /\busers?\b/i, /\bpeople\b/i, /privileg/i, /\bno access\b/i, /\ball\b/i, /\btotal\b/i]) {
        assert.equal(forbidden.test(card), false, `${label} must not say ${String(forbidden)}`)
      }
      assert.match(card, /Coverage not yet verified\./)
    }
    // The denial is stated once, in the panel's own introduction.
    assert.match(panel.text(), /observed schedule records, not people or confirmed administrator access/)
  } finally {
    panel.cleanup()
  }
})

test('a failed latest attempt shows the older observation as older, aged from the stored age not the clock', () => {
  // Deliberately inconsistent fixture: the stored timestamp is long past while the stored age is
  // small. Only an implementation reading ageMs can produce the minutes label.
  const panel = renderPanel({
    ACTIVE: {
      data: view('ACTIVE', 'last-attempt-failed', observationPayload({
        committedAt: '2024-03-01T09:00:00.000Z',
        contentChangedAt: '2024-02-28T09:00:00.000Z',
        observedRecordCount: 9,
        ageMs: 300_000,
      })),
    },
    ELIGIBLE: { data: view('ELIGIBLE', 'last-attempt-failed', null) },
  })
  try {
    const withOlder = panel.cardFor(ACTIVE_LABEL).textContent ?? ''
    assert.match(withOlder, /The most recent collection attempt did not finish\./)
    assert.match(withOlder, /Showing the previous successful collection/)
    assert.match(withOlder, /9 schedule records observed\./)
    assert.match(withOlder, /2024/, 'the older observation keeps its actual stored date')
    assert.match(withOlder, /5 minutes old/, 'the age comes from the stored observation, not from now')
    assert.equal(/refreshed|just now|up to date/i.test(withOlder), false, 'older data must never read as newly refreshed')

    const withoutOlder = panel.cardFor(ELIGIBLE_LABEL).textContent ?? ''
    assert.match(withoutOlder, /The most recent collection attempt did not finish\./)
    assert.match(withoutOlder, /No earlier successful collection is available to show\./)
    assert.equal(withoutOlder.includes('Showing the previous successful collection'), false)
  } finally {
    panel.cleanup()
  }
})

test('one plane failing leaves the other intact and leaks no raw failure detail', () => {
  const panel = renderPanel({
    ACTIVE: { isError: true },
    ELIGIBLE: { data: view('ELIGIBLE', 'observed', observationPayload({ observedRecordCount: 2 })) },
  })
  try {
    const failed = panel.cardFor(ACTIVE_LABEL).textContent ?? ''
    const ok = panel.cardFor(ELIGIBLE_LABEL).textContent ?? ''
    assert.match(failed, /These observations are unavailable right now\./)
    assert.match(ok, /2 schedule records observed\./)
    const all = panel.text()
    for (const forbidden of [RAW_FAILURE, '500', 'Error:', 'fetch', 'graph.microsoft.com', ATTEMPT_ID, SCOPE_VERSION, CONTENT_DIGEST]) {
      assert.equal(all.includes(forbidden), false, `rendered copy must not contain ${forbidden}`)
    }
  } finally {
    panel.cleanup()
  }
})

test('the only action is a per-plane re-read of the summary; there is no collection or setup control', () => {
  const panel = renderPanel({
    ACTIVE: { isError: true },
    ELIGIBLE: { data: view('ELIGIBLE', 'observed', observationPayload()) },
  })
  try {
    const labels = panel.buttons().map((node) => (node.textContent ?? '').trim())
    assert.deepEqual(labels, ['Try again'], 'exactly one control, on the failing plane only')
    for (const label of labels) {
      assert.equal(/collect|set ?up|enable|connect|configure|start|grant|consent/i.test(label), false, label)
    }
    panel.click(panel.buttons()[0])
    assert.deepEqual(panel.refetches, ['ACTIVE'], 'the retry re-reads only the failing plane')
  } finally {
    panel.cleanup()
  }
})

test('a retry already in flight disables the control instead of stacking requests', () => {
  const panel = renderPanel({ ACTIVE: { isError: true, isFetching: true }, ELIGIBLE: { isPending: true } })
  try {
    const button = panel.buttons()[0]
    assert.equal(button.disabled, true)
    panel.click(button)
    assert.deepEqual(panel.refetches, [], 'a disabled control issues no request')
  } finally {
    panel.cleanup()
  }
})

test('no internal identifier reaches the rendered page in any state', () => {
  const states = [
    { ACTIVE: { data: view('ACTIVE', 'observed', observationPayload()) }, ELIGIBLE: { data: view('ELIGIBLE', 'observed', observationPayload({ observedRecordCount: 0 })) } },
    { ACTIVE: { data: view('ACTIVE', 'last-attempt-failed', observationPayload()) }, ELIGIBLE: { data: view('ELIGIBLE', 'never-collected', null) } },
    { ACTIVE: { isError: true }, ELIGIBLE: { isPending: true } },
  ]
  assert.equal(states.length, 3)
  for (const state of states) {
    const panel = renderPanel(state as Record<string, PlaneState>)
    try {
      const html = panel.container.innerHTML
      for (const sentinel of [ATTEMPT_ID, SCOPE_VERSION, CONTENT_DIGEST, 'EXHAUSTED', 'NOT_ESTABLISHED', 'UNKNOWN']) {
        assert.equal(html.includes(sentinel), false, `${sentinel} must not reach the markup`)
      }
    } finally {
      panel.cleanup()
    }
  }
})

/** A failed read must outrank data the cache retained from an earlier success. react-query keeps the
 *  previous `data` on the query while reporting an error (proved against the real QueryClient in the
 *  hook suite), so a panel that renders `data` whenever it exists would present a stale observation
 *  as the current one, next to copy saying the observations are unavailable. */
test('a failed read suppresses the retained observation for that plane and leaves the other plane alone', () => {
  const retained = view('ACTIVE', 'observed', observationPayload({ observedRecordCount: 7 }))
  for (const label of ['forbidden', 'unavailable', 'unsupported response']) {
    const panel = renderPanel({
      // data retained from the earlier success, error on the refetch
      ACTIVE: { data: retained, isError: true },
      ELIGIBLE: { data: view('ELIGIBLE', 'observed', observationPayload({ observedRecordCount: 2 })) },
    })
    try {
      const failed = panel.cardFor(ACTIVE_LABEL).textContent ?? ''
      assert.match(failed, /These observations are unavailable right now\./, label)
      assert.equal(failed.includes('7 schedule records observed.'), false, `${label}: stale count must not render`)
      assert.equal(/Collected /.test(failed), false, `${label}: stale collection time must not render`)
      assert.equal(/Coverage not yet verified/.test(failed), false, `${label}: no coverage claim without an observation`)
      // The other plane keeps its own successful state.
      assert.match(panel.cardFor(ELIGIBLE_LABEL).textContent ?? '', /2 schedule records observed\./, label)
      // The read-only retry is still offered on the failing plane only.
      assert.deepEqual(panel.buttons().map((node) => (node.textContent ?? '').trim()), ['Try again'], label)
    } finally {
      panel.cleanup()
    }
  }
})

/** Not to be confused with the above: a SUCCESSFUL response whose collection status is
 *  last-attempt-failed is valid data and must still show its older committed observation. */
test('a successful last-attempt-failed response still shows the older observation with its own clocks', () => {
  const panel = renderPanel({
    ACTIVE: {
      data: view('ACTIVE', 'last-attempt-failed', observationPayload({
        committedAt: '2026-09-28T06:00:00.000Z',
        observedRecordCount: 9,
        ageMs: 600_000,
      })),
    },
    ELIGIBLE: { isPending: true },
  })
  try {
    const card = panel.cardFor(ACTIVE_LABEL).textContent ?? ''
    assert.match(card, /Showing the previous successful collection/)
    assert.match(card, /9 schedule records observed\./)
    assert.match(card, /10 minutes old/)
    assert.equal(card.includes('These observations are unavailable right now.'), false)
  } finally {
    panel.cleanup()
  }
})

test('with no selected tenant the panel renders nothing and asks for nothing', () => {
  const panel = renderPanel({ ACTIVE: { isPending: true } }, '')
  try {
    assert.equal(panel.container.innerHTML, '')
    assert.deepEqual(panel.asked, [], 'no query may be configured without a tenant')
  } finally {
    panel.cleanup()
  }
})

test('the panel is mounted in the live overview with the route tenant id from the page', () => {
  const section = readFileSync(resolvePath(repoRoot, 'app/(protected)/tenants/[id]/components/sections/entra-overview-section.tsx'), 'utf8')
  const page = readFileSync(resolvePath(repoRoot, 'app/(protected)/tenants/[id]/page.tsx'), 'utf8')
  assert.match(section, /import \{ PimScheduleObservationsPanel \} from '@\/components\/tenant\/pim-schedule-observations-panel'/)
  const mount = section.match(/<PimScheduleObservationsPanel[^>]*>/g) ?? []
  assert.equal(mount.length, 1, 'mounted exactly once')
  assert.match(mount[0], /customerTenantId=\{resolvedTenantId\}/)
  assert.match(section, /resolvedTenantId: string/)
  // The page passes the route-derived id, not a Microsoft tenant id or a bundle field.
  const mounts = page.match(/<EntraOverviewSection[\s\S]*?\/>/g) ?? []
  assert.equal(mounts.length, 1, 'the page mounts the overview section exactly once')
  assert.match(mounts[0], /resolvedTenantId=\{resolvedTenantId\}/)
  assert.match(page, /const resolvedTenantId = String\(tenantId \|\| ''\)/)
})
