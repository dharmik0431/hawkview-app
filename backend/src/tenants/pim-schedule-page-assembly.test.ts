import assert from 'node:assert/strict'
import test from 'node:test'
import { assemblePimSchedulePages as assemble, type PimSchedulePage,
  type PimPageAssemblyBounds, type PimPageAssemblyResult } from './pim-schedule-page-assembly.js'
import { normalizePimScheduleObservations as normalize } from './pim-schedule-observation.js'

const context = { tenantId: 'T-alpha', plane: 'ACTIVE' as const }
// Synthetic limits only; production defaults are not selected here.
const bounds: PimPageAssemblyBounds = { maxPages: 10, maxInputRows: 20, maxInputBytes: 10000,
  maxConflictVersions: 4, maxConflictEvidenceBytes: 1000 }
const page = (token: string, value: unknown[], next?: unknown): PimSchedulePage => ({
  requestedPageToken: token, envelope: next === undefined ? { value } : { value, '@odata.nextLink': next },
})
function accepted(result: PimPageAssemblyResult) {
  assert.equal(result.ok, true)
  if (!result.ok) throw Error('Expected successful assembly')
  return result
}
function fail(pages: readonly PimSchedulePage[], code: string, limits = bounds) {
  assert.deepEqual(assemble(context, pages, limits), { ok: false, code })
}
const normalized = (records: unknown[], plane: 'ACTIVE' | 'ELIGIBLE' = 'ACTIVE') =>
  normalize(records.map(record => ({ ...context, plane, record })), bounds)

