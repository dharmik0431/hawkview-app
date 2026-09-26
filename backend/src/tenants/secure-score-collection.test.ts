import { ChangeEvidenceService } from '../changes/change-evidence.service.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService, entraCollectionLimitsForResource, currentScoreSnapshot, authoritativeSnapshot, partialSnapshot } from './tenant-sync.service.js'
import { CURRENT_SECURE_SCORE_URL, currentSecureScoresFromResponse, SecureScoreResponseError } from './secure-score-collection.js'
import { getMicrosoftSecureScore } from './secure-score.util.js'

const now = Date.parse('2026-09-26T12:00:00Z')
const valid = { id: 'current', createdDateTime: new Date(now).toISOString(), currentScore: 75, maxScore: 100 }

function harness(response: () => Response | Promise<Response>) {
  const previous = [{ ...valid, id: 'previous', currentScore: 50 }]
  const lastSuccessfulAt = new Date(now - 86400000)
  const state: any = { status: 'SUCCEEDED', lastSuccessfulAt, consecutiveFailures: 0 }
  const saved: any[] = []; const calls: any[] = []; const diagnostics: string[] = []
  let recovered = 0
  const service: any = new TenantSyncService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any)
  service.notifications = { publishIncident: async () => {}, resolveIncident: async () => { recovered++ } }
  service.logger = { warn: (message: string) => diagnostics.push(message) }
  service.withSnapshotUtc = async (_resource: string, work: any) => work({ syncState: {
    upsert: async ({ update }: any) => { Object.assign(state, update); return { ...state } },
    update: async ({ data }: any) => {
      const failures = typeof data.consecutiveFailures === 'object' ? state.consecutiveFailures + 1 : data.consecutiveFailures ?? state.consecutiveFailures
      Object.assign(state, data, { consecutiveFailures: failures }); return { ...state }
    },
  } })
  service.saveSnapshot = async (...args: any[]) => { saved.push(args) }
  service.fetchGraphPage = async (...args: any[]) => { calls.push(args); return response() }
  return { state, previous, lastSuccessfulAt, saved, calls, diagnostics, get recovered() { return recovered },
    run: () => service.syncCurrentSecureScore({ id: 'synthetic-tenant', organizationId: 'synthetic-org' }, 'synthetic-token') }
}

for (const [name, payload] of Object.entries({
  empty: { value: [] }, mixedMalformed: { value: [valid, { ...valid, id: '' }] },
  nextLink: { value: [valid], '@odata.nextLink': 'https://graph.microsoft.com/continuation' },
  malformedNextLink: { value: [valid], '@odata.nextLink': null },
  malformedEnvelope: { values: [valid] }, malformedRow: { value: [null] },
  stringScore: { value: [{ ...valid, currentScore: '75' }] },
  zeroMaximum: { value: [{ ...valid, maxScore: 0 }] },
  negativeScore: { value: [{ ...valid, currentScore: -1 }] },
  aboveMaximum: { value: [{ ...valid, currentScore: 101 }] },
  missingId: { value: [{ ...valid, id: '' }] },
  shortDate: { value: [{ ...valid, createdDateTime: '2026' }] },
  rolloverDate: { value: [{ ...valid, createdDateTime: '2026-02-30T00:00:00Z' }] },
  longId: { value: [{ ...valid, id: 'x'.repeat(257) }] },
  whitespaceId: { value: [{ ...valid, id: ' ' }] },
  invalidDate: { value: [{ ...valid, createdDateTime: 'invalid' }] },
  futureDate: { value: [{ ...valid, createdDateTime: new Date(now + 1).toISOString() }] },
})) {
  test(`current-score ${name} refuses snapshot and preserves previous success`, async (t) => {
    t.mock.method(Date, 'now', () => now)
    const h = harness(() => new Response(JSON.stringify(payload)))
    await assert.rejects(h.run)
    assert.equal(h.calls.length, 1)
    assert.equal(h.saved.length, 0)
    assert.equal(h.recovered, 0)
    assert.equal(h.state.status, 'FAILED')
    assert.equal(h.state.lastSuccessfulAt, h.lastSuccessfulAt)
    assert.equal(h.state.consecutiveFailures, 1)
    assert.equal(h.state.lastErrorCode, 'MICROSOFT_INVALID_RESPONSE')
    assert.equal(h.previous[0].currentScore, 50)
    assert.ok(!h.diagnostics.join('').includes('synthetic-token'))
    assert.ok(!h.diagnostics.join('').includes('synthetic-tenant'))
  })
}

