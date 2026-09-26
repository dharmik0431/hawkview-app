import assert from 'node:assert/strict'
import test from 'node:test'
import { composeTenantAssessment, type TenantAssessment } from '../evaluation-core/compose.js'
import type { Finding } from '../evaluation-core/contract.js'
import { nativePublicationRows, mayResolveNativeAbsence, publishNativeAssessment } from './native-alert-publisher.js'

const input = {
  organizationId: 'org', customerTenantId: 'tenant', rowsFetched: 5, sources: [],
  windowStart: new Date('2026-08-11T00:00:00Z'), windowEnd: new Date('2026-09-10T00:00:00Z'),
  completedAt: new Date('2026-09-10T00:00:00Z'), expiresAt: new Date('2026-12-09T00:00:00Z'),
}
const finding: Finding = {
  detectorId: 'repeated-credential-failure',
  subject: { kind: 'DIRECTORY_USER', userRef: 'opaque-subject',
    correlation: { available: true, matchedBy: 'DIRECTORY_OBJECT_ID', ref: 'opaque-subject' } },
  signals: [
    { signal: 'PASSWORD_REJECTED', count: 5, capped: false,
      latest: { at: '2026-09-09T00:00:00Z', kind: 'EVENT_OCCURRED' } },
    { signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES', count: 0, capped: false, latest: null },
  ],
}
const assessment = (items: readonly Finding[] = [finding]): TenantAssessment => ({
  ...composeTenantAssessment([]), findings: { complete: true, items },
})

type Options = { prior?: unknown; latest?: Date; foreign?: boolean; failAt?: string }
function database(options: Options = {}) {
  const events: { name: string; data: any }[] = []
  const committed: typeof events = []
  const capture = (name: string, data?: unknown) => {
    if (options.failAt === name) throw new Error('SYNTHETIC_WRITE_FAILURE')
    events.push({ name, data })
  }
  const tx = {
    $queryRawUnsafe: async (sql: string, first: string, second: string) => {
      if (sql.includes('FROM identity_risk_operational_controls')) return []
      if (sql.includes('FROM organizations')) { assert.equal(first, input.organizationId); return [{ id: first }] }
      assert.equal(first, input.customerTenantId); assert.equal(second, input.organizationId)
      if (sql.includes('FROM tenant_connections')) return [{ id: 'connection' }]
      assert.match(sql, /FROM customer_tenants/)
      capture('scope'); return options.foreign ? [] : [{ id: first }]
    },
    $executeRawUnsafe: async (sql: string, org: string, tenant: string, payload: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return 0
      capture('standing', { sql, org, tenant, rows: JSON.parse(payload) }); return 1
    },
    identityRiskEvaluationRun: {
      findUnique: async ({ where }: any) => {
        assert.equal(where.organizationId_customerTenantId_runKey.organizationId, input.organizationId)
        assert.equal(where.organizationId_customerTenantId_runKey.customerTenantId, input.customerTenantId)
        return options.prior === undefined ? null : { id: 'existing-run', evaluationFindings: options.prior }
      },
      findFirst: async () => options.latest ? { windowEnd: options.latest } : null,
      create: async ({ data }: any) => { capture('run', data); return { id: 'new-run' } },
      update: async ({ data }: any) => { capture('marker', data); return {} },
    },
    identityRiskMatchedResult: { createMany: async ({ data }: any) => { capture('matched', data); return { count: data.length } } },
    identityRiskFinding: { updateMany: async (args: any) => { capture('lifecycle', args); return { count: 0 } } },
  }
  return { events, committed, db: {
    $transaction: async (run: (client: typeof tx) => Promise<unknown>) => {
      // Models commit visibility for orchestration only; real rollback is a DB gate.
      const result = await run(tx)
      committed.push(...events)
      return result
    },
  } }
}

test('native publication carries all six NOT_ASSESSED fields and source occurrence, not evaluation time', () => {
  const [row] = nativePublicationRows(assessment(), input, 'run-one')
  assert.ok(row)
  for (const side of [row.pair.matched, row.pair.finding]) {
    for (const key of ['severity', 'confidence', 'coverage'] as const) assert.equal(side[key], 'NOT_ASSESSED')
  }
  assert.equal(row.observedAt.toISOString(), '2026-09-09T00:00:00.000Z')
  assert.equal(row.expiresAt.toISOString(), '2026-12-08T00:00:00.000Z')
  const [retry] = nativePublicationRows(assessment(), input, 'run-two')
  assert.equal(row.pair.finding.dedupeKey, retry!.pair.finding.dedupeKey)
  assert.notEqual(row.pair.matched.resultKey, retry!.pair.matched.resultKey)
  const [foreign] = nativePublicationRows(assessment(), { ...input, organizationId: 'other-org' }, 'run-one')
  assert.notEqual(row.pair.finding.dedupeKey, foreign!.pair.finding.dedupeKey)
})

test('unknown detector, missing/out-of-window occurrence and expired evidence cannot become open findings', () => {
  assert.throws(() => nativePublicationRows(assessment([{ ...finding, detectorId: 'unapproved' }]), input, 'run'))
  for (const at of ['not-a-date', '2026-09-11T00:00:00Z', '2026-08-10T00:00:00Z']) {
    const altered: Finding = { ...finding, signals: [{ ...finding.signals[0], latest: { at, kind: 'EVENT_OCCURRED' } }] }
    assert.throws(() => nativePublicationRows(assessment([altered]), input, 'run'), /INVALID_OBSERVATION/)
  }
  assert.deepEqual(nativePublicationRows(assessment(), { ...input, expiresAt: input.completedAt }, 'run'), [])
})

test('real publisher orchestration writes run, matched parent, standing finding and marker in one transaction', async () => {
  const { db, committed } = database()
  assert.deepEqual(await publishNativeAssessment(db as never, assessment(), input), { id: 'new-run', publication: 'PUBLISHED' })
  assert.deepEqual(committed.map(e => e.name), ['scope', 'run', 'matched', 'standing', 'lifecycle', 'marker'])
  const matched = committed.find(e => e.name === 'matched')!.data[0]
  const standing = committed.find(e => e.name === 'standing')!.data
  assert.equal(matched.evaluationRunId, 'new-run')
  assert.equal(standing.rows[0].matched_id, matched.id)
  assert.equal(standing.org, input.organizationId)
  assert.equal(standing.tenant, input.customerTenantId)
  assert.match(standing.sql, /EXCLUDED.observed_at >= existing.observed_at/)
  assert.deepEqual(committed.at(-1)!.data.evaluationFindings.nativeAlertPublication, { version: 1, status: 'PUBLISHED' })
})

test('scope failure and each publisher write failure cannot report a committed publication', async () => {
  for (const failAt of ['run', 'matched', 'standing', 'lifecycle', 'marker']) {
    const { db, committed } = database({ failAt })
    await assert.rejects(publishNativeAssessment(db as never, assessment(), input), /SYNTHETIC_WRITE_FAILURE/)
    assert.deepEqual(committed, [])
  }
  const { db, committed, events } = database({ foreign: true })
  await assert.rejects(publishNativeAssessment(db as never, assessment(), input), /SCOPE_UNAVAILABLE/)
  assert.deepEqual(committed, [])
  assert.deepEqual(events.map(e => e.name), ['scope'])
})

test('a historical run key is not publication proof and a committed retry does not publish twice', async () => {
  for (const [prior, publication] of [
    [{ version: 'hawkview-run-findings/v1' }, 'HISTORICAL_NOT_REPLAYED'],
    [{ nativeAlertPublication: { version: 1, status: 'PUBLISHED' } }, 'ALREADY_PUBLISHED'],
  ] as const) {
    const { db, events } = database({ prior })
    assert.deepEqual(await publishNativeAssessment(db as never, assessment(), input), { id: 'existing-run', publication })
    assert.deepEqual(events.map(e => e.name), ['scope'])
  }
  const { db } = database({ prior: { nativeAlertPublication: { version: 99, status: 'PUBLISHED' } } })
  await assert.rejects(publishNativeAssessment(db as never, assessment(), input), /INVALID_MARKER/)
})

test('an older delayed window records assessment but never regresses standing findings', async () => {
  const { db, events } = database({ latest: new Date('2026-09-11T00:00:00Z') })
  const result = await publishNativeAssessment(db as never, assessment(), input)
  assert.equal(result.publication, 'OLDER_WINDOW_NOT_PUBLISHED')
  assert.deepEqual(events.map(e => e.name), ['scope', 'run', 'marker'])
})

test('only complete and authoritative absence resolves; expiry remains scoped to this native rule', async () => {
  assert.equal(mayResolveNativeAbsence(assessment([])), false)
  const complete: TenantAssessment = { ...assessment([]), claim: { permitted: true } }
  assert.equal(mayResolveNativeAbsence(complete), true)
  const incomplete: TenantAssessment = { ...complete,
    findings: { complete: false, items: [], because: ['WINDOW_TRUNCATED'] } }
  assert.equal(mayResolveNativeAbsence(incomplete), false)
  const partial = database()
  await publishNativeAssessment(partial.db as never, incomplete, input)
  assert.deepEqual(partial.events.filter(e => e.name === 'lifecycle').map(e => e.data.data.state), ['EXPIRED'])
  const { db, events } = database()
  await publishNativeAssessment(db as never, complete, input)
  const updates = events.filter(e => e.name === 'lifecycle').map(e => e.data)
  assert.deepEqual(updates.map(u => u.data.state), ['EXPIRED', 'RESOLVED'])
  for (const { where } of updates) {
    assert.equal(where.organizationId, input.organizationId)
    assert.equal(where.customerTenantId, input.customerTenantId)
    assert.equal(where.ruleId, 'HV-ID-AUTH-011.v1')
    assert.equal(where.state, 'OPEN')
  }
})

test('publication batches parent/standing writes at 128 without changing stable subject keys', async () => {
  const items = Array.from({ length: 129 }, (_, i): Finding => ({ ...finding,
    subject: { ...finding.subject, kind: 'DIRECTORY_USER', userRef: `opaque-${i}` } as Finding['subject'],
  }))
  const { db, events } = database()
  await publishNativeAssessment(db as never, assessment(items), input)
  assert.deepEqual(events.filter(e => e.name === 'matched').map(e => e.data.length), [128, 1])
})
