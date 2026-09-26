// Run from backend/: node --import tsx --test ../scripts/what-changed-availability.test.mjs
// Actual service, queryFn, InfiniteQueryObserver, normalization, table and summary.
// Storage, HTTP transport and surrounding presentation components are isolated.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { ChangesService } from '../backend/src/changes/changes.service.ts'
import * as changeTypes from '../app/(protected)/what-changed/data/change-types.ts'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query'

const backendRequire = createRequire(new URL('../backend/package.json', import.meta.url))
const { transformSync } = backendRequire('esbuild')
const identity = { subject: 'synthetic-user' }
const range = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z', page: '1', pageSize: '250' }
const date = new Date('2026-08-01T12:00:00.000Z')
const audit = {
  id: 'raw-1', organizationId: 'org-1', microsoftAuditId: 'directory-1', activityDisplayName: 'Reset user password',
  category: 'UserManagement', eventDateTime: date, customerTenantId: 'tenant-1', operationType: 'Update',
  result: 'success', resultReason: null, initiatedBy: null, targetResources: [{ type: 'User', displayName: 'fixture@example.test' }],
  additionalDetails: null, raw: {}, correlationId: null,
}
const base = {
  eventDateTime: date, organizationId: 'org-1', customerTenantId: 'tenant-1', category: 'Exchange', severity: 'High',
  actorPrincipalName: 'fixture@example.test', actorDisplayName: null, actorId: null, targetId: 'fixture',
  targetDisplayName: 'fixture@example.test', ipAddress: null, location: null, beforeState: null, afterState: null,
  correlationId: null, changedFields: [], workload: 'Exchange', result: 'Succeeded',
}
const unified = { ...base, id: 'unified-1', source: 'M365_UNIFIED_AUDIT', sourceEventId: 'unified-1', operationName: 'Set-InboxRule', summary: 'Synthetic rule change', raw: { Operation: 'Set-InboxRule', Workload: 'Exchange' } }
const snapshot = { ...base, id: 'snapshot-1', source: 'SNAPSHOT_DIFFERENCE', sourceEventId: 'snapshot-1', eventDateTime: new Date(date.getTime() + 3600000), operationName: 'Exchange inbox rule changed', summary: 'Synthetic snapshot difference', actorPrincipalName: null, beforeState: { forwardTo: [] }, afterState: { forwardTo: ['fixture@example.test'] }, changedFields: ['forwardTo'], targetType: 'EXCHANGE_MAILBOX_RULES', raw: { evidenceOrigin: 'hawkview_snapshot_difference', microsoftSource: 'Microsoft Graph /users/{id}/mailFolders/inbox/messageRules' } }
const projectedDirectory = { ...base, id: 'projection-directory', source: 'DIRECTORY_AUDIT', sourceEventId: 'directory-1', operationName: 'Reset user password', category: 'Passwords', summary: 'Synthetic directory change', targetType: 'User', raw: { operationType: 'Update' } }
const empty = async () => []
const fail = async () => { throw new Error('private synthetic source diagnostic') }
function service(readAudit = empty, readEvidence = empty, extra = {}) {
  const scoped = (fn) => async (query) => {
    assert.deepEqual(query.where.organizationId.in, ['org-1'])
    assert.ok(query.where.customerTenantId.in.every((id) => id === 'tenant-1'))
    return fn(query)
  }
  const instance = new ChangesService({
    user: { findUnique: async () => ({ disabledAt: null, memberships: [{ organizationId: 'org-1' }] }) },
    customerTenant: { findMany: async () => [{ id: 'tenant-1', displayName: 'Fixture' }] },
    directoryAuditLog: { findMany: scoped(readAudit) }, changeEvidenceEvent: { findMany: scoped(readEvidence) }, ...extra,
  })
  instance.logger = { warn() {} }
  return instance
}

