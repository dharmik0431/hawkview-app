import assert from 'node:assert/strict'
import test from 'node:test'
import { NATIVE_SUMMARY_RUN_BYTES, NATIVE_SUMMARY_SQL, readNativeRiskSummary, type NativeSummaryScope } from './native-risk-summary.js'

const now = new Date('2026-09-15T12:00:00Z')
const tenant = (id = 'tenant-a', organizationId = 'org-a') => ({ id, organizationId, gate: null })
const scope = (tenants = [tenant()], totalTenants = tenants.length): NativeSummaryScope => ({ totalTenants, tenants })
function row(id = 'tenant-a', value = 2) {
  return {
    organizationId: 'org-a', customerTenantId: id, readLimitExceeded: false,
    completedAt: '2026-09-15T11:00:00.000Z', windowStart: '2026-09-01T00:00:00.000Z',
    windowEnd: '2026-09-15T10:00:00.000Z', expiresAt: '2026-09-16T00:00:00.000Z',
    evaluationCoverage: { version: 'hawkview-run-coverage/v1', streams: [{ stream: 'GRAPH_SIGN_INS', coverage: {
      version: 'hawkview-coverage/v1', collectionScope: { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' },
      applies: 10, doesNotApply: {}, notYetCited: {}, unknown: {}, unprocessable: {},
    } }] },
    evaluationFindings: {
      version: 'hawkview-run-findings/v1', complete: true, claim: { permitted: true },
      count: { accuracy: 'EXACT', value, scope: { evidenceRequested: ['GRAPH_INTERACTIVE_ONLY'], setAside: [], covered: ['synthetic-detector'], notCovered: [] } },
      // Deliberately not the same number of rows as the canonical count.
      items: Array.from({ length: value === 0 ? 0 : value + 1 }, (_, index) => ({ detectorId: 'synthetic-detector', subject: { kind: 'DIRECTORY_USER', userRef: `synthetic-private-subject-${index % value}` },
        signals: [{ signal: 'SYNTHETIC_SIGNAL', count: 99, latest: null, capped: false }] })), sources: [],
    },
  }
}
function reader(rows: unknown[]) {
  const calls: unknown[][] = []
  return { calls, client: { $queryRawUnsafe: async <T>(...args: unknown[]) => { calls.push(args); return rows as T } } }
}

test('native canonical count is not the number of finding rows; no identities escape', async () => {
  const { client, calls } = reader([row()])
  const result = await readNativeRiskSummary(client, scope(), now)
  assert.equal(result.fleet.accuracy, 'EXACT')
  assert.equal(result.fleet.distinctUserCount, 2)
  assert.equal(result.tenants[0].distinctUserCount, 2)
  assert.equal(result.countUnit, 'TENANT_USER_IDENTITIES')
  assert.equal(result.source, 'HAWKVIEW_NATIVE_ASSESSMENT')
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(calls[0][1] as string), [{ id: 'tenant-a', organizationId: 'org-a' }])
  assert.equal(calls[0][4], now.toISOString())
  assert.equal(calls[0][5], NATIVE_SUMMARY_RUN_BYTES)
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-subject|SYNTHETIC_SIGNAL|synthetic-detector|items|userRef/)
})

test('exact zero requires every tenant to have a complete current permitted verdict', async () => {
  const result = await readNativeRiskSummary(reader([row('tenant-a', 0), row('tenant-b', 0)]).client, scope([tenant(), tenant('tenant-b')]), now)
  assert.equal(result.fleet.distinctUserCount, 0)
  assert.equal(result.fleet.accuracy, 'EXACT')
  assert.equal(result.fleet.assessedTenants, 2)
})

test('mixed complete and partial runs preserve only a justified lower bound', async () => {
  const partial = row('tenant-b', 3)
  partial.evaluationFindings.complete = false
  const result = await readNativeRiskSummary(reader([row(), partial]).client, scope([tenant(), tenant('tenant-b')]), now)
  assert.equal(result.fleet.distinctUserCount, 5)
  assert.equal(result.fleet.accuracy, 'AT_LEAST')
  assert.equal(result.tenants[1].accuracy, 'AT_LEAST')
  assert.deepEqual(result.fleet.limitations, ['PARTIAL_ASSESSMENT'])
})

