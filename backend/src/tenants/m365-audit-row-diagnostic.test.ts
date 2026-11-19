import assert from 'node:assert/strict'
import test from 'node:test'
import { observeAuditGapRowDiagnostic, AUDIT_GAP_DIAGNOSTIC_RESPONSE_BYTES,
  type AuditGapDiagnosticInput } from './m365-audit-row-diagnostic.js'
import { AUDIT_GAP_SELECTION_URI_BYTES } from './m365-audit-gap-selection.js'
import type { AuditGapTransferTransaction } from './m365-audit-gap-transfer.js'

const org = '11111111-1111-4111-8111-111111111111'
const tenant = '22222222-2222-4222-8222-222222222222'
const id = '33333333-3333-4333-8333-333333333333'
const later = '44444444-4444-4444-8444-444444444444'
const at = '2026-11-19T17:00:00.123456Z'
const input = (): AuditGapDiagnosticInput => ({ organizationId: org, customerTenantId: tenant, afterId: null })
const row = (patch: Record<string, unknown> = {}) => ({ id, organizationId: org, customerTenantId: tenant,
  uriExceedsLimit: true, ...patch })
const encode = (value: unknown) => JSON.stringify({ observedAt: at, row: value })
function fixture(result: unknown, failure?: unknown) {
  const calls: { sql: string; values: unknown[] }[] = []
  const transaction: AuditGapTransferTransaction = {
    async $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T> {
      calls.push({ sql, values })
      if (failure !== undefined) throw failure
      return result as T
    },
  }
  return { transaction, calls }
}
const observation = (value: unknown) => fixture([{ diagnostic: encode(value) }])
async function refused(result: unknown, code = 'RESULT_INVALID') {
  const f = fixture(result)
  await assert.rejects(observeAuditGapRowDiagnostic(f.transaction, input()), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, `M365_AUDIT_GAP_DIAGNOSTIC_${code}`)
    assert.equal(error.cause, undefined)
    return true
  })
  assert.equal(f.calls.length, 1)
}

// Scripted transport only. These tests execute no SQL and do not establish a
// database snapshot, scope isolation, payload transport or query-cost bound.
test('HAW-75 diagnostic binds a single scoped observation with fixed limits and no writer', async () => {
  assert.equal(AUDIT_GAP_DIAGNOSTIC_RESPONSE_BYTES, 1024)
  const f = observation(row())
  assert.deepEqual(await observeAuditGapRowDiagnostic(f.transaction, input()), { observedAt: at, row: row() })
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0]!.values, [org, tenant, null, AUDIT_GAP_SELECTION_URI_BYTES, 1024])
  const sql = f.calls[0]!.sql
  assert.equal(sql.includes(org) || sql.includes(tenant), false)
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|OFFSET|FOR\s+SHARE)\b/)
  assert.doesNotMatch(sql, /microsoft_content_id|content_expires_at|ledger_expires_at|updated_at|md5|sha256/)
  assert.match(sql, /octet_length\(content_uri\) > \$4::integer/)
})

test('HAW-75 diagnostic returns no continuation or safe disposition for either row or absence', async () => {
  for (const value of [null, row(), row({ uriExceedsLimit: false })]) {
    const result = await observeAuditGapRowDiagnostic(observation(value).transaction, input())
    assert.deepEqual(result, { observedAt: at, row: value })
    assert.deepEqual(Object.keys(result).sort(), ['observedAt', 'row'])
  }
  const f = observation(row({ id: later }))
  const result = await observeAuditGapRowDiagnostic(f.transaction, { ...input(), afterId: id })
  assert.equal(result.row!.id, later)
  assert.equal(f.calls[0]!.values[2], id)
})

test('HAW-75 diagnostic rejects invalid scope or continuation before transport', async () => {
  for (const patch of [{ organizationId: 'bad' }, { customerTenantId: "' OR true" },
    { afterId: '' }, { afterId: 'not-a-uuid' }, { afterId: undefined }]) {
    const f = observation(null)
    await assert.rejects(observeAuditGapRowDiagnostic(f.transaction, { ...input(), ...patch } as AuditGapDiagnosticInput),
      /DIAGNOSTIC_INPUT_INVALID$/)
    assert.equal(f.calls.length, 0)
  }
})