test('single page preserves full raw values and only reports transport syntax', () => {
  const raw = { id: 'i', extension: { values: [1, null, 'é😀'] }, assignmentType: 'Activated', activatedUsing: {} }
  const r = accepted(assemble(context, [page('opaque:first', [raw])], bounds))
  assert.deepEqual(r, { ok: true, pageCount: 1, paginationTerminated: true, observations: normalized([raw]) })
  assert.deepEqual(r.observations.instances[0]!.variants[0]!.raw, raw)
  assert.deepEqual(r.observations.instances[0]!.variants[0]!.diagnostics, ['RELATIONSHIP_ID_ABSENT'])
})
for (const ending of ['absent', 'null'] as const) test('empty terminal page: ' + ending, () => {
  const p = ending === 'absent' ? page('one', []) : page('one', [], null)
  assert.deepEqual(assemble(context, [p], { ...bounds, maxInputRows: 0, maxInputBytes: 0,
    maxConflictVersions: 0, maxConflictEvidenceBytes: 0 }),
  { ok: true, pageCount: 1, paginationTerminated: true, observations: { ok: true, instances: [], rejected: [] } })
})
test('empty intermediate page still contributes its continuation and page count', () => {
  const rows = [{ id: 'a' }, { id: 'b' }]
  const r = accepted(assemble(context, [page('a', [rows[0]], 'b'), page('b', [], 'c'), page('c', [rows[1]])], bounds))
  assert.equal(r.pageCount, 3); assert.deepEqual(r.observations, normalized(rows))
  fail([page('a', [], 'b'), page('b', [], 'c')], 'MISSING_CONTINUATION_PAGE')
})
test('normalizer retains malformed identities and primitives across pages', () => {
  const rows = [{ id: 'valid' }, { id: 11 }, { extra: true }, null, 17]
  const r = accepted(assemble(context, [page('a', rows.slice(0, 2), 'b'), page('b', rows.slice(2))], bounds))
  assert.deepEqual(r.observations, normalized(rows)); assert.equal(r.observations.rejected.length, 4)
})
for (const value of [undefined, null, 17, 'bad', [], {}, { value: null }, { value: {} }, { value: 0 }]) {
  test('reject malformed envelope ' + JSON.stringify(value), () => {
    fail([{ requestedPageToken: 'a', envelope: value }], 'INVALID_PAGE_ENVELOPE')
  })
}
for (const value of [undefined, '', ' \n ', 0, false, [], {}]) {
  test('reject malformed present continuation ' + JSON.stringify(value), () => {
    fail([{ requestedPageToken: 'a', envelope: { value: [], '@odata.nextLink': value } }], 'INVALID_CONTINUATION')
  })
}
test('chain errors never return the already-valid prefix', () => {
  fail([page('a', [{ id: 'prefix' }], 'b')], 'MISSING_CONTINUATION_PAGE')
  fail([page('a', [{ id: 'prefix' }], 'b'), page('wrong', [])], 'PAGE_TOKEN_MISMATCH')
  fail([page('a', [{ id: 'prefix' }]), page('b', [])], 'PAGE_AFTER_TERMINATION')
  fail([page('a', [{ id: 'prefix' }], 'b'), { requestedPageToken: 'b', envelope: {} }], 'INVALID_PAGE_ENVELOPE')
})
test('tokens compare exactly and do not claim URL safety', () => {
  const opaque = ' file:///not-a-request '
  accepted(assemble(context, [page('a', [], opaque), page(opaque, [])], bounds))
  fail([page('a', [], 'Token'), page('token', [])], 'PAGE_TOKEN_MISMATCH')
  fail([page('a', [], ' b '), page('b', [])], 'PAGE_TOKEN_MISMATCH')
})
test('repeated tokens and cycles are refused even with a supplied terminal page', () => {
  fail([page('a', [], 'a'), page('a', [])], 'REPEATED_PAGE_TOKEN')
  fail([page('a', [], 'b'), page('b', [], 'a'), page('a', [])], 'REPEATED_PAGE_TOKEN')
  fail([page('a', [], 'a')], 'MISSING_CONTINUATION_PAGE')
})
test('invalid pages and tokens, including sparse page input, cannot become empty success', () => {
  fail([], 'NO_PAGES')
  for (const token of ['', '  ', null, 17, undefined]) {
    fail([{ requestedPageToken: token, envelope: { value: [] } } as PimSchedulePage], 'INVALID_PAGE_TOKEN')
  }
  fail([null] as unknown as PimSchedulePage[], 'INVALID_PAGE_TOKEN')
  fail(Array(1) as PimSchedulePage[], 'INVALID_PAGE_TOKEN')
  assert.deepEqual(assemble(context, null as unknown as PimSchedulePage[], bounds), { ok: false, code: 'INVALID_INPUT' })
})
test('page limit counts empty pages and is inclusive; no default bounds', () => {
  const pages = [page('a', [], 'b'), page('b', [])]
  accepted(assemble(context, pages, { ...bounds, maxPages: 2 }))
  fail(pages, 'PAGE_LIMIT_EXCEEDED', { ...bounds, maxPages: 1 })
  fail([page('a', [])], 'PAGE_LIMIT_EXCEEDED', { ...bounds, maxPages: 0 })
  for (const key of Object.keys(bounds)) for (const value of [undefined, null, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '2']) {
    fail([page('a', [])], 'INVALID_BOUNDS', { ...bounds, [key]: value } as PimPageAssemblyBounds)
  }
  assert.deepEqual(assemble(context, [page('a', [])], undefined as unknown as PimPageAssemblyBounds), { ok: false, code: 'INVALID_BOUNDS' })
})
test('row budget is checked before reading/flattening rows and includes duplicates/rejections', () => {
  const rows = [{ id: 'i' }, { id: 'i' }, { id: null }]
  const pages = [page('a', rows.slice(0, 1), 'b'), page('b', rows.slice(1))]
  accepted(assemble(context, pages, { ...bounds, maxInputRows: 3 }))
  fail(pages, 'INPUT_ROW_LIMIT_EXCEEDED', { ...bounds, maxInputRows: 2 })
  let read = 0
  const oversized = Object.defineProperty(Array(3), '0', { get() { read++; throw Error('read') }, enumerable: true })
  fail([page('a', oversized)], 'INPUT_ROW_LIMIT_EXCEEDED', { ...bounds, maxInputRows: 2 })
  assert.equal(read, 0)
})
test('byte budget aggregates all pages and per-row context using normalizer accounting', () => {
  const rows = [{ id: 'é', text: '😀' }, { id: 'é', text: '😀' }, { id: null }]
  const bytes = rows.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)) + Buffer.byteLength(JSON.stringify(['T-alpha', 'ACTIVE'])), 0)
  const pages = [page('a', rows.slice(0, 1), 'b'), page('b', rows.slice(1))]
  accepted(assemble(context, pages, { ...bounds, maxInputBytes: bytes }))
  fail(pages, 'INPUT_BYTE_LIMIT_EXCEEDED', { ...bounds, maxInputBytes: bytes - 1 })
})
test('cross-page duplicates/conflicts use actual normalizer and remain order independent', () => {
  const a = { id: 'i', extra: 11 }, b = { id: 'i', extra: '11' }
  const first = accepted(assemble(context, [page('a', [a], 'b'), page('b', [b, { extra: 11, id: 'i' }])], bounds))
  const reversed = accepted(assemble(context, [page('a', [b], 'b'), page('b', [a, b])], bounds))
  assert.deepEqual(first, reversed); assert.deepEqual(first.observations, normalized([a, b, a]))
  assert.equal(first.observations.instances[0]!.variants.length, 2)
  const dup = accepted(assemble(context, [page('a', [a], 'b'), page('b', [a])], bounds))
  assert.equal(dup.observations.instances[0]!.variants.length, 1)
})
test('conflict limits apply globally across page boundaries without partial payload', () => {
  const a = { id: 'i', n: 1 }, b = { id: 'i', n: 2 }
  const pages = [page('a', [a], 'b'), page('b', [b])]
  const bytes = Buffer.byteLength(JSON.stringify(a)) + Buffer.byteLength(JSON.stringify(b))
  accepted(assemble(context, pages, { ...bounds, maxConflictVersions: 2, maxConflictEvidenceBytes: bytes }))
  fail(pages, 'CONFLICT_EVIDENCE_LIMIT_EXCEEDED', { ...bounds, maxConflictVersions: 1 })
  fail(pages, 'CONFLICT_EVIDENCE_LIMIT_EXCEEDED', { ...bounds, maxConflictEvidenceBytes: bytes - 1 })
})
test('caller context is authoritative even for empty pages and conflicting payload labels', () => {
  const raw = { id: 'i', tenantId: 'attacker', plane: 'ACTIVE' }
  const r = accepted(assemble({ ...context, plane: 'ELIGIBLE' }, [page('a', [raw])], bounds))
  assert.deepEqual(r.observations, normalized([raw], 'ELIGIBLE'))
  for (const ctx of [{ tenantId: '', plane: 'ACTIVE' }, { tenantId: 'T', plane: 'other' }, null]) {
    assert.deepEqual(assemble(ctx as typeof context, [page('a', [])], bounds), { ok: false, code: 'INVALID_CONTEXT' })
  }
})
test('whole-chain validation precedes normalization; malformed row is not a valid partial result', () => {
  fail([page('a', [undefined], 'b')], 'MISSING_CONTINUATION_PAGE')
  fail([page('a', [{ id: 'i' }], 'b'), page('b', [undefined])], 'INVALID_JSON')
})
test('accessor envelopes/array elements are rejected without execution; inherited value is refused', () => {
  let read = 0
  const envelope = Object.defineProperty({}, 'value', { get() { read++; return [] }, enumerable: true })
  fail([{ requestedPageToken: 'a', envelope }], 'INVALID_PAGE_ENVELOPE')
  fail([{ requestedPageToken: 'a', envelope: Object.create({ value: [] }) }], 'INVALID_PAGE_ENVELOPE')
  const rows = Object.defineProperty([0], '0', { get() { read++; return { id: 'i' } }, enumerable: true })
  fail([page('a', rows)], 'INVALID_PAGE_ENVELOPE')
  fail([page('a', Array(1))], 'INVALID_PAGE_ENVELOPE')
  assert.equal(read, 0)
})
test('inputs remain unchanged and returned observations are detached; calls retain no state', () => {
  const pages = [page('a', [{ id: 'i', extra: [1] }])], saved = structuredClone(pages)
  const r = accepted(assemble(context, pages, bounds)); assert.deepEqual(pages, saved)
  ;(r.observations.instances[0]!.variants[0]!.raw.extra as number[]).push(2)
  assert.deepEqual(pages, saved)
  assert.deepEqual(accepted(assemble(context, [page('a', [])], bounds)).observations, normalized([]))
})
