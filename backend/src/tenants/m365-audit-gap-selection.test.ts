import assert from 'node:assert/strict'
import test from 'node:test'
import { selectExpiredAuditGapPage, AUDIT_GAP_SELECTION_URI_BYTES, AUDIT_GAP_SELECTION_PAGE_BYTES,
  type AuditGapSelectionInput } from './m365-audit-gap-selection.js'
import type { AuditGapTransferTransaction, SelectedAuditGapClaim } from './m365-audit-gap-transfer.js'

const org = '11111111-1111-4111-8111-111111111111'
const tenant = '22222222-2222-4222-8222-222222222222'
const id = '33333333-3333-4333-8333-333333333333'
const later = '44444444-4444-4444-8444-444444444444'
const at = '2026-11-19T08:00:00.123456Z'
const input = (): AuditGapSelectionInput => ({ organizationId: org, customerTenantId: tenant, afterId: null, limit: 1 })
const claim = (patch: Partial<SelectedAuditGapClaim> = {}): SelectedAuditGapClaim => ({
  organizationId: org, customerTenantId: tenant, id, microsoftContentId: 'stored-id ', contentType: 'Audit.General',
  status: 'FAILED', contentUri: 'https://example.invalid/fixture?private=synthetic', attemptCount: 2,
  updatedAt: at, discoveredAt: '2026-10-01T08:00:00.123456Z', ledgerExpiresAt: at, contentExpiresAt: null, ...patch,
})
const encode = (row: unknown, expired = false) => JSON.stringify({ observedAt: at, row, expired })
function fixture(rows: unknown, reject?: Error) {
  const calls: { sql: string; values: unknown[] }[] = []
  const transaction: AuditGapTransferTransaction = {
    async $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T> {
      calls.push({ sql, values })
      if (reject) throw reject
      return rows as T
    },
  }
  return { transaction, calls }
}
const pageFixture = (row: unknown, expired = false) => fixture([{ page: encode(row, expired) }])
async function refused(rows: unknown, code = 'RESULT_INVALID') {
  const f = fixture(rows)
  await assert.rejects(selectExpiredAuditGapPage(f.transaction, input()), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, `M365_AUDIT_GAP_SELECTION_${code}`)
    assert.equal(error.cause, undefined)
    return true
  })
  assert.equal(f.calls.length, 1)
}

// Scripted transport only: no SQL is executed. Scope/clock/order/gates still
// require registered physical qualification through the actual adapter.
test('HAW-75 selector binds one immutable scope and fixed payload caps without a production writer', async () => {
  const f = pageFixture(claim(), true)
  const result = await selectExpiredAuditGapPage(f.transaction, input())
  assert.deepEqual(result, { observedAt: at, examinedCount: 1, lastExaminedId: id, endOfPass: false, candidates: [claim()] })
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0]!.values, [org, tenant, null, AUDIT_GAP_SELECTION_URI_BYTES, AUDIT_GAP_SELECTION_PAGE_BYTES])
  assert.equal(f.calls[0]!.sql.includes(org), false)
  assert.equal(f.calls[0]!.sql.includes(tenant), false)
  assert.doesNotMatch(f.calls[0]!.sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|OFFSET)\b/)
})

test('HAW-75 selector keeps unexpired-page continuation distinct from empty end of scan', async () => {
  const first = pageFixture(claim(), false)
  const page = await selectExpiredAuditGapPage(first.transaction, input())
  assert.deepEqual(page, { observedAt: at, examinedCount: 1, lastExaminedId: id, endOfPass: false, candidates: [] })
  const second = pageFixture(claim({ id: later }), true)
  const selected = await selectExpiredAuditGapPage(second.transaction, { ...input(), afterId: page.lastExaminedId })
  assert.equal(selected.candidates[0]!.id, later)
  assert.equal(second.calls[0]!.values[2], id)
  const final = pageFixture(null)
  assert.deepEqual(await selectExpiredAuditGapPage(final.transaction, { ...input(), afterId: later }),
    { observedAt: at, examinedCount: 0, lastExaminedId: null, endOfPass: true, candidates: [] })
})

test('HAW-75 selector preserves each unresolved status and exact microsecond/null fields', async () => {
  for (const status of ['PENDING', 'PROCESSING', 'RETRY', 'FAILED', 'INSUFFICIENT_CAPACITY']) {
    const selected = claim({ status, contentExpiresAt: '2026-11-19T08:00:00.123457Z' })
    assert.deepEqual((await selectExpiredAuditGapPage(pageFixture(selected, true).transaction, input())).candidates, [selected])
  }
})