test('partial zero, withheld and missing runs cannot become all-clear', async () => {
  const partial = row('tenant-a', 0)
  partial.evaluationFindings.complete = false
  const withheld = row('tenant-b')
  Object.assign(withheld.evaluationFindings.count, { accuracy: 'NOT_AVAILABLE', value: null })
  const result = await readNativeRiskSummary(reader([partial, withheld]).client, scope([tenant(), tenant('tenant-b'), tenant('tenant-c')]), now)
  assert.equal(result.fleet.distinctUserCount, null)
  assert.equal(result.fleet.accuracy, 'NOT_AVAILABLE')
  assert.equal(result.fleet.assessedTenants, 2)
  assert.deepEqual(result.fleet.limitations, ['COUNT_WITHHELD', 'NO_CURRENT_RUN', 'PARTIAL_ASSESSMENT'])
})

test('empty membership scope is not zero and does not query runs', async () => {
  const { client, calls } = reader([])
  const result = await readNativeRiskSummary(client, scope([]), now)
  assert.equal(calls.length, 0)
  assert.equal(result.fleet.distinctUserCount, null)
  assert.deepEqual(result.fleet.limitations, ['NO_TENANTS'])
})

test('100 and 101 tenant boundary is explicit and never exact after truncation', async () => {
  const tenants = Array.from({ length: 100 }, (_, index) => tenant(`tenant-${index}`))
  const rows = tenants.map((entry) => row(entry.id, 1))
  const exact = await readNativeRiskSummary(reader(rows).client, scope(tenants), now)
  assert.equal(exact.fleet.accuracy, 'EXACT')
  const { client, calls } = reader(rows)
  const capped = await readNativeRiskSummary(client, scope(tenants, 101), now)
  assert.equal(calls.length, 1)
  assert.equal(capped.fleet.distinctUserCount, 100)
  assert.equal(capped.fleet.accuracy, 'AT_LEAST')
  assert.equal(capped.fleet.scopeComplete, false)
  assert.equal(capped.fleet.enumeratedTenants, 100)
  assert.deepEqual(capped.fleet.limitations, ['SCOPE_CAPPED'])
})

test('hard-disabled and rollout-disabled tenants are not queried or counted', async () => {
  const { client, calls } = reader([])
  const result = await readNativeRiskSummary(client, { totalTenants: 2, tenants: [
    { ...tenant(), gate: 'EVALUATION_DISABLED' }, { ...tenant('tenant-b'), gate: 'NOT_ENABLED_FOR_TENANT' },
  ] }, now)
  assert.equal(calls.length, 0)
  assert.equal(result.fleet.assessedTenants, 0)
  assert.equal(result.fleet.distinctUserCount, null)
})

test('foreign organization, unknown tenant, duplicate rows and invalid scopes fail closed', async () => {
  for (const rows of [[{ ...row(), organizationId: 'foreign-org' }], [row('foreign-tenant')], [row(), row()]]) {
    await assert.rejects(readNativeRiskSummary(reader(rows).client, scope(), now), /Invalid summary read/)
  }
  for (const invalid of [scope([tenant(), tenant()]), scope([tenant()], 0), scope(Array.from({ length: 101 }, (_, i) => tenant(`${i}`)))]) {
    await assert.rejects(readNativeRiskSummary(reader([]).client, invalid, now), /Invalid summary scope/)
  }
})