function uiHarness(transport) {
  let queryOptions
  let queryState = { isLoading: false }
  let summaryProps
  const Null = () => null
  const mocks = {
    react: React, 'react/jsx-runtime': createRequire(import.meta.url)('react/jsx-runtime'),
    '@/lib/utils': { cn: (...values) => values.filter((v) => typeof v === 'string').join(' ') },
    'next/navigation': { useSearchParams: () => new URLSearchParams() },
    'lucide-react': new Proxy({}, { get: () => Null }),
    '@tanstack/react-query': { useInfiniteQuery: (options) => { queryOptions = options; return queryState } },
    '@/lib/api/client': { apiClient: { get: async (url, options) => {
      assert.equal(url, '/api/changes')
      assert.equal(options.params.pageSize, '250')
      return transport(options.params)
    } } },
    './time-window-picker': { getQuickRangeDates: () => range, parseISOOrLocal: (value) => new Date(value) },
    './investigation-toolbar': { InvestigationToolbar: Null },
    './row': { WhatChangedRow: ({ e }) => React.createElement('div', { 'data-event': e.id }, e.title) },
    './drawer': { WhatChangedDrawer: Null }, '../data/change-types': changeTypes,
    '@/components/ui/button': { Button: ({ children }) => React.createElement('button', null, children) },
  }
  function load(relative) {
    const filename = new URL('../app/(protected)/what-changed/' + relative, import.meta.url)
    const code = transformSync(readFileSync(filename, 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code
    const module = { exports: {} }
    new Function('require', 'module', 'exports', code)((name) => {
      assert.ok(name in mocks, `Unexpected import ${name}`)
      return mocks[name]
    }, module, module.exports)
    return module.exports
  }
  mocks['../data/event-classifier'] = load('data/event-classifier.ts')
  const RealSummary = load('components/summary-strip.tsx').SummaryStrip
  mocks['./summary-strip'] = { SummaryStrip: (props) => { summaryProps = props; return React.createElement(RealSummary, props) } }
  const View = load('components/table.tsx').WhatChangedView
  const render = () => { summaryProps = undefined; return renderToStaticMarkup(React.createElement(View)) }
  render() // Capture the production table queryFn, pagination and retry options.
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } })
  const observer = new InfiniteQueryObserver(client, queryOptions)
  return {
    async first() { await observer.refetch(); return this.current() },
    async next() { await observer.fetchNextPage(); return this.current() },
    current() {
      queryState = observer.getCurrentResult()
      return { html: render(), summary: summaryProps, state: queryState }
    },
    close() { observer.destroy(); client.clear() },
  }
}
async function frontend(response) {
  const ui = uiHarness(async () => response)
  try { return await ui.first() } finally { ui.close() }
}
function assertIncomplete(ui) {
  assert.ok(!ui.html.includes('authoritative empty'))
  assert.ok(!ui.html.includes('Both source reads completed'))
  assert.equal(ui.summary?.incomplete, true)
  assert.ok(ui.html.includes('Upstream collection completeness has not been verified'))
  for (const count of Object.values(ui.summary.summary)) {
    assert.ok(ui.html.includes(count > 0 ? `${count.toLocaleString()} observed` : 'Unknown'))
  }
}

