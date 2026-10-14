import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const React = require('react')
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const h = React.createElement
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const groupSource = resolve(repoRoot, 'app/(protected)/tenants/[id]/components/sections/groups-section.tsx')
const freshnessSource = resolve(repoRoot, 'components/tenant/data-freshness-details.tsx')
const groupsClock = '2026-10-14T07:00:00.000Z'

function loadModules() {
  const component = (tag: string) => ({ children, ...props }: any) => h(tag, props, children)
  const mocks: Record<string, unknown> = {
    '@/components/ui/card': { Card: component('section'), CardContent: component('div') },
    '@/components/ui/badge': { Badge: component('span') },
    '@/components/ui/input': { Input: component('input') },
    '@/components/ui/button': { Button: component('button') },
    '@/app/(protected)/activity/data/normalize': {
      hasIncompleteActivityEvidence: () => false,
      normalizeSignInEvent: (value: unknown) => value,
      normalizeAuditEvent: (value: unknown) => value,
    },
    '@/lib/tenants/sharepoint-view-model': { buildSharePointViewModel: () => ({}) },
    '@/lib/tenants/dataset-cadence': { datasetCadence: () => ({ label: 'Not reported' }) },
    '@/lib/tenants/collection-readiness': { readinessLabel: String, readinessDiagnostic: String },
  }
  const cache = new Map<string, any>()
  const load = (base: string): any => {
    let file = ''
    let source = ''
    for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
      try { source = readFileSync(candidate, 'utf8'); file = candidate; break } catch { continue }
    }
    assert.ok(file, `Cannot resolve ${base}`)
    if (cache.has(file)) return cache.get(file)
    const moduleObject = { exports: {} as any }
    cache.set(file, moduleObject.exports)
    const output = ts.transpileModule(source, { fileName: file, compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText
    const localRequire = (specifier: string) => {
      if (specifier in mocks) return mocks[specifier]
      const local = specifier.startsWith('@/') ? resolve(repoRoot, specifier.slice(2))
        : specifier.startsWith('.') ? resolve(dirname(file), specifier) : null
      return local ? load(local) : require(specifier)
    }
    new Function('require', 'exports', 'module', output)(localRequire, moduleObject.exports, moduleObject)
    cache.set(file, moduleObject.exports)
    return moduleObject.exports
  }
  return { GroupsSection: load(groupSource).default, DataFreshnessDetails: load(freshnessSource).DataFreshnessDetails }
}

function bundle(groups: unknown, status = 'succeeded', success: string | null = groupsClock, exchangeGroups: unknown[] = []) {
  return {
    tenant: { id: 'synthetic', name: 'Synthetic' },
    ...(groups === undefined ? {} : { entra: { groups } }),
    exchange: { groups: exchangeGroups },
    sync: { groups: { status, lastSuccessfulAt: success,
      outcomeProjection: { recordedOutcome: { kind: status === 'failed' ? 'FAILED' : 'SUCCEEDED' } } } },
    signIns: [], auditLogs: [], licenses: { rows: [] },
  }
}

const security = { id: 'security-id', displayName: 'Stored security group', type: 'Security', owners: null }
const dynamic = { id: 'dynamic-id', displayName: 'Stored dynamic group', type: 'Dynamic security', owners: null }

async function mounted(data: any, check: (section: HTMLElement, document: Document, dom: any) => Promise<void> | void, includeFreshness = false) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://fixture.invalid' })
  const globals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const { GroupsSection, DataFreshnessDetails } = loadModules()
  const root = createRoot(dom.window.document.getElementById('root'))
  try {
    await React.act(async () => root.render(h(React.Fragment, null,
      h('main', { id: 'groups-under-test' }, h(GroupsSection, { bundle: data })),
      includeFreshness ? h('aside', { id: 'freshness-under-test' }, h(DataFreshnessDetails, { bundle: data })) : null,
    )))
    const section = dom.window.document.getElementById('groups-under-test') as HTMLElement
    await check(section, dom.window.document, dom)
  } finally {
    await React.act(async () => root.unmount())
    for (const [key, descriptor] of Array.from(globals.entries())) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

function tile(section: HTMLElement, label: string) {
  const heading = Array.from(section.querySelectorAll('div')).find((node) =>
    node.childElementCount === 0 && node.textContent?.trim() === label)
  assert.ok(heading, `${label} tile exists`)
  return heading.parentElement?.textContent?.trim() ?? ''
}

test('canonical stored groups with successful collection populate total and non-total tiles', async () => {
  await mounted(bundle([security, dynamic]), (section) => {
    assert.match(tile(section, 'Stored groups'), /2$/)
    assert.match(tile(section, 'Security'), /2$/)
    assert.match(tile(section, 'Dynamic'), /1$/)
    assert.match(section.textContent ?? '', /Stored security group/)
    assert.match(section.textContent ?? '', /Stored dynamic group/)
  })
})

test('successful empty canonical inventory is verified without a fabricated tenant population', async () => {
  await mounted(bundle([]), (section) => {
    assert.match(tile(section, 'Stored groups'), /0$/)
    assert.match(tile(section, 'Dynamic'), /0$/)
    assert.match(section.textContent ?? '', /The recorded snapshot contains no records/)
    assert.match(section.textContent ?? '', /No group rows were stored in the last successful inventory/)
  })
})

for (const exchangeGroups of [[{ id: 'exchange-id', name: 'Exchange-only subset', type: 'Distribution list' }], []]) {
  test(`missing canonical inventory does not borrow Exchange ${exchangeGroups.length ? 'nonempty' : 'empty'} subset or its verified-empty claim`, async () => {
    await mounted(bundle(undefined, 'succeeded', groupsClock, exchangeGroups), (section, document) => {
      assert.match(tile(section, 'Stored groups'), /—$/)
      assert.match(tile(section, 'Distribution'), /—$/)
      assert.doesNotMatch(section.textContent ?? '', /Exchange-only subset|The recorded snapshot contains no records/)
      assert.match(section.textContent ?? '', /Directory group inventory unavailable in this response/)
      const groupArticle = Array.from(document.querySelectorAll('#freshness-under-test article'))
        .find((item) => item.querySelector('h3')?.textContent === 'Groups')
      assert.ok(groupArticle, 'the real freshness panel includes Groups')
      assert.equal(groupArticle.querySelector('time')?.getAttribute('datetime'), groupsClock,
        'the true GROUPS clock remains visible without a canonical inventory')
    }, true)
  })
}

test('historical canonical rows without a success clock stay visible but out of all inventory tiles', async () => {
  await mounted(bundle([security], 'failed', null), (section, document, dom) => {
    assert.match(tile(section, 'Stored groups'), /—$/)
    assert.match(tile(section, 'Security'), /—$/)
    assert.match(section.textContent ?? '', /Stored group rows are available, but no successful collection is recorded/)
    assert.match(section.textContent ?? '', /Stored security group/)
    const typeFilter = section.querySelector('select') as HTMLSelectElement
    assert.ok(typeFilter)
    React.act(() => {
      typeFilter.value = 'Distribution list'
      typeFilter.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    assert.match(section.textContent ?? '', /No stored groups match the current search or filter criteria/)
  })
})

test('a successful empty result followed by FAILED remains last reported, not awaiting collection', async () => {
  await mounted(bundle([], 'failed', groupsClock), (section) => {
    assert.match(tile(section, 'Stored groups'), /0$/)
    assert.match(tile(section, 'Security'), /0$/)
    assert.match(section.textContent ?? '', /The recorded snapshot contains no records/)
    assert.match(section.textContent ?? '', /Last reported stored group inventory · latest refresh failed/)
    assert.doesNotMatch(section.textContent ?? '', /awaiting collection|synchronization is required/i)
  })
})
