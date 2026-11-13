import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  attemptHistoricalHealthReconciliation as attempt,
  HISTORICAL_RECONCILIATION_FINGERPRINT as fingerprint,
  HISTORICAL_RECONCILIATION_GENERATION as generation,
} from './tenant-health-historical-reconciliation.js'

type Database = Parameters<typeof attempt>[0]
type Stage = 'settings' | 'lock' | 'migrations' | 'triggers' | 'receipt' | 'current' | 'orphans' | 'invariant' | 'record'
type Fixture = {
  fail?: Stage; error?: unknown; receipt?: string; invalid?: boolean; missingMigration?: boolean;
  wrongChecksum?: boolean; disabledTrigger?: boolean; recordCount?: number;
  beforeRollback?: () => Promise<void>; rollbackError?: Error; commitError?: Error
}

// Synthetic transaction boundary only. SQL behavior still requires registered CI.
function fixture(options: Fixture = {}) {
  const events: string[] = []
  const calls: Array<{ stage: Stage; sql: string; values: unknown[] }> = []
  let transactionOptions: unknown
  const call = async (sql: string, ...values: unknown[]) => {
    const stage: Stage = sql.startsWith('SET LOCAL') ? 'settings'
      : sql.startsWith('LOCK TABLE') ? 'lock'
        : sql.includes('FROM public._prisma_migrations') ? 'migrations'
          : sql.includes('FROM pg_catalog.pg_trigger') ? 'triggers'
            : sql.startsWith('SELECT protocol_fingerprint') ? 'receipt'
              : sql.startsWith('INSERT INTO public.tenant_health_source_authorities') ? 'current'
                : sql.startsWith('UPDATE public.tenant_health_source_authorities') ? 'orphans'
                  : sql.startsWith('SELECT EXISTS') ? 'invariant' : 'record'
    calls.push({ stage, sql, values })
    events.push(stage)
    if (options.fail === stage) throw options.error
    if (stage === 'migrations') {
      const rows = (values[0] as string[]).map(name => ({ migration_name: name,
        checksum: createHash('sha256').update(readFileSync(
          new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url))).digest('hex'),
        finished: true, rolled_back: false }))
      if (options.missingMigration) rows.pop()
      if (options.wrongChecksum) rows[0].checksum = '0'.repeat(64)
      return rows
    }
    if (stage === 'triggers') return (values[0] as string[]).map(name => ({
      trigger_name: name,
      table_name: name.includes('audit_') ? 'directory_audit_logs'
        : name.includes('preserve_') ? 'tenant_health_reconciliation_generations' : 'customer_tenants',
      enabled: options.disabledTrigger ? 'D' : 'O',
    }))
    if (stage === 'receipt') return options.receipt === undefined ? [] : [{ protocol_fingerprint: options.receipt }]
    if (stage === 'invariant') return [{ invalid: options.invalid ?? false }]
    return stage === 'record' ? options.recordCount ?? 1 : 0
  }
  const database = { async $transaction(callback: (transaction: unknown) => Promise<unknown>, opts: unknown) {
    transactionOptions = opts
    events.push('begin')
    let result: unknown
    try { result = await callback({ $executeRawUnsafe: call, $queryRawUnsafe: call }) } catch (error) {
      events.push('rollback-start')
      await options.beforeRollback?.()
      if (options.rollbackError) throw options.rollbackError
      events.push('rollback-end')
      throw error
    }
    events.push('commit')
    if (options.commitError) throw options.commitError
    return result
  } } as unknown as Database
  return { database, events, calls, options: () => transactionOptions }
}