test('latest score succeeds without retaining historical control details; resets prior failure', async (t) => {
  t.mock.method(Date, 'now', () => now)
  const row = { ...valid, controlScores: [{ description: 'x'.repeat(1100000) }], averageComparativeScores: [{ unknown: true }] }
  const wire = JSON.stringify({ value: [row] })
  assert.ok(Buffer.byteLength(wire) > entraCollectionLimitsForResource('SECURE_SCORES').materializedBytes)
  assert.ok(Buffer.byteLength(wire) < entraCollectionLimitsForResource('SECURE_SCORES').pageBytes)
  const h = harness(() => new Response(wire))
  h.state.status = 'FAILED'; h.state.consecutiveFailures = 4
  await h.run()
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0][0], CURRENT_SECURE_SCORE_URL)
  assert.equal(new URL(h.calls[0][0]).searchParams.get('$top'), '1')
  assert.equal(h.calls[0][3].timeoutMs, 30000)
  assert.equal(h.calls[0][3].deadlineAt, now + 600000)
  assert.equal(h.saved.length, 1)
  assert.deepEqual(h.saved[0][2], { completeness: 'current_score_complete', rows: [valid] })
  assert.equal(getMicrosoftSecureScore(h.saved[0][2].rows), 75)
  assert.equal(h.state.status, 'SUCCEEDED')
  assert.equal(h.state.consecutiveFailures, 0)
  assert.equal(h.state.lastErrorCode, null)
  assert.notEqual(h.state.lastSuccessfulAt, h.lastSuccessfulAt)
  assert.equal(h.recovered, 1)
})

test('old provider dates, multiple providers and tied-date selection preserve existing semantics', async (t) => {
  t.mock.method(Date, 'now', () => now)
  const old = { ...valid, id: 'old', createdDateTime: '2025-01-01T00:00:00.000Z', currentScore: 0 }
  const h = harness(() => new Response(JSON.stringify({ value: [old] })))
  await h.run()
  assert.equal(h.state.status, 'SUCCEEDED')
  assert.equal(h.saved[0][2].rows[0].createdDateTime, old.createdDateTime)
  assert.equal(getMicrosoftSecureScore(h.saved[0][2].rows), 0)
  const tied = { ...valid, id: 'other-provider', currentScore: 85 }
  const rows = [valid, old, tied]
  const multi = harness(() => new Response(JSON.stringify({ value: rows })))
  await multi.run()
  assert.deepEqual(multi.saved[0][2].rows, rows)
  assert.equal(getMicrosoftSecureScore(multi.saved[0][2].rows), getMicrosoftSecureScore(rows))
  assert.equal(getMicrosoftSecureScore(multi.saved[0][2].rows), 85)
})

test('provider row bound is enforced without partial save', async (t) => {
  t.mock.method(Date, 'now', () => now)
  const h = harness(() => new Response(JSON.stringify({ value: Array.from({ length: 101 }, (_, i) => ({ ...valid, id: String(i) })) })))
  await assert.rejects(h.run)
  assert.equal(h.saved.length, 0)
  assert.equal(h.state.lastSuccessfulAt, h.lastSuccessfulAt)
  assert.equal(h.state.lastErrorCode, 'HAWKVIEW_CAPACITY_GUARD')
  assert.equal(JSON.parse(h.diagnostics[0]).reason, 'ROW_LIMIT')
})

