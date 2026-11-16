import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { stageExpiredAuditGapTransfer, type AuditGapTransferTransaction, type SelectedAuditGapClaim } from './m365-audit-gap-transfer.js'

const org = '11111111-1111-4111-8111-111111111111'
const tenant = '22222222-2222-4222-8222-222222222222'
const id = '33333333-3333-4333-8333-333333333333'
const other = '44444444-4444-4444-8444-444444444444'
const at = '2026-11-16T07:00:00.123456Z'
const claim = (patch: Partial<SelectedAuditGapClaim> = {}): SelectedAuditGapClaim => ({
  id, organizationId: org, customerTenantId: tenant, microsoftContentId: 'stored-content',
  contentType: 'Audit.General', status: 'RETRY', contentUri: 'https://example.invalid/private?secret=redacted',
  attemptCount: 2, updatedAt: at, discoveredAt: '2026-10-17T07:00:00.123456Z',
  ledgerExpiresAt: at, contentExpiresAt: null, ...patch,
})

interface Step { sql: string; rows?: unknown[]; error?: Error; before?: () => Promise<void> }
interface Call { query: string; values: unknown[] }
function scripted(steps: Step[]) {
  const calls: Call[] = []
  const transaction: AuditGapTransferTransaction = {
    async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
      const step = steps[calls.length]
      calls.push({ query, values })
      assert.ok(step, `Unexpected query number ${calls.length}`)
      assert.ok(query.includes(step.sql), `Expected statement ${step.sql}`)
      await step.before?.()
      if (step.error) throw step.error
      return step.rows as T
    },
  }
  return { transaction, calls, done: () => assert.equal(calls.length, steps.length) }
}

const reads = (state: unknown[] = [], gap: unknown[] = [], source: unknown[] = [{ id }]): Step[] => [
  { sql: 'FROM public.customer_tenants', rows: [{ id: tenant }] },
  { sql: 'FROM public.m365_audit_coverage_states', rows: state },
  { sql: 'FROM public.m365_audit_coverage_gaps', rows: gap },
  { sql: 'FROM public.m365_activity_contents WHERE', rows: source },
]
const clock = (patch: Record<string, unknown> = {}): Step => ({
  sql: 'WITH observed AS MATERIALIZED',
  rows: [{ observedAt: at, sourceExpiredAt: at, expired: true, reason: 'LEDGER_EXPIRED', ...patch }],
})
const writes = (existingState = false): Step[] => [
  { sql: 'INSERT INTO public.m365_audit_coverage_gaps', rows: [{ id: other }] },
  { sql: `${existingState ? 'UPDATE' : 'INSERT INTO'} public.m365_audit_coverage_states`, rows: [{ id: tenant }] },
  { sql: 'DELETE FROM public.m365_activity_contents', rows: [{ id }] },
]

// Scripted transactions exercise JS control flow and parameter contracts only.
// They execute no SQL, establish no locks/owner proof, and prove no DB rollback.
test('new expired gap stages URL-free evidence and state before exact source deletion', async () => {
  const selected = claim({ microsoftContentId: `${'x'.repeat(499)} ` })
  const fixture = scripted([...reads(), clock(), ...writes()])
  const result = await stageExpiredAuditGapTransfer(fixture.transaction, selected)
  fixture.done()
  assert.deepEqual(result, { staged: true, reason: 'LEDGER_EXPIRED' })
  assert.equal('transferred' in result, false, 'staging is not commit acknowledgement')
  const insert = fixture.calls[5]
  assert.equal(insert.values[4], createHash('sha256').update(selected.microsoftContentId).digest('hex'))
  assert.equal(insert.values[8], at, 'explicit post-wait observation overrides transaction-start default')
  assert.equal(fixture.calls[6].values[2], at)
  assert.equal(insert.values.includes(selected.contentUri), false)
  assert.equal(insert.values.includes(selected.microsoftContentId), false)
  assert.equal(JSON.stringify(result).includes(selected.contentUri), false)
  const lock = fixture.calls[3]
  const deletion = fixture.calls[7]
  assert.deepEqual(deletion.values, lock.values)
  assert.equal(deletion.values[8], at, 'microseconds are not rounded through Date')
  assert.equal(deletion.values[11], null, 'nullable provider expiry remains explicit')
  for (const column of ['id', 'organization_id', 'customer_tenant_id', 'microsoft_content_id', 'content_type',
    'status', 'content_uri', 'attempt_count', 'updated_at', 'discovered_at', 'ledger_expires_at', 'content_expires_at']) {
    assert.ok(lock.query.includes(column))
    assert.ok(deletion.query.includes(column))
  }
})

