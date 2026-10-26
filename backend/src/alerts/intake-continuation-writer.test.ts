import assert from 'node:assert/strict'
import test from 'node:test'
import {
  commitActiveIntakeReceipt, INTAKE_RECEIPT_TRANSACTION_LIMITS,
  type IntakeReceiptRunner, type IntakeReceiptTransactionLimits,
} from './intake-continuation-writer.js'
import type { IntakeSourceSnapshot } from './intake-continuation-policy.js'
import type { SqlRunner } from './pipeline-store.js'

const source: IntakeSourceSnapshot = {
  id: '00000000-0000-0000-0000-000000000001',
  organizationId: '00000000-0000-0000-0000-000000000002',
  customerTenantId: '00000000-0000-0000-0000-000000000003',
  matchedResultId: '00000000-0000-0000-0000-000000000004',
  dedupeKey: 'stable-source', ruleId: 'HV-ID-AUTH-001.v1', ruleVersion: 'v1',
  subjectType: 'USER', subjectId: 'subject-a', state: 'OPEN',
  severity: 'HIGH', confidence: 'MEDIUM', coverage: 'FULL',
  observedAt: '2026-10-25T10:00:00.123456Z',
  expiresAt: '2026-10-26T10:00:00.123456Z',
  updatedAt: '2026-10-25T10:01:00.123456Z',
}

function sourceRow(current: IntakeSourceSnapshot) {
  return {
    id: current.id, organization_id: current.organizationId,
    customer_tenant_id: current.customerTenantId,
    matched_result_id: current.matchedResultId, dedupe_key: current.dedupeKey,
    rule_id: current.ruleId, rule_version: current.ruleVersion,
    subject_type: current.subjectType, subject_id: current.subjectId,
    state: current.state, severity: current.severity,
    confidence: current.confidence, coverage: current.coverage,
    observed_at_exact: current.observedAt, expires_at_exact: current.expiresAt,
    updated_at_exact: current.updatedAt,
  }
}

function fixture(options: {
  current?: IntakeSourceSnapshot | null
  prior?: { organizationId?: string; outcome: string; mappingRevision?: string } | null
  claimed?: number
  receiptLockError?: Error
  decisionClock?: string | null
  finalClock?: string | null
} = {}) {
  const attempted: string[] = []
  const committed: string[] = []
  const queries: Array<{ sql: string; params: readonly unknown[] }> = []
  const executes: Array<{ sql: string; params: readonly unknown[] }> = []
  const transactionLimits: IntakeReceiptTransactionLimits[] = []
  let clockReads = 0
  const transactionRunner: SqlRunner = {
    async query<T>(sql: string, params: readonly unknown[]): Promise<readonly T[]> {
      queries.push({ sql, params })
      if (sql.includes('FROM identity_risk_findings f')) {
        const current = options.current === undefined ? source : options.current
        return (current === null ? [] : [sourceRow(current)]) as T[]
      }
      if (sql.includes('FROM alert_finding_intake_status')) {
        if (options.receiptLockError) throw options.receiptLockError
        if (!options.prior) return []
        return [{
          finding_id: source.id,
          organization_id: options.prior.organizationId ?? source.organizationId,
          customer_tenant_id: source.customerTenantId,
          source_rule_id: source.ruleId, source_rule_version: source.ruleVersion,
          outcome: options.prior.outcome,
          mapping_revision: options.prior.mappingRevision ?? 'map-a',
        }] as T[]
      }
      if (sql.includes('clock_timestamp()')) {
        const value = ++clockReads === 1 ? options.decisionClock :
          options.finalClock === undefined ? options.decisionClock : options.finalClock
        return (value === null ? [] : [{
          decided_at_exact: value ?? '2026-10-25T12:00:00.000000Z',
        }]) as T[]
      }
      throw new Error('UNEXPECTED_QUERY')
    },
    async execute(sql: string, params: readonly unknown[]): Promise<number> {
      executes.push({ sql, params })
      if (sql.startsWith('SET LOCAL ')) return 0
      if (sql.includes('INSERT INTO alert_finding_intake_status')) {
        attempted.push('receipt')
        return options.claimed ?? 1
      }
      attempted.push('effect')
      return 1
    },
    async transaction<T>(run: (tx: SqlRunner) => Promise<T>): Promise<T> {
      return run(transactionRunner)
    },
  }
  const runner: IntakeReceiptRunner = {
    query: transactionRunner.query,
    execute: transactionRunner.execute,
    async transaction<T>(_run: (tx: SqlRunner) => Promise<T>): Promise<T> {
      throw new Error('UNBOUNDED_TRANSACTION_USED')
    },
    async transactionWithLimits<T>(
      limits: IntakeReceiptTransactionLimits,
      run: (tx: SqlRunner) => Promise<T>,
    ): Promise<T> {
      transactionLimits.push(limits)
      const result = await run(transactionRunner)
      committed.push(...attempted)
      return result
    },
  }
  return { runner, attempted, committed, queries, executes, transactionLimits }
}