test('HAW-75 selector rejects invalid scope, cursor and read limits before calling transport', async () => {
  for (const patch of [
    { organizationId: 'not-a-uuid' }, { customerTenantId: 'scope injection' }, { afterId: '' },
    ...[0, -1, 2, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER].map(limit => ({ limit })),
  ]) {
    const f = pageFixture(null)
    await assert.rejects(selectExpiredAuditGapPage(f.transaction, { ...input(), ...patch }), /SELECTION_INPUT_INVALID$/)
    assert.equal(f.calls.length, 0)
  }
})

test('HAW-75 selector captures query and validation scope before an asynchronous wait', async () => {
  const selected = input()
  const f = fixture([{ page: encode(claim(), true) }])
  const pending = selectExpiredAuditGapPage(f.transaction, selected)
  selected.organizationId = later; selected.customerTenantId = later; selected.afterId = later; selected.limit = 100
  assert.deepEqual((await pending).candidates, [claim()])
  assert.deepEqual(f.calls[0]!.values.slice(0, 3), [org, tenant, null])
})

test('HAW-75 selector refuses malformed envelopes without exposing raw payloads', async () => {
  for (const rows of [null, [], [{ page: encode(null) }, { page: encode(null) }], [{ page: null }],
    [{ page: encode(null), extra: 'private' }], [{ page: '{private=synthetic' }], [{ page: '[]' }],
    [{ page: JSON.stringify({ observedAt: at, expired: false }) }],
    [{ page: JSON.stringify({ observedAt: '2026-02-30T08:00:00.123456Z', row: null, expired: false }) }],
    [{ page: encode(null, true) }], [{ page: JSON.stringify({ refused: 'URI_LIMIT', row: claim() }) }],
    [{ page: JSON.stringify({ refused: 'unknown' }) }]]) await refused(rows)
})

test('HAW-75 selector refuses inconsistent scope, nonforward IDs and malformed selected claims', async () => {
  for (const patch of [
    { organizationId: later }, { customerTenantId: later }, { id: 'bad-id' }, { status: 'COMPLETED' }, { status: 'UNKNOWN' },
    { microsoftContentId: '' }, { microsoftContentId: 'x'.repeat(501) }, { contentType: 'x'.repeat(81) },
    { contentUri: '' }, { contentUri: 'contains\0nul' }, { attemptCount: -1 }, { attemptCount: 1.5 }, { attemptCount: 2_147_483_648 },
    { updatedAt: '2026-11-19T08:00:00.123Z' }, { discoveredAt: '2026-02-30T08:00:00.123456Z' },
    { ledgerExpiresAt: 'infinity' }, { contentExpiresAt: '2026-11-19T08:00:00.123456+00:00' },
  ]) await refused([{ page: encode(claim(patch), true) }])
  await refused([{ page: encode({ ...claim(), extra: 'private' }, true) }])
  for (const afterId of [id, later]) await assert.rejects(
    selectExpiredAuditGapPage(pageFixture(claim(), true).transaction, { ...input(), afterId }), /SELECTION_RESULT_INVALID$/)
})

test('HAW-75 selector accepts exact defensive URI/page boundaries and refuses over-limit transport', async () => {
  const atUriLimit = claim({ contentUri: 'x'.repeat(AUDIT_GAP_SELECTION_URI_BYTES) })
  assert.equal((await selectExpiredAuditGapPage(pageFixture(atUriLimit, true).transaction, input())).candidates.length, 1)
  await refused([{ page: encode(claim({ contentUri: atUriLimit.contentUri + 'x' }), true) }])
  const empty = encode(null)
  const padded = ' '.repeat(AUDIT_GAP_SELECTION_PAGE_BYTES - Buffer.byteLength(empty)) + empty
  assert.equal((await selectExpiredAuditGapPage(fixture([{ page: padded }]).transaction, input())).endOfPass, true)
  await refused([{ page: padded + ' ' }], 'PAGE_LIMIT')
  // These are posttransport decoder controls, not proof of the SQL gates.
})

test('HAW-75 selector preserves only fixed SQL refusal codes and sanitizes arbitrary driver errors', async () => {
  for (const code of ['URI_LIMIT', 'PAGE_LIMIT', 'ENCODING_UNSUPPORTED'])
    await refused([{ page: JSON.stringify({ refused: code }) }], code)
  const f = fixture(undefined, new Error('driver private URI: https://example.invalid/?synthetic=secret'))
  await assert.rejects(selectExpiredAuditGapPage(f.transaction, input()), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'M365_AUDIT_GAP_SELECTION_QUERY_FAILED')
    assert.equal(error.cause, undefined)
    return true
  })
})