test('a distinct new gap updates the existing generation once without clearing sticky state', async () => {
  const fixture = scripted([...reads([{ organizationId: org, generation: 7n }]), clock(), ...writes(true)])
  assert.equal((await stageExpiredAuditGapTransfer(fixture.transaction, claim())).staged, true)
  fixture.done()
  assert.deepEqual(fixture.calls[6].values, [tenant, org, at, 7n])
  assert.ok(fixture.calls[6].query.includes('generation = generation + 1'))
  assert.equal(fixture.calls[6].query.includes('has_purged_unrepaired_gap'), false)
  assert.equal(fixture.calls[6].query.includes('incomplete_since'), false)
})

test('a retained unresolved identity does not refresh gap evidence or advance generation again', async () => {
  const fixture = scripted([...reads([{ organizationId: org, generation: 7n }],
    [{ organizationId: org, contentType: 'Audit.General', resolvedAt: null }]), clock(), writes()[2]])
  assert.equal((await stageExpiredAuditGapTransfer(fixture.transaction, claim())).staged, true)
  fixture.done()
  assert.equal(fixture.calls.some((call) => /\b(INSERT|UPDATE)\b/.test(call.query.replace(/FOR UPDATE/g, ''))), false)
})

test('absent tenant, changed or completed source, and not-yet-expired row stage no writes', async () => {
  const absent = scripted([{ sql: 'FROM public.customer_tenants', rows: [] }])
  assert.deepEqual(await stageExpiredAuditGapTransfer(absent.transaction, claim()), { staged: false, reason: 'TENANT_ABSENT' })
  absent.done()
  // A changed or completed current row cannot match the selected unresolved
  // predicate. The database evaluation of that predicate still needs PG CI.
  const changed = scripted(reads([], [], []))
  assert.deepEqual(await stageExpiredAuditGapTransfer(changed.transaction, claim()), { staged: false, reason: 'SOURCE_CHANGED_OR_ABSENT' })
  changed.done()
  const pending = scripted([...reads(), clock({ expired: false })])
  assert.deepEqual(await stageExpiredAuditGapTransfer(pending.transaction, claim()), { staged: false, reason: 'NOT_EXPIRED' })
  pending.done()
})

test('owner-independent tenant/source waits finish before the separate clock query', async () => {
  let release: () => void = () => { throw new Error('not initialized') }
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const steps = [...reads(), clock(), ...writes()]
  steps[3].before = () => waiting
  const fixture = scripted(steps)
  const selected = claim()
  const pending = stageExpiredAuditGapTransfer(fixture.transaction, selected)
  for (let turn = 0; turn < 8 && fixture.calls.length < 4; turn++) await Promise.resolve()
  assert.equal(fixture.calls.length, 4)
  selected.contentUri = 'https://example.invalid/new-claim'
  selected.attemptCount = 99
  release()
  assert.equal((await pending).staged, true)
  fixture.done()
  assert.equal(fixture.calls[7].values[6], claim().contentUri, 'selection is captured before waits')
  assert.equal(fixture.calls[7].values[7], 2)
})

test('all supported database expiry reasons are preserved without claiming SQL boundary proof', async () => {
  for (const reason of ['LEDGER_EXPIRED', 'PROVIDER_URL_EXPIRED', 'URL_AGE_EXPIRED']) {
    const fixture = scripted([...reads(), clock({ reason }), ...writes()])
    assert.deepEqual(await stageExpiredAuditGapTransfer(fixture.transaction, claim()), { staged: true, reason })
    assert.equal(fixture.calls[5].values[6], reason)
    fixture.done()
  }
})