test('expired, invalid, absent and future clocks never permit a count', async () => {
  for (const change of [
    { expiresAt: now.toISOString() }, { completedAt: null }, { completedAt: new Date('invalid') },
    { completedAt: new Date(now.getTime() + 1).toISOString() }, { windowStart: '2026-09-16T00:00:00.000Z' },
    { windowEnd: now.toISOString() }, { expiresAt: new Date('invalid') },
    { completedAt: '2026-09-15 11:00:00' }, { completedAt: '2026-09-15T07:00:00.000-04:00' },
    { completedAt: '2026-02-30T11:00:00.000Z' },
  ]) {
    const { client, calls } = reader([{ ...row(), ...change }])
    const result = await readNativeRiskSummary(client, scope(), now)
    assert.equal(result.fleet.distinctUserCount, null)
    assert.equal(result.fleet.assessedTenants, 0)
    assert.equal(calls.length, 1, 'must not fall back to another older run')
  }
})

test('malformed persisted verdicts and hostile structures remain unavailable', async () => {
  const valid = row().evaluationFindings
  const bad: unknown[] = [null, {}, { ...valid, version: 'future' }, { ...valid, count: {} },
    { ...valid, count: { ...valid.count, accuracy: 'GUESS' } }, { ...valid, count: { ...valid.count, accuracy: ['EXACT'] } }, { ...valid, count: { ...valid.count, value: -1 } },
    { ...valid, count: { ...valid.count, value: 0.5 } }, { ...valid, count: { ...valid.count, scope: {} } },
    { ...valid, claim: { permitted: 'yes' } }, { ...valid, claim: { permitted: false } },
    JSON.parse('{"__proto__":{"secret":"never-return"}}'), Object.create(valid),
    { ...valid, debug: { constructor: 'never-return' } },
  ]
  for (const evaluationFindings of bad) {
    const result = await readNativeRiskSummary(reader([{ ...row(), evaluationFindings }]).client, scope(), now)
    assert.equal(result.tenants[0].accuracy, 'NOT_AVAILABLE')
    assert.deepEqual(result.tenants[0].limitations, ['INVALID_RUN'])
    assert.doesNotMatch(JSON.stringify(result), /never-return/)
  }
})

test('database and defensive payload budgets withhold oversized evidence', async () => {
  for (const oversized of [{ ...row(), readLimitExceeded: true, evaluationFindings: null },
    { ...row(), evaluationFindings: { ...row().evaluationFindings, debug: 'x'.repeat(NATIVE_SUMMARY_RUN_BYTES) } }]) {
    const result = await readNativeRiskSummary(reader([oversized]).client, scope(), now)
    assert.deepEqual(result.tenants[0].limitations, ['READ_LIMIT_EXCEEDED'])
  }
  assert.match(NATIVE_SUMMARY_SQL, /CASE WHEN[\s\S]*octet_length[\s\S]*THEN r.evaluation_findings ELSE NULL/)
  assert.match(NATIVE_SUMMARY_SQL, /organization_id=s\."organizationId" AND r.customer_tenant_id=s.id/)
  assert.match(NATIVE_SUMMARY_SQL, /completed_at DESC,r.id DESC/)
})

test('a missing assessment denominator cannot produce an exact all-clear', async () => {
  const empty = row('tenant-a', 0)
  empty.evaluationCoverage.streams = []
  empty.evaluationFindings.count.scope.covered = []
  empty.evaluationFindings.count.scope.evidenceRequested = []
  const result = await readNativeRiskSummary(reader([empty]).client, scope(), now)
  assert.equal(result.fleet.distinctUserCount, null)
  assert.equal(result.fleet.accuracy, 'NOT_AVAILABLE')
  assert.deepEqual(result.tenants[0].limitations, ['PARTIAL_ASSESSMENT'])
})

test('repeated and concurrent reads are deterministic; read failure never becomes partial success', async () => {
  const { client } = reader([row()])
  const results = await Promise.all(Array.from({ length: 10 }, () => readNativeRiskSummary(client, scope(), now)))
  for (const result of results) assert.deepEqual(result, results[0])
  await assert.rejects(readNativeRiskSummary({ $queryRawUnsafe: async () => { throw new Error('synthetic failure') } }, scope(), now))
})