for (const advertised of [true, false]) {
  test(`raw byte guard cancels ${advertised ? 'advertised' : 'streamed'} oversized response`, async (t) => {
    t.mock.method(Date, 'now', () => now)
    let cancelled = false
    const size = entraCollectionLimitsForResource('SECURE_SCORES').pageBytes + 1
    const h = harness(() => new Response(new ReadableStream({
      start(controller) { if (!advertised) controller.enqueue(new Uint8Array(size)) },
      cancel() { cancelled = true },
    }), { headers: advertised ? { 'content-length': String(size) } : {} }))
    await assert.rejects(h.run)
    assert.equal(cancelled, true)
    assert.equal(h.saved.length, 0)
    assert.equal(h.state.lastSuccessfulAt, h.lastSuccessfulAt)
    assert.equal(h.state.lastErrorCode, 'HAWKVIEW_CAPACITY_GUARD')
  })
}

test('collector absolute deadline rejects a delayed response without saving', async (t) => {
  let clock = now
  t.mock.method(Date, 'now', () => clock)
  const h = harness(() => { clock += 600001; return new Response(JSON.stringify({ value: [valid] })) })
  await assert.rejects(h.run)
  assert.equal(h.saved.length, 0)
  assert.equal(h.state.lastSuccessfulAt, h.lastSuccessfulAt)
})

test('invalid JSON and transport failure preserve last good state', async (t) => {
  t.mock.method(Date, 'now', () => now)
  for (const response of [() => new Response('{'), () => { throw new Error('network unavailable') }]) {
    const h = harness(response)
    await assert.rejects(h.run)
    assert.equal(h.saved.length, 0)
    assert.equal(h.recovered, 0)
    assert.equal(h.state.lastSuccessfulAt, h.lastSuccessfulAt)
  }
})

test('nonfinite score values are refused before projection', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => currentSecureScoresFromResponse({ value: [{ ...valid, currentScore: value }] }, now), /INVALID_RESPONSE/)
    assert.throws(() => currentSecureScoresFromResponse({ value: [{ ...valid, maxScore: value }] }, now), /INVALID_RESPONSE/)
  }
})

test('DateTimeOffset timestamps preserve source text and compare the actual instant', async (t) => {
  t.mock.method(Date, 'now', () => now)
  for (const createdDateTime of ['2026-09-26T17:30:00+05:30', '2026-09-26T08:00:00-04:00', '2026-09-26T12:00:00.0000000+00:00']) {
    const h = harness(() => new Response(JSON.stringify({ value: [{ ...valid, createdDateTime }] })))
    await h.run()
    assert.equal(h.state.status, 'SUCCEEDED')
    assert.equal(h.saved[0][2].rows[0].createdDateTime, createdDateTime)
    assert.equal(getMicrosoftSecureScore(h.saved[0][2].rows), 75)
  }
  for (const createdDateTime of ['2026-09-26T17:30:01+05:30', '2026-09-26T08:00:01-04:00', '2026-02-30T17:30:00+05:30', '2026-09-26T12:00:00+24:00', '2026-09-26T12:00:00']) {
    assert.throws(() => currentSecureScoresFromResponse({ value: [{ ...valid, createdDateTime }] }, now), /INVALID_RESPONSE/)
  }
})

test('response diagnostics do not invent a prior baseline', async (t) => {
  t.mock.method(Date, 'now', () => now)
  assert.ok(!new SecureScoreResponseError('EMPTY_RESPONSE').message.includes('retained'))
  const h = harness(() => new Response(JSON.stringify({ value: [] })))
  h.state.lastSuccessfulAt = null
  await assert.rejects(h.run)
  assert.equal(h.saved.length, 0)
  assert.equal(h.state.lastSuccessfulAt, null)
  assert.ok(!h.diagnostics.join('').includes('retained'))
})

