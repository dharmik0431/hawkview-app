import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { datasetAge, applicationsAge, servicePrincipalsAge, groupsAge, licensesAge, conditionalAccessAge, dnsAge, selectedDnsRecord, entraOverviewAge, licenseActivityAge, sharePointAge, sharePointReportAge, datasetReportDate, signInsAge, activityLogsAge, exchangeAge } from './dataset-age.ts'

const now = Date.parse('2026-09-29T18:00:00Z')
const at = (minutes: number) => new Date(now - minutes * 60000).toISOString()
const evidence = (minutes: number) => ({ source: 'Test inventory', observedAt: at(minutes) })
for (const [minutes, label, outdated] of [[5, 'Updated 5 minutes ago', false], [10, 'Updated 10 minutes ago', false], [359, 'Updated 5 hours ago', false], [360, 'Updated 6 hours ago', true], [1440, 'Updated 1 day ago', true]] as const) {
  test(`age boundary: ${minutes} minutes`, () => assert.deepEqual(datasetAge(evidence(minutes), now), { label, outdated, timestamp: at(minutes) }))
}
test('unavailable clocks cannot become current or outdated', () => {
  for (const observedAt of [null, undefined, '', 'invalid', '2026-09-29', '2026-09-29T12:00:00', 123, at(-1)]) {
    assert.deepEqual(datasetAge({ source: 'Test', observedAt }, now), { label: 'Update time unavailable', outdated: false, timestamp: null })
  }
  assert.equal(datasetAge(evidence(5), NaN).timestamp, null)
})
test('dataset clocks ignore unrelated newer successes and worker statuses', () => {
  for (const status of ['running', 'failed', 'pending', 'success']) {
    const bundle = { sync: {
      applications: { lastSuccessfulAt: at(360), status }, servicePrincipals: { lastSuccessfulAt: at(10), status },
      groups: { lastSuccessfulAt: at(5), status }, users: { lastSuccessfulAt: at(0) },
    }, syncFreshness: { services: { entraId: { status: 'STALE', lastSuccessfulCollectionAt: at(0) } } } }
    assert.equal(datasetAge(applicationsAge(bundle), now).outdated, true)
    assert.equal(datasetAge(servicePrincipalsAge(bundle), now).label, 'Updated 10 minutes ago')
    assert.equal(datasetAge(groupsAge(bundle), now).label, 'Updated 5 minutes ago')
  }
  assert.equal(datasetAge(applicationsAge({ sync: { users: { lastSuccessfulAt: at(0) } } }), now).timestamp, null)
})
test('license props must match the dated bundle inventory', () => {
  const rows: unknown[] = [], bundle = { licenses: { rows }, sync: { licenses: { status: 'succeeded', lastSuccessfulAt: at(5) } } }
  assert.equal(licensesAge(bundle, rows).emptyVerified, true)
  assert.equal(datasetAge(licensesAge(bundle, rows), now).timestamp, at(5))
  assert.equal(datasetAge(licensesAge(bundle, []), now).timestamp, null)
})
test('Conditional Access uses the selected evidence observation', () => {
  assert.equal(datasetAge(conditionalAccessAge({ conditionalAccess: { availability: 'READY', observedAt: at(360) }, observedAt: at(5) }), now).outdated, true)
  assert.equal(datasetAge(conditionalAccessAge({ conditionalAccess: { availability: 'UNVERIFIED' }, observedAt: at(5) }), now).timestamp, null)
})
test('DNS switches both records and clock with domain; absent selection cannot borrow root', () => {
  const a = { domain: 'a.example', checkedAt: at(5) }, b = { domain: 'b.example', checkedAt: at(360) }
  const dns = { ...a, byDomain: { 'a.example': a, 'b.example': b } }
  assert.equal(selectedDnsRecord(dns, 'B.EXAMPLE'), b)
  assert.equal(datasetAge(dnsAge(dns, 'b.example'), now).outdated, true)
  assert.equal(selectedDnsRecord(dns, 'missing.example'), null)
  assert.equal(datasetAge(dnsAge(dns, 'missing.example'), now).timestamp, null)
  assert.equal(selectedDnsRecord(a, 'A.EXAMPLE'), a)
})
test('composite/report/event contract gaps stay unavailable', () => {
  for (const adapter of [entraOverviewAge, licenseActivityAge, sharePointAge]) assert.equal(datasetAge(adapter(), now).timestamp, null)
})