test('HAW-75 diagnostic captures query and response scope before caller mutation', async () => {
  const selected = input()
  const f = observation(row())
  const pending = observeAuditGapRowDiagnostic(f.transaction, selected)
  selected.organizationId = later; selected.customerTenantId = later; selected.afterId = later
  assert.deepEqual(await pending, { observedAt: at, row: row() })
  assert.deepEqual(f.calls[0]!.values.slice(0, 3), [org, tenant, null])
})

test('HAW-75 diagnostic refuses malformed envelopes and extra payload fields with fixed errors', async () => {
  for (const result of [null, [], [{ diagnostic: encode(null) }, { diagnostic: encode(null) }],
    [{ diagnostic: null }], [{ diagnostic: encode(null), raw: 'private' }], [{ diagnostic: '{private' }],
    [{ diagnostic: '[]' }], [{ diagnostic: 'null' }], [{ diagnostic: '{}' }],
    [{ diagnostic: JSON.stringify({ observedAt: at, row: null, contentUri: 'private' }) }],
    [{ diagnostic: JSON.stringify({ refused: 'RESPONSE_LIMIT', row: row() }) }],
    [{ diagnostic: JSON.stringify({ refused: 'URI_LIMIT' }) }]]) await refused(result)
})

test('HAW-75 diagnostic rejects bad timestamps, row identity, scope, flags and nonforward observations', async () => {
  for (const observedAt of ['2026-02-30T17:00:00.123456Z', '2026-11-19T17:00:00.123Z',
    '2026-11-19T17:00:00.123456+00:00', 'infinity', null])
    await refused([{ diagnostic: JSON.stringify({ observedAt, row: null }) }])
  for (const value of [[], {}, row({ id: 'bad' }), row({ organizationId: later }), row({ customerTenantId: later }),
    row({ uriExceedsLimit: null }), row({ uriExceedsLimit: 1 }), row({ contentUri: 'private' }),
    { id, organizationId: org, customerTenantId: tenant }]) await refused([{ diagnostic: encode(value) }])
  for (const afterId of [id, later]) await assert.rejects(
    observeAuditGapRowDiagnostic(observation(row()).transaction, { ...input(), afterId }), /DIAGNOSTIC_RESULT_INVALID$/)
})

test('HAW-75 diagnostic enforces exact defensive text bytes before JSON parsing', async () => {
  const payload = encode(row())
  const padded = ' '.repeat(AUDIT_GAP_DIAGNOSTIC_RESPONSE_BYTES - Buffer.byteLength(payload)) + payload
  const f = fixture([{ diagnostic: padded }])
  assert.deepEqual(await observeAuditGapRowDiagnostic(f.transaction, input()), { observedAt: at, row: row() })
  await refused([{ diagnostic: padded + ' ' }], 'RESPONSE_LIMIT')
  const multibyte = 'é'.repeat(513)
  assert.ok(multibyte.length < AUDIT_GAP_DIAGNOSTIC_RESPONSE_BYTES)
  await refused([{ diagnostic: multibyte }], 'RESPONSE_LIMIT')
  // This is only a posttransport decoder guard, not SQL pretransport proof.
})

test('HAW-75 diagnostic allows only fixed server refusals and strips driver messages and causes', async () => {
  for (const code of ['RESPONSE_LIMIT', 'ENCODING_UNSUPPORTED'])
    await refused([{ diagnostic: JSON.stringify({ refused: code }) }], code)
  for (const failure of [new Error('driver URI https://example.invalid/?fixture=private'),
    new Error('M365_AUDIT_GAP_DIAGNOSTIC_RESPONSE_LIMIT'), { raw: 'private' }]) {
    const f = fixture(undefined, failure)
    await assert.rejects(observeAuditGapRowDiagnostic(f.transaction, input()), error => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'M365_AUDIT_GAP_DIAGNOSTIC_QUERY_FAILED')
      assert.equal(error.cause, undefined)
      return true
    })
  }
})