const writeEffect = (tx: SqlRunner) => tx.execute('INSERT INTO synthetic_effect VALUES (1)', []).then(() => undefined)
const dataWrites = (f: ReturnType<typeof fixture>) =>
  f.executes.filter(each => !each.sql.startsWith('SET LOCAL '))

test('inactive seam locks exact source and claims receipt before database-only effects', async () => {
  const f = fixture()
  const result = await commitActiveIntakeReceipt(f.runner, source, 'map-a', 'COMPLETED', writeEffect)
  assert.deepEqual(result, { kind: 'COMMITTED' })
  assert.deepEqual(f.committed, ['receipt', 'effect'])
  assert.deepEqual(f.transactionLimits, [INTAKE_RECEIPT_TRANSACTION_LIMITS])
  assert.deepEqual(f.executes.slice(0, 2).map(each => each.sql),
    ["SET LOCAL lock_timeout = '500ms'", "SET LOCAL statement_timeout = '2500ms'"])
  assert.deepEqual(f.executes.slice(0, 2).map(each => each.params), [[], []])
  assert.match(f.queries[0].sql, /FOR UPDATE OF f NOWAIT/)
  assert.deepEqual(f.queries[0].params,
    [source.id, source.organizationId, source.customerTenantId])
  assert.match(f.queries[1].sql, /FOR UPDATE/)
  assert.match(f.queries[2].sql, /clock_timestamp\(\)/)
  assert.doesNotMatch(f.queries[2].sql, /\bnow\(\)|CURRENT_TIMESTAMP/i)
  assert.match(f.executes[2].sql, /ON CONFLICT \(finding_id\) DO UPDATE/)
  assert.match(f.executes[2].sql, /outcome = 'BLOCKED_UNMAPPED'/)
  assert.match(f.executes[2].sql, /INTERVAL '2160 hours'/)
  assert.equal(f.executes[2].params[7], '2026-10-25T12:00:00.000000Z')
})

test('invalid database decision clock refuses a receipt and all effects', async () => {
  for (const invalid of [
    '2026-10-25T12:00:00.000',
    '2026-10-25T12:00:00.000+00:00',
    '2026-10-25T12:00:00Z',
    '2026-02-30T12:00:00.000Z',
    '2026-10-25T12:00:00.1234Z',
    null,
  ]) {
    const f = fixture({ decisionClock: invalid })
    assert.deepEqual(await commitActiveIntakeReceipt(f.runner, source, 'map-a', 'COMPLETED', writeEffect),
      { kind: 'REFUSED', reason: 'UNTRUSTED_TIME' }, String(invalid))
    assert.deepEqual(f.transactionLimits, [INTAKE_RECEIPT_TRANSACTION_LIMITS], String(invalid))
    assert.deepEqual(dataWrites(f), [], String(invalid))
  }
  const precise = fixture({ decisionClock: '2026-10-25T12:00:00.123456Z' })
  assert.deepEqual(await commitActiveIntakeReceipt(precise.runner, source, 'map-a', 'COMPLETED',
    writeEffect), { kind: 'COMMITTED' })
  assert.equal(precise.executes[2].params[7], '2026-10-25T12:00:00.123456Z')
})

test('caller cannot claim a historical outcome through the active writer', async () => {
  const f = fixture()
  await assert.rejects(commitActiveIntakeReceipt(f.runner, source, 'map-a',
    'AGED_OUT_RECORDED' as 'COMPLETED', writeEffect), /INVALID_INTAKE_RECEIPT_INPUT/)
  assert.deepEqual(f.transactionLimits, [])
  assert.deepEqual(dataWrites(f), [])
})

test('a finding aged or expired after selection cannot claim active effects', async () => {
  for (const [current, decisionClock, reason] of [
    [{ ...source, expiresAt: '2026-10-27T10:00:00.123456Z' },
      '2026-10-26T10:00:00.123457Z', 'HISTORICAL_ONLY'],
    [{ ...source, observedAt: '2026-10-26T09:00:00.000000Z' },
      '2026-10-26T10:00:00.123456Z', 'HISTORICAL_ONLY'],
    [{ ...source, state: 'EXPIRED' }, '2026-10-25T12:00:00.000000Z', 'HISTORICAL_ONLY'],
    [{ ...source, state: 'RESOLVED' }, '2026-10-25T12:00:00.000000Z', 'INELIGIBLE'],
  ] as const) {
    const f = fixture({ current, decisionClock })
    assert.deepEqual(await commitActiveIntakeReceipt(f.runner, current, 'map-a', 'COMPLETED',
      writeEffect), { kind: 'REFUSED', reason })
    assert.deepEqual(dataWrites(f), [], reason)
  }
})