for (const [name, a, e] of [['directory rejects', fail, empty], ['projection rejects', empty, fail], ['both reject', fail, fail]]) {
  test(`source→query→table/summary: ${name} does not certify zero`, async () => {
    const result = await service(a, e).list(identity, range)
    assert.equal(result.summary.countStatus, 'unknown')
    assert.equal(JSON.stringify(result).includes('private synthetic'), false)
    const ui = await frontend(result)
    assertIncomplete(ui)
    assert.equal((ui.html.match(/>Unknown</g) ?? []).length, 4)
    assert.ok(ui.html.includes('unread remainder is unknown'))
    assert.ok(ui.html.includes('not a verified zero'))
  })
}
test('successful empty reads are limited to retained evidence and upstream completeness remains unknown', async () => {
  const result = await service().list(identity, range)
  assert.equal(result.collectionCompleteness, 'unknown')
  const ui = await frontend(result)
  assert.equal(ui.summary.incomplete, false)
  assert.ok(ui.html.includes('Both source reads completed with no matching retained evidence'))
  assert.ok(!ui.html.includes('authoritative empty'))
})
for (const [name, a, e, count] of [
  ['raw directory survives', async () => [audit], fail, 1],
  ['unified audit and snapshot survive', fail, async () => [unified, snapshot], 2],
  ['matching directory projection survives', fail, async () => [projectedDirectory], 1],
]) {
  test(`${name} without certifying the failed source`, async () => {
    const result = await service(a, e).list(identity, range)
    assert.equal(result.changes.length, count)
    assert.equal(result.summary.countStatus, 'observed_partial')
    const ui = await frontend(result)
    assertIncomplete(ui)
    assert.equal(ui.summary.summary.total, count)
    assert.equal((ui.html.match(/data-event=/g) ?? []).length, count)
  })
}
for (const source of ['directory', 'projection']) {
  const record = source === 'directory' ? audit : unified
  const page = Array.from({ length: 1000 }, (_, i) => ({ ...record, id: `row-${i}`, ...(source === 'directory' ? { microsoftAuditId: `event-${i}` } : { sourceEventId: `event-${i}` }) }))
  const makeService = (read) => service(source === 'directory' ? read : empty, source === 'projection' ? read : empty)
  test(`${source} later query rejection retains earlier rows with partial class coverage`, async () => {
    const result = await makeService(async (q) => q.cursor ? fail() : page).list(identity, range)
    const key = source === 'directory' ? 'directoryAudit' : 'normalizedEvidence'
    assert.equal(result.sourceAvailability[key].status, 'partial')
    assert.deepEqual(result.sourceAvailability[key].evidenceClasses, source === 'directory' ? ['DIRECTORY_AUDIT'] : ['DIRECTORY_AUDIT', 'M365_UNIFIED_AUDIT', 'SNAPSHOT_DIFFERENCE'])
    assert.equal(result.summary.total, 1000)
    assert.equal(result.summary.countStatus, 'observed_partial')
    assert.equal(result.changes.length, 250)
    assertIncomplete(await frontend(result))
  })
  for (const mode of ['missing', 'repeated']) {
    test(`${source} ${mode} cursor rejects through the query lifecycle`, async () => {
      const instance = makeService(async () => mode === 'missing' ? page.map((r, i) => i === 999 ? { ...r, id: '' } : r) : page)
      const ui = uiHarness((q) => instance.list(identity, q))
      try {
        const result = await ui.first()
        assert.match(result.state.error?.message, /pagination could not advance safely/)
        assert.ok(result.html.includes('could not be loaded'))
        assert.equal(result.summary, undefined)
        assert.ok(!result.html.includes('authoritative empty'))
      } finally { ui.close() }
    })
  }
  test(`${source} 1000+1 advancing pagination retains all counts`, async () => {
    const result = await makeService(async (q) => {
      if (!q.cursor) return page
      assert.deepEqual(q.cursor, { id: 'row-999' }); assert.equal(q.skip, 1)
      return [{ ...record, id: 'last', microsoftAuditId: 'last', sourceEventId: 'last' }]
    }).list(identity, range)
    assert.equal(result.summary.total, 1001)
    assert.equal(result.pagination.totalPages, 5)
    assert.equal(result.summary.countStatus, 'observed')
    // Only the first response page is loaded: recomputed counts are incomplete.
    assertIncomplete(await frontend(result))
  })
}
test('real second-page transport rejection retains first-page rows and qualifies recomputed summary', async () => {
  const result = await service(async () => [audit]).list(identity, range)
  result.pagination = { page: 1, pageSize: 250, total: 251, totalPages: 2 }
  let requests = 0
  const ui = uiHarness(async (q) => {
    requests++
    if (q.page === '2') throw new Error('private HTTP rejection')
    return result
  })
  try {
    assertIncomplete(await ui.first())
    const next = await ui.next()
    assert.equal(requests, 2)
    assert.equal(next.state.isFetchNextPageError, true)
    assertIncomplete(next)
    assert.ok(next.html.includes('Previously loaded rows remain available'))
    assert.ok(next.html.includes('data-event="audit:directory-1"'))
    assert.ok(!next.html.includes('private HTTP rejection'))
  } finally { ui.close() }
})
for (const mode of ['partial-first', 'partial-second', 'legacy-first', 'legacy-second']) {
  test(`actual response page merge: ${mode} cannot erase partiality`, async () => {
    const first = await service(async () => [audit]).list(identity, range)
    const second = await service(empty, async () => [unified]).list(identity, range)
    first.pagination = { page: 1, pageSize: 250, total: 251, totalPages: 2 }
    second.pagination = { page: 2, pageSize: 250, total: 251, totalPages: 2 }
    const target = mode.endsWith('first') ? first : second
    if (mode.startsWith('legacy')) delete target.sourceAvailability
    else target.sourceAvailability.normalizedEvidence.status = 'partial'
    const ui = uiHarness(async (q) => q.page === '1' ? first : second)
    try {
      await ui.first()
      const merged = await ui.next()
      assert.equal(merged.state.hasNextPage, false)
      assertIncomplete(merged)
      assert.equal(merged.summary.summary.total, 2)
      assert.equal((merged.html.match(/data-event=/g) ?? []).length, 2)
    } finally { ui.close() }
  })
}
test('dedupe and routine mailbox exclusion remain intact', async () => {
  const routine = { ...unified, operationName: 'MoveToDeletedItems', raw: { Operation: 'MoveToDeletedItems', Workload: 'Exchange' } }
  const result = await service(async () => [audit], async () => [projectedDirectory, routine]).list(identity, range)
  assert.deepEqual(result.changes.map((e) => e.id), ['audit:directory-1'])
})
for (const mutation of ['summary', 'tenants', 'pagination', 'sourceAvailability', 'malformed-row']) {
  test(`malformed/legacy ${mutation} cannot certify zero in actual table and summary`, async () => {
    const response = await service().list(identity, range)
    if (mutation === 'malformed-row') response.changes = [{}]
    else delete response[mutation]
    assertIncomplete(await frontend(response))
  })
}