test('published Graph top1 example and a valid continuation variant save only current rows', async (t) => {
  t.mock.method(Date, 'now', () => now)
  // Minimal score fields from the official list-securescores response example.
  // This published example has no nextLink; it is not live-tenant evidence.
  const example = { id: '00000001-0001-0001-0001-000000000001c_2019-03-19',
    createdDateTime: '2019-03-19T15:21:00Z', currentScore: 387, maxScore: 697 }
  const h = harness(() => new Response(JSON.stringify({ value: [example] })))
  await h.run()
  assert.deepEqual(h.saved[0][2].rows, [example])
  const continuation = harness(() => new Response(JSON.stringify({ value: [example],
    '@odata.nextLink': 'https://graph.microsoft.com/v1.0/security/secureScores?$skip=1' })))
  await continuation.run()
  assert.equal(continuation.calls.length, 1)
  assert.deepEqual(continuation.saved[0][2].rows, [example])
})

test('v3: bounded current score ignores a valid continuation without another request', async (t) => {
  t.mock.method(Date, 'now', () => now)
  let requests = 0
  const h = harness(() => {
    assert.equal(++requests, 1, 'current-score query must not follow history')
    return new Response(JSON.stringify({ value: [valid], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/security/secureScores?$skiptoken=opaque%2Bvalue' }))
  })
  await h.run()
  assert.deepEqual(h.saved[0][2].rows, [valid])
  assert.equal(h.calls.length, 1)
})

for (const [status, warning] of [[206, 'provider/failure'], [206, null], [200, 'provider/failure'], [200, ''], [200, 'malformed-warning'], [200, 'provider-one/403, provider-two/504'], [201, null], [202, null]] as const) {
  test(`v3: rejects status${status} warning${String(warning)} before saving`, async (t) => {
    t.mock.method(Date, 'now', () => now)
    let cancelled = false
    const h = harness(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ value: [valid] }))); controller.close() },
      cancel() { cancelled = true },
    }), { status, headers: warning === null ? {} : { WaRnInG: warning } }))
    await assert.rejects(h.run)
    assert.equal(cancelled, true)
    assert.equal(h.saved.length, 0)
    assert.equal(h.recovered, 0)
    assert.equal(h.state.lastSuccessfulAt, h.lastSuccessfulAt)
  })
}

for (const next of ['', null, 42, 'https://foreign.invalid/v1.0/security/secureScores',
  'https://graph.microsoft.com/v1.0/users?$skip=1', 'not-a-url',
  'https://user@graph.microsoft.com/v1.0/security/secureScores',
  'https://graph.microsoft.com/v1.0/security/secureScores#fragment',
  `https://graph.microsoft.com/v1.0/security/secureScores?$skiptoken=${'x'.repeat(4096)}`]) {
  test(`malformed or out-of-scope continuation ${String(next).slice(0, 60)} is refused without follow`, async (t) => {
    t.mock.method(Date, 'now', () => now)
    const h = harness(() => new Response(JSON.stringify({ value: [valid], '@odata.nextLink': next })))
    await assert.rejects(h.run)
    assert.equal(h.calls.length, 1)
    assert.equal(h.saved.length, 0)
    assert.equal(h.state.lastSuccessfulAt, h.lastSuccessfulAt)
  })
}