const require = createRequire(import.meta.url)
const React = require('react')
const { JSDOM } = require('jsdom')
const { createRoot } = require('react-dom/client')
const { renderToStaticMarkup } = require('react-dom/server')
const ts = require('typescript')
const base = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const cache = new Map<string, any>()
function load(path: string): any {
  if (cache.has(path)) return cache.get(path)
  const exports: any = {}; cache.set(path, exports)
  const js = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  new Function('require', 'exports', js)((name: string) => {
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name)
    const target = name.startsWith('@/') ? resolve(base, name.slice(2)) : resolve(dirname(path), name)
    return load([target, target + '.tsx', target + '.ts'].find(p => existsSync(p))!)
  }, exports)
  return exports
}
const { SectionFreshness } = load(resolve(base, 'components/tenant/section-freshness.tsx'))
test('server render has a stable unknown clock', () => {
  const html = renderToStaticMarkup(React.createElement(SectionFreshness, { evidence: evidence(5) }))
  assert.match(html, /Update time unavailable/)
  assert.doesNotMatch(html, /Syncing|Collection failing|returned nothing|emerald/)
})
test('mounted age ticks, changes dataset, preserves unavailable vs empty, and cleans up', async () => {
  const dom = new JSDOM('<div id="root"></div>')
  const saved = new Map(['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT', 'setInterval', 'clearInterval'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const oldNow = Date.now; let clock = now, tick: (() => void) | null = null, cleared = false
  Date.now = () => clock
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    setInterval: (fn: () => void, ms: number) => { assert.equal(ms, 60000); tick = fn; return 91 },
    clearInterval: (id: number) => { assert.equal(id, 91); cleared = true },
  })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const root = createRoot(dom.window.document.getElementById('root'))
  const render = async (value: any) => React.act(async () => root.render(React.createElement(SectionFreshness, { evidence: value, isEmpty: true })))
  const text = () => dom.window.document.body.textContent
  try {
    await render({ ...evidence(359), emptyVerified: true })
    assert.match(text(), /Updated 5 hours ago/); assert.doesNotMatch(text(), /Outdated/)
    assert.match(text(), /snapshot contains no records/)
    clock += 60000; await React.act(async () => tick!())
    assert.match(text(), /Updated 6 hours ago.*Outdated/)
    await render({ source: 'Other tenant', observedAt: new Date(clock - 5 * 60000).toISOString(), emptyVerified: false })
    assert.match(text(), /Updated 5 minutes ago/); assert.match(text(), /has not been verified/)
    assert.doesNotMatch(text(), /Outdated|Syncing|failed|collector/i)
    await render({ source: 'Dated report', observedAt: '2026-09-29', reportDate: '2026-09-29' })
    assert.match(text(), /Report dated Sep 29, 2026/); assert.match(text(), /Update time unavailable/)
    await render({ source: 'Missing report', observedAt: null, emptyVerified: true })
    assert.match(text(), /Update time unavailable/); assert.match(text(), /has not been verified/)
  } finally {
    await React.act(async () => root.unmount()); Date.now = oldNow
    for (const [key, descriptor] of Array.from(saved)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key)
    dom.window.close()
  }
  assert.equal(cleared, true)
})

test('report date is canonical observation, never download time or newest legacy row', () => {
  assert.equal(datasetAge(sharePointReportAge({ contractPresent: true, usageReport: { reportRefreshedAt: at(1440) }, sync: { lastSuccessAt: at(5) } }), now).outdated, true)
  assert.equal(datasetAge(sharePointReportAge({ contractPresent: false, usageReport: { reportRefreshedAt: at(5) } }), now).timestamp, null)
})

test('a successful clock without an actual array cannot verify an empty result', () => {
  const bundle = { sync: { applications: { status: 'success', lastSuccessfulAt: at(5) } } }
  assert.equal(applicationsAge(bundle).emptyVerified, false)
  assert.equal(applicationsAge({ ...bundle, entra: { applications: [] } }).emptyVerified, true)
})

test('date-only report keeps known calendar date without inventing hour precision', () => {
  const evidence = sharePointReportAge({ contractPresent: true, usageReport: { reportRefreshedAt: '2026-09-29' } })
  assert.equal(datasetAge(evidence, now).timestamp, null)
  assert.equal(datasetReportDate(evidence, now), 'Report dated Sep 29, 2026')
  for (const reportDate of ['2026-09-30', '2026-02-30', 'invalid', null, at(5)]) assert.equal(datasetReportDate({ source: 'Report', observedAt: null, reportDate }, now), null)
})
test('active tenant page cannot show aggregate collector freshness beside dataset age', () => {
  const page = readFileSync(resolve(base, 'app/(protected)/tenants/[id]/page.tsx'), 'utf8')
  assert.doesNotMatch(page, /serviceFreshnessDescription|serviceFreshnessText|lastSuccessfulCollectionAt/)
})