test('a callback crossing the active boundary rolls its receipt and effects back', async () => {
  for (const [current, decisionClock, finalClock] of [
    [source, '2026-10-26T10:00:00.123455Z', '2026-10-26T10:00:00.123456Z'],
    [{ ...source, expiresAt: '2026-10-27T10:00:00.123456Z' },
      '2026-10-26T10:00:00.123456Z', '2026-10-26T10:00:00.123457Z'],
    [source, '2026-10-25T12:00:00.000000Z', null],
  ] as const) {
    const f = fixture({ current, decisionClock, finalClock })
    await assert.rejects(commitActiveIntakeReceipt(f.runner, current, 'map-a',
      'COMPLETED', writeEffect), /INTAKE_ACTIVE_EFFECT_BOUNDARY_CROSSED/)
    assert.deepEqual(f.attempted, ['receipt', 'effect'])
    assert.deepEqual(f.committed, [])
    assert.equal(f.queries.filter(each => each.sql.includes('clock_timestamp()')).length, 2)
  }
})

test('receipt-row lock failure rolls back before the claim and effects', async () => {
  const lockError = Object.assign(new Error('LOCK_NOT_AVAILABLE'), { code: '55P03' })
  const f = fixture({ receiptLockError: lockError })
  await assert.rejects(commitActiveIntakeReceipt(f.runner, source, 'map-a', 'COMPLETED',
    writeEffect), (error: unknown) => error === lockError)
  assert.deepEqual(f.transactionLimits, [INTAKE_RECEIPT_TRANSACTION_LIMITS])
  assert.deepEqual(f.attempted, [])
  assert.deepEqual(f.committed, [])
})

test('changed microsecond source version refuses all receipt and effect writes', async () => {
  const f = fixture({ current: { ...source, updatedAt: '2026-10-25T10:01:00.123457Z' } })
  assert.deepEqual(await commitActiveIntakeReceipt(f.runner, source, 'map-a', 'COMPLETED', writeEffect),
  { kind: 'REFUSED', reason: 'SOURCE_CHANGED' })
  assert.deepEqual(f.committed, [])
  assert.deepEqual(dataWrites(f), [])
})

test('source removed or moved before lock cannot get a receipt', async () => {
  const f = fixture({ current: null })
  assert.deepEqual(await commitActiveIntakeReceipt(f.runner, source, 'map-a', 'COMPLETED', writeEffect),
  { kind: 'REFUSED', reason: 'SOURCE_MISSING_OR_MOVED' })
  assert.deepEqual(dataWrites(f), [])
})

test('terminal receipt and unchanged unmapped receipt cannot run effects again', async () => {
  for (const prior of [{ outcome: 'COMPLETED' }, { outcome: 'BLOCKED_UNMAPPED' }]) {
    const f = fixture({ prior })
    assert.deepEqual(await commitActiveIntakeReceipt(f.runner, source, 'map-a', 'COMPLETED', writeEffect),
    { kind: 'REFUSED', reason: 'ALREADY_DECIDED' })
    assert.deepEqual(dataWrites(f), [])
  }
})

test('changed reviewed mapping can retry only a blocked finding', async () => {
  const f = fixture({ prior: { outcome: 'BLOCKED_UNMAPPED', mappingRevision: 'map-a' } })
  assert.deepEqual(await commitActiveIntakeReceipt(f.runner, source, 'map-b', 'COMPLETED', writeEffect),
  { kind: 'COMMITTED' })
  assert.deepEqual(f.committed, ['receipt', 'effect'])
})

test('scope-conflicting receipt is refused without effects', async () => {
  const f = fixture({ prior: { organizationId: '00000000-0000-0000-0000-000000000099', outcome: 'COMPLETED' } })
  assert.deepEqual(await commitActiveIntakeReceipt(f.runner, source, 'map-a', 'COMPLETED', writeEffect),
  { kind: 'REFUSED', reason: 'SCOPE_MISMATCH' })
  assert.deepEqual(dataWrites(f), [])
})

test('lost receipt claim aborts before effects; later effect failure rolls receipt back', async () => {
  const lost = fixture({ claimed: 0 })
  await assert.rejects(commitActiveIntakeReceipt(lost.runner, source, 'map-a', 'COMPLETED',
    writeEffect), /INTAKE_RECEIPT_CLAIM_LOST/)
  assert.deepEqual(lost.attempted, ['receipt'])
  assert.deepEqual(lost.committed, [])

  const failed = fixture()
  await assert.rejects(commitActiveIntakeReceipt(failed.runner, source, 'map-a', 'COMPLETED',
    async tx => {
      await writeEffect(tx)
      throw new Error('EFFECT_FAILED')
    }), /EFFECT_FAILED/)
  assert.deepEqual(failed.attempted, ['receipt', 'effect'])
  assert.deepEqual(failed.committed, [])
})
