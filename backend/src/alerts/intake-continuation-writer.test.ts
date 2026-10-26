import assert from 'node:assert/strict'
import test from 'node:test'
import { commitActiveIntakeReceipt } from './intake-continuation-writer.js'
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
} = {}) {
  const attempted: string[] = []
  const committed: string[] = []
  const queries: Array<{ sql: string; params: readonly unknown[] }> = []
  const executes: Array<{ sql: string; params: readonly unknown[] }> = []
  const transactionRunner: SqlRunner = {
    async query<T>(sql: string, params: readonly unknown[]): Promise<readonly T[]> {
      queries.push({ sql, params })
      if (sql.includes('FROM identity_risk_findings f')) {
        const current = options.current === undefined ? source : options.current
        return (current === null ? [] : [sourceRow(current)]) as T[]
      }
      if (sql.includes('FROM alert_finding_intake_status')) {
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
      throw new Error('UNEXPECTED_QUERY')
    },
    async execute(sql: string, params: readonly unknown[]): Promise<number> {
      executes.push({ sql, params })
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
  const runner: SqlRunner = {
    query: transactionRunner.query,
    execute: transactionRunner.execute,
    async transaction<T>(run: (tx: SqlRunner) => Promise<T>): Promise<T> {
      const result = await run(transactionRunner)
      committed.push(...attempted)
      return result
    },
  }
  return { runner, attempted, committed, queries, executes }
}

const writeEffect = (tx: SqlRunner) => tx.execute('INSERT INTO synthetic_effect VALUES (1)', []).then(() => undefined)

test('inactive seam locks exact source and claims receipt before database-only effects', async () => {
  const f = fixture()
  const result = await commitActiveIntakeReceipt(f.runner, source, 'map-a', 'COMPLETED',
    '2026-10-25T12:00:00.000Z', writeEffect)
  assert.deepEqual(result, { kind: 'COMMITTED' })
  assert.deepEqual(f.committed, ['receipt', 'effect'])
  assert.match(f.queries[0].sql, /FOR UPDATE OF f NOWAIT/)
  assert.deepEqual(f.queries[0].params,
    [source.id, source.organizationId, source.customerTenantId])
  assert.match(f.queries[1].sql, /FOR UPDATE/)
  assert.match(f.executes[0].sql, /ON CONFLICT \(finding_id\) DO UPDATE/)
  assert.match(f.executes[0].sql, /outcome = 'BLOCKED_UNMAPPED'/)
  assert.match(f.executes[0].sql, /INTERVAL '2160 hours'/)
})

test('changed microsecond source version refuses all receipt and effect writes', async () => {
  const f = fixture({ current: { ...source, updatedAt: '2026-10-25T10:01:00.123457Z' } })
  assert.deepEqual(await commitActiveIntakeReceipt(f.runner, source, 'map-a', 'COMPLETED',
    '2026-10-25T12:00:00.000Z', writeEffect),
  { kind: 'REFUSED', reason: 'SOURCE_CHANGED' })
  assert.deepEqual(f.committed, [])
  assert.deepEqual(f.executes, [])
})

test('source removed or moved before lock cannot get a receipt', async () => {
  const f = fixture({ current: null })
  assert.deepEqual(await commitActiveIntakeReceipt(f.runner, source, 'map-a', 'COMPLETED',
    '2026-10-25T12:00:00.000Z', writeEffect),
  { kind: 'REFUSED', reason: 'SOURCE_MISSING_OR_MOVED' })
  assert.deepEqual(f.executes, [])
})

test('terminal receipt and unchanged unmapped receipt cannot run effects again', async () => {
  for (const prior of [{ outcome: 'COMPLETED' }, { outcome: 'BLOCKED_UNMAPPED' }]) {
    const f = fixture({ prior })
    assert.deepEqual(await commitActiveIntakeReceipt(f.runner, source, 'map-a', 'COMPLETED',
      '2026-10-25T12:00:00.000Z', writeEffect),
    { kind: 'REFUSED', reason: 'ALREADY_DECIDED' })
    assert.deepEqual(f.executes, [])
  }
})

test('changed reviewed mapping can retry only a blocked finding', async () => {
  const f = fixture({ prior: { outcome: 'BLOCKED_UNMAPPED', mappingRevision: 'map-a' } })
  assert.deepEqual(await commitActiveIntakeReceipt(f.runner, source, 'map-b', 'COMPLETED',
    '2026-10-25T12:00:00.000Z', writeEffect),
  { kind: 'COMMITTED' })
  assert.deepEqual(f.committed, ['receipt', 'effect'])
})

test('scope-conflicting receipt is refused without effects', async () => {
  const f = fixture({ prior: { organizationId: '00000000-0000-0000-0000-000000000099', outcome: 'COMPLETED' } })
  assert.deepEqual(await commitActiveIntakeReceipt(f.runner, source, 'map-a', 'COMPLETED',
    '2026-10-25T12:00:00.000Z', writeEffect),
  { kind: 'REFUSED', reason: 'SCOPE_MISMATCH' })
  assert.deepEqual(f.executes, [])
})

test('lost receipt claim aborts before effects; later effect failure rolls receipt back', async () => {
  const lost = fixture({ claimed: 0 })
  await assert.rejects(commitActiveIntakeReceipt(lost.runner, source, 'map-a', 'COMPLETED',
    '2026-10-25T12:00:00.000Z', writeEffect), /INTAKE_RECEIPT_CLAIM_LOST/)
  assert.deepEqual(lost.attempted, ['receipt'])
  assert.deepEqual(lost.committed, [])

  const failed = fixture()
  await assert.rejects(commitActiveIntakeReceipt(failed.runner, source, 'map-a', 'COMPLETED',
    '2026-10-25T12:00:00.000Z', async tx => {
      await writeEffect(tx)
      throw new Error('EFFECT_FAILED')
    }), /EFFECT_FAILED/)
  assert.deepEqual(failed.attempted, ['receipt', 'effect'])
  assert.deepEqual(failed.committed, [])
})