test('selected sign-in fallback clock cannot borrow a newer Graph success', () => {
  const selected = { selectedSource: 'OFFICE_365_ACTIVITY_FEED', availability: 'CURRENT_LIMITED', observedAt: at(360), graphSuccessAt: at(5) }
  assert.equal(datasetAge(signInsAge(selected), now).outdated, true)
  assert.equal(datasetAge(signInsAge({ ...selected, observedAt: null }), now).timestamp, null)
  assert.equal(datasetAge(signInsAge({ observedAt: at(5) }), now).timestamp, null)
  assert.equal(datasetAge(signInsAge({ selectedSource: 'MICROSOFT_GRAPH', observedAt: at(5) }), now).label, 'Updated 5 minutes ago')
})
test('Exchange composite and undated activity sign-ins stay unavailable; audit uses own clock', () => {
  const bundle = { auditLogs: [], sync: { auditLogs: { status: 'succeeded', lastSuccessfulAt: at(360) }, signIns: { lastSuccessfulAt: at(5) } } }
  assert.equal(datasetAge(exchangeAge(), now).timestamp, null)
  assert.equal(datasetAge(activityLogsAge(bundle, 'signins'), now).timestamp, null)
  assert.equal(datasetAge(activityLogsAge(bundle, 'audit'), now).outdated, true)
})

test('secondary Exchange and fallback notices cannot promise current collection', () => {
  const exchange = readFileSync(resolve(base, 'app/(protected)/tenants/[id]/components/sections/exchange-section.tsx'), 'utf8')
  const signins = readFileSync(resolve(base, 'app/(protected)/tenants/[id]/components/sections/signins-section.tsx'), 'utf8')
  const activity = readFileSync(resolve(base, 'app/(protected)/activity/page.tsx'), 'utf8')
  assert.doesNotMatch(exchange, /Current dataset|Exchange data is synchronized|DatasetStatus\.label\}/)
  assert.doesNotMatch(signins, /using current login evidence|freshnessLabel|['"]Syncing['"]/)
  assert.doesNotMatch(activity, /Sync in progress|HawkView is collecting|Stale log evidence/)
})

test('invalid original calendar components never normalize into plausible ages', () => {
  for (const observedAt of ['2026-02-30T12:00:00Z', '2026-04-31T12:00:00Z', '2026-02-29T12:00:00+05:30', '1900-02-29T12:00:00Z', '2100-02-29T12:00:00Z', '2024-02-30T12:00:00-05:00', '2026-01-00T12:00:00Z', '2026-13-01T12:00:00Z', '2026-01-01T24:00:00Z']) {
    assert.equal(datasetAge({ source: 'Calendar test', observedAt }, Date.parse('2101-01-01T00:00:00Z')).timestamp, null, observedAt)
  }
})
test('leap days and valid offsets preserve their actual instants across date boundaries', () => {
  for (const [observedAt, timestamp] of [
    ['2024-02-29T18:30:00-05:30', '2024-03-01T00:00:00.000Z'],
    ['2000-02-29T23:00:00-01:00', '2000-03-01T00:00:00.000Z'],
    ['2026-01-01T00:30:00+01:00', '2025-12-31T23:30:00.000Z'],
    ['2026-03-01T00:30:00+14:00', '2026-02-28T10:30:00.000Z'],
  ]) {
    const result = datasetAge({ source: 'Offset test', observedAt }, Date.parse(timestamp) + 6 * 3600000)
    assert.equal(result.timestamp, timestamp)
    assert.equal(result.label, 'Updated 6 hours ago')
    assert.equal(result.outdated, true)
  }
})
test('license age belongs only to the inventory region and security evidence stays independent', () => {
  const Licenses = load(resolve(base, 'app/(protected)/tenants/[id]/components/sections/licenses-section.tsx')).default
  for (const [availability, enabled, caption] of [['UNVERIFIED', null, 'Security defaults evidence unavailable'], ['READY', true, 'Reported security defaults setting']] as const) {
    const rows: unknown[] = []
    const dom = new JSDOM(renderToStaticMarkup(React.createElement(Licenses, { licenseRows: rows, bundle: { licenses: { rows }, sync: { licenses: { status: 'succeeded', lastSuccessfulAt: at(360) } } }, securityDefaultsEvidence: { availability, enabled } })))
    const region = dom.window.document.querySelector('[role="region"][aria-labelledby="license-inventory-heading"]')
    assert.ok(region)
    assert.match(region.textContent, /License Inventory.*Update time unavailable/)
    region.remove()
    assert.doesNotMatch(dom.window.document.body.textContent, /Update time unavailable|Updated .* ago/)
    assert.match(dom.window.document.body.textContent, new RegExp(caption))
    assert.doesNotMatch(dom.window.document.body.textContent, /Synchronized security defaults setting/)
    dom.window.close()
  }
})