test('resolved, contradictory-scope/type, or markerless retained gaps fail before source mutation', async () => {
  for (const [state, gap, code] of [
    [[{ organizationId: other, generation: 1n }], [], 'STATE_SCOPE_INVALID'],
    [[{ organizationId: org, generation: 1n }], [{ organizationId: other, contentType: 'Audit.General', resolvedAt: null }], 'IDENTITY_CONFLICT'],
    [[{ organizationId: org, generation: 1n }], [{ organizationId: org, contentType: 'Audit.Exchange', resolvedAt: null }], 'IDENTITY_CONFLICT'],
    [[{ organizationId: org, generation: 1n }], [{ organizationId: org, contentType: 'Audit.General', resolvedAt: at }], 'RESOLVED_IDENTITY_CONFLICT'],
    [[], [{ organizationId: org, contentType: 'Audit.General', resolvedAt: null }], 'STICKY_STATE_MISSING'],
  ] as const) {
    const steps = reads([...state], [...gap]).slice(0, code === 'STATE_SCOPE_INVALID' ? 2 : 3)
    const fixture = scripted(steps)
    await assert.rejects(stageExpiredAuditGapTransfer(fixture.transaction, claim()), new RegExp(`^Error: M365_AUDIT_GAP_${code}$`))
    fixture.done()
  }
})

test('write-count loss or driver failure rejects staging instead of returning success or leaking URL', async () => {
  for (const [index, code] of [[5, 'INSERT_LOST'], [6, 'STATE_WRITE_LOST'], [7, 'DELETE_LOST']] as const) {
    const steps = [...reads(), clock(), ...writes()].slice(0, index + 1)
    steps[index].rows = []
    const fixture = scripted(steps)
    await assert.rejects(stageExpiredAuditGapTransfer(fixture.transaction, claim()), new RegExp(code))
    fixture.done()
  }
  const steps = [...reads([{ organizationId: org, generation: 9_223_372_036_854_775_807n }]), clock(), ...writes(true)].slice(0, 7)
  steps[6].error = new Error(`synthetic overflow/permission failure with ${claim().contentUri}`)
  const fixture = scripted(steps)
  await assert.rejects(stageExpiredAuditGapTransfer(fixture.transaction, claim()), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'M365_AUDIT_GAP_STAGE_FAILED')
    assert.equal(error.cause, undefined)
    assert.equal(error.stack?.includes(claim().contentUri), false)
    return true
  })
  fixture.done()
})

test('invalid selection and malformed clock responses reject without an evidence write', async () => {
  for (const patch of [
    { id: 'invalid' }, { organizationId: other.toUpperCase().replace('4444', 'ZZZZ') },
    { microsoftContentId: '' }, { microsoftContentId: 'x'.repeat(501) }, { contentType: '' },
    { status: 'COMPLETED' }, { status: 'UNKNOWN' }, { contentUri: '' },
    { attemptCount: -1 }, { attemptCount: 1.5 }, { attemptCount: 2_147_483_648 },
    { updatedAt: '2026-02-30T00:00:00Z' }, { updatedAt: '2026-11-16T07:00:00.1234567Z' },
    { discoveredAt: 'invalid' }, { ledgerExpiresAt: 'infinity' }, { contentExpiresAt: 'invalid' },
  ]) {
    const fixture = scripted([])
    await assert.rejects(stageExpiredAuditGapTransfer(fixture.transaction, claim(patch)), /SELECTED_CLAIM_INVALID/)
    fixture.done()
  }
  for (const patch of [{ observedAt: 'invalid' }, { sourceExpiredAt: 'infinity' }, { expired: null }, { reason: 'CONTENT_UNAVAILABLE' }]) {
    const fixture = scripted([...reads(), clock(patch)])
    await assert.rejects(stageExpiredAuditGapTransfer(fixture.transaction, claim()), /CLOCK_INVALID/)
    fixture.done()
  }
})

test('outer rejection discards the staged result; unknown acknowledgement requires a fresh read', async () => {
  const first = scripted([...reads(), clock(), ...writes()])
  let reported = false
  const outer = async () => {
    const result = await stageExpiredAuditGapTransfer(first.transaction, claim())
    assert.equal(result.staged, true)
    throw new Error('synthetic outer commit rejection')
  }
  await assert.rejects(outer().then(() => { reported = true }), /outer commit rejection/)
  assert.equal(reported, false)
  first.done()
  const reread = scripted(reads([{ organizationId: org, generation: 1n }],
    [{ organizationId: org, contentType: 'Audit.General', resolvedAt: null }], []))
  assert.deepEqual(await stageExpiredAuditGapTransfer(reread.transaction, claim()),
    { staged: false, reason: 'SOURCE_CHANGED_OR_ABSENT' })
  reread.done()
  // This illustrates result propagation, not database commit/rollback recovery.
})