test('snapshot supersession remains scoped to matching evidence in its time window', async () => {
  const nearby = { ...snapshot, eventDateTime: date }
  const result = await service(empty, async () => [unified, nearby, snapshot]).list(identity, range)
  assert.deepEqual(result.changes.map((e) => e.id).sort(), [
    'evidence:M365_UNIFIED_AUDIT:unified-1', 'evidence:SNAPSHOT_DIFFERENCE:snapshot-1',
  ])
  // The later snapshot survives; the one at the matching audit time is suppressed.
  assert.equal(result.changes.find((e) => e.id.includes('SNAPSHOT_DIFFERENCE')).ts, snapshot.eventDateTime.toISOString())
})
for (const [name, extra, query] of [
  ['disabled identity', { user: { findUnique: async () => ({ disabledAt: date, memberships: [] }) } }, range],
  ['tenant lookup fails', { customerTenant: { findMany: fail } }, range],
  ['invalid range', {}, { ...range, from: 'invalid' }],
  ['overwide range', {}, { ...range, from: '2025-01-01' }],
]) {
  test(`${name} rejects before an empty success can be presented`, async () => {
    await assert.rejects(() => service(empty, empty, extra).list(identity, query))
  })
}
test('foreign requested tenant never expands the source query scope', async () => {
  let calls = 0
  const read = async (query) => { calls++; assert.deepEqual(query.where.customerTenantId.in, []); return [] }
  await service(read, read).list(identity, { ...range, tenantId: 'foreign-tenant' })
  assert.equal(calls, 2)
})