test('partial provider failure then valid continuation recovers in the same wrapper instance', async (t) => {
  t.mock.method(Date, 'now', () => now)
  let partial = true
  const h = harness(() => new Response(JSON.stringify({ value: [valid], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/security/secureScores?$skip=1' }),
    { status: partial ? 206 : 200, headers: partial ? { Warning: 'secret-provider-warning' } : {} }))
  await assert.rejects(h.run)
  assert.equal(h.state.status, 'FAILED')
  assert.equal(h.saved.length, 0)
  assert.equal(h.state.lastSuccessfulAt, h.lastSuccessfulAt)
  assert.equal(h.recovered, 0)
  partial = false
  await h.run()
  assert.equal(h.calls.length, 2)
  assert.equal(h.saved.length, 1)
  assert.equal(h.state.status, 'SUCCEEDED')
  assert.equal(h.state.consecutiveFailures, 0)
  assert.equal(h.recovered, 1)
  assert.ok(!h.diagnostics.join('').includes('secret-provider-warning'))
})

test('interleaved providers and equal-instant offsets keep newest and tie-last scalar semantics', async (t) => {
  t.mock.method(Date, 'now', () => now)
  const rows = [{ ...valid, id: 'provider-a', createdDateTime: '2026-09-26T17:30:00+05:30', currentScore: 60 },
    { ...valid, id: 'old-provider', createdDateTime: '2020-01-01T00:00:00Z', currentScore: 99 },
    { ...valid, id: 'provider-b', createdDateTime: '2026-09-26T08:00:00-04:00', currentScore: 80 }]
  for (const ordered of [rows, [...rows].reverse()]) {
    const h = harness(() => new Response(JSON.stringify({ value: ordered, '@odata.nextLink': 'https://graph.microsoft.com/v1.0/security/secureScores?$skip=1' })))
    await h.run()
    assert.deepEqual(h.saved[0][2].rows, ordered)
    assert.equal(getMicrosoftSecureScore(h.saved[0][2].rows), getMicrosoftSecureScore(ordered))
  }
})

test('exact wire byte and row boundaries succeed without weakening the limits', async (t) => {
  t.mock.method(Date, 'now', () => now)
  const cap = entraCollectionLimitsForResource('SECURE_SCORES').pageBytes
  const base = { value: [valid], unused: '' }
  const text = JSON.stringify({ ...base, unused: 'x'.repeat(cap - Buffer.byteLength(JSON.stringify(base))) })
  assert.equal(Buffer.byteLength(text), cap)
  const bytes = harness(() => new Response(text))
  await bytes.run()
  assert.deepEqual(bytes.saved[0][2].rows, [valid])
  const hundred = Array.from({ length: 100 }, (_, i) => ({ ...valid, id: String(i) }))
  const rows = harness(() => new Response(JSON.stringify({ value: hundred })))
  await rows.run()
  assert.equal(rows.saved[0][2].rows.length, 100)
})

test('actual snapshot write gate scopes current scores and never invents historical removals', async () => {
  const tenant = { id: 'tenant', organizationId: 'org' }
  const previous = [{ ...valid, id: 'older', createdDateTime: '2020-01-01T00:00:00Z' }, valid]
  let persisted: unknown; let transactions = 0; let evidenceWrites = 0
  const tx = {
    $executeRawUnsafe: async () => 0,
    $queryRawUnsafe: async () => [{ timezone: 'UTC' }],
    tenantEntraSnapshot: {
      findUnique: async () => ({ payload: previous, observedAt: new Date('2025-01-01'), organizationId: tenant.organizationId }),
      upsert: async ({ update }: any) => { persisted = update.payload },
    },
    changeEvidenceEvent: { createMany: async () => { evidenceWrites++; return { count: 0 } } },
  }
  const service: any = new TenantSyncService({ $transaction: async (work: any) => { transactions++; return work(tx) } } as any, {} as any, {} as any, {} as any, {} as any, {} as any)
  service.changeEvidence = new ChangeEvidenceService({} as any)
  await service.saveSnapshot(tenant, 'SECURE_SCORES', currentScoreSnapshot([valid]))
  assert.deepEqual(persisted, [valid])
  assert.equal(evidenceWrites, 0)
  assert.equal(getMicrosoftSecureScore(persisted), getMicrosoftSecureScore(previous))
  assert.equal(transactions, 1)
  await assert.rejects(() => service.saveSnapshot(tenant, 'DOMAINS', currentScoreSnapshot([])), /partial or unverified/)
  await assert.rejects(() => service.saveSnapshot(tenant, 'SECURE_SCORES', partialSnapshot([])), /partial or unverified/)
  assert.equal(transactions, 1, 'refused scopes must never enter persistence')
  await service.saveSnapshot(tenant, 'SECURE_SCORES', authoritativeSnapshot([valid]))
  assert.equal(transactions, 2, 'existing authoritative snapshots remain supported')
})