test('historical repair holds the fixed source boundary, validates prerequisites and records last', async () => {
  const f = fixture()
  assert.deepEqual(await attempt(f.database), { outcome: 'completed', generation, fingerprint })
  assert.deepEqual(f.events, ['begin', 'settings', 'lock', 'migrations', 'triggers', 'receipt',
    'current', 'orphans', 'invariant', 'record', 'commit'])
  assert.deepEqual(f.options(), { isolationLevel: 'ReadCommitted', maxWait: 2_000, timeout: 5_000 })
  const tables = f.calls[1].sql.match(/public\.[a-z_]+/g)
  assert.deepEqual(tables, ['public.organizations', 'public.customer_tenants', 'public.directory_audit_logs',
    'public.tenant_health_snapshots', 'public.tenant_health_source_authorities',
    'public.tenant_health_reconciliation_generations'])
  assert.match(f.calls[1].sql, /IN EXCLUSIVE MODE NOWAIT$/)
  assert.deepEqual(f.calls.at(-1)?.values, [generation, fingerprint])
})

test('exact completed receipt returns without rotating or rewriting authority', async () => {
  const f = fixture({ receipt: fingerprint })
  assert.deepEqual(await attempt(f.database), { outcome: 'already_completed', generation, fingerprint })
  assert.deepEqual(f.events, ['begin', 'settings', 'lock', 'migrations', 'triggers', 'receipt', 'commit'])
})

test('mismatched receipt and missing or disabled prerequisites fail before authority mutation', async () => {
  for (const options of [{ receipt: 'f'.repeat(64) }, { missingMigration: true },
    { wrongChecksum: true }, { disabledTrigger: true }]) {
    const f = fixture(options)
    await assert.rejects(attempt(f.database), /RECONCILIATION_(GENERATION_MISMATCH|MIGRATIONS_UNVERIFIED|TRIGGERS_UNVERIFIED)/)
    assert.ok(!f.events.includes('current'))
    assert.equal(f.events.at(-1), 'rollback-end')
  }
})

test('lock contention is deferred only after the transaction has finished rollback', async () => {
  let release!: () => void
  let entered!: () => void
  const rolledBack = new Promise<void>(resolve => { release = resolve })
  const rollbackStarted = new Promise<void>(resolve => { entered = resolve })
  const f = fixture({ fail: 'lock', error: { code: '55P03' }, beforeRollback: async () => {
    entered(); await rolledBack
  } })
  let settled = false
  const result = attempt(f.database).finally(() => { settled = true })
  await rollbackStarted
  assert.equal(settled, false)
  assert.deepEqual(f.events, ['begin', 'settings', 'lock', 'rollback-start'])
  release()
  assert.deepEqual(await result, { outcome: 'deferred', reason: 'source_lock_unavailable' })
  assert.equal(f.events.at(-1), 'rollback-end')
})

test('recognized Prisma lock errors defer; other stages, timeouts and text alone remain failures', async () => {
  const errors = [{ code: '55P03' }, { code: 'P2010', meta: { code: '55P03' } },
    { code: 'P2010', meta: { driverAdapterError: { cause: { kind: 'postgres', originalCode: '55P03' } } } }]
  for (const error of errors) {
    assert.equal((await attempt(fixture({ fail: 'lock', error }).database)).outcome, 'deferred')
    await assert.rejects(attempt(fixture({ fail: 'migrations', error }).database), actual => actual === error)
  }
  for (const error of [{ code: '57014' }, { code: '40P01' }, { code: 'P2028' },
    new Error('55P03 lock not available'), { code: 'P2010', meta: { code: '57014' } }]) {
    await assert.rejects(attempt(fixture({ fail: 'lock', error }).database), actual => actual === error)
  }
})

test('rollback, commit, invariant and receipt failures never become a successful attempt', async () => {
  const rollbackError = new Error('connection lost while rolling back')
  await assert.rejects(attempt(fixture({ fail: 'lock', error: { code: '55P03' }, rollbackError }).database),
    error => error === rollbackError)
  const commitError = new Error('commit acknowledgment lost')
  await assert.rejects(attempt(fixture({ commitError }).database), error => error === commitError)
  const invariant = fixture({ invalid: true })
  await assert.rejects(attempt(invariant.database), /INVARIANT_FAILED/)
  assert.ok(!invariant.events.includes('record'))
  const receipt = fixture({ recordCount: 0 })
  await assert.rejects(attempt(receipt.database), /RECEIPT_MISSING/)
  assert.equal(receipt.events.at(-1), 'rollback-end')
})
