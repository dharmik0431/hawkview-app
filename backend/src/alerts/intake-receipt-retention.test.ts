import assert from 'node:assert/strict'
import test from 'node:test'
import {
  INTAKE_RECEIPT_CLEANUP_BATCH, pruneDueIntakeReceipts,
} from './intake-receipt-retention.js'
import type { SqlRunner } from './pipeline-store.js'

const tickAt = '2027-01-23T12:00:00.000000Z'
const orphan = { finding_id: '00000000-0000-0000-0000-000000000001',
  exact_parent_exists: false, any_parent_exists: false }
const live = { finding_id: '00000000-0000-0000-0000-000000000002',
  exact_parent_exists: true, any_parent_exists: true }

test('inactive receipt cleanup is transactional, bounded, and leaves locked rows due', async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  let transactions = 0
  const runner: SqlRunner = {
    async query<T>(sql: string, params: readonly unknown[]): Promise<readonly T[]> {
      calls.push({ sql, params })
      // A locked due head is absent from this page; the unlocked due tail is
      // still returned. The physical-DB test must prove PostgreSQL behavior.
      return [orphan, live] as T[]
    },
    async execute(sql, params) {
      calls.push({ sql, params })
      return 1
    },
    async transaction<T>(work: (tx: SqlRunner) => Promise<T>) {
      transactions++
      return work(this)
    },
  }
  const result = await pruneDueIntakeReceipts(runner, tickAt)
  assert.deepEqual(result, { inspected: 2, removed: 1, rescheduled: 1,
    scopeMismatches: 0, fullPage: false })
  assert.equal(transactions, 1)
  assert.equal(calls.length, 3)
  assert.match(calls[0].sql, /ORDER BY s\.next_cleanup_check_at, s\.finding_id\s+LIMIT 256\s+FOR UPDATE OF s SKIP LOCKED/)
  assert.match(calls[0].sql, /s\.next_cleanup_check_at <= \$1::timestamptz/)
  assert.match(calls[0].sql, /f\.organization_id = d\.organization_id\s+AND f\.customer_tenant_id = d\.customer_tenant_id/)
  assert.deepEqual(calls[0].params, [tickAt])
  assert.match(calls[1].sql, /DELETE FROM alert_finding_intake_status/)
  assert.match(calls[1].sql, /NOT EXISTS \(SELECT 1 FROM identity_risk_findings/)
  assert.deepEqual(calls[1].params, [tickAt, [orphan.finding_id]])
  assert.match(calls[2].sql, /next_cleanup_check_at = \$1::timestamptz \+ INTERVAL '24 hours'/)
  assert.deepEqual(calls[2].params, [tickAt, [live.finding_id]])
  assert.equal(INTAKE_RECEIPT_CLEANUP_BATCH, 256)
})

test('cross-scope head is retained and rescheduled while an orphan tail is deleted', async () => {
  const writes: Array<{ sql: string; params: readonly unknown[] }> = []
  const mismatch = { finding_id: '00000000-0000-0000-0000-000000000003',
    exact_parent_exists: false, any_parent_exists: true }
  const runner: SqlRunner = {
    async query<T>() {
      return [mismatch, orphan] as T[]
    },
    async execute(sql, params) { writes.push({ sql, params }); return 1 },
    async transaction<T>(work: (tx: SqlRunner) => Promise<T>) { return work(this) },
  }
  const result = await pruneDueIntakeReceipts(runner, tickAt)
  assert.deepEqual(result, { inspected: 2, removed: 1, rescheduled: 1,
    scopeMismatches: 1, fullPage: false })
  assert.deepEqual(writes[0].params, [tickAt, [orphan.finding_id]])
  assert.deepEqual(writes[1].params, [tickAt, [mismatch.finding_id]])
})

test('cleanup detects a changing due row and keeps the entire transaction uncommitted', async () => {
  const runner: SqlRunner = {
    async query<T>() { return [orphan] as T[] },
    async execute() { return 0 },
    async transaction<T>(work: (tx: SqlRunner) => Promise<T>) { return work(this) },
  }
  await assert.rejects(pruneDueIntakeReceipts(runner, tickAt), /INTAKE_RECEIPT_CLEANUP_RACE/)
})
