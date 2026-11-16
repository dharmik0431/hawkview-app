import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { PrismaService } from '../prisma/prisma.service.js'
import {
  attemptHistoricalHealthReconciliation as reconcile,
  HISTORICAL_RECONCILIATION_GENERATION as repairGeneration,
  HISTORICAL_RECONCILIATION_FINGERPRINT as repairFingerprint,
} from './tenant-health-historical-reconciliation.js'

// The registered backend CI applies committed migrations before this suite.
// Only the registered hosted disposable job may exercise this migration witness.
const RUN = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
  && process.env.HAWKVIEW_CI_DISPOSABLE_POSTGRES === '1'
const URL = RUN ? assertDisposableTestDatabase().toString() : undefined

const migrations = [
  '20261109150000_tenant_health_source_authority_foundation',
  '20261109150100_tenant_health_exact_source_index',
  '20261109150200_tenant_health_attach_source_key',
  '20261109150300_tenant_health_source_authority_table',
  '20261109150400_tenant_health_source_authority_backfill',
  '20261109150500_tenant_health_snapshot_constraint_validation',
]

function sqlState(expected: string) {
  return (error: unknown): boolean =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === expected
}

function isNumericOverflow(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const value = error as { code?: unknown; meta?: { code?: unknown;
    driverAdapterError?: { cause?: { kind?: unknown; code?: unknown; originalCode?: unknown } } } }
  const cause = value.meta?.driverAdapterError?.cause
  return value.code === '22003' || (value.code === 'P2010' && (value.meta?.code === '22003' ||
    (cause?.kind === 'postgres' && (cause.code === '22003' || cause.originalCode === '22003')) ||
    (cause?.kind === 'ValueOutOfRange' && cause.originalCode === '22003')))
}

test('HAW-70 overflow validator recognizes the installed Prisma transaction adapter without database access', async t => {
  // An unconnected client routes the transaction query to a synthetic server
  // error. Exercise the real adapter/client envelope without opening a database.
  const pool = new pg.Pool()
  const connection = Object.assign(new pg.Client(), { release: () => {} })
  t.mock.method(connection, 'connect', async () => { throw new Error('Database connections are forbidden in this test') })
  const statements: string[] = []
  t.mock.method(connection, 'query', async (query: { text: string }) => {
    statements.push(query.text)
    if (query.text === 'SELECT 1') throw Object.assign(new Error('bigint out of range'), { code: '22003', severity: 'ERROR' })
    assert.ok(['BEGIN', 'ROLLBACK'].includes(query.text), 'Only synthetic transaction control is permitted')
    return { rows: [], rowCount: 0, fields: [], command: query.text, oid: 0 }
  })
  t.mock.method(pool, 'query', async () => { throw new Error('Pool queries are forbidden in this test') })
  t.mock.method(pool, 'connect', async () => connection)
  const client = new PrismaClient({ adapter: new PrismaPg(pool) })
  try {
    await assert.rejects(client.$transaction(tx => tx.$executeRawUnsafe('SELECT 1')), (error: unknown) => {
      const value = error as { code: string; meta: { driverAdapterError: { cause: { kind: string } } } }
      assert.equal(value.code, 'P2010', 'The real Prisma client must wrap the injected driver error')
      assert.equal(value.meta.driverAdapterError.cause.kind, 'ValueOutOfRange')
      return isNumericOverflow(error)
    })
    assert.deepEqual(statements, ['BEGIN', 'SELECT 1', 'ROLLBACK'])
  } finally {
    await client.$disconnect()
    await pool.end()
  }
  for (const error of [null, new Error('bigint out of range'), { code: '57014' },
    { code: 'P2010', meta: { code: '23505' } },
    { code: 'P2010', meta: { driverAdapterError: { cause: { kind: 'ValueOutOfRange' } } } },
    { code: 'P2010', meta: { driverAdapterError: { cause: { kind: 'ValueOutOfRange', originalCode: '57014' } } } },
  ]) assert.equal(isNumericOverflow(error), false, 'Only an exact numeric-overflow SQLSTATE is accepted')
})

test('HAW-70 late receipt-lock contention defers after releasing earlier source locks',
  { skip: !RUN, timeout: 60_000 }, async () => {
    const observer = new pg.Client({ connectionString: URL!, statement_timeout: 3_000 })
    const blocker = new pg.Client({ connectionString: URL!, statement_timeout: 3_000 })
    const probe = new pg.Client({ connectionString: URL!, statement_timeout: 3_000 })
    const prisma = new PrismaService()
    const [org, tenant, snapshot] = Array.from({ length: 3 }, () => randomUUID())
    const sourceLock = `LOCK TABLE public.organizations, public.customer_tenants,
      public.directory_audit_logs, public.tenant_health_snapshots,
      public.tenant_health_source_authorities IN EXCLUSIVE MODE NOWAIT`
    const readAuthority = async () => (await observer.query(
      `SELECT incarnation::text, source_revision::text, live, current_snapshot_id::text,
              current_observation_sequence::text FROM public.tenant_health_source_authorities
        WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])).rows
    const readReceipt = async () => (await observer.query(
      `SELECT generation, protocol_fingerprint FROM public.tenant_health_reconciliation_generations
        WHERE generation = $1`, [repairGeneration])).rows
    const readMigrationHistory = async () => (await observer.query(
      `SELECT id, migration_name, checksum, started_at::text, finished_at::text,
              rolled_back_at::text, applied_steps_count, md5(COALESCE(logs, '')) AS log_digest
         FROM public._prisma_migrations ORDER BY id`)).rows
    const assertMarkerHeld = async () => {
      const held = await blocker.query(
        `SELECT 1 FROM pg_catalog.pg_locks WHERE pid = pg_backend_pid()
          AND relation = 'public.tenant_health_reconciliation_generations'::regclass
          AND mode = 'ShareLock' AND granted`)
      assert.equal(held.rowCount, 1, 'The competing marker lock must remain held during the probe')
    }
    const assertSourcesFree = async () => {
      await probe.query('BEGIN')
      try { await probe.query(sourceLock) } finally { await probe.query('ROLLBACK') }
    }
    await observer.connect()
    try {
      await blocker.connect()
      try {
        await probe.connect()
        try {
          assert.deepEqual(await readReceipt(), [], 'This witness precedes the fixed-generation success case')
          await observer.query('BEGIN')
          await observer.query(`INSERT INTO organizations (id, name, slug, updated_at)
            VALUES ($1, 'HAW-70 late-lock fixture', $2, now())`, [org, `haw70-${org}`])
          await observer.query(`INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, updated_at)
            VALUES ($1, $2, $3, now())`, [tenant, org, randomUUID()])
          await observer.query(`INSERT INTO tenant_health_snapshots
            (id, organization_id, customer_tenant_id, health_model_version, overall_status, payload,
             evaluated_at, source_incarnation, source_revision, observation_sequence)
            SELECT $1, organization_id, customer_tenant_id, 1, 'UNKNOWN', '{}'::jsonb,
                   now(), incarnation, source_revision, 1 FROM tenant_health_source_authorities
             WHERE organization_id = $2 AND customer_tenant_id = $3`, [snapshot, org, tenant])
          await observer.query(`UPDATE tenant_health_source_authorities
            SET current_snapshot_id = $1, current_observation_sequence = 1
            WHERE organization_id = $2 AND customer_tenant_id = $3`, [snapshot, org, tenant])
          await observer.query('COMMIT')
          const before = await readAuthority()
          assert.equal(before.length, 1)
          assert.equal(before[0].current_snapshot_id, snapshot)
          const historyBefore = await readMigrationHistory()
          await assertSourcesFree()
          await blocker.query('BEGIN')
          await blocker.query('LOCK TABLE public.tenant_health_reconciliation_generations IN SHARE MODE')
          await assertMarkerHeld()

          const startedAt = performance.now()
          assert.deepEqual(await reconcile(prisma), { outcome: 'deferred', reason: 'source_lock_unavailable' },
            'The real adapter must preserve a recognized lock error; other errors are not deferrals')
          assert.ok(performance.now() - startedAt < 8_000,
            'The exploratory attempt has 2s acquisition + 5s transaction limits, with 1s CI headroom')
          await assertMarkerHeld()
          await assertSourcesFree()
          await assertMarkerHeld()
          assert.deepEqual(await readAuthority(), before)
          assert.deepEqual(await readReceipt(), [])
          assert.deepEqual(await readMigrationHistory(), historyBefore)
          await blocker.query('ROLLBACK')

          // A later ordinary attempt reaches its receipt after contention ends.
          // Abort before commit to preserve the fixed generation for the next
          // test. This is not an automatic-retry or successful-deployment proof.
          const interrupted = new Error('stop recovered attempt before commit')
          const aborting = {
            $transaction: (callback: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>,
              options: Parameters<typeof prisma.$transaction>[1]) => prisma.$transaction(async tx => {
              assert.equal((await callback(tx) as { outcome: string }).outcome, 'completed')
              const changed = await tx.$queryRawUnsafe<Array<{ source_revision: bigint; current_snapshot_id: string | null }>>(
                `SELECT source_revision, current_snapshot_id FROM public.tenant_health_source_authorities
                  WHERE organization_id = $1::uuid AND customer_tenant_id = $2::uuid`, org, tenant)
              assert.equal(changed[0].source_revision, BigInt(before[0].source_revision) + 1n)
              assert.equal(changed[0].current_snapshot_id, null)
              assert.deepEqual(await readAuthority(), before)
              assert.deepEqual(await readReceipt(), [])
              throw interrupted
            }, options),
          } as unknown as Pick<PrismaService, '$transaction'>
          await assert.rejects(reconcile(aborting), error => error === interrupted)
          await assertSourcesFree()
          assert.deepEqual(await readAuthority(), before)
          assert.deepEqual(await readReceipt(), [])
          assert.deepEqual(await readMigrationHistory(), historyBefore)
        } finally {
          try { await probe.query('ROLLBACK') } finally { await probe.end() }
        }
      } finally {
        try { await blocker.query('ROLLBACK') } finally { await blocker.end() }
      }
    } finally {
      try {
        await observer.query('ROLLBACK')
        await observer.query('DELETE FROM organizations WHERE id = $1', [org])
      } finally { await prisma.$disconnect(); await observer.end() }
    }
  })

for (const overflowStage of ['current-authority', 'orphan-tombstone'] as const) {
  test(`HAW-70 ${overflowStage} revision overflow rolls back the entire reconciliation`,
    { skip: !RUN, timeout: 60_000 }, async () => {
      const observer = new pg.Client({ connectionString: URL!, statement_timeout: 3_000 })
      const probe = new pg.Client({ connectionString: URL!, statement_timeout: 3_000 })
      const prisma = new PrismaService()
      const [org, snapshot] = [randomUUID(), randomUUID()]
      // Same-organization UUID ordering makes the ordinary current row eligible
      // before the overflowing current row. It does not expose statement internals.
      const [current, overflowing] = [randomUUID(), randomUUID()].sort()
      const readAuthorities = async () => (await observer.query(
        `SELECT customer_tenant_id::text, incarnation::text, source_revision::text, live,
                current_snapshot_id::text, current_observation_sequence::text
           FROM public.tenant_health_source_authorities WHERE organization_id = $1
           ORDER BY customer_tenant_id`, [org])).rows
      const readSnapshots = async () => (await observer.query(
        `SELECT id::text, customer_tenant_id::text, source_incarnation::text,
                source_revision::text, observation_sequence::text, payload, evaluated_at::text
           FROM public.tenant_health_snapshots WHERE organization_id = $1 ORDER BY id`, [org])).rows
      const readReceipt = async () => (await observer.query(
        `SELECT generation, protocol_fingerprint FROM public.tenant_health_reconciliation_generations
          WHERE generation = $1`, [repairGeneration])).rows
      const readMigrationHistory = async () => (await observer.query(
        `SELECT id, migration_name, checksum, started_at::text, finished_at::text,
                rolled_back_at::text, applied_steps_count, md5(COALESCE(logs, '')) AS log_digest
           FROM public._prisma_migrations ORDER BY id`)).rows
      await observer.connect()
      try {
        await probe.connect()
        try {
          assert.deepEqual(await readReceipt(), [], 'Overflow witnesses precede committed generation success')
          assert.deepEqual((await observer.query(`SELECT organization_id::text, customer_tenant_id::text
            FROM public.tenant_health_source_authorities WHERE source_revision = 9223372036854775807`)).rows, [],
          'An unrelated max-revision row must not cause this fixture to pass')
          await observer.query('BEGIN')
          await observer.query(`INSERT INTO organizations (id, name, slug, updated_at)
            VALUES ($1, 'HAW-70 overflow fixture', $2, now())`, [org, `haw70-${org}`])
          for (const tenant of overflowStage === 'current-authority' ? [current, overflowing] : [current]) {
            await observer.query(`INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, updated_at)
              VALUES ($1, $2, $3, now())`, [tenant, org, randomUUID()])
          }
          await observer.query(`UPDATE tenant_health_source_authorities SET source_revision = 7
            WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, current])
          if (overflowStage === 'current-authority') {
            await observer.query(`UPDATE tenant_health_source_authorities SET source_revision = 9223372036854775807
              WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, overflowing])
          } else {
            await observer.query(`INSERT INTO tenant_health_source_authorities
              (organization_id, customer_tenant_id, source_revision, live)
              VALUES ($1, $2, 9223372036854775807, true)`, [org, overflowing])
          }
          await observer.query(`INSERT INTO tenant_health_snapshots
            (id, organization_id, customer_tenant_id, health_model_version, overall_status, payload,
             evaluated_at, source_incarnation, source_revision, observation_sequence)
            SELECT $1, organization_id, customer_tenant_id, 1, 'UNKNOWN', '{}'::jsonb,
                   now(), incarnation, source_revision, 1 FROM tenant_health_source_authorities
             WHERE organization_id = $2 AND customer_tenant_id = $3`, [snapshot, org, current])
          await observer.query(`UPDATE tenant_health_source_authorities
            SET current_snapshot_id = $1, current_observation_sequence = 1
            WHERE organization_id = $2 AND customer_tenant_id = $3`, [snapshot, org, current])
          await observer.query('COMMIT')
          const before = await readAuthorities()
          assert.equal(before.length, 2)
          const originalCurrent = before.find(row => row.customer_tenant_id === current)!
          assert.equal(originalCurrent.current_snapshot_id, snapshot)
          assert.equal(before.find(row => row.customer_tenant_id === overflowing)!.source_revision, '9223372036854775807')
          const snapshotsBefore = await readSnapshots()
          assert.equal(snapshotsBefore.length, 1)
          const historyBefore = await readMigrationHistory()
          let currentUpsertCompleted = false
          const observing = {
            $transaction: (callback: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>,
              options: Parameters<typeof prisma.$transaction>[1]) => prisma.$transaction(async tx => {
              const transaction = {
                $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx),
                $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
                  const count = await tx.$executeRawUnsafe(sql, ...values)
                  if (sql.startsWith('INSERT INTO public.tenant_health_source_authorities')) {
                    currentUpsertCompleted = true
                    const changed = await tx.$queryRawUnsafe<Array<{
                      incarnation: string; source_revision: bigint; current_snapshot_id: string | null
                    }>>(`SELECT incarnation::text, source_revision, current_snapshot_id::text
                         FROM public.tenant_health_source_authorities
                        WHERE organization_id = $1::uuid AND customer_tenant_id = $2::uuid`, org, current)
                    assert.equal(changed[0].source_revision, 8n)
                    assert.notEqual(changed[0].incarnation, originalCurrent.incarnation)
                    assert.equal(changed[0].current_snapshot_id, null)
                    assert.deepEqual(await readAuthorities(), before, 'Earlier repair is not externally visible')
                  }
                  return count
                },
              } as unknown as typeof tx
              return callback(transaction)
            }, options),
          } as unknown as Pick<PrismaService, '$transaction'>
          // Require actual numeric overflow, not an unrelated prerequisite,
          // timeout, connection, or synthetic observer assertion failure.
          await assert.rejects(reconcile(observing), isNumericOverflow)
          assert.equal(currentUpsertCompleted, overflowStage === 'orphan-tombstone',
            'Late overflow must follow an observed successful real current-authority UPSERT')
          await probe.query('BEGIN')
          try {
            await probe.query(`LOCK TABLE public.organizations, public.customer_tenants,
              public.directory_audit_logs, public.tenant_health_snapshots,
              public.tenant_health_source_authorities, public.tenant_health_reconciliation_generations
              IN EXCLUSIVE MODE NOWAIT`)
          } finally { await probe.query('ROLLBACK') }
          assert.deepEqual(await readAuthorities(), before)
          assert.deepEqual(await readSnapshots(), snapshotsBefore)
          assert.deepEqual(await readReceipt(), [], 'Overflow cannot leave a completion receipt')
          assert.deepEqual(await readMigrationHistory(), historyBefore)
        } finally {
          try { await probe.query('ROLLBACK') } finally { await probe.end() }
        }
      } finally {
        try {
          await observer.query('ROLLBACK')
          // Remove max-revision fixtures before tenant deletion can itself
          // overflow its tombstone trigger. This is disposable-test cleanup.
          await observer.query('DELETE FROM tenant_health_source_authorities WHERE organization_id = $1', [org])
          await observer.query('DELETE FROM organizations WHERE id = $1', [org])
        } finally { await prisma.$disconnect(); await observer.end() }
      }
    })
}

test('HAW-70 precommit database session loss rolls back repair and permits a fresh attempt',
  { skip: !RUN, timeout: 60_000 }, async () => {
    // This destructive fixture is hosted-CI-only; the shared parser validates
    // the exact provisioning workflow, job, database and role on this port.
    assert.equal(assertDisposableTestDatabase().port, '5432', 'Session termination is registered-CI-only')
    const observer = new pg.Client({ connectionString: URL!, statement_timeout: 3_000 })
    const prisma = new PrismaService()
    const recovery = new PrismaService()
    const [org, tenant, snapshot] = Array.from({ length: 3 }, () => randomUUID())
    const application = `haw70-loss-${randomUUID()}`
    const tables = ['organizations', 'customer_tenants', 'directory_audit_logs',
      'tenant_health_snapshots', 'tenant_health_source_authorities', 'tenant_health_reconciliation_generations']
    type Transaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
    const readAuthority = async () => (await observer.query(
      `SELECT incarnation::text, source_revision::text, live, current_snapshot_id::text,
              current_observation_sequence::text FROM public.tenant_health_source_authorities
        WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])).rows
    const readSnapshots = async () => (await observer.query(
      `SELECT id::text, source_incarnation::text, source_revision::text,
              observation_sequence::text, payload, evaluated_at::text
         FROM public.tenant_health_snapshots WHERE organization_id = $1 ORDER BY id`, [org])).rows
    const readReceipt = async () => (await observer.query(
      `SELECT generation, protocol_fingerprint FROM public.tenant_health_reconciliation_generations
        WHERE generation = $1`, [repairGeneration])).rows
    const readMigrationHistory = async () => (await observer.query(
      `SELECT id, migration_name, checksum, started_at::text, finished_at::text,
              rolled_back_at::text, applied_steps_count, md5(COALESCE(logs, '')) AS log_digest
         FROM public._prisma_migrations ORDER BY id`)).rows
    const assertLocksFree = async () => {
      await observer.query('BEGIN')
      try {
        await observer.query(`LOCK TABLE public.organizations, public.customer_tenants,
          public.directory_audit_logs, public.tenant_health_snapshots,
          public.tenant_health_source_authorities, public.tenant_health_reconciliation_generations
          IN EXCLUSIVE MODE NOWAIT`)
      } finally { await observer.query('ROLLBACK') }
    }
    await observer.connect()
    try {
      await Promise.all([prisma.$connect(), recovery.$connect()])
      assert.deepEqual(await readReceipt(), [], 'Session-loss witness precedes committed generation success')
      await observer.query('BEGIN')
      await observer.query(`INSERT INTO organizations (id, name, slug, updated_at)
        VALUES ($1, 'HAW-70 session-loss fixture', $2, now())`, [org, `haw70-${org}`])
      await observer.query(`INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, updated_at)
        VALUES ($1, $2, $3, now())`, [tenant, org, randomUUID()])
      await observer.query(`INSERT INTO tenant_health_snapshots
        (id, organization_id, customer_tenant_id, health_model_version, overall_status, payload,
         evaluated_at, source_incarnation, source_revision, observation_sequence)
        SELECT $1, organization_id, customer_tenant_id, 1, 'UNKNOWN', '{}'::jsonb,
               now(), incarnation, source_revision, 1 FROM tenant_health_source_authorities
         WHERE organization_id = $2 AND customer_tenant_id = $3`, [snapshot, org, tenant])
      await observer.query(`UPDATE tenant_health_source_authorities
        SET current_snapshot_id = $1, current_observation_sequence = 1
        WHERE organization_id = $2 AND customer_tenant_id = $3`, [snapshot, org, tenant])
      await observer.query('COMMIT')
      const before = await readAuthority()
      assert.equal(before.length, 1)
      assert.equal(before[0].current_snapshot_id, snapshot)
      const snapshotsBefore = await readSnapshots()
      const historyBefore = await readMigrationHistory()
      const assertUncommittedRepair = async (tx: Transaction) => {
        const [changed] = await tx.$queryRawUnsafe<Array<{
          incarnation: string; source_revision: bigint; current_snapshot_id: string | null
        }>>(`SELECT incarnation::text, source_revision, current_snapshot_id::text
             FROM public.tenant_health_source_authorities
            WHERE organization_id = $1::uuid AND customer_tenant_id = $2::uuid`, org, tenant)
        assert.notEqual(changed.incarnation, before[0].incarnation)
        assert.equal(changed.source_revision, BigInt(before[0].source_revision) + 1n)
        assert.equal(changed.current_snapshot_id, null)
        assert.deepEqual(await tx.$queryRawUnsafe(
          `SELECT generation, protocol_fingerprint FROM public.tenant_health_reconciliation_generations
            WHERE generation = $1`, repairGeneration),
        [{ generation: repairGeneration, protocol_fingerprint: repairFingerprint }])
        assert.deepEqual(await readAuthority(), before)
        assert.deepEqual(await readReceipt(), [])
      }
      let reachedRealCommitAfterLoss = false
      const disconnected = {
        $transaction: (callback: (tx: Transaction) => Promise<unknown>,
          options: Parameters<typeof prisma.$transaction>[1]) => prisma.$transaction(async tx => {
          await tx.$queryRawUnsafe("SELECT set_config('application_name', $1, true)", application)
          const result = await callback(tx)
          assert.deepEqual(result, { outcome: 'completed', generation: repairGeneration, fingerprint: repairFingerprint })
          await assertUncommittedRepair(tx)
          const [identity] = await tx.$queryRawUnsafe<Array<{ pid: number; started: string }>>(
            `SELECT pid, backend_start::text AS started FROM pg_catalog.pg_stat_activity
              WHERE pid = pg_backend_pid()`)
          assert.ok(Number.isInteger(identity.pid) && identity.pid > 0)
          // Exactly this test's transaction must still hold every repair lock.
          const held = await observer.query<{ relname: string }>(
            `SELECT c.relname FROM pg_catalog.pg_locks l
               JOIN pg_catalog.pg_class c ON c.oid = l.relation
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
              WHERE a.pid = $1 AND a.backend_start = $2::timestamptz
                AND a.application_name = $3 AND a.datname = current_database() AND a.usename = current_user
                AND a.pid <> pg_backend_pid() AND n.nspname = 'public'
                AND c.relname = ANY($4::text[]) AND l.mode = 'ExclusiveLock' AND l.granted`,
            [identity.pid, identity.started, application, tables])
          assert.deepEqual(held.rows.map(row => row.relname).sort(), [...tables].sort())
          // Positive timeout waits for confirmed termination on PostgreSQL 16.
          // No other backend is selected; no synthetic error replaces loss.
          const terminated = await observer.query(
            `SELECT pg_terminate_backend(a.pid, 1000) AS terminated FROM pg_catalog.pg_stat_activity a
              WHERE a.pid = $1 AND a.backend_start = $2::timestamptz AND a.application_name = $3
                AND a.datname = current_database() AND a.usename = current_user AND a.pid <> pg_backend_pid()`,
            [identity.pid, identity.started, application])
          assert.deepEqual(terminated.rows, [{ terminated: true }])
          await observer.query('SELECT pg_stat_clear_snapshot()')
          assert.deepEqual((await observer.query(
            `SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz`,
            [identity.pid, identity.started])).rows, [])
          reachedRealCommitAfterLoss = true
          return result // Real Prisma commit must now reject on the lost session.
        }, options),
      } as unknown as Pick<PrismaService, '$transaction'>
      await assert.rejects(reconcile(disconnected))
      assert.equal(reachedRealCommitAfterLoss, true, 'A prerequisite or observer assertion must not count as session loss')
      await assertLocksFree()
      assert.deepEqual(await readAuthority(), before)
      assert.deepEqual(await readSnapshots(), snapshotsBefore)
      assert.deepEqual(await readReceipt(), [])
      assert.deepEqual(await readMigrationHistory(), historyBefore)

      // A new service can reach a complete repair. Deliberately roll it back to
      // preserve the immutable generation for the later committed-success case.
      const interrupted = new Error('rollback fresh recovery fixture before commit')
      const recovering = {
        $transaction: (callback: (tx: Transaction) => Promise<unknown>,
          options: Parameters<typeof recovery.$transaction>[1]) => recovery.$transaction(async tx => {
          assert.equal((await callback(tx) as { outcome: string }).outcome, 'completed')
          await assertUncommittedRepair(tx)
          throw interrupted
        }, options),
      } as unknown as Pick<PrismaService, '$transaction'>
      await assert.rejects(reconcile(recovering), error => error === interrupted)
      await assertLocksFree()
      assert.deepEqual(await readAuthority(), before)
      assert.deepEqual(await readSnapshots(), snapshotsBefore)
      assert.deepEqual(await readReceipt(), [])
      assert.deepEqual(await readMigrationHistory(), historyBefore)
    } finally {
      try {
        await observer.query('ROLLBACK')
        await observer.query('DELETE FROM organizations WHERE id = $1', [org])
      } finally {
        try { await Promise.all([prisma.$disconnect(), recovery.$disconnect()]) } finally { await observer.end() }
      }
    }
  })

test('HAW-70 competing reconciliation runners recover after rollback and do not repeat a committed repair',
  { skip: !RUN, timeout: 60_000 }, async () => {
    const client = new pg.Client({ connectionString: URL!, statement_timeout: 3_000 })
    const prisma = new PrismaService()
    const contender = new PrismaService()
    const [org, missing, current, deadCurrent, orphan, deadAbsent, snapshot] =
      Array.from({ length: 7 }, () => randomUUID())
    type Authority = { customer_tenant_id: string; incarnation: string; source_revision: string;
      live: boolean; current_snapshot_id: string | null; current_observation_sequence: string }
    const readAuthorities = async () => (await client.query<Authority>(
      `SELECT customer_tenant_id::text, incarnation::text, source_revision::text, live,
              current_snapshot_id::text, current_observation_sequence::text
         FROM public.tenant_health_source_authorities WHERE organization_id = $1
         ORDER BY customer_tenant_id`, [org])).rows
    const readReceipt = async () => (await client.query(
      `SELECT generation, protocol_fingerprint FROM public.tenant_health_reconciliation_generations
        WHERE generation = $1`, [repairGeneration])).rows
    await client.connect()
    try {
      await Promise.all([prisma.$connect(), contender.$connect()])
      assert.deepEqual(await readReceipt(), [], 'Each registered job needs a fresh disposable database')
      await client.query('BEGIN')
      await client.query(`INSERT INTO organizations (id, name, slug, updated_at)
        VALUES ($1, 'HAW-70 historical repair fixture', $2, now())`, [org, `haw70-${org}`])
      for (const tenant of [missing, current, deadCurrent]) {
        await client.query(`INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, updated_at)
          VALUES ($1, $2, $3, now())`, [tenant, org, randomUUID()])
      }
      // Synthesize pre-trigger historical states without disabling any writer.
      await client.query(`DELETE FROM tenant_health_source_authorities
        WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, missing])
      await client.query(`UPDATE tenant_health_source_authorities SET live = false, source_revision = 7
        WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, deadCurrent])
      await client.query(`INSERT INTO tenant_health_source_authorities
        (organization_id, customer_tenant_id, source_revision, live)
        VALUES ($1, $2, 9, true), ($1, $3, 11, false)`, [org, orphan, deadAbsent])
      await client.query(`INSERT INTO tenant_health_snapshots
        (id, organization_id, customer_tenant_id, health_model_version, overall_status, payload,
         evaluated_at, source_incarnation, source_revision, observation_sequence)
        SELECT $1, organization_id, customer_tenant_id, 1, 'UNKNOWN', '{}'::jsonb,
               now(), incarnation, source_revision, 1 FROM tenant_health_source_authorities
         WHERE organization_id = $2 AND customer_tenant_id = $3`, [snapshot, org, current])
      await client.query(`UPDATE tenant_health_source_authorities
        SET current_snapshot_id = $1, current_observation_sequence = 1
        WHERE organization_id = $2 AND customer_tenant_id = $3`, [snapshot, org, current])
      await client.query('COMMIT')
      const before = await readAuthorities()
      const readSnapshots = async () => (await client.query(
        `SELECT id::text, source_incarnation::text, source_revision::text,
                observation_sequence::text, payload, evaluated_at::text
           FROM public.tenant_health_snapshots WHERE organization_id = $1 ORDER BY id`, [org])).rows
      const readMigrationHistory = async () => (await client.query(
        `SELECT id, migration_name, checksum, started_at::text, finished_at::text,
                rolled_back_at::text, applied_steps_count, md5(COALESCE(logs, '')) AS log_digest
           FROM public._prisma_migrations ORDER BY id`)).rows
      const snapshotsBefore = await readSnapshots()
      const historyBefore = await readMigrationHistory()
      type Transaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
      const assertOpponentDefers = async (holder: Transaction, opponent: PrismaService) => {
        const [owner] = await holder.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid')
        const observing = {
          $transaction: (callback: (tx: Transaction) => Promise<unknown>,
            options: Parameters<typeof prisma.$transaction>[1]) => opponent.$transaction(async tx => {
            const [other] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid')
            assert.notEqual(other.pid, owner.pid, 'Contending attempts must use distinct database sessions')
            return callback(tx)
          }, options),
        } as unknown as Pick<PrismaService, '$transaction'>
        // The real NOWAIT source lock must reject the opponent. No fabricated
        // lock error or timing sleep is used to make the contender defer.
        assert.deepEqual(await reconcile(observing), { outcome: 'deferred', reason: 'source_lock_unavailable' })
        assert.deepEqual(await readAuthorities(), before, 'No uncommitted repair becomes externally visible')
        assert.deepEqual(await readReceipt(), [], 'No uncommitted receipt becomes externally visible')
      }
      const interrupted = new Error('injected rollback before commit')
      const aborting = {
        $transaction: (callback: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>,
          options: Parameters<typeof prisma.$transaction>[1]) => prisma.$transaction(async tx => {
          assert.equal((await callback(tx) as { outcome: string }).outcome, 'completed')
          await assertOpponentDefers(tx, contender)
          throw interrupted
        }, options),
      } as unknown as Pick<PrismaService, '$transaction'>
      await assert.rejects(reconcile(aborting), error => error === interrupted)
      assert.deepEqual(await readAuthorities(), before)
      assert.deepEqual(await readReceipt(), [], 'An interrupted transaction records no completion')
      assert.deepEqual(await readSnapshots(), snapshotsBefore)
      assert.deepEqual(await readMigrationHistory(), historyBefore)
      await client.query('BEGIN')
      try {
        await client.query(`LOCK TABLE public.organizations, public.customer_tenants,
          public.directory_audit_logs, public.tenant_health_snapshots,
          public.tenant_health_source_authorities, public.tenant_health_reconciliation_generations
          IN EXCLUSIVE MODE NOWAIT`)
      } finally { await client.query('ROLLBACK') }

      const lostResult = new Error('injected loss of success result after confirmed commit')
      let committed = false
      const recovering = {
        $transaction: async (callback: (tx: Transaction) => Promise<unknown>,
          options: Parameters<typeof contender.$transaction>[1]) => {
          const result = await contender.$transaction(async tx => {
            const repaired = await callback(tx)
            assert.deepEqual(repaired, { outcome: 'completed',
              generation: repairGeneration, fingerprint: repairFingerprint })
            // B now owns the repair boundary; A must defer until B commits.
            await assertOpponentDefers(tx, prisma)
            return repaired
          }, options)
          assert.deepEqual(result, { outcome: 'completed',
            generation: repairGeneration, fingerprint: repairFingerprint })
          committed = true
          // This models a lost caller-visible result, not a real process crash,
          // lost network acknowledgment or uncertain database commit outcome.
          throw lostResult
        },
      } as unknown as Pick<PrismaService, '$transaction'>
      await assert.rejects(reconcile(recovering), error => error === lostResult)
      assert.equal(committed, true, 'The injected result loss must occur after successful real commit')
      const after = await readAuthorities()
      const byId = new Map(after.map(row => [row.customer_tenant_id, row]))
      assert.equal(after.length, 5)
      const fresh = byId.get(missing)!
      assert.equal(fresh.live, true)
      assert.equal(fresh.source_revision, '1')
      assert.equal(fresh.current_snapshot_id, null)
      assert.equal(fresh.current_observation_sequence, '0')
      assert.ok(fresh.incarnation)
      for (const tenant of [current, deadCurrent]) {
        const old = before.find(row => row.customer_tenant_id === tenant)!
        const repaired = byId.get(tenant)!
        assert.notEqual(repaired.incarnation, old.incarnation)
        assert.equal(BigInt(repaired.source_revision), BigInt(old.source_revision) + 1n)
        assert.equal(repaired.live, true)
        assert.equal(repaired.current_snapshot_id, null)
        assert.equal(repaired.current_observation_sequence, '0')
      }
      assert.deepEqual(byId.get(orphan), { ...before.find(row => row.customer_tenant_id === orphan)!,
        source_revision: '10', live: false, current_snapshot_id: null, current_observation_sequence: '0' })
      assert.deepEqual(byId.get(deadAbsent), before.find(row => row.customer_tenant_id === deadAbsent))
      assert.deepEqual(await readReceipt(), [{ generation: repairGeneration, protocol_fingerprint: repairFingerprint }])
      assert.deepEqual(await reconcile(prisma), { outcome: 'already_completed',
        generation: repairGeneration, fingerprint: repairFingerprint })
      assert.deepEqual(await readAuthorities(), after, 'A retry after commit must not rotate authority again')
      assert.deepEqual(await readReceipt(), [{ generation: repairGeneration, protocol_fingerprint: repairFingerprint }])
      assert.deepEqual(await readSnapshots(), snapshotsBefore)
      assert.deepEqual(await readMigrationHistory(), historyBefore)
    } finally {
      try {
        await client.query('ROLLBACK')
        await client.query('DELETE FROM organizations WHERE id = $1', [org])
        // Keep the immutable experimental receipt only in this disposable job.
      } finally {
        try { await Promise.all([prisma.$disconnect(), contender.$disconnect()]) } finally { await client.end() }
      }
    }
  })

test('HAW-70 private reconciliation receipts reject malformed identity and ordinary mutation',
  { skip: !RUN, timeout: 30_000 }, async () => {
    const client = new pg.Client({ connectionString: URL! })
    const generation = `ci-${randomUUID()}`
    const fingerprint = '1'.repeat(64)
    await client.connect()
    try {
      const migration = await client.query(
        `SELECT migration_name FROM _prisma_migrations
          WHERE migration_name = '20261113170000_tenant_health_reconciliation_marker'
            AND finished_at IS NOT NULL AND rolled_back_at IS NULL`)
      assert.equal(migration.rowCount, 1, 'The registered job must apply the marker migration')
      const privacy = await client.query<{ relrowsecurity: boolean; exposed: boolean }>(
        `SELECT relrowsecurity,
                EXISTS (SELECT 1 FROM aclexplode(COALESCE(relacl, acldefault('r', relowner))) a
                         LEFT JOIN pg_roles r ON r.oid = a.grantee
                         WHERE a.grantee = 0 OR r.rolname IN ('anon', 'authenticated')) AS exposed
           FROM pg_class WHERE oid = 'public.tenant_health_reconciliation_generations'::regclass`)
      assert.deepEqual(privacy.rows, [{ relrowsecurity: true, exposed: false }])

      await client.query('BEGIN')
      const inserted = await client.query<{ completed_at: Date }>(
        `INSERT INTO public.tenant_health_reconciliation_generations
           (generation, protocol_fingerprint) VALUES ($1, $2) RETURNING completed_at`,
        [generation, fingerprint])
      assert.ok(Number.isFinite(inserted.rows[0].completed_at.getTime()))

      const rejected = async (sql: string, values: string[], code: string) => {
        await client.query('SAVEPOINT rejected_marker_change')
        await assert.rejects(client.query(sql, values), sqlState(code))
        await client.query('ROLLBACK TO SAVEPOINT rejected_marker_change')
        await client.query('RELEASE SAVEPOINT rejected_marker_change')
      }
      for (const [invalidGeneration, invalidFingerprint] of [
        ['', fingerprint], ['Bad generation', fingerprint],
        [`ci-${randomUUID()}`, 'a'.repeat(63)], [`ci-${randomUUID()}`, 'G'.repeat(64)],
      ]) {
        await rejected(
          `INSERT INTO public.tenant_health_reconciliation_generations
             (generation, protocol_fingerprint) VALUES ($1, $2)`,
          [invalidGeneration, invalidFingerprint], '23514')
      }
      await rejected(
        `INSERT INTO public.tenant_health_reconciliation_generations
           (generation, protocol_fingerprint, completed_at) VALUES ($1, $2, 'infinity')`,
        [`ci-${randomUUID()}`, fingerprint], '23514')
      await rejected(
        `INSERT INTO public.tenant_health_reconciliation_generations
           (generation, protocol_fingerprint) VALUES ($1, $2)`,
        [generation, fingerprint], '23505')
      for (const sql of [
        `UPDATE public.tenant_health_reconciliation_generations SET generation = 'changed' WHERE generation = $1`,
        `UPDATE public.tenant_health_reconciliation_generations SET protocol_fingerprint = repeat('2', 64) WHERE generation = $1`,
        `UPDATE public.tenant_health_reconciliation_generations SET completed_at = now() WHERE generation = $1`,
        `UPDATE public.tenant_health_reconciliation_generations SET completed_at = now() WHERE generation = $1 AND false`,
        `DELETE FROM public.tenant_health_reconciliation_generations WHERE generation = $1`,
        `DELETE FROM public.tenant_health_reconciliation_generations WHERE generation = $1 AND false`,
      ]) await rejected(sql, [generation], '55000')
      await rejected('TRUNCATE public.tenant_health_reconciliation_generations', [], '55000')

      // A conflict must not replace the receipt. A future runner must SELECT
      // and compare this fingerprint, not infer success from DO NOTHING.
      const duplicate = await client.query(
        `INSERT INTO public.tenant_health_reconciliation_generations
           (generation, protocol_fingerprint) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [generation, '2'.repeat(64)])
      assert.equal(duplicate.rowCount, 0)
      const retained = await client.query<{ protocol_fingerprint: string; completed_at: Date }>(
        `SELECT protocol_fingerprint, completed_at FROM public.tenant_health_reconciliation_generations
          WHERE generation = $1`, [generation])
      assert.equal(retained.rows[0].protocol_fingerprint, fingerprint)
      assert.equal(retained.rows[0].completed_at.getTime(), inserted.rows[0].completed_at.getTime())
    } finally {
      try { await client.query('ROLLBACK') } finally { await client.end() }
    }
  })

test('HAW-70 reconciliation receipt and authority change commit or roll back together',
  { skip: !RUN, timeout: 30_000 }, async () => {
    // Schema coupling witness only: no production reconciliation runner exists.
    const writer = new pg.Client({ connectionString: URL! })
    const observer = new pg.Client({ connectionString: URL! })
    const [org, tenant, microsoftTenant] = Array.from({ length: 3 }, () => randomUUID())
    const generation = `ci-${randomUUID()}`
    const readAuthority = async (client: pg.Client) => (await client.query<{
      incarnation: string; source_revision: string
    }>(`SELECT incarnation::text, source_revision::text FROM public.tenant_health_source_authorities
         WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])).rows
    const readReceipt = async () => (await observer.query(
      `SELECT generation, protocol_fingerprint FROM public.tenant_health_reconciliation_generations
        WHERE generation = $1`, [generation])).rows
    const changeAndRecord = async () => {
      await writer.query(
        `UPDATE public.tenant_health_source_authorities
            SET incarnation = gen_random_uuid(), source_revision = source_revision + 1,
                current_snapshot_id = NULL, current_observation_sequence = 0
          WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])
      await writer.query(
        `INSERT INTO public.tenant_health_reconciliation_generations
           (generation, protocol_fingerprint) VALUES ($1, $2)`, [generation, '3'.repeat(64)])
    }
    await writer.connect()
    try {
      await observer.connect()
      try {
        await writer.query(
          `INSERT INTO organizations (id, name, slug, updated_at)
           VALUES ($1, 'HAW-70 marker witness', $2, now())`, [org, `haw70-${org}`])
        await writer.query(
          `INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, updated_at)
           VALUES ($1, $2, $3, now())`, [tenant, org, microsoftTenant])
        const initial = await readAuthority(observer)
        assert.equal(initial.length, 1)
        await writer.query('BEGIN')
        await changeAndRecord()
        assert.notDeepEqual(await readAuthority(writer), initial)
        assert.deepEqual(await readAuthority(observer), initial)
        assert.deepEqual(await readReceipt(), [], 'No receipt is visible before commit')
        await writer.query('ROLLBACK')
        assert.deepEqual(await readAuthority(observer), initial)
        assert.deepEqual(await readReceipt(), [], 'Rollback retains no completion claim')

        await writer.query('BEGIN')
        await changeAndRecord()
        const changed = await readAuthority(writer)
        assert.notEqual(changed[0].incarnation, initial[0].incarnation)
        assert.equal(BigInt(changed[0].source_revision), BigInt(initial[0].source_revision) + 1n)
        assert.deepEqual(await readAuthority(observer), initial)
        assert.deepEqual(await readReceipt(), [])
        await writer.query('COMMIT')
        assert.deepEqual(await readAuthority(observer), changed)
        assert.deepEqual(await readReceipt(), [{ generation, protocol_fingerprint: '3'.repeat(64) }])
      } finally {
        await observer.end()
      }
    } finally {
      try {
        await writer.query('ROLLBACK')
        await writer.query('DELETE FROM organizations WHERE id = $1', [org])
        // The unique synthetic receipt is intentionally retained in disposable
        // CI: cleanup must not bypass the immutable-marker contract.
      } finally { await writer.end() }
    }
  })

test('HAW-70 six-phase migration has a valid exact key and enforced scope fences',
  { skip: !RUN, timeout: 30_000 }, async () => {
    const client = new pg.Client({ connectionString: URL! })
    await client.connect()
    try {
      const applied = await client.query<{
        migration_name: string; finished: boolean; rolled_back: boolean
      }>(`SELECT migration_name, finished_at IS NOT NULL AS finished,
                 rolled_back_at IS NOT NULL AS rolled_back
            FROM _prisma_migrations
           WHERE migration_name LIKE '20261109150%'
           ORDER BY migration_name`)
      assert.deepEqual(applied.rows.map(row => row.migration_name), migrations)
      assert.ok(applied.rows.every(row => row.finished && !row.rolled_back),
        'Every ordered phase must be applied by Prisma Migrate')

      const exactIndex = await client.query<{
        indisunique: boolean; indisvalid: boolean; indisready: boolean
      }>(`SELECT i.indisunique, i.indisvalid, i.indisready
            FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
           WHERE c.oid = 'tenant_health_snapshots_exact_source_key'::regclass`)
      assert.deepEqual(exactIndex.rows, [{ indisunique: true, indisvalid: true, indisready: true }],
        'Concurrent index must have completed and attached as a valid exact key')

      const constraints = await client.query<{
        conname: string; contype: string; convalidated: boolean;
        condeferrable: boolean; condeferred: boolean; confupdtype: string; confdeltype: string
      }>(`SELECT conname, contype, convalidated, condeferrable, condeferred,
                 confupdtype, confdeltype
            FROM pg_constraint
           WHERE conrelid IN ('tenant_health_snapshots'::regclass,
                              'tenant_health_source_authorities'::regclass)
             AND conname = ANY($1::text[])`, [[
        'tenant_health_snapshots_exact_source_key',
        'tenant_health_snapshots_source_tag_complete',
        'tenant_health_snapshots_organization_id_fkey',
        'tenant_health_snapshots_customer_tenant_id_organization_id_fkey',
        'tenant_health_source_authorities_exact_pointer_fkey',
      ]])
      const byName = new Map(constraints.rows.map(row => [row.conname, row]))
      assert.equal(byName.size, 5)
      assert.equal(byName.get('tenant_health_snapshots_exact_source_key')?.contype, 'u')
      for (const name of [
        'tenant_health_snapshots_source_tag_complete',
        'tenant_health_snapshots_organization_id_fkey',
        'tenant_health_snapshots_customer_tenant_id_organization_id_fkey',
      ]) assert.equal(byName.get(name)?.convalidated, true, name)
      for (const name of [
        'tenant_health_snapshots_organization_id_fkey',
        'tenant_health_snapshots_customer_tenant_id_organization_id_fkey',
      ]) {
        assert.equal(byName.get(name)?.confupdtype, 'r', name)
        assert.equal(byName.get(name)?.confdeltype, 'c', name)
      }
      const pointer = byName.get('tenant_health_source_authorities_exact_pointer_fkey')
      assert.equal(pointer?.contype, 'f')
      assert.equal(pointer?.condeferrable, true)
      assert.equal(pointer?.condeferred, true)
      assert.equal(pointer?.confdeltype, 'a')

      const authority = await client.query<{ relrowsecurity: boolean; public_grant: boolean }>(
        `SELECT relrowsecurity,
                EXISTS (SELECT 1 FROM aclexplode(COALESCE(relacl, acldefault('r', relowner)))
                         WHERE grantee = 0) AS public_grant
           FROM pg_class WHERE oid = 'tenant_health_source_authorities'::regclass`)
      assert.deepEqual(authority.rows, [{ relrowsecurity: true, public_grant: false }])
    } finally {
      await client.end()
    }
  })

test('HAW-70 exact pointer rejects stale tags and history blocks a tenant scope move',
  { skip: !RUN, timeout: 30_000 }, async () => {
    const client = new pg.Client({ connectionString: URL! })
    await client.connect()
    const [org, otherOrg, tenant, microsoftTenant, snapshot] =
      Array.from({ length: 5 }, () => randomUUID())
    await client.query('BEGIN')
    try {
      for (const id of [org, otherOrg]) {
        await client.query(
          `INSERT INTO organizations (id, name, slug, updated_at)
           VALUES ($1, 'HAW-70 CI fixture', $2, now())`,
          [id, `haw70-${id}`])
      }
      await client.query(
        `INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, updated_at)
         VALUES ($1, $2, $3, now())`, [tenant, org, microsoftTenant])
      const created = await client.query<{ incarnation: string }>(
        `SELECT incarnation::text
           FROM tenant_health_source_authorities
          WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])
      assert.equal(created.rowCount, 1)
      const { incarnation } = created.rows[0]
      await client.query(
        `INSERT INTO tenant_health_snapshots
           (id, organization_id, customer_tenant_id, health_model_version,
            overall_status, payload, evaluated_at, source_incarnation,
            source_revision, observation_sequence)
         VALUES ($1, $2, $3, 1, 'UNKNOWN', '{}'::jsonb, now(), $4, 1, 1)`,
        [snapshot, org, tenant, incarnation])
      await client.query(
        `UPDATE tenant_health_source_authorities
            SET current_snapshot_id = $1, current_observation_sequence = 1
          WHERE organization_id = $2 AND customer_tenant_id = $3`,
        [snapshot, org, tenant])
      await client.query('SET CONSTRAINTS ALL IMMEDIATE')

      await client.query('SAVEPOINT stale_pointer')
      await assert.rejects(
        client.query(`UPDATE tenant_health_source_authorities SET source_revision = 2
                       WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant]),
        sqlState('23503'))
      await client.query('ROLLBACK TO SAVEPOINT stale_pointer')

      await client.query('SAVEPOINT moved_tenant')
      await assert.rejects(
        client.query(`UPDATE customer_tenants SET organization_id = $1 WHERE id = $2`,
          [otherOrg, tenant]), sqlState('23503'))
      await client.query('ROLLBACK TO SAVEPOINT moved_tenant')

      await client.query('SAVEPOINT partial_tag')
      await assert.rejects(
        client.query(
          `INSERT INTO tenant_health_snapshots
             (id, organization_id, customer_tenant_id, health_model_version,
              overall_status, payload, evaluated_at, source_incarnation)
           VALUES ($1, $2, $3, 1, 'UNKNOWN', '{}'::jsonb, now(), $4)`,
          [randomUUID(), org, tenant, incarnation]), sqlState('23514'))
      await client.query('ROLLBACK TO SAVEPOINT partial_tag')
    } finally {
      try { await client.query('ROLLBACK') } finally { await client.end() }
    }
  })

test('HAW-70 tenant insert creates authority atomically and reused ID gets a new incarnation',
  { skip: !RUN, timeout: 30_000 }, async () => {
    const writer = new pg.Client({ connectionString: URL! })
    const observer = new pg.Client({ connectionString: URL! })
    const [org, tenant, firstMicrosoftTenant, secondMicrosoftTenant] =
      Array.from({ length: 4 }, () => randomUUID())
    const authority = async (client: pg.Client) => {
      const result = await client.query<{
        incarnation: string; source_revision: string; live: boolean;
        current_snapshot_id: string | null; current_observation_sequence: string
      }>(`SELECT incarnation::text, source_revision::text, live,
                 current_snapshot_id::text, current_observation_sequence::text
            FROM tenant_health_source_authorities
           WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])
      return result.rows
    }

    await writer.connect()
    try {
      await observer.connect()
      try {
        await writer.query('BEGIN')
        await writer.query(
          `INSERT INTO organizations (id, name, slug, updated_at)
           VALUES ($1, 'HAW-70 tenant create witness', $2, now())`,
          [org, `haw70-${org}`])
        await writer.query(
          `INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, updated_at)
           VALUES ($1, $2, $3, now())`, [tenant, org, firstMicrosoftTenant])
        const uncommitted = await authority(writer)
        assert.equal(uncommitted.length, 1)
        assert.deepEqual(uncommitted[0], {
          incarnation: uncommitted[0].incarnation,
          source_revision: '1', live: true,
          current_snapshot_id: null, current_observation_sequence: '0',
        })
        assert.deepEqual(await authority(observer), [],
          'A second client cannot see an uncommitted tenant authority')
        await writer.query('ROLLBACK')
        assert.deepEqual(await authority(observer), [],
          'Rolling back tenant creation also rolls back authority')

        await writer.query('BEGIN')
        await writer.query(
          `INSERT INTO organizations (id, name, slug, updated_at)
           VALUES ($1, 'HAW-70 tenant create witness', $2, now())`,
          [org, `haw70-${org}`])
        await writer.query(
          `INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, updated_at)
           VALUES ($1, $2, $3, now())`, [tenant, org, firstMicrosoftTenant])
        await writer.query('COMMIT')
        const first = (await authority(observer))[0]
        assert.equal(first.live, true)
        assert.equal(first.source_revision, '1')

        await writer.query('BEGIN')
        await writer.query('DELETE FROM customer_tenants WHERE id = $1', [tenant])
        await writer.query('COMMIT')
        const tombstone = (await authority(observer))[0]
        assert.equal(tombstone.live, false)
        assert.equal(tombstone.current_snapshot_id, null)

        await writer.query('BEGIN')
        await writer.query(
          `INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, updated_at)
           VALUES ($1, $2, $3, now())`, [tenant, org, secondMicrosoftTenant])
        await writer.query('COMMIT')
        const revived = (await authority(observer))[0]
        assert.equal(revived.live, true)
        assert.notEqual(revived.incarnation, first.incarnation,
          'A reused tenant ID must not inherit its old source incarnation')
        assert.equal(BigInt(revived.source_revision), BigInt(tombstone.source_revision) + 1n)
        assert.equal(revived.current_snapshot_id, null)
        assert.equal(revived.current_observation_sequence, '0')
      } finally {
        try {
          await writer.query('ROLLBACK')
          await writer.query('BEGIN')
          try {
            await writer.query('DELETE FROM customer_tenants WHERE id = $1', [tenant])
            await writer.query(
              `DELETE FROM tenant_health_source_authorities
                WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])
            await writer.query('DELETE FROM organizations WHERE id = $1', [org])
            await writer.query('COMMIT')
          } catch (error) {
            await writer.query('ROLLBACK')
            throw error
          }
        } finally {
          await observer.end()
        }
      }
    } finally {
      await writer.end()
    }
  })

// This physical witness runs only in the registered disposable PostgreSQL job.
test('HAW-70 audit insert, update, and delete invalidate current health in the same transaction',
  {
    skip: !RUN || process.env.HAWKVIEW_HAW70_AUDIT_WRITER_WITNESS !== '1',
    timeout: 30_000,
  }, async () => {
    const writer = new pg.Client({ connectionString: URL! })
    const reader = new pg.Client({ connectionString: URL! })
    const [org, tenant, microsoftTenant, firstSnapshot,
      secondSnapshot, thirdSnapshot, auditLog, bulkAuditA, bulkAuditB,
      otherTenant, otherMicrosoftTenant, movedAudit,
      sourceMoveSnapshot, destinationMoveSnapshot] =
      Array.from({ length: 14 }, () => randomUUID())
    const current = async (client: pg.Client) => {
      const result = await client.query<{
        source_revision: string; current_snapshot_id: string | null
      }>(`SELECT source_revision::text, current_snapshot_id::text
            FROM tenant_health_source_authorities
           WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])
      assert.equal(result.rowCount, 1)
      return result.rows[0]
    }

    await writer.connect()
    try {
      await reader.connect()
      try {
        await writer.query('BEGIN')
        await writer.query(
          `INSERT INTO organizations (id, name, slug, updated_at)
           VALUES ($1, 'HAW-70 audit writer witness', $2, now())`, [org, `haw70-${org}`])
        await writer.query(
          `INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, updated_at)
           VALUES ($1, $2, $3, now())`, [tenant, org, microsoftTenant])
        const seeded = await writer.query<{
          incarnation: string; source_revision: string
        }>(`SELECT incarnation::text, source_revision::text
              FROM tenant_health_source_authorities
             WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])
        assert.equal(seeded.rowCount, 1)
        const { incarnation } = seeded.rows[0]
        const sourceRevision = BigInt(seeded.rows[0].source_revision)
        await writer.query(
          `INSERT INTO tenant_health_snapshots
             (id, organization_id, customer_tenant_id, health_model_version,
              overall_status, payload, evaluated_at, source_incarnation,
              source_revision, observation_sequence)
           VALUES ($1, $2, $3, 1, 'UNKNOWN', '{}'::jsonb, now(), $4, $5, 1)`,
          [firstSnapshot, org, tenant, incarnation, sourceRevision.toString()])
        await writer.query(
          `UPDATE tenant_health_source_authorities
              SET current_snapshot_id = $1, current_observation_sequence = 1
            WHERE organization_id = $2 AND customer_tenant_id = $3`,
          [firstSnapshot, org, tenant])
        await writer.query('COMMIT')
        assert.deepEqual(await current(reader), {
          source_revision: sourceRevision.toString(), current_snapshot_id: firstSnapshot,
        })

        await writer.query('BEGIN')
        await writer.query(
          `INSERT INTO directory_audit_logs
             (id, organization_id, customer_tenant_id, microsoft_audit_id,
              event_date_time, activity_display_name, raw, expires_at)
           VALUES ($1, $2, $3, $4, now(), 'HAW-70 audit witness', '{}'::jsonb,
                   now() + interval '1 day')`,
          [auditLog, org, tenant, `haw70-${auditLog}`])
        assert.deepEqual(await current(writer), {
          source_revision: (sourceRevision + 1n).toString(), current_snapshot_id: null,
        }, 'The audit insert must invalidate the pointer before its transaction commits')
        assert.deepEqual(await current(reader), {
          source_revision: sourceRevision.toString(), current_snapshot_id: firstSnapshot,
        }, 'A second client must not see an uncommitted revision')
        await writer.query('COMMIT')
        assert.deepEqual(await current(reader), {
          source_revision: (sourceRevision + 1n).toString(), current_snapshot_id: null,
        })

        await writer.query('BEGIN')
        await writer.query(
          `INSERT INTO directory_audit_logs
             (id, organization_id, customer_tenant_id, microsoft_audit_id,
              event_date_time, activity_display_name, raw, expires_at)
           VALUES ($1, $2, $3, $4, now(), 'HAW-70 duplicate witness', '{}'::jsonb,
                   now() + interval '1 day')
           ON CONFLICT (customer_tenant_id, microsoft_audit_id) DO NOTHING`,
          [randomUUID(), org, tenant, `haw70-${auditLog}`])
        assert.deepEqual(await current(writer), {
          source_revision: (sourceRevision + 1n).toString(), current_snapshot_id: null,
        }, 'A skipped duplicate must not advance source authority')
        await writer.query('COMMIT')

        await writer.query('BEGIN')
        await writer.query(
          `INSERT INTO tenant_health_snapshots
             (id, organization_id, customer_tenant_id, health_model_version,
              overall_status, payload, evaluated_at, source_incarnation,
              source_revision, observation_sequence)
           VALUES ($1, $2, $3, 1, 'UNKNOWN', '{}'::jsonb, now(), $4, $5, 2)`,
          [secondSnapshot, org, tenant, incarnation, (sourceRevision + 1n).toString()])
        await writer.query(
          `UPDATE tenant_health_source_authorities
              SET current_snapshot_id = $1, current_observation_sequence = 2
            WHERE organization_id = $2 AND customer_tenant_id = $3`,
          [secondSnapshot, org, tenant])
        await writer.query('COMMIT')

        await writer.query('BEGIN')
        await writer.query(
          `UPDATE directory_audit_logs SET activity_display_name = 'Corrected audit witness'
            WHERE id = $1`, [auditLog])
        assert.deepEqual(await current(writer), {
          source_revision: (sourceRevision + 2n).toString(), current_snapshot_id: null,
        }, 'An audit correction must invalidate the pointer before commit')
        assert.deepEqual(await current(reader), {
          source_revision: (sourceRevision + 1n).toString(), current_snapshot_id: secondSnapshot,
        }, 'A second client must not see an uncommitted audit correction')
        await writer.query('ROLLBACK')
        assert.deepEqual(await current(reader), {
          source_revision: (sourceRevision + 1n).toString(), current_snapshot_id: secondSnapshot,
        }, 'A rolled-back correction must preserve current authority')

        await writer.query('BEGIN')
        await writer.query(
          `UPDATE directory_audit_logs SET activity_display_name = 'Corrected audit witness'
            WHERE id = $1`, [auditLog])
        await writer.query('COMMIT')
        assert.deepEqual(await current(reader), {
          source_revision: (sourceRevision + 2n).toString(), current_snapshot_id: null,
        })

        await writer.query('BEGIN')
        await writer.query(
          `INSERT INTO tenant_health_snapshots
             (id, organization_id, customer_tenant_id, health_model_version,
              overall_status, payload, evaluated_at, source_incarnation,
              source_revision, observation_sequence)
           VALUES ($1, $2, $3, 1, 'UNKNOWN', '{}'::jsonb, now(), $4, $5, 3)`,
          [thirdSnapshot, org, tenant, incarnation, (sourceRevision + 2n).toString()])
        await writer.query(
          `UPDATE tenant_health_source_authorities
              SET current_snapshot_id = $1, current_observation_sequence = 3
            WHERE organization_id = $2 AND customer_tenant_id = $3`,
          [thirdSnapshot, org, tenant])
        await writer.query('COMMIT')

        await writer.query('BEGIN')
        await writer.query('DELETE FROM directory_audit_logs WHERE id = $1', [auditLog])
        assert.deepEqual(await current(writer), {
          source_revision: (sourceRevision + 3n).toString(), current_snapshot_id: null,
        }, 'The audit delete must invalidate the pointer before its transaction commits')
        await writer.query('ROLLBACK')
        assert.deepEqual(await current(reader), {
          source_revision: (sourceRevision + 2n).toString(), current_snapshot_id: thirdSnapshot,
        }, 'A rolled-back audit delete must preserve the previous authority')
        const retained = await reader.query(
          'SELECT id FROM directory_audit_logs WHERE id = $1', [auditLog])
        assert.equal(retained.rowCount, 1)

        await writer.query('BEGIN')
        await writer.query('DELETE FROM directory_audit_logs WHERE id = $1', [auditLog])
        assert.deepEqual(await current(writer), {
          source_revision: (sourceRevision + 3n).toString(), current_snapshot_id: null,
        })
        await writer.query('COMMIT')
        assert.deepEqual(await current(reader), {
          source_revision: (sourceRevision + 3n).toString(), current_snapshot_id: null,
        })

        await writer.query('BEGIN')
        await writer.query(
          `INSERT INTO directory_audit_logs
             (id, organization_id, customer_tenant_id, microsoft_audit_id,
              event_date_time, activity_display_name, raw, expires_at)
           VALUES ($1, $2, $3, $4, now(), 'Bulk audit A', '{}'::jsonb, now() + interval '1 day'),
                  ($5, $2, $3, $6, now(), 'Bulk audit B', '{}'::jsonb, now() + interval '1 day')`,
          [bulkAuditA, org, tenant, `haw70-${bulkAuditA}`, bulkAuditB, `haw70-${bulkAuditB}`])
        assert.deepEqual(await current(writer), {
          source_revision: (sourceRevision + 4n).toString(), current_snapshot_id: null,
        }, 'One bulk insert must advance the tenant revision once')
        await writer.query('DELETE FROM directory_audit_logs WHERE id = ANY($1::uuid[])',
          [[bulkAuditA, bulkAuditB]])
        assert.deepEqual(await current(writer), {
          source_revision: (sourceRevision + 5n).toString(), current_snapshot_id: null,
        }, 'One bulk delete must advance the tenant revision once')
        await writer.query('COMMIT')

        await writer.query('BEGIN')
        await writer.query(
          `INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, updated_at)
           VALUES ($1, $2, $3, now())`, [otherTenant, org, otherMicrosoftTenant])
        const destination = await writer.query<{ incarnation: string }>(
          `SELECT incarnation::text FROM tenant_health_source_authorities
            WHERE organization_id = $1 AND customer_tenant_id = $2`,
          [org, otherTenant])
        assert.equal(destination.rowCount, 1)
        await writer.query(
          `INSERT INTO directory_audit_logs
             (id, organization_id, customer_tenant_id, microsoft_audit_id,
              event_date_time, activity_display_name, raw, expires_at)
           VALUES ($1, $2, $3, $4, now(), 'Scope move witness', '{}'::jsonb,
                   now() + interval '1 day')`,
          [movedAudit, org, tenant, `haw70-${movedAudit}`])
        assert.equal((await current(writer)).source_revision,
          (sourceRevision + 6n).toString())
        await writer.query(
          `INSERT INTO tenant_health_snapshots
             (id, organization_id, customer_tenant_id, health_model_version,
              overall_status, payload, evaluated_at, source_incarnation,
              source_revision, observation_sequence)
           VALUES ($1, $2, $3, 1, 'UNKNOWN', '{}'::jsonb, now(), $4, $5, 4),
                  ($6, $2, $7, 1, 'UNKNOWN', '{}'::jsonb, now(), $8, 1, 5)`,
          [sourceMoveSnapshot, org, tenant, incarnation,
            (sourceRevision + 6n).toString(), destinationMoveSnapshot,
            otherTenant, destination.rows[0].incarnation])
        await writer.query(
          `UPDATE tenant_health_source_authorities
              SET current_snapshot_id = $1, current_observation_sequence = 4
            WHERE organization_id = $2 AND customer_tenant_id = $3`,
          [sourceMoveSnapshot, org, tenant])
        await writer.query(
          `UPDATE tenant_health_source_authorities
              SET current_snapshot_id = $1, current_observation_sequence = 5
            WHERE organization_id = $2 AND customer_tenant_id = $3`,
          [destinationMoveSnapshot, org, otherTenant])
        await writer.query(
          `UPDATE directory_audit_logs SET customer_tenant_id = $1 WHERE id = $2`,
          [otherTenant, movedAudit])
        assert.deepEqual(await current(writer), {
          source_revision: (sourceRevision + 7n).toString(), current_snapshot_id: null,
        },
          'A scope move must invalidate the old tenant')
        const moved = await writer.query<{
          source_revision: string; current_snapshot_id: string | null
        }>(
          `SELECT source_revision::text, current_snapshot_id::text
             FROM tenant_health_source_authorities
            WHERE organization_id = $1 AND customer_tenant_id = $2`,
          [org, otherTenant])
        assert.deepEqual(moved.rows, [{
          source_revision: '2', current_snapshot_id: null,
        }],
          'A scope move must also invalidate the destination tenant')
        await writer.query('ROLLBACK')
        assert.deepEqual(await current(reader), {
          source_revision: (sourceRevision + 5n).toString(), current_snapshot_id: null,
        }, 'A rolled-back scope move must preserve original authority')
        const rolledBackDestination = await reader.query(
          `SELECT 1 FROM tenant_health_source_authorities
            WHERE organization_id = $1 AND customer_tenant_id = $2`,
          [org, otherTenant])
        assert.equal(rolledBackDestination.rowCount, 0)
      } finally {
        try {
          await writer.query('ROLLBACK')
          await writer.query('BEGIN')
          try {
            await writer.query(
              `UPDATE tenant_health_source_authorities SET current_snapshot_id = NULL
                WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])
            await writer.query('DELETE FROM directory_audit_logs WHERE id = $1', [auditLog])
            await writer.query(
              'DELETE FROM tenant_health_snapshots WHERE organization_id = $1 AND customer_tenant_id = $2',
              [org, tenant])
            await writer.query('DELETE FROM customer_tenants WHERE id = $1', [tenant])
            await writer.query(
              'DELETE FROM tenant_health_source_authorities WHERE organization_id = $1 AND customer_tenant_id = $2',
              [org, tenant])
            await writer.query('DELETE FROM organizations WHERE id = $1', [org])
            await writer.query('COMMIT')
          } catch (error) {
            await writer.query('ROLLBACK')
            throw error
          }
        } finally {
          await reader.end()
        }
      }
    } finally {
      await writer.end()
    }
  })

// Deletion must retain one authority tombstone even when cascading audit rows
// and its health snapshot away in the same transaction.
test('HAW-70 tenant deletion clears current health and retains a dead authority',
  {
    skip: !RUN || process.env.HAWKVIEW_HAW70_TENANT_DELETE_WITNESS !== '1',
    timeout: 30_000,
  }, async () => {
    const client = new pg.Client({ connectionString: URL! })
    const [org, tenant, microsoftTenant, snapshot, auditLog] =
      Array.from({ length: 5 }, () => randomUUID())
    await client.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO organizations (id, name, slug, updated_at)
         VALUES ($1, 'HAW-70 tenant delete witness', $2, now())`,
        [org, `haw70-${org}`])
      await client.query(
        `INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, updated_at)
         VALUES ($1, $2, $3, now())`, [tenant, org, microsoftTenant])
      await client.query(
        `INSERT INTO directory_audit_logs
           (id, organization_id, customer_tenant_id, microsoft_audit_id,
            event_date_time, activity_display_name, raw, expires_at)
         VALUES ($1, $2, $3, $4, now(), 'HAW-70 cascade witness', '{}'::jsonb,
                 now() + interval '1 day')`,
        [auditLog, org, tenant, `haw70-${auditLog}`])
      const seeded = await client.query<{
        incarnation: string; source_revision: string
      }>(`SELECT incarnation::text, source_revision::text
            FROM tenant_health_source_authorities
           WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])
      assert.equal(seeded.rowCount, 1)
      const { incarnation } = seeded.rows[0]
      const sourceRevision = BigInt(seeded.rows[0].source_revision)
      await client.query(
        `INSERT INTO tenant_health_snapshots
           (id, organization_id, customer_tenant_id, health_model_version,
            overall_status, payload, evaluated_at, source_incarnation,
            source_revision, observation_sequence)
         VALUES ($1, $2, $3, 1, 'HEALTHY', '{}'::jsonb, now(), $4, $5, 1)`,
        [snapshot, org, tenant, incarnation, sourceRevision.toString()])
      await client.query(
        `UPDATE tenant_health_source_authorities
            SET current_snapshot_id = $1, current_observation_sequence = 1
          WHERE organization_id = $2 AND customer_tenant_id = $3`,
        [snapshot, org, tenant])
      await client.query('COMMIT')

      await client.query('BEGIN')
      await client.query('DELETE FROM customer_tenants WHERE id = $1', [tenant])
      const deleted = await client.query<{
        live: boolean; source_revision: string; current_snapshot_id: string | null
      }>(`SELECT live, source_revision::text, current_snapshot_id::text
            FROM tenant_health_source_authorities
           WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])
      assert.equal(deleted.rowCount, 1)
      assert.equal(deleted.rows[0].live, false)
      assert.equal(deleted.rows[0].current_snapshot_id, null)
      assert.ok(BigInt(deleted.rows[0].source_revision) > sourceRevision,
        'Deletion must advance authority even if an audit cascade already invalidated it')
      await client.query('COMMIT')

      const retained = await client.query<{
        live: boolean; current_snapshot_id: string | null
      }>(`SELECT live, current_snapshot_id::text
            FROM tenant_health_source_authorities
           WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])
      assert.deepEqual(retained.rows, [{ live: false, current_snapshot_id: null }])
      const oldHistory = await client.query(
        'SELECT id FROM tenant_health_snapshots WHERE id = $1', [snapshot])
      assert.equal(oldHistory.rowCount, 0, 'The deleted tenant cannot leave current history behind')
      const oldAudit = await client.query(
        'SELECT id FROM directory_audit_logs WHERE id = $1', [auditLog])
      assert.equal(oldAudit.rowCount, 0, 'The deleted tenant cannot leave audit history behind')
    } finally {
      try {
        await client.query('ROLLBACK')
        await client.query('BEGIN')
        try {
          await client.query(
            `UPDATE tenant_health_source_authorities SET current_snapshot_id = NULL
              WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])
          await client.query('DELETE FROM tenant_health_snapshots WHERE id = $1', [snapshot])
          await client.query('DELETE FROM customer_tenants WHERE id = $1', [tenant])
          await client.query(
            `DELETE FROM tenant_health_source_authorities
              WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])
          await client.query('DELETE FROM organizations WHERE id = $1', [org])
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        await client.end()
      }
    }
  })

// Two real clients reproduce the old cycle: tenant deletion waits for an audit
// row while the audit writer must update the same tenant's source authority.
// The witness is gated to the registered disposable PostgreSQL CI job.
test('HAW-70 tenant deletion and audit writes cannot invert source-authority locks',
  {
    skip: !RUN || process.env.HAWKVIEW_HAW70_DELETE_LOCK_ORDER_WITNESS !== '1',
    timeout: 90_000,
  }, async () => {
    for (const mode of ['update', 'delete', 'tenant-rollback'] as const) {
      const auditWriter = new pg.Client({ connectionString: URL! })
      const tenantDeleter = new pg.Client({ connectionString: URL! })
      const [org, tenant, microsoftTenant, snapshot, auditLog] =
        Array.from({ length: 5 }, () => randomUUID())
      let deleteOutcome: Promise<{ result?: pg.QueryResult; error?: unknown }> | undefined
      let seeded = false

      await auditWriter.connect()
      try {
        await tenantDeleter.connect()
        await auditWriter.query('BEGIN')
        await auditWriter.query(
          `INSERT INTO organizations (id, name, slug, updated_at)
           VALUES ($1, 'HAW-70 lock-order witness', $2, now())`,
          [org, `haw70-${org}`])
        await auditWriter.query(
          `INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, updated_at)
           VALUES ($1, $2, $3, now())`, [tenant, org, microsoftTenant])
        await auditWriter.query(
          `INSERT INTO directory_audit_logs
             (id, organization_id, customer_tenant_id, microsoft_audit_id,
              event_date_time, activity_display_name, raw, expires_at)
           VALUES ($1, $2, $3, $4, now(), 'HAW-70 lock-order witness', '{}'::jsonb,
                   now() + interval '1 day')`,
          [auditLog, org, tenant, `haw70-${auditLog}`])
        const authority = await auditWriter.query<{
          incarnation: string; source_revision: string
        }>(`SELECT incarnation::text, source_revision::text
              FROM tenant_health_source_authorities
             WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])
        assert.equal(authority.rowCount, 1, mode)
        const { incarnation, source_revision: seededRevision } = authority.rows[0]
        await auditWriter.query(
          `INSERT INTO tenant_health_snapshots
             (id, organization_id, customer_tenant_id, health_model_version,
              overall_status, payload, evaluated_at, source_incarnation,
              source_revision, observation_sequence)
           VALUES ($1, $2, $3, 1, 'HEALTHY', '{}'::jsonb, now(), $4, $5, 1)`,
          [snapshot, org, tenant, incarnation, seededRevision])
        await auditWriter.query(
          `UPDATE tenant_health_source_authorities
              SET current_snapshot_id = $1, current_observation_sequence = 1
            WHERE organization_id = $2 AND customer_tenant_id = $3`,
          [snapshot, org, tenant])
        await auditWriter.query('COMMIT')
        seeded = true

        await auditWriter.query('BEGIN')
        await auditWriter.query("SET LOCAL lock_timeout = '8s'")
        await auditWriter.query("SET LOCAL statement_timeout = '12s'")
        const writerPid = (await auditWriter.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid')).rows[0].pid
        const lockedAudit = await auditWriter.query(
          'SELECT id FROM directory_audit_logs WHERE id = $1 FOR UPDATE', [auditLog])
        assert.equal(lockedAudit.rowCount, 1, mode)

        await tenantDeleter.query('BEGIN')
        await tenantDeleter.query("SET LOCAL lock_timeout = '10s'")
        await tenantDeleter.query("SET LOCAL statement_timeout = '15s'")
        const deleterPid = (await tenantDeleter.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid')).rows[0].pid
        deleteOutcome = tenantDeleter.query(
          'DELETE FROM customer_tenants WHERE id = $1', [tenant]
        ).then(result => ({ result }), error => ({ error }))

        const blockDeadline = Date.now() + 6_000
        let blockedOnWriter = false
        while (Date.now() < blockDeadline) {
          const blocked = await auditWriter.query<{ blocked: boolean }>(
            'SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked',
            [writerPid, deleterPid])
          if (blocked.rows[0].blocked) {
            blockedOnWriter = true
            break
          }
          await delay(25)
        }
        assert.equal(blockedOnWriter, true,
          `${mode}: tenant DELETE must reach the audit row held by the writer`)

        await auditWriter.query('SAVEPOINT authority_lock_probe')
        try {
          const unlockedAuthority = await auditWriter.query(
            `SELECT 1 FROM tenant_health_source_authorities
              WHERE organization_id = $1 AND customer_tenant_id = $2
              FOR UPDATE NOWAIT`, [org, tenant])
          assert.equal(unlockedAuthority.rowCount, 1, mode)
        } catch (error) {
          await auditWriter.query('ROLLBACK TO SAVEPOINT authority_lock_probe')
          throw error
        }

        if (mode === 'delete') {
          await auditWriter.query('DELETE FROM directory_audit_logs WHERE id = $1',
            [auditLog])
        } else {
          await auditWriter.query(
            `UPDATE directory_audit_logs
                SET activity_display_name = 'HAW-70 corrected audit witness'
              WHERE id = $1`, [auditLog])
        }
        const writerAuthority = await auditWriter.query<{
          live: boolean; source_revision: string; current_snapshot_id: string | null
        }>(`SELECT live, source_revision::text, current_snapshot_id::text
              FROM tenant_health_source_authorities
             WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])
        assert.equal(writerAuthority.rows[0].live, true, mode)
        assert.equal(writerAuthority.rows[0].current_snapshot_id, null, mode)
        assert.ok(BigInt(writerAuthority.rows[0].source_revision) > BigInt(seededRevision),
          `${mode}: audit write must advance source authority`)
        await auditWriter.query('COMMIT')

        const deletion = await deleteOutcome
        if (deletion.error) throw deletion.error
        assert.equal(deletion.result?.rowCount, 1, mode)
        await tenantDeleter.query(mode === 'tenant-rollback' ? 'ROLLBACK' : 'COMMIT')

        const finalAuthority = await auditWriter.query<{
          live: boolean; source_revision: string; current_snapshot_id: string | null
        }>(`SELECT live, source_revision::text, current_snapshot_id::text
              FROM tenant_health_source_authorities
             WHERE organization_id = $1 AND customer_tenant_id = $2`, [org, tenant])
        assert.equal(finalAuthority.rowCount, 1, mode)
        assert.equal(finalAuthority.rows[0].live, mode === 'tenant-rollback', mode)
        assert.equal(finalAuthority.rows[0].current_snapshot_id, null, mode)
        assert.ok(BigInt(finalAuthority.rows[0].source_revision) > BigInt(seededRevision),
          `${mode}: final source revision must advance`)
        const retainedTenant = await auditWriter.query(
          'SELECT id FROM customer_tenants WHERE id = $1', [tenant])
        assert.equal(retainedTenant.rowCount, mode === 'tenant-rollback' ? 1 : 0, mode)
        const retainedAudit = await auditWriter.query(
          'SELECT id FROM directory_audit_logs WHERE id = $1', [auditLog])
        assert.equal(retainedAudit.rowCount, mode === 'tenant-rollback' ? 1 : 0, mode)
      } finally {
        try {
          await auditWriter.query('ROLLBACK')
          if (deleteOutcome) await deleteOutcome
          await tenantDeleter.query('ROLLBACK')
          if (seeded) {
            await auditWriter.query('BEGIN')
            try {
              await auditWriter.query('DELETE FROM directory_audit_logs WHERE id = $1',
                [auditLog])
              await auditWriter.query('DELETE FROM customer_tenants WHERE id = $1', [tenant])
              await auditWriter.query(
                'DELETE FROM tenant_health_source_authorities WHERE organization_id = $1 AND customer_tenant_id = $2',
                [org, tenant])
              await auditWriter.query('DELETE FROM organizations WHERE id = $1', [org])
              await auditWriter.query('COMMIT')
            } catch (error) {
              await auditWriter.query('ROLLBACK')
              throw error
            }
          }
        } finally {
          await tenantDeleter.end()
          await auditWriter.end()
        }
      }
    }
  })

// Sync-state source participation is a separate, unpublished writer slice. These
// witnesses use only the already registered hosted disposable PostgreSQL suite.
async function syncStateAuthorityFixture(context: import('node:test').TestContext) {
  assert.equal(assertDisposableTestDatabase().port, '5432')
  const writer = new pg.Client({ connectionString: URL!, statement_timeout: 5_000 })
  const observer = new pg.Client({ connectionString: URL!, statement_timeout: 5_000 })
  const organizations = [randomUUID(), randomUUID()]
  const scopes = [
    { organizationId: organizations[0], tenantId: randomUUID() },
    { organizationId: organizations[0], tenantId: randomUUID() },
    { organizationId: organizations[1], tenantId: randomUUID() },
  ]
  context.after(async () => {
    try {
      await writer.query('ROLLBACK')
      await observer.query('ROLLBACK')
      // An overflow fixture must not poison cleanup's source/deletion triggers.
      await observer.query(`UPDATE tenant_health_source_authorities
        SET source_revision = 1, current_snapshot_id = NULL, current_observation_sequence = 0
        WHERE organization_id = ANY($1::uuid[])`, [organizations])
      await observer.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [organizations])
      await observer.query('DELETE FROM tenant_health_source_authorities WHERE organization_id = ANY($1::uuid[])', [organizations])
    } finally { await Promise.all([writer.end(), observer.end()]) }
  })
  await Promise.all([writer.connect(), observer.connect()])
  assert.notEqual((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
    (await observer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
  const authority = async (client: pg.Client, index: number) => {
    const scope = scopes[index]
    const result = await client.query<{
      incarnation: string; source_revision: string; live: boolean;
      current_snapshot_id: string | null; current_observation_sequence: string;
    }>(`SELECT incarnation::text, source_revision::text, live,
        current_snapshot_id::text, current_observation_sequence::text
        FROM tenant_health_source_authorities
        WHERE organization_id = $1 AND customer_tenant_id = $2`, [scope.organizationId, scope.tenantId])
    return result.rows[0]
  }
  const tag = async (index: number) => {
    const scope = scopes[index], snapshot = randomUUID()
    await writer.query('BEGIN')
    await writer.query(`INSERT INTO tenant_health_snapshots
      (id, organization_id, customer_tenant_id, health_model_version, overall_status,
       payload, evaluated_at, source_incarnation, source_revision, observation_sequence)
      SELECT $1, organization_id, customer_tenant_id, 1, 'UNKNOWN', '{}'::jsonb,
        now(), incarnation, source_revision, 1 FROM tenant_health_source_authorities
        WHERE organization_id = $2 AND customer_tenant_id = $3`, [snapshot, scope.organizationId, scope.tenantId])
    await writer.query(`UPDATE tenant_health_source_authorities
      SET current_snapshot_id = $1, current_observation_sequence = 1
      WHERE organization_id = $2 AND customer_tenant_id = $3`, [snapshot, scope.organizationId, scope.tenantId])
    await writer.query('COMMIT')
    const result = await authority(observer, index)
    assert.equal(result.current_snapshot_id, snapshot)
    return result
  }
  await writer.query('BEGIN')
  for (const org of organizations) await writer.query(`INSERT INTO organizations (id, name, slug, updated_at)
    VALUES ($1, 'HAW-70 sync-state witness', $2, now())`, [org, `haw70-sync-${org}`])
  for (const scope of scopes) await writer.query(`INSERT INTO customer_tenants
    (id, organization_id, microsoft_tenant_id, updated_at) VALUES ($1, $2, $3, now())`,
  [scope.tenantId, scope.organizationId, randomUUID()])
  await writer.query('COMMIT')
  for (let i = 0; i < scopes.length; i++) await tag(i)
  const insert = (client: pg.Client, index: number, resource = 'USERS', id = randomUUID()) => {
    const scope = scopes[index]
    return client.query(`INSERT INTO sync_states
      (id, organization_id, customer_tenant_id, resource_type, status, updated_at)
      VALUES ($1, $2, $3, $4::"SyncResourceType", 'IDLE', now())`,
    [id, scope.organizationId, scope.tenantId, resource])
  }
  const invalidated = (before: Awaited<ReturnType<typeof authority>>) => ({ ...before,
    source_revision: (BigInt(before.source_revision) + 1n).toString(),
    current_snapshot_id: null, current_observation_sequence: '0' })
  return { writer, observer, scopes, authority, tag, insert, invalidated }
}

test('HAW-70 sync-state create, claim, terminal outcomes and deletion invalidate only at their source commit',
  { skip: !RUN, timeout: 60_000 }, async context => {
    const f = await syncStateAuthorityFixture(context)
    const id = randomUUID()
    const untouched = await f.authority(f.observer, 1)
    const changes = [
      () => f.insert(f.writer, 0, 'USERS', id),
      () => f.writer.query(`UPDATE sync_states SET status = 'RUNNING', last_attempt_at = now() WHERE id = $1`, [id]),
      () => f.writer.query(`UPDATE sync_states SET status = 'SUCCEEDED', last_successful_at = now() WHERE id = $1`, [id]),
      () => f.writer.query(`UPDATE sync_states SET status = 'FAILED', last_error_code = 'SYNTHETIC',
        last_error_message = 'synthetic failure', consecutive_failures = 1 WHERE id = $1`, [id]),
      () => f.writer.query('UPDATE sync_states SET delta_link = delta_link WHERE id = $1', [id]),
      () => f.writer.query('DELETE FROM sync_states WHERE id = $1', [id]),
    ]
    for (let step = 0; step < changes.length; step++) {
      const before = await f.authority(f.observer, 0)
      const sourceBefore = (await f.observer.query('SELECT * FROM sync_states WHERE id = $1', [id])).rows
      await f.writer.query('BEGIN')
      assert.equal((await changes[step]()).rowCount, 1)
      assert.deepEqual(await f.authority(f.writer, 0), f.invalidated(before))
      assert.deepEqual(await f.authority(f.observer, 0), before, 'an independent session still sees the old current pointer')
      assert.deepEqual((await f.observer.query('SELECT * FROM sync_states WHERE id = $1', [id])).rows, sourceBefore)
      await f.writer.query('COMMIT')
      assert.deepEqual(await f.authority(f.observer, 0), f.invalidated(before))
      assert.deepEqual(await f.authority(f.observer, 1), untouched)
      const sourceAfter = (await f.observer.query('SELECT * FROM sync_states WHERE id = $1', [id])).rows
      if (step === 5) assert.deepEqual(sourceAfter, [])
      else assert.equal(sourceAfter[0].status, ['IDLE', 'RUNNING', 'SUCCEEDED', 'FAILED', 'FAILED'][step])
      if (step < changes.length - 1) await f.tag(0)
    }
  })

test('HAW-70 sync-state bulk, conflict, zero-row, rollback and cross-organization scope moves use exact affected pairs',
  { skip: !RUN, timeout: 60_000 }, async context => {
    const f = await syncStateAuthorityFixture(context)
    const before = await f.authority(f.observer, 0), otherBefore = await f.authority(f.observer, 1)
    const ids = [randomUUID(), randomUUID()], scope = f.scopes[0]
    await f.writer.query(`INSERT INTO sync_states
      (id, organization_id, customer_tenant_id, resource_type, updated_at)
      VALUES ($1, $3, $4, 'USERS', now()), ($2, $3, $4, 'GROUPS', now())`,
    [...ids, scope.organizationId, scope.tenantId])
    assert.deepEqual(await f.authority(f.observer, 0), f.invalidated(before), 'bulk rows coalesce per event')
    await f.tag(0)
    const tagged = await f.authority(f.observer, 0)
    await f.writer.query(`INSERT INTO sync_states
      (id, organization_id, customer_tenant_id, resource_type, updated_at)
      VALUES ($1, $2, $3, 'USERS', now()) ON CONFLICT (customer_tenant_id, resource_type) DO NOTHING`,
    [randomUUID(), scope.organizationId, scope.tenantId])
    await f.writer.query('UPDATE sync_states SET status = status WHERE id = $1', [randomUUID()])
    await f.writer.query('DELETE FROM sync_states WHERE id = $1', [randomUUID()])
    assert.deepEqual(await f.authority(f.observer, 0), tagged)
    await f.writer.query(`INSERT INTO sync_states
      (id, organization_id, customer_tenant_id, resource_type, status, updated_at)
      VALUES ($1, $2, $3, 'USERS', 'FAILED', now())
      ON CONFLICT (customer_tenant_id, resource_type) DO UPDATE SET status = EXCLUDED.status`,
    [randomUUID(), scope.organizationId, scope.tenantId])
    assert.deepEqual(await f.authority(f.observer, 0), f.invalidated(tagged), 'empty INSERT transition and actual UPDATE count once')
    await f.tag(0)
    const moveFrom = await f.authority(f.observer, 0), moveTo = await f.authority(f.observer, 2)
    const move = () => f.writer.query(`UPDATE sync_states SET organization_id = $2, customer_tenant_id = $3,
      resource_type = 'DEVICES' WHERE id = $1`, [ids[1], f.scopes[2].organizationId, f.scopes[2].tenantId])
    await f.writer.query('BEGIN')
    await move()
    assert.deepEqual(await f.authority(f.writer, 0), f.invalidated(moveFrom))
    assert.deepEqual(await f.authority(f.writer, 2), f.invalidated(moveTo))
    assert.deepEqual(await f.authority(f.observer, 0), moveFrom)
    assert.deepEqual(await f.authority(f.observer, 2), moveTo)
    await f.writer.query('ROLLBACK')
    assert.deepEqual(await f.authority(f.observer, 0), moveFrom)
    assert.deepEqual(await f.authority(f.observer, 2), moveTo)
    assert.equal((await f.observer.query('SELECT customer_tenant_id FROM sync_states WHERE id = $1', [ids[1]])).rows[0].customer_tenant_id, scope.tenantId)
    await move()
    assert.deepEqual(await f.authority(f.observer, 0), f.invalidated(moveFrom))
    assert.deepEqual(await f.authority(f.observer, 2), f.invalidated(moveTo))
    assert.equal((await f.observer.query('SELECT customer_tenant_id FROM sync_states WHERE id = $1', [ids[1]])).rows[0].customer_tenant_id, f.scopes[2].tenantId)
    assert.deepEqual(await f.authority(f.observer, 1), otherBefore)
  })

test('HAW-70 sync-state overflow rolls back its source and missing or dead authority never becomes trusted',
  { skip: !RUN, timeout: 60_000 }, async context => {
    const f = await syncStateAuthorityFixture(context)
    const first = f.scopes[0]
    await f.writer.query(`UPDATE tenant_health_source_authorities SET source_revision = 9223372036854775807,
      current_snapshot_id = NULL, current_observation_sequence = 0 WHERE organization_id = $1 AND customer_tenant_id = $2`,
    [first.organizationId, first.tenantId])
    const overflowBefore = await f.authority(f.observer, 0)
    await assert.rejects(f.insert(f.writer, 0), sqlState('22003'))
    assert.deepEqual(await f.authority(f.observer, 0), overflowBefore)
    assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM sync_states WHERE customer_tenant_id = $1', [first.tenantId])).rows[0].n, 0)
    const missing = f.scopes[1], dead = f.scopes[2]
    await f.writer.query('DELETE FROM tenant_health_source_authorities WHERE organization_id = $1 AND customer_tenant_id = $2', [missing.organizationId, missing.tenantId])
    await f.writer.query(`UPDATE tenant_health_source_authorities SET live = false,
      current_snapshot_id = NULL, current_observation_sequence = 0 WHERE organization_id = $1 AND customer_tenant_id = $2`,
    [dead.organizationId, dead.tenantId])
    const deadBefore = await f.authority(f.observer, 2)
    await f.insert(f.writer, 1)
    await f.insert(f.writer, 2)
    assert.equal(await f.authority(f.observer, 1), undefined)
    assert.deepEqual(await f.authority(f.observer, 2), deadBefore)
    assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM sync_states WHERE customer_tenant_id = ANY($1::uuid[])', [[missing.tenantId, dead.tenantId]])).rows[0].n, 2)
  })

function insertHealthInputSnapshot(
  f: Awaited<ReturnType<typeof syncStateAuthorityFixture>>,
  index: number, resource = 'AUTH_REGISTRATIONS', id = randomUUID(),
) {
  const scope = f.scopes[index]
  return f.writer.query(`INSERT INTO tenant_entra_snapshots
    (id, organization_id, customer_tenant_id, resource_type, payload, observed_at, updated_at)
    VALUES ($1, $2, $3, $4::"SyncResourceType", '[]'::jsonb, '2026-11-16T02:00:00Z', now())`,
  [id, scope.organizationId, scope.tenantId, resource])
}

test('HAW-70 saved-health snapshot inputs invalidate payload, observation, no-op and deletion only at commit',
  { skip: !RUN, timeout: 60_000 }, async context => {
    const f = await syncStateAuthorityFixture(context)
    const siblingBefore = await f.authority(f.observer, 1)
    for (const resource of ['AUTH_REGISTRATIONS', 'RISKY_USERS']) {
      const id = randomUUID()
      const read = async (client: pg.Client) => (await client.query(
        'SELECT payload, observed_at::text FROM tenant_entra_snapshots WHERE id = $1', [id])).rows
      const mutations = [
        () => insertHealthInputSnapshot(f, 0, resource, id),
        () => f.writer.query(`UPDATE tenant_entra_snapshots SET payload = '[{"changed":true}]'::jsonb WHERE id = $1`, [id]),
        () => f.writer.query(`UPDATE tenant_entra_snapshots SET observed_at = observed_at + interval '1 minute' WHERE id = $1`, [id]),
        () => f.writer.query('UPDATE tenant_entra_snapshots SET payload = payload WHERE id = $1', [id]),
        () => f.writer.query('DELETE FROM tenant_entra_snapshots WHERE id = $1', [id]),
      ]
      for (let step = 0; step < mutations.length; step++) {
        const before = await f.tag(0), sourceBefore = await read(f.observer)
        await f.writer.query('BEGIN')
        assert.equal((await mutations[step]()).rowCount, 1)
        assert.deepEqual(await f.authority(f.writer, 0), f.invalidated(before))
        const sourceAfter = await read(f.writer)
        if (step === 3) assert.deepEqual(sourceAfter, sourceBefore)
        else assert.notDeepEqual(sourceAfter, sourceBefore)
        assert.deepEqual(await f.authority(f.observer, 0), before)
        assert.deepEqual(await read(f.observer), sourceBefore)
        await f.writer.query('COMMIT')
        assert.deepEqual(await f.authority(f.observer, 0), f.invalidated(before))
        assert.deepEqual(await read(f.observer), sourceAfter)
        assert.deepEqual(await f.authority(f.observer, 1), siblingBefore)
      }
    }
  })

test('HAW-70 snapshot membership, upsert and scope transitions invalidate exactly the old and new relevant pairs',
  { skip: !RUN, timeout: 60_000 }, async context => {
    const f = await syncStateAuthorityFixture(context)
    const ids = [randomUUID(), randomUUID(), randomUUID()], scope = f.scopes[0]
    const transition = async (affected: number[], mutate: () => Promise<pg.QueryResult>) => {
      const before = []
      for (let i = 0; i < f.scopes.length; i++) before.push(await f.tag(i))
      await mutate()
      for (let i = 0; i < f.scopes.length; i++) assert.deepEqual(await f.authority(f.observer, i),
        affected.includes(i) ? f.invalidated(before[i]) : before[i])
    }
    await transition([0], () => f.writer.query(`INSERT INTO tenant_entra_snapshots
      (id, organization_id, customer_tenant_id, resource_type, updated_at)
      VALUES ($1, $4, $5, 'AUTH_REGISTRATIONS', now()), ($2, $4, $5, 'RISKY_USERS', now()),
        ($3, $6, $7, 'SECURE_SCORES', now())`,
    [...ids, scope.organizationId, scope.tenantId, f.scopes[1].organizationId, f.scopes[1].tenantId]))
    const upsert = (index: number, action: 'NOTHING' | 'UPDATE') => {
      const target = f.scopes[index]
      return f.writer.query(`INSERT INTO tenant_entra_snapshots
        (id, organization_id, customer_tenant_id, resource_type, payload, updated_at)
        VALUES ($1, $2, $3, 'AUTH_REGISTRATIONS', '[{"updated":true}]'::jsonb, now())
        ON CONFLICT (customer_tenant_id, resource_type) DO ${action === 'NOTHING' ? 'NOTHING' : 'UPDATE SET payload = EXCLUDED.payload'}`,
      [randomUUID(), target.organizationId, target.tenantId])
    }
    await transition([], () => upsert(0, 'NOTHING'))
    await transition([0], () => upsert(0, 'UPDATE'))
    await transition([1], () => upsert(1, 'UPDATE')) // Fresh INSERT path of the same statement.
    const mixedBefore = await f.tag(1), mixedId = randomUUID(), mixedScope = f.scopes[1]
    assert.equal((await f.writer.query(`INSERT INTO tenant_entra_snapshots
      (id, organization_id, customer_tenant_id, resource_type, payload, updated_at)
      VALUES ($1, $3, $4, 'AUTH_REGISTRATIONS', '[{"mixed":true}]'::jsonb, now()),
        ($2, $3, $4, 'RISKY_USERS', '[]'::jsonb, now())
      ON CONFLICT (customer_tenant_id, resource_type) DO UPDATE SET payload = EXCLUDED.payload`,
    [randomUUID(), mixedId, mixedScope.organizationId, mixedScope.tenantId])).rowCount, 2)
    assert.deepEqual(await f.authority(f.observer, 1), f.invalidated(f.invalidated(mixedBefore)),
      'One inserted row plus one updated row advance the same scope once per actual event')
    assert.equal((await f.writer.query('DELETE FROM tenant_entra_snapshots WHERE id = $1', [mixedId])).rowCount, 1)
    await transition([], () => f.writer.query('UPDATE tenant_entra_snapshots SET payload = payload WHERE id = $1', [randomUUID()]))
    await transition([], () => f.writer.query('DELETE FROM tenant_entra_snapshots WHERE id = $1', [randomUUID()]))
    for (const resource of ['SIGN_INS', 'DIRECTORY_ROLES', 'SECURITY_DEFAULTS', 'CONDITIONAL_ACCESS', 'SECURE_SCORES']) {
      const excludedId = randomUUID()
      await transition([], () => insertHealthInputSnapshot(f, 2, resource, excludedId))
      await transition([], () => f.writer.query('UPDATE tenant_entra_snapshots SET payload = payload WHERE id = $1', [excludedId]))
      await transition([], () => f.writer.query('DELETE FROM tenant_entra_snapshots WHERE id = $1', [excludedId]))
    }
    const move = (index: number, resource: string) => f.writer.query(`UPDATE tenant_entra_snapshots
      SET organization_id = $2, customer_tenant_id = $3, resource_type = $4::"SyncResourceType" WHERE id = $1`,
    [ids[1], f.scopes[index].organizationId, f.scopes[index].tenantId, resource])
    await transition([0], () => move(0, 'SECURE_SCORES')) // Included -> excluded, old membership counts.
    await transition([], () => move(0, 'CONDITIONAL_ACCESS'))
    await transition([2], () => move(2, 'RISKY_USERS')) // Excluded old scope is not invalidated.
    await transition([2, 1], () => move(1, 'RISKY_USERS'))
    await transition([1, 0], () => move(0, 'RISKY_USERS')) // Same organization, distinct tenants.
    await transition([0, 2], () => move(2, 'AUTH_REGISTRATIONS'))
    await transition([2], () => move(2, 'SECURE_SCORES'))
    await transition([0], () => move(0, 'RISKY_USERS'))
    const before = await f.tag(0), otherBefore = await f.tag(2)
    await f.writer.query('BEGIN')
    await move(2, 'RISKY_USERS')
    assert.deepEqual(await f.authority(f.writer, 0), f.invalidated(before))
    assert.deepEqual(await f.authority(f.writer, 2), f.invalidated(otherBefore))
    assert.deepEqual(await f.authority(f.observer, 0), before)
    assert.deepEqual(await f.authority(f.observer, 2), otherBefore)
    await f.writer.query('ROLLBACK')
    assert.deepEqual(await f.authority(f.observer, 0), before)
    assert.deepEqual(await f.authority(f.observer, 2), otherBefore)
    assert.equal((await f.observer.query('SELECT customer_tenant_id FROM tenant_entra_snapshots WHERE id = $1', [ids[1]])).rows[0].customer_tenant_id, scope.tenantId)
  })

test('HAW-70 snapshot authority overflow rolls back source changes without resurrecting absent or dead authority',
  { skip: !RUN, timeout: 60_000 }, async context => {
    const f = await syncStateAuthorityFixture(context)
    const id = randomUUID(), first = f.scopes[0]
    await insertHealthInputSnapshot(f, 0, 'AUTH_REGISTRATIONS', id)
    await f.writer.query(`UPDATE tenant_health_source_authorities SET source_revision = 9223372036854775807,
      current_snapshot_id = NULL, current_observation_sequence = 0 WHERE organization_id = $1 AND customer_tenant_id = $2`,
    [first.organizationId, first.tenantId])
    const before = await f.authority(f.observer, 0)
    const readSource = async () => (await f.observer.query(`SELECT * FROM tenant_entra_snapshots
      WHERE customer_tenant_id = $1 ORDER BY id`, [first.tenantId])).rows
    const sourceBefore = await readSource()
    for (const mutate of [() => insertHealthInputSnapshot(f, 0, 'RISKY_USERS'),
      () => f.writer.query(`UPDATE tenant_entra_snapshots SET payload = '[{"changed":true}]'::jsonb WHERE id = $1`, [id]),
      () => f.writer.query('DELETE FROM tenant_entra_snapshots WHERE id = $1', [id])]) {
      await assert.rejects(mutate(), sqlState('22003'))
      assert.deepEqual(await readSource(), sourceBefore)
      assert.deepEqual(await f.authority(f.observer, 0), before)
    }
    await insertHealthInputSnapshot(f, 0, 'SECURE_SCORES')
    assert.deepEqual(await f.authority(f.observer, 0), before, 'An unrelated snapshot must not touch exhausted authority')
    const missing = f.scopes[1], dead = f.scopes[2]
    await f.writer.query('DELETE FROM tenant_health_source_authorities WHERE organization_id = $1 AND customer_tenant_id = $2', [missing.organizationId, missing.tenantId])
    await f.writer.query(`UPDATE tenant_health_source_authorities SET live = false,
      current_snapshot_id = NULL, current_observation_sequence = 0 WHERE organization_id = $1 AND customer_tenant_id = $2`,
    [dead.organizationId, dead.tenantId])
    const deadBefore = await f.authority(f.observer, 2)
    await insertHealthInputSnapshot(f, 1)
    await insertHealthInputSnapshot(f, 2, 'RISKY_USERS')
    assert.equal(await f.authority(f.observer, 1), undefined)
    assert.deepEqual(await f.authority(f.observer, 2), deadBefore)
    assert.equal((await f.observer.query(`SELECT count(*)::int AS n FROM tenant_entra_snapshots
      WHERE customer_tenant_id = ANY($1::uuid[])`, [[missing.tenantId, dead.tenantId]])).rows[0].n, 2)
  })

// All participating child sources must be present: single-child coverage cannot establish
// ordering when a parent DELETE also cascades through other child sources.
// Do not infer a deadlock from nested SQL alone; require a real blocking edge.
for (const deleteTarget of ['tenant', 'organization'] as const) {
  test(`HAW-70 ${deleteTarget} cascades with audit, sync-state and health-input snapshot rows preserve source-before-authority ordering`,
    { skip: !RUN, timeout: 120_000 }, async context => {
      for (const heldSource of ['sync-state', 'audit', 'snapshot'] as const) {
        for (const mutation of ['update', 'delete'] as const) {
          for (const outcome of ['commit', 'rollback'] as const) {
            await context.test(`${heldSource} ${mutation}, ${deleteTarget} ${outcome}`, { timeout: 15_000 }, async subcontext => {
              const f = await syncStateAuthorityFixture(subcontext)
              const deleter = new pg.Client({ connectionString: URL!, statement_timeout: 10_000 })
              const scope = f.scopes[0], syncId = randomUUID(), auditId = randomUUID(), snapshotId = randomUUID()
              let deletion: Promise<{ result?: pg.QueryResult; error?: unknown }> | undefined
              await deleter.connect()
              try {
                await f.insert(f.writer, 0, 'USERS', syncId)
                await f.writer.query(`INSERT INTO directory_audit_logs
                  (id, organization_id, customer_tenant_id, microsoft_audit_id,
                   event_date_time, activity_display_name, raw, expires_at)
                  VALUES ($1, $2, $3, $4, now(), 'cascade before', '{}'::jsonb, now() + interval '1 day')`,
                [auditId, scope.organizationId, scope.tenantId, `haw70-cascade-${auditId}`])
                await insertHealthInputSnapshot(f, 0, 'RISKY_USERS', snapshotId)
                const before = await f.tag(0)
                const siblingBefore = await f.authority(f.observer, 1)
                const outsideBefore = await f.authority(f.observer, 2)
                const readOrganization = async (client: pg.Client) => ({
                  organization: (await client.query('SELECT id FROM organizations WHERE id = $1', [scope.organizationId])).rows,
                  tenants: (await client.query('SELECT id FROM customer_tenants WHERE organization_id = $1 ORDER BY id', [scope.organizationId])).rows,
                  snapshots: (await client.query('SELECT id FROM tenant_health_snapshots WHERE organization_id = $1 ORDER BY id', [scope.organizationId])).rows,
                })
                const organizationBefore = await readOrganization(f.observer)
                assert.equal(organizationBefore.organization.length, 1)
                assert.equal(organizationBefore.tenants.length, 2)
                assert.ok(organizationBefore.snapshots.length >= 2)
                if (deleteTarget === 'organization') {
                  // Direct authority deletion is an RI action, unlike the queued
                  // tenant tombstone. Inspect actual trigger names, never OIDs
                  // or migration timestamps, and do not alter their order.
                  const cascadeOrder = await f.observer.query<{ child: string; trigger_name: string }>(`
                    SELECT child.relname AS child, trigger.tgname AS trigger_name
                    FROM pg_catalog.pg_trigger AS trigger
                    JOIN pg_catalog.pg_constraint AS constraint_row ON constraint_row.oid = trigger.tgconstraint
                    JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = trigger.tgfoid
                    JOIN pg_catalog.pg_class AS child ON child.oid = constraint_row.conrelid
                    WHERE trigger.tgrelid = 'public.organizations'::regclass
                      AND trigger.tgisinternal AND trigger.tgtype = 9 AND trigger.tgenabled = 'O'
                      AND procedure.proname = 'RI_FKey_cascade_del'
                      AND procedure.pronamespace = 'pg_catalog'::regnamespace
                      AND constraint_row.contype = 'f' AND constraint_row.confdeltype = 'c'
                      AND constraint_row.convalidated
                      AND constraint_row.confrelid = 'public.organizations'::regclass
                      AND child.oid IN ('public.customer_tenants'::regclass, 'public.sync_states'::regclass,
                        'public.directory_audit_logs'::regclass, 'public.tenant_entra_snapshots'::regclass,
                        'public.tenant_health_source_authorities'::regclass)
                    ORDER BY trigger.tgname COLLATE "C"`)
                  assert.deepEqual(cascadeOrder.rows.map(row => row.child).sort(),
                    ['customer_tenants', 'directory_audit_logs', 'sync_states', 'tenant_entra_snapshots', 'tenant_health_source_authorities'])
                  subcontext.diagnostic(`Relevant organization DELETE cascade order: ${JSON.stringify(cascadeOrder.rows)}`)
                }
                const readSources = async (client: pg.Client) => ({
                  sync: (await client.query('SELECT id, status FROM sync_states WHERE id = $1', [syncId])).rows,
                  audit: (await client.query('SELECT id, activity_display_name FROM directory_audit_logs WHERE id = $1', [auditId])).rows,
                  inputSnapshot: (await client.query('SELECT id, payload FROM tenant_entra_snapshots WHERE id = $1', [snapshotId])).rows,
                })
                const sourceBefore = await readSources(f.observer)
                assert.equal(sourceBefore.sync.length, 1)
                assert.equal(sourceBefore.audit.length, 1)
                assert.equal(sourceBefore.inputSnapshot.length, 1)
                const writerPid = (await f.writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
                const observerPid = (await f.observer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
                const deleterPid = (await deleter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
                assert.equal(new Set([writerPid, observerPid, deleterPid]).size, 3)

                await f.writer.query('BEGIN')
                const locked = heldSource === 'sync-state'
                  ? await f.writer.query('SELECT id FROM sync_states WHERE id = $1 FOR UPDATE', [syncId])
                  : heldSource === 'audit'
                    ? await f.writer.query('SELECT id FROM directory_audit_logs WHERE id = $1 FOR UPDATE', [auditId])
                    : await f.writer.query('SELECT id FROM tenant_entra_snapshots WHERE id = $1 FOR UPDATE', [snapshotId])
                assert.equal(locked.rowCount, 1)
                await deleter.query('BEGIN')
                await deleter.query("SET LOCAL lock_timeout = '8s'")
                deletion = (deleteTarget === 'organization'
                  ? deleter.query('DELETE FROM organizations WHERE id = $1', [scope.organizationId])
                  : deleter.query('DELETE FROM customer_tenants WHERE id = $1', [scope.tenantId]))
                  .then(result => ({ result }), error => ({ error }))

                let blocked = false
                const deadline = Date.now() + 4_000
                while (Date.now() < deadline) {
                  blocked = (await f.observer.query<{ blocked: boolean }>(
                    'SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked', [writerPid, deleterPid])).rows[0].blocked
                  if (blocked) break
                  await delay(25)
                }
                assert.equal(blocked, true, `${deleteTarget} DELETE must actually wait on the held child source`)
                assert.deepEqual(await f.authority(f.observer, 0), before)
                assert.deepEqual(await readSources(f.observer), sourceBefore)
                // If a cascade already holds H while waiting for the child row,
                // reject immediately instead of hiding the cycle behind a retry.
                const available = await f.writer.query(`SELECT 1 FROM tenant_health_source_authorities
                  WHERE organization_id = $1 AND customer_tenant_id = $2 FOR UPDATE NOWAIT`,
                [scope.organizationId, scope.tenantId])
                assert.equal(available.rowCount, 1, 'authority must remain available to the held-source writer')

                const changed = heldSource === 'sync-state'
                  ? mutation === 'delete'
                    ? await f.writer.query('DELETE FROM sync_states WHERE id = $1', [syncId])
                    : await f.writer.query("UPDATE sync_states SET status = 'SUCCEEDED', last_successful_at = now() WHERE id = $1", [syncId])
                  : heldSource === 'audit'
                    ? mutation === 'delete'
                      ? await f.writer.query('DELETE FROM directory_audit_logs WHERE id = $1', [auditId])
                      : await f.writer.query("UPDATE directory_audit_logs SET activity_display_name = 'cascade after' WHERE id = $1", [auditId])
                    : mutation === 'delete'
                      ? await f.writer.query('DELETE FROM tenant_entra_snapshots WHERE id = $1', [snapshotId])
                      : await f.writer.query("UPDATE tenant_entra_snapshots SET payload = '[{\"changed\":true}]'::jsonb WHERE id = $1", [snapshotId])
                assert.equal(changed.rowCount, 1)
                const writerAuthority = f.invalidated(before)
                assert.deepEqual(await f.authority(f.writer, 0), writerAuthority)
                assert.deepEqual(await f.authority(f.observer, 0), before)
                assert.deepEqual(await readSources(f.observer), sourceBefore)
                const sourceAfterWriter = await readSources(f.writer)
                if (heldSource === 'sync-state') {
                  assert.deepEqual(sourceAfterWriter.sync, mutation === 'delete' ? [] : [{ id: syncId, status: 'SUCCEEDED' }])
                  assert.deepEqual(sourceAfterWriter.audit, sourceBefore.audit)
                  assert.deepEqual(sourceAfterWriter.inputSnapshot, sourceBefore.inputSnapshot)
                } else if (heldSource === 'audit') {
                  assert.deepEqual(sourceAfterWriter.audit, mutation === 'delete' ? [] : [{ id: auditId, activity_display_name: 'cascade after' }])
                  assert.deepEqual(sourceAfterWriter.sync, sourceBefore.sync)
                  assert.deepEqual(sourceAfterWriter.inputSnapshot, sourceBefore.inputSnapshot)
                } else {
                  assert.deepEqual(sourceAfterWriter.inputSnapshot, mutation === 'delete' ? [] : [{ id: snapshotId, payload: [{ changed: true }] }])
                  assert.deepEqual(sourceAfterWriter.sync, sourceBefore.sync)
                  assert.deepEqual(sourceAfterWriter.audit, sourceBefore.audit)
                }
                await f.writer.query('COMMIT')

                const result = await deletion
                if (result.error) throw result.error
                assert.equal(result.result?.rowCount, 1)
                const deletingAuthority = await f.authority(deleter, 0)
                if (deleteTarget === 'organization') {
                  assert.equal(deletingAuthority, undefined, 'organization deletion removes authority instead of retaining tombstones')
                  assert.equal(await f.authority(deleter, 1), undefined)
                  assert.deepEqual(await readOrganization(deleter), { organization: [], tenants: [], snapshots: [] })
                } else {
                  assert.equal(deletingAuthority.live, false)
                  assert.equal(deletingAuthority.incarnation, before.incarnation)
                  assert.equal(deletingAuthority.current_snapshot_id, null)
                  assert.equal(deletingAuthority.current_observation_sequence, '0')
                  assert.ok(BigInt(deletingAuthority.source_revision) > BigInt(writerAuthority.source_revision))
                }
                assert.deepEqual(await readSources(deleter), { sync: [], audit: [], inputSnapshot: [] })
                // The cascade is still uncommitted, so only the writer's commit
                // may be visible through the independent observer connection.
                assert.deepEqual(await f.authority(f.observer, 0), writerAuthority)
                assert.deepEqual(await readSources(f.observer), sourceAfterWriter)
                assert.deepEqual(await readOrganization(f.observer), organizationBefore)
                assert.deepEqual(await f.authority(f.observer, 1), siblingBefore)
                await deleter.query(outcome === 'commit' ? 'COMMIT' : 'ROLLBACK')

                assert.deepEqual(await f.authority(f.observer, 0), outcome === 'commit' ? deletingAuthority : writerAuthority)
                assert.deepEqual(await readSources(f.observer), outcome === 'commit' ? { sync: [], audit: [], inputSnapshot: [] } : sourceAfterWriter)
                assert.equal((await f.observer.query('SELECT id FROM customer_tenants WHERE id = $1', [scope.tenantId])).rowCount,
                  outcome === 'commit' ? 0 : 1)
                assert.deepEqual(await f.authority(f.observer, 1),
                  deleteTarget === 'organization' && outcome === 'commit' ? undefined : siblingBefore)
                assert.deepEqual(await f.authority(f.observer, 2), outsideBefore)
                if (deleteTarget === 'organization') {
                  assert.deepEqual(await readOrganization(f.observer), outcome === 'commit'
                    ? { organization: [], tenants: [], snapshots: [] } : organizationBefore)
                }
              } finally {
                // Release the deliberately held source before waiting for the
                // competing statement; its transaction must end before cleanup.
                await f.writer.query('ROLLBACK')
                if (deletion) await deletion
                await deleter.query('ROLLBACK')
                await deleter.end()
              }
            })
          }
        }
      }
    })
}

const snapshotRaceVariants = [
  { name: 'insert', resource: 'AUTH_REGISTRATIONS', upsert: false, existing: false },
  { name: 'fresh upsert', resource: 'RISKY_USERS', upsert: true, existing: false },
  { name: 'conflicting upsert', resource: 'AUTH_REGISTRATIONS', upsert: true, existing: true },
] as const

// These are source-statement schedules. They do not inject locks/triggers or
// claim to exercise the complete collector's advisory/evidence transaction.
async function snapshotParentRaceFixture(
  context: import('node:test').TestContext,
  variant: typeof snapshotRaceVariants[number],
  deleteTarget: 'tenant' | 'organization',
) {
  const f = await syncStateAuthorityFixture(context)
  const scope = f.scopes[0], sourceId = randomUUID(), auditId = randomUUID()
  await f.insert(f.writer, 0)
  await f.writer.query(`INSERT INTO directory_audit_logs
    (id, organization_id, customer_tenant_id, microsoft_audit_id,
     event_date_time, activity_display_name, raw, expires_at)
    VALUES ($1, $2, $3, $4, now(), 'snapshot race', '{}'::jsonb, now() + interval '1 day')`,
  [auditId, scope.organizationId, scope.tenantId, `haw70-snapshot-race-${auditId}`])
  if (variant.existing) await insertHealthInputSnapshot(f, 0, variant.resource, sourceId)
  await f.tag(0)
  const read = async (client: pg.Client) => ({
    organization: (await client.query('SELECT id FROM organizations WHERE id = $1', [scope.organizationId])).rows,
    tenants: (await client.query('SELECT id FROM customer_tenants WHERE organization_id = $1 ORDER BY id', [scope.organizationId])).rows,
    source: (await client.query(`SELECT id, resource_type, payload, observed_at FROM tenant_entra_snapshots
      WHERE customer_tenant_id = $1 AND resource_type = $2::"SyncResourceType"`, [scope.tenantId, variant.resource])).rows,
    sync: (await client.query('SELECT id, status FROM sync_states WHERE customer_tenant_id = $1 ORDER BY id', [scope.tenantId])).rows,
    audit: (await client.query('SELECT id, activity_display_name FROM directory_audit_logs WHERE customer_tenant_id = $1 ORDER BY id', [scope.tenantId])).rows,
    histories: (await client.query(`SELECT id, customer_tenant_id FROM tenant_health_snapshots
      WHERE organization_id = $1 ORDER BY id`, [scope.organizationId])).rows,
    authorities: await Promise.all(f.scopes.map((_, index) => f.authority(client, index))),
  })
  const before = await read(f.observer)
  assert.equal(before.source.length, variant.existing ? 1 : 0)
  assert.equal(before.organization.length, 1)
  assert.equal(before.tenants.length, 2)
  assert.equal(before.sync.length, 1)
  assert.equal(before.audit.length, 1)
  assert.ok(before.histories.some(row => row.customer_tenant_id === f.scopes[1].tenantId))
  const write = () => f.writer.query(`INSERT INTO tenant_entra_snapshots
    (id, organization_id, customer_tenant_id, resource_type, payload, observed_at, updated_at)
    VALUES ($1, $2, $3, $4::"SyncResourceType", '[{"witness":"candidate"}]'::jsonb, '2026-11-16T03:45:00Z', now())
    ${variant.upsert ? `ON CONFLICT (customer_tenant_id, resource_type)
      DO UPDATE SET payload = EXCLUDED.payload, observed_at = EXCLUDED.observed_at` : ''}`,
  [variant.existing ? randomUUID() : sourceId, scope.organizationId, scope.tenantId, variant.resource])
  const deleteParent = (client: pg.Client) => deleteTarget === 'organization'
    ? client.query('DELETE FROM organizations WHERE id = $1', [scope.organizationId])
    : client.query('DELETE FROM customer_tenants WHERE id = $1', [scope.tenantId])
  const assertWritten = (state: Awaited<ReturnType<typeof read>>) => {
    assert.deepEqual(state.source, [{ id: sourceId, resource_type: variant.resource,
      payload: [{ witness: 'candidate' }], observed_at: new Date('2026-11-16T03:45:00Z') }])
    assert.deepEqual(state.authorities, [f.invalidated(before.authorities[0]), ...before.authorities.slice(1)])
    assert.deepEqual({ ...state, source: before.source, authorities: before.authorities }, before)
  }
  const assertDeleted = (state: Awaited<ReturnType<typeof read>>, prior: Awaited<ReturnType<typeof read>>) => {
    const authority = state.authorities[0]
    if (deleteTarget === 'organization') assert.equal(authority, undefined)
    else {
      assert.ok(BigInt(authority.source_revision) > BigInt(prior.authorities[0].source_revision))
      assert.deepEqual({ ...authority, source_revision: prior.authorities[0].source_revision },
        { ...prior.authorities[0], live: false, current_snapshot_id: null, current_observation_sequence: '0' })
    }
    assert.deepEqual(state, { ...prior,
      organization: deleteTarget === 'organization' ? [] : prior.organization,
      tenants: deleteTarget === 'organization' ? [] : prior.tenants.filter(row => row.id !== scope.tenantId),
      source: [], sync: [], audit: [],
      histories: deleteTarget === 'organization' ? [] : prior.histories.filter(row => row.customer_tenant_id !== scope.tenantId),
      authorities: [authority, deleteTarget === 'organization' ? undefined : prior.authorities[1], prior.authorities[2]],
    })
  }
  return { ...f, before, read, write, deleteParent, assertWritten, assertDeleted }
}

async function snapshotRacePids(writer: pg.Client, observer: pg.Client, deleter: pg.Client) {
  const pids = await Promise.all([writer, observer, deleter].map(async client =>
    (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid))
  assert.equal(new Set(pids).size, 3)
  return { writerPid: pids[0], deleterPid: pids[2] }
}

async function assertSnapshotRaceBlocks(observer: pg.Client, holderPid: number, blockedPid: number) {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    const blocked = (await observer.query<{ blocked: boolean }>(
      'SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked', [holderPid, blockedPid])).rows[0].blocked
    if (blocked) return
    await delay(25)
  }
  assert.fail('The competing statement must actually block on the other session, not merely run later')
}

function captureSnapshotRaceQuery(query: Promise<pg.QueryResult>): Promise<{ result?: pg.QueryResult; error?: unknown }> {
  return query.then(result => ({ result }), error => ({ error }))
}

for (const deleteTarget of ['tenant', 'organization'] as const) {
  test(`HAW-70 snapshot insert/upsert before ${deleteTarget} deletion preserves writer and deletion commit boundaries`,
    { skip: !RUN, timeout: 120_000 }, async context => {
      for (const variant of snapshotRaceVariants) {
        for (const writerOutcome of ['commit', 'rollback'] as const) {
          for (const deleteOutcome of ['commit', 'rollback'] as const) {
            await context.test(`${variant.name}, source ${writerOutcome}, parent ${deleteOutcome}`,
              { timeout: 15_000 }, async subcontext => {
                const f = await snapshotParentRaceFixture(subcontext, variant, deleteTarget)
                const deleter = new pg.Client({ connectionString: URL!, statement_timeout: 10_000 })
                let pendingDelete: ReturnType<typeof captureSnapshotRaceQuery> | undefined
                await deleter.connect()
                try {
                  const pids = await snapshotRacePids(f.writer, f.observer, deleter)
                  await f.writer.query('BEGIN')
                  assert.equal((await f.write()).rowCount, 1)
                  const written = await f.read(f.writer)
                  f.assertWritten(written)
                  assert.deepEqual(await f.read(f.observer), f.before)
                  await deleter.query('BEGIN')
                  await deleter.query("SET LOCAL lock_timeout = '8s'")
                  pendingDelete = captureSnapshotRaceQuery(f.deleteParent(deleter))
                  await assertSnapshotRaceBlocks(f.observer, pids.writerPid, pids.deleterPid)
                  assert.deepEqual(await f.read(f.observer), f.before)
                  await f.writer.query(writerOutcome === 'commit' ? 'COMMIT' : 'ROLLBACK')
                  const deletion = await pendingDelete
                  if (deletion.error) throw deletion.error
                  assert.equal(deletion.result?.rowCount, 1)
                  const visibleWriterState = writerOutcome === 'commit' ? written : f.before
                  const deleted = await f.read(deleter)
                  f.assertDeleted(deleted, visibleWriterState)
                  assert.deepEqual(await f.read(f.observer), visibleWriterState,
                    'Only the resolved writer transaction is visible while deletion is uncommitted')
                  await deleter.query(deleteOutcome === 'commit' ? 'COMMIT' : 'ROLLBACK')
                  assert.deepEqual(await f.read(f.observer), deleteOutcome === 'commit' ? deleted : visibleWriterState)
                } finally {
                  // The writer is the known blocker in this schedule. Release
                  // it before awaiting the queued DELETE or fixture cleanup.
                  await f.writer.query('ROLLBACK')
                  if (pendingDelete) await pendingDelete
                  await deleter.query('ROLLBACK')
                  await deleter.end()
                }
              })
          }
        }
      }
    })

  test(`HAW-70 snapshot insert/upsert after uncommitted ${deleteTarget} deletion rejects removed parents and preserves rollback`,
    { skip: !RUN, timeout: 120_000 }, async context => {
      for (const variant of snapshotRaceVariants) {
        for (const outcome of ['parent commits', 'parent rolls back, source commits', 'both roll back'] as const) {
          await context.test(`${variant.name}, ${outcome}`, { timeout: 15_000 }, async subcontext => {
            const f = await snapshotParentRaceFixture(subcontext, variant, deleteTarget)
            const deleter = new pg.Client({ connectionString: URL!, statement_timeout: 10_000 })
            let pendingWrite: ReturnType<typeof captureSnapshotRaceQuery> | undefined
            await deleter.connect()
            try {
              const pids = await snapshotRacePids(f.writer, f.observer, deleter)
              await deleter.query('BEGIN')
              assert.equal((await f.deleteParent(deleter)).rowCount, 1)
              const deleted = await f.read(deleter)
              f.assertDeleted(deleted, f.before)
              assert.deepEqual(await f.read(f.observer), f.before)
              await f.writer.query('BEGIN')
              pendingWrite = captureSnapshotRaceQuery(f.write())
              await assertSnapshotRaceBlocks(f.observer, pids.deleterPid, pids.writerPid)
              assert.deepEqual(await f.read(f.observer), f.before)
              await deleter.query(outcome === 'parent commits' ? 'COMMIT' : 'ROLLBACK')
              const write = await pendingWrite
              if (outcome === 'parent commits') {
                assert.ok(sqlState('23503')(write.error) && write.error instanceof Error)
                assert.ok('table' in write.error && write.error.table === 'tenant_entra_snapshots',
                  'The refused write must fail the snapshot parent FK, not unrelated fixture setup')
                assert.equal(write.result, undefined)
                await f.writer.query('ROLLBACK')
                assert.deepEqual(await f.read(f.observer), deleted)
              } else {
                if (write.error) throw write.error
                assert.equal(write.result?.rowCount, 1)
                const written = await f.read(f.writer)
                f.assertWritten(written)
                assert.deepEqual(await f.read(f.observer), f.before,
                  'Parent rollback does not make the still-uncommitted snapshot write visible')
                await f.writer.query(outcome === 'both roll back' ? 'ROLLBACK' : 'COMMIT')
                assert.deepEqual(await f.read(f.observer), outcome === 'both roll back' ? f.before : written)
              }
            } finally {
              // Reverse the release order: this schedule's completed but
              // uncommitted parent deletion is the source statement's blocker.
              await deleter.query('ROLLBACK')
              if (pendingWrite) await pendingWrite
              await f.writer.query('ROLLBACK')
              await deleter.end()
            }
          })
        }
      }
    })
}

const healthGuardFunctions = [
  'tenant_health_authorize_on_tenant_insert',
  'tenant_health_invalidate_on_audit_change',
  'tenant_health_invalidate_on_input_snapshot_change',
  'tenant_health_invalidate_on_sync_state_change',
  'tenant_health_tombstone_on_tenant_delete',
] as const

async function healthFunctionSettings(client: pg.Client) {
  return (await client.query(`SELECT p.proname, p.prosecdef, p.proowner::text,
      p.proacl::text, md5(p.prosrc) AS body_digest,
      ARRAY(SELECT setting FROM unnest(p.proconfig) AS setting ORDER BY setting) AS settings
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) AND p.pronargs = 0
    ORDER BY p.proname`, [healthGuardFunctions])).rows
}

// A synthetic effective-role probe, not proof that a production login cannot
// SET/RESET ROLE. All role/policy changes are confined to registered CI fixtures.
async function withRestrictedHealthWriter(
  f: Awaited<ReturnType<typeof syncStateAuthorityFixture>>,
  table: 'directory_audit_logs' | 'sync_states' | 'customer_tenants' | 'tenant_entra_snapshots',
  run: (beginRestricted: (sourcePolicy?: boolean) => Promise<void>, role: string) => Promise<void>,
  sourceOrganizations: readonly string[] = [f.scopes[0].organizationId],
) {
  const role = `haw70_rls_${randomUUID().replaceAll('-', '')}`
  const policy = `${role}_source`
  assert.ok(sourceOrganizations.includes(f.scopes[0].organizationId))
  for (const org of sourceOrganizations) assert.ok(f.scopes.some(scope => scope.organizationId === org))
  const policyOrganizations = [...new Set(sourceOrganizations)].map(org => `'${org}'::uuid`).join(', ')
  const settings = await healthFunctionSettings(f.writer)
  assert.deepEqual(settings.map(row => row.proname), healthGuardFunctions)
  for (const row of settings) {
    assert.equal(row.prosecdef, false)
    assert.deepEqual(row.settings, ['row_security=off', 'search_path=pg_catalog'])
  }
  const beginRestricted = async (sourcePolicy = true) => {
    await f.writer.query('BEGIN')
    await f.writer.query("SET LOCAL lock_timeout = '2s'")
    await f.writer.query('SET LOCAL row_security = on')
    if (!sourcePolicy) await f.writer.query(`DROP POLICY "${policy}" ON public.${table}`)
    await f.writer.query(`SET LOCAL ROLE "${role}"`)
    const identities = (await f.writer.query(`SELECT current_user AS effective_role,
        r.rolsuper, r.rolbypassrls, r.rolinherit, r.rolcanlogin,
        pg_has_role(current_user, c.relowner, 'USAGE') AS owner_rights,
        row_security_active(c.oid) AS rls_active
      FROM pg_roles r CROSS JOIN pg_class c
      WHERE r.rolname = current_user
        AND c.oid IN ($1::regclass, 'public.tenant_health_source_authorities'::regclass)`,
    [`public.${table}`])).rows
    assert.equal(identities.length, 2)
    for (const row of identities) assert.deepEqual(row, {
      effective_role: role, rolsuper: false, rolbypassrls: false, rolinherit: false,
      rolcanlogin: false, owner_rights: false, rls_active: true,
    })
  }
  try {
    await f.writer.query('BEGIN')
    await f.writer.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS
      NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION`)
    await f.writer.query(`GRANT USAGE ON SCHEMA public TO "${role}"`)
    await f.writer.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${table} TO "${role}"`)
    await f.writer.query(`GRANT SELECT, INSERT, UPDATE ON public.tenant_health_source_authorities TO "${role}"`)
    // UUID and identifiers are generated in this fixture, never caller input.
    await f.writer.query(`CREATE POLICY "${policy}" ON public.${table} FOR ALL TO "${role}"
      USING (organization_id IN (${policyOrganizations}))
      WITH CHECK (organization_id IN (${policyOrganizations}))`)
    await f.writer.query('COMMIT')
    await run(beginRestricted, role)
  } finally {
    await f.writer.query('ROLLBACK')
    await f.writer.query('RESET ROLE')
    if ((await f.writer.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount) {
      await f.writer.query(`DROP POLICY IF EXISTS "${policy}" ON public.${table}`)
      await f.writer.query(`REVOKE ALL ON public.${table}, public.tenant_health_source_authorities FROM "${role}"`)
      await f.writer.query(`REVOKE ALL ON SCHEMA public FROM "${role}"`)
      await f.writer.query(`DROP ROLE "${role}"`)
    }
    assert.deepEqual(await healthFunctionSettings(f.writer), settings,
      'Negative controls must not commit weaker function settings or change bodies/owners/ACLs')
  }
}

function authorityRlsError(functionName: typeof healthGuardFunctions[number]) {
  return (error: unknown): boolean => {
    assert.ok(sqlState('42501')(error))
    assert.ok(error instanceof Error)
    assert.match(error.message, /row-level security.*tenant_health_source_authorities/)
    assert.ok('where' in error && String(error.where).includes(`${functionName}()`),
      'The intended authority-writing trigger must reject, not an unrelated source ACL/policy')
    return true
  }
}

for (const source of ['audit', 'sync-state'] as const) {
  test(`HAW-70 ${source} authority RLS guard rejects real restricted writes and preserves owner invalidation`,
    { skip: !RUN, timeout: 60_000 }, async context => {
      const f = await syncStateAuthorityFixture(context)
      const table = source === 'audit' ? 'directory_audit_logs' : 'sync_states'
      const fn = source === 'audit'
        ? 'tenant_health_invalidate_on_audit_change' : 'tenant_health_invalidate_on_sync_state_change'
      const [id, extraId] = [randomUUID(), randomUUID()], scope = f.scopes[0]
      const insert = (newId: ReturnType<typeof randomUUID>) => source === 'audit'
        ? f.writer.query(`INSERT INTO directory_audit_logs
            (id, organization_id, customer_tenant_id, microsoft_audit_id,
             event_date_time, activity_display_name, raw, expires_at)
            VALUES ($1, $2, $3, $4, now(), 'initial', '{}'::jsonb, now() + interval '1 day')`,
        [newId, scope.organizationId, scope.tenantId, `haw70-rls-${newId}`])
        : f.insert(f.writer, 0, newId === id ? 'USERS' : 'GROUPS', newId)
      const update = (value: string) => f.writer.query(source === 'audit'
        ? 'UPDATE directory_audit_logs SET activity_display_name = $2 WHERE id = $1'
        : 'UPDATE sync_states SET delta_link = $2 WHERE id = $1', [id, value])
      const readSource = async (client = f.observer) => (await client.query(
        `SELECT * FROM public.${table} WHERE id = ANY($1::uuid[]) ORDER BY id`, [[id, extraId]])).rows
      await insert(id)
      const before = await f.tag(0), siblingBefore = await f.authority(f.observer, 1)
      const sourceBefore = await readSource()
      await withRestrictedHealthWriter(f, table, async (beginRestricted, role) => {
        // No source policy: zero changes or an authority-RLS error from the
        // statement trigger are both valid. Neither reproduces a stale write.
        await beginRestricted(false)
        assert.deepEqual(await readSource(f.writer), [])
        try { assert.equal((await update('source-denied')).rowCount, 0) }
        catch (error) { authorityRlsError(fn)(error) }
        await f.writer.query('ROLLBACK')
        assert.deepEqual(await readSource(), sourceBefore)
        assert.deepEqual(await f.authority(f.observer, 0), before)

        // Temporarily recover the exact unguarded body inside one transaction.
        // Restore its guard before COMMIT: only the fixture mutation commits.
        const settings = await healthFunctionSettings(f.writer)
        await f.writer.query('BEGIN')
        await f.writer.query(`ALTER FUNCTION public.${fn}() RESET row_security`)
        await f.writer.query('SET LOCAL row_security = on')
        await f.writer.query(`SET LOCAL ROLE "${role}"`)
        assert.equal((await readSource(f.writer)).length, 1)
        assert.equal(await f.authority(f.writer, 0), undefined, 'Live authority is hidden, not absent')
        assert.equal((await update('unguarded-committed')).rowCount, 1)
        await f.writer.query('RESET ROLE')
        assert.deepEqual(await f.authority(f.writer, 0), before)
        assert.deepEqual(await readSource(), sourceBefore, 'The observer must not see uncommitted source data')
        await f.writer.query(`ALTER FUNCTION public.${fn}() SET row_security = off`)
        assert.deepEqual(await healthFunctionSettings(f.writer), settings)
        await f.writer.query('COMMIT')
        const staleSource = await readSource()
        assert.equal(staleSource.length, 1)
        assert.equal(staleSource[0][source === 'audit' ? 'activity_display_name' : 'delta_link'], 'unguarded-committed')
        assert.deepEqual(await f.authority(f.observer, 0), before,
          'The committed negative control must retain the old current pointer for a privileged reader')

        for (const mutation of [() => update('guarded'), () => insert(extraId),
          () => f.writer.query(`DELETE FROM public.${table} WHERE id = $1`, [id])]) {
          await beginRestricted()
          assert.equal((await readSource(f.writer)).length, 1)
          assert.equal(await f.authority(f.writer, 0), undefined)
          await assert.rejects(mutation(), authorityRlsError(fn))
          await f.writer.query('ROLLBACK')
          assert.deepEqual(await readSource(), staleSource)
          assert.deepEqual(await f.authority(f.observer, 0), before)
        }

        // Separate ACL denial from the earlier rewrite-time RLS guard. The
        // temporary guard reset and failed write both roll back together.
        await f.writer.query(`REVOKE SELECT, INSERT, UPDATE ON public.tenant_health_source_authorities FROM "${role}"`)
        await f.writer.query('BEGIN')
        await f.writer.query(`ALTER FUNCTION public.${fn}() RESET row_security`)
        await f.writer.query('SET LOCAL row_security = on')
        await f.writer.query(`SET LOCAL ROLE "${role}"`)
        await assert.rejects(update('no-authority-acl'), error => {
          assert.ok(sqlState('42501')(error) && error instanceof Error)
          assert.match(error.message, /permission denied for table tenant_health_source_authorities/)
          return true
        })
        await f.writer.query('ROLLBACK')
        assert.deepEqual(await healthFunctionSettings(f.writer), settings)
        assert.deepEqual(await readSource(), staleSource)
        assert.deepEqual(await f.authority(f.observer, 0), before)

        await f.writer.query('BEGIN')
        assert.equal((await update('owner-committed')).rowCount, 1)
        assert.deepEqual(await f.authority(f.writer, 0), f.invalidated(before))
        assert.deepEqual(await f.authority(f.observer, 0), before)
        await f.writer.query('COMMIT')
        assert.equal((await readSource())[0][source === 'audit' ? 'activity_display_name' : 'delta_link'], 'owner-committed')
        assert.deepEqual(await f.authority(f.observer, 0), f.invalidated(before))
        assert.deepEqual(await f.authority(f.observer, 1), siblingBefore)
      })
    })
}

for (const source of ['audit', 'sync-state'] as const) {
  test(`HAW-70 ${source} restricted scope moves cannot retain old and new tenant health pointers`,
    { skip: !RUN, timeout: 120_000 }, async context => {
      for (const destination of [1, 2] as const) {
        await context.test(destination === 1 ? 'same organization' : 'different organization',
          { timeout: 30_000 }, async subcontext => {
            const f = await syncStateAuthorityFixture(subcontext)
            const table = source === 'audit' ? 'directory_audit_logs' : 'sync_states'
            const fn = source === 'audit'
              ? 'tenant_health_invalidate_on_audit_change' : 'tenant_health_invalidate_on_sync_state_change'
            const id = randomUUID(), from = f.scopes[0], to = f.scopes[destination]
            if (source === 'audit') await f.writer.query(`INSERT INTO directory_audit_logs
              (id, organization_id, customer_tenant_id, microsoft_audit_id,
               event_date_time, activity_display_name, raw, expires_at)
              VALUES ($1, $2, $3, $4, now(), 'restricted move', '{}'::jsonb, now() + interval '1 day')`,
            [id, from.organizationId, from.tenantId, `haw70-move-${id}`])
            else await f.insert(f.writer, 0, 'USERS', id)
            await f.tag(0)
            const readSource = async (client: pg.Client) => (await client.query(
              `SELECT * FROM public.${table} WHERE id = $1`, [id])).rows
            const readAuthorities = (client: pg.Client) => Promise.all(f.scopes.map((_, index) => f.authority(client, index)))
            const readSnapshots = async (client: pg.Client) => (await client.query(`SELECT * FROM tenant_health_snapshots
              WHERE customer_tenant_id = ANY($1::uuid[]) ORDER BY id`, [f.scopes.map(scope => scope.tenantId)])).rows
            const move = (origin: number, target: number) => f.writer.query(`UPDATE public.${table}
              SET organization_id = $4, customer_tenant_id = $5
              WHERE id = $1 AND organization_id = $2 AND customer_tenant_id = $3`,
            [id, f.scopes[origin].organizationId, f.scopes[origin].tenantId,
              f.scopes[target].organizationId, f.scopes[target].tenantId])
            const before = await readAuthorities(f.observer), sourceBefore = await readSource(f.observer)
            const snapshotsBefore = await readSnapshots(f.observer)
            assert.equal(sourceBefore.length, 1)
            assert.equal(sourceBefore[0].organization_id, from.organizationId)
            assert.equal(sourceBefore[0].customer_tenant_id, from.tenantId)
            for (const authority of before) assert.ok(authority.live && authority.current_snapshot_id)
            const movedSource = [{ ...sourceBefore[0], organization_id: to.organizationId, customer_tenant_id: to.tenantId }]
            await withRestrictedHealthWriter(f, table, async (beginRestricted, role) => {
              const settings = await healthFunctionSettings(f.writer)
              // The source policy permits BOTH endpoints. Remove only the matching
              // authority guard, commit a real move, and restore settings first.
              await beginRestricted()
              try {
                await f.writer.query('RESET ROLE')
                await f.writer.query(`ALTER FUNCTION public.${fn}() RESET row_security`)
                await f.writer.query(`SET LOCAL ROLE "${role}"`)
                assert.deepEqual(await readSource(f.writer), sourceBefore)
                assert.equal(await f.authority(f.writer, 0), undefined)
                assert.equal(await f.authority(f.writer, destination), undefined)
                assert.equal((await move(0, destination)).rowCount, 1)
                assert.deepEqual(await readSource(f.writer), movedSource)
                await f.writer.query('RESET ROLE')
                assert.deepEqual(await readAuthorities(f.writer), before)
                assert.deepEqual(await readSource(f.observer), sourceBefore)
                await f.writer.query(`ALTER FUNCTION public.${fn}() SET row_security = off`)
                assert.deepEqual(await healthFunctionSettings(f.writer), settings)
                await f.writer.query('COMMIT')
              } finally { await f.writer.query('ROLLBACK') }
              assert.deepEqual(await readSource(f.observer), movedSource)
              assert.deepEqual(await readAuthorities(f.observer), before,
                'The committed unguarded move must leave both old pointers visible to an independent reader')

              // Reverse the actual committed move, not a no-op at its destination.
              await beginRestricted()
              try {
                assert.deepEqual(await readSource(f.writer), movedSource)
                assert.equal(await f.authority(f.writer, 0), undefined)
                assert.equal(await f.authority(f.writer, destination), undefined)
                await assert.rejects(move(destination, 0), authorityRlsError(fn))
              } finally { await f.writer.query('ROLLBACK') }
              assert.deepEqual(await readSource(f.observer), movedSource)
              assert.deepEqual(await readAuthorities(f.observer), before)
              assert.deepEqual(await readSnapshots(f.observer), snapshotsBefore)

              const invalidated = before.map((authority, index) => index === 0 || index === destination
                ? f.invalidated(authority) : authority)
              await f.writer.query('BEGIN')
              try {
                assert.equal((await move(destination, 0)).rowCount, 1)
                assert.deepEqual(await readSource(f.writer), sourceBefore)
                assert.deepEqual(await readAuthorities(f.writer), invalidated)
                assert.deepEqual(await readSource(f.observer), movedSource)
                assert.deepEqual(await readAuthorities(f.observer), before)
                await f.writer.query('COMMIT')
              } finally { await f.writer.query('ROLLBACK') }
              assert.deepEqual(await readSource(f.observer), sourceBefore)
              assert.deepEqual(await readAuthorities(f.observer), invalidated,
                'Owner movement invalidates each endpoint exactly once and leaves the third scope unchanged')
              assert.deepEqual(await readSnapshots(f.observer), snapshotsBefore)
            }, [from.organizationId, to.organizationId])
          })
      }
    })
}

test('HAW-70 tenant lifecycle authority writes reject an RLS-dependent source writer atomically',
  { skip: !RUN, timeout: 60_000 }, async context => {
    const f = await syncStateAuthorityFixture(context), scope = f.scopes[0], newTenant = randomUUID()
    const before = await f.authority(f.observer, 0)
    const readTenants = async () => (await f.observer.query(
      'SELECT id FROM customer_tenants WHERE organization_id = $1 ORDER BY id', [scope.organizationId])).rows
    const tenantsBefore = await readTenants()
    await withRestrictedHealthWriter(f, 'customer_tenants', async beginRestricted => {
      for (const [fn, mutation] of [
        ['tenant_health_authorize_on_tenant_insert', () => f.writer.query(`INSERT INTO customer_tenants
          (id, organization_id, microsoft_tenant_id, updated_at) VALUES ($1, $2, $3, now())`,
        [newTenant, scope.organizationId, randomUUID()])],
        ['tenant_health_tombstone_on_tenant_delete', () => f.writer.query(
          'DELETE FROM customer_tenants WHERE id = $1', [scope.tenantId])],
      ] as const) {
        await beginRestricted()
        assert.equal((await f.writer.query('SELECT id FROM customer_tenants WHERE id = $1', [scope.tenantId])).rowCount, 1)
        assert.equal(await f.authority(f.writer, 0), undefined)
        await assert.rejects(mutation(), authorityRlsError(fn))
        await f.writer.query('ROLLBACK')
        assert.deepEqual(await readTenants(), tenantsBefore)
        assert.deepEqual(await f.authority(f.observer, 0), before)
        assert.equal((await f.observer.query(`SELECT 1 FROM tenant_health_source_authorities
          WHERE organization_id = $1 AND customer_tenant_id = $2`, [scope.organizationId, newTenant])).rowCount, 0)
      }
    })
  })

test('HAW-70 snapshot RLS and authority permissions fail closed while unrelated resources remain writable',
  { skip: !RUN, timeout: 60_000 }, async context => {
    const f = await syncStateAuthorityFixture(context)
    const id = randomUUID(), excludedId = randomUUID()
    await insertHealthInputSnapshot(f, 0, 'AUTH_REGISTRATIONS', id)
    await insertHealthInputSnapshot(f, 0, 'SECURE_SCORES', excludedId)
    const before = await f.tag(0)
    const readSource = async () => (await f.observer.query(`SELECT * FROM tenant_entra_snapshots
      WHERE customer_tenant_id = $1 ORDER BY id`, [f.scopes[0].tenantId])).rows
    const sourceBefore = await readSource()
    const update = () => f.writer.query(`UPDATE tenant_entra_snapshots
      SET observed_at = observed_at + interval '1 minute' WHERE id = $1`, [id])
    await withRestrictedHealthWriter(f, 'tenant_entra_snapshots', async (beginRestricted, role) => {
      const mutations = [update, () => insertHealthInputSnapshot(f, 0, 'RISKY_USERS'),
        () => f.writer.query('DELETE FROM tenant_entra_snapshots WHERE id = $1', [id]),
        () => f.writer.query(`UPDATE tenant_entra_snapshots SET resource_type = 'SECURITY_DEFAULTS' WHERE id = $1`, [id]),
        () => f.writer.query(`UPDATE tenant_entra_snapshots SET resource_type = 'RISKY_USERS' WHERE id = $1`, [excludedId])]
      for (const mutate of mutations) {
        await beginRestricted()
        assert.equal((await f.writer.query('SELECT id FROM tenant_entra_snapshots WHERE id = $1', [id])).rowCount, 1)
        assert.equal(await f.authority(f.writer, 0), undefined, 'Authority is hidden, not absent')
        await assert.rejects(mutate(), authorityRlsError('tenant_health_invalidate_on_input_snapshot_change'))
        await f.writer.query('ROLLBACK')
        assert.deepEqual(await readSource(), sourceBefore)
        assert.deepEqual(await f.authority(f.observer, 0), before)
      }
      await f.writer.query(`REVOKE SELECT, INSERT, UPDATE ON public.tenant_health_source_authorities FROM "${role}"`)
      // Isolate ACL denial from the RLS rewrite guard; reset only inside this
      // rollback-only transaction, as in the existing audit/sync witnesses.
      await f.writer.query('BEGIN')
      await f.writer.query('ALTER FUNCTION public.tenant_health_invalidate_on_input_snapshot_change() RESET row_security')
      await f.writer.query('SET LOCAL row_security = on')
      await f.writer.query(`SET LOCAL ROLE "${role}"`)
      await assert.rejects(update(), error => {
        assert.ok(sqlState('42501')(error) && error instanceof Error)
        assert.match(error.message, /permission denied for table tenant_health_source_authorities/)
        return true
      })
      await f.writer.query('ROLLBACK')
      assert.deepEqual(await readSource(), sourceBefore)
      assert.deepEqual(await f.authority(f.observer, 0), before)
      await beginRestricted()
      assert.equal((await f.writer.query('UPDATE tenant_entra_snapshots SET payload = payload WHERE id = $1', [excludedId])).rowCount, 1)
      await f.writer.query('COMMIT')
      assert.deepEqual(await readSource(), sourceBefore)
      assert.deepEqual(await f.authority(f.observer, 0), before, 'Excluded transitions never access authority')
    })
  })

test('HAW-70 truncation refuses source, parent cascade and multi-table operations without committing fixture loss',
  { skip: !RUN, timeout: 120_000 }, async context => {
    const f = await syncStateAuthorityFixture(context)
    const tables = ['customer_tenants', 'directory_audit_logs', 'organizations',
      'sync_states', 'tenant_entra_snapshots', 'tenant_health_snapshots', 'tenant_health_source_authorities'] as const
    const organizations = [...new Set(f.scopes.map(scope => scope.organizationId))]
    const role = `haw70_truncate_${randomUUID().replaceAll('-', '')}`
    const triggerState = async () => (await f.writer.query(`SELECT c.relname, t.tgenabled,
        t.tgtype::int, t.tgisinternal, p.proname, p.prosecdef, p.proconfig
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
        AND t.tgname = 'tenant_health_refuse_truncate' ORDER BY c.relname`, [tables])).rows
    const readState = async (client: pg.Client) => {
      const state: Record<string, unknown[]> = {}
      for (const table of tables) state[table] = (await client.query(`SELECT to_jsonb(source) AS row
        FROM public.${table} AS source WHERE ${table === 'organizations' ? 'id' : 'organization_id'} = ANY($1::uuid[])
        ORDER BY to_jsonb(source)::text`, [organizations])).rows
      state.receipts = (await client.query(`SELECT generation, protocol_fingerprint, completed_at::text
        FROM tenant_health_reconciliation_generations ORDER BY generation`)).rows
      return state
    }
    const refuses = (firstTable: typeof tables[number]) => (error: unknown): boolean => {
      assert.ok(sqlState('55000')(error) && error instanceof Error)
      assert.equal(error.message, 'TENANT_HEALTH_TRUNCATE_REQUIRES_VERSIONED_DELETE')
      assert.ok('schema' in error && error.schema === 'public')
      assert.ok('table' in error && error.table === firstTable)
      return true
    }
    for (let index = 0; index < f.scopes.length; index++) {
      await f.insert(f.writer, index)
      await insertHealthInputSnapshot(f, index)
      const scope = f.scopes[index], auditId = randomUUID()
      await f.writer.query(`INSERT INTO directory_audit_logs
        (id, organization_id, customer_tenant_id, microsoft_audit_id,
         event_date_time, activity_display_name, raw, expires_at)
        VALUES ($1, $2, $3, $4, now(), 'truncate fixture', '{}'::jsonb, now() + interval '1 day')`,
      [auditId, scope.organizationId, scope.tenantId, `haw70-truncate-${auditId}`])
      await f.tag(index)
    }
    const before = await readState(f.observer), guards = await triggerState()
    assert.equal(before.directory_audit_logs.length, 3)
    assert.equal(before.sync_states.length, 3)
    assert.equal(before.tenant_entra_snapshots.length, 3)
    assert.equal(before.tenant_health_source_authorities.length, 3)
    assert.deepEqual(guards.map(row => row.relname), tables)
    for (const guard of guards) assert.deepEqual(guard, {
      relname: guard.relname, tgenabled: 'A', tgtype: 34, tgisinternal: false,
      proname: 'tenant_health_refuse_truncate', prosecdef: false, proconfig: ['search_path=pg_catalog'],
    }, 'Every installed guard must be BEFORE STATEMENT TRUNCATE and ENABLE ALWAYS')
    await f.writer.query('CREATE TEMP TABLE haw70_truncate_sentinel (value text NOT NULL)')
    await f.writer.query("INSERT INTO haw70_truncate_sentinel VALUES ('unchanged')")
    try {
      // Negative control is rollback-only, never a committed truncation. It
      // proves DELETE invalidation is absent without losing shared CI data.
      assert.equal((await f.writer.query(`SELECT 1 FROM pg_constraint
        WHERE contype = 'f' AND confrelid = 'public.directory_audit_logs'::regclass`)).rowCount, 0)
      assert.equal((await f.writer.query(`SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = 'public.directory_audit_logs'::regclass
          AND t.tgname = 'tenant_health_audit_delete_invalidate'
          AND t.tgtype = 8 AND t.tgenabled IN ('O', 'A')
          AND t.tgfoid = 'public.tenant_health_invalidate_on_audit_change()'::regprocedure`)).rowCount, 1)
      await f.writer.query('BEGIN')
      try {
        await f.writer.query("SET LOCAL lock_timeout = '2s'")
        await f.writer.query("SET LOCAL session_replication_role = 'origin'")
        await f.writer.query('ALTER TABLE public.directory_audit_logs DISABLE TRIGGER tenant_health_refuse_truncate')
        await f.writer.query('TRUNCATE public.directory_audit_logs')
        assert.equal((await f.writer.query('SELECT 1 FROM directory_audit_logs')).rowCount, 0)
        for (let index = 0; index < f.scopes.length; index++) {
          const authority = await f.authority(f.writer, index)
          assert.ok(authority.current_snapshot_id)
        }
        const unguarded = await readState(f.writer)
        assert.deepEqual(unguarded, { ...before, directory_audit_logs: [] })
      } finally { await f.writer.query('ROLLBACK') }
      assert.deepEqual(await triggerState(), guards)
      assert.deepEqual(await readState(f.observer), before)

      const commands: Array<{ sql: string; first: typeof tables[number] }> = [
        ...tables.map(table => ({ first: table,
          sql: `TRUNCATE public.${table}${['customer_tenants', 'organizations', 'tenant_health_snapshots'].includes(table) ? ' CASCADE' : ''}` })),
        { sql: 'TRUNCATE public.directory_audit_logs, public.sync_states', first: 'directory_audit_logs' },
        { sql: 'TRUNCATE public.sync_states, public.directory_audit_logs', first: 'sync_states' },
        { sql: 'TRUNCATE pg_temp.haw70_truncate_sentinel, public.directory_audit_logs RESTART IDENTITY', first: 'directory_audit_logs' },
      ]
      for (const mode of ['origin', 'local', 'replica'] as const) {
        for (const command of commands) {
          await f.writer.query('BEGIN')
          try {
            await f.writer.query("SET LOCAL lock_timeout = '2s'")
            await f.writer.query(`SET LOCAL session_replication_role = '${mode}'`)
            await f.writer.query("UPDATE haw70_truncate_sentinel SET value = 'must roll back'")
            await assert.rejects(f.writer.query(command.sql), refuses(command.first))
          } finally { await f.writer.query('ROLLBACK') }
          assert.deepEqual((await f.writer.query('SELECT value FROM haw70_truncate_sentinel')).rows, [{ value: 'unchanged' }])
          assert.deepEqual(await readState(f.observer), before)
        }
      }

      // Explicit TRUNCATE privileges reach the installed guard even though this
      // effective role sees no source rows under RLS. This is not login proof.
      await f.writer.query('BEGIN')
      await f.writer.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION`)
      await f.writer.query(`GRANT USAGE ON SCHEMA public TO "${role}"`)
      await f.writer.query(`GRANT SELECT, TRUNCATE ON public.directory_audit_logs, public.sync_states, public.tenant_entra_snapshots TO "${role}"`)
      await f.writer.query('COMMIT')
      for (const command of commands.filter(value =>
        !value.sql.includes('pg_temp') && ['directory_audit_logs', 'sync_states', 'tenant_entra_snapshots'].includes(value.first))) {
        await f.writer.query('BEGIN')
        try {
          await f.writer.query("SET LOCAL lock_timeout = '2s'")
          await f.writer.query('SET LOCAL row_security = on')
          await f.writer.query(`SET LOCAL ROLE "${role}"`)
          const access = (await f.writer.query(`SELECT c.relname,
              has_table_privilege(current_user, c.oid, 'TRUNCATE') AS can_truncate,
              row_security_active(c.oid) AS rls_active,
              pg_has_role(current_user, c.relowner, 'USAGE') AS owner_rights
            FROM pg_class c WHERE c.oid IN ('public.directory_audit_logs'::regclass, 'public.sync_states'::regclass, 'public.tenant_entra_snapshots'::regclass)
            ORDER BY c.relname`)).rows
          assert.deepEqual(access, ['directory_audit_logs', 'sync_states', 'tenant_entra_snapshots'].map(relname => ({
            relname, can_truncate: true, rls_active: true, owner_rights: false,
          })))
          assert.equal((await f.writer.query('SELECT 1 FROM directory_audit_logs')).rowCount, 0)
          assert.equal((await f.writer.query('SELECT 1 FROM sync_states')).rowCount, 0)
          assert.equal((await f.writer.query('SELECT 1 FROM tenant_entra_snapshots')).rowCount, 0)
          await assert.rejects(f.writer.query(command.sql), refuses(command.first))
        } finally { await f.writer.query('ROLLBACK') }
        assert.deepEqual(await readState(f.observer), before)
      }

      // CASCADE checks privileges on dependent tables before BEFORE triggers.
      // Grant the catalog-derived ordinary-table closure inside each rollback-only
      // attempt so an unrelated ACL failure cannot masquerade as guard refusal.
      const cascades = commands.filter(command => command.sql.endsWith(' CASCADE'))
      assert.equal(cascades.length, 3)
      for (const command of cascades) {
        const closure = (await f.writer.query(`WITH RECURSIVE affected(oid) AS (
            SELECT $1::regclass::oid
            UNION
            SELECT fk.conrelid FROM pg_constraint fk
            JOIN affected parent ON fk.confrelid = parent.oid WHERE fk.contype = 'f'
          ) SELECT c.oid::int AS oid, n.nspname, c.relname, c.relkind, c.relispartition,
            EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid OR i.inhparent = c.oid) AS inherited
          FROM affected a JOIN pg_class c ON c.oid = a.oid
          JOIN pg_namespace n ON n.oid = c.relnamespace ORDER BY c.oid`, [`public.${command.first}`])).rows
        assert.ok(closure.length > 1)
        assert.equal(closure.filter(row => row.relname === command.first).length, 1)
        for (const relation of closure) {
          assert.equal(relation.nspname, 'public')
          assert.equal(relation.relkind, 'r', 'This bounded witness supports ordinary tables only')
          assert.equal(relation.relispartition, false)
          assert.equal(relation.inherited, false, 'Partition/inheritance closure requires a separate witness')
          assert.notEqual(relation.relname, 'tenant_health_reconciliation_generations')
        }
        const relationIds = closure.map(row => row.oid)
        const privileges = async () => (await f.writer.query(`SELECT c.oid::int AS oid,
            has_table_privilege($2::name, c.oid, 'TRUNCATE') AS can_truncate
          FROM pg_class c WHERE c.oid = ANY($1::oid[]) ORDER BY c.oid`, [relationIds, role])).rows
        const priorPrivileges = await privileges()
        const rootId = closure.find(row => row.relname === command.first)!.oid
        assert.equal(priorPrivileges.find(row => row.oid === rootId)?.can_truncate, false)
        context.diagnostic(`${command.first} CASCADE privilege closure: ${closure.map(row => row.relname).join(', ')}`)
        const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`
        const relations = closure.map(row => `${quoteIdentifier(row.nspname)}.${quoteIdentifier(row.relname)}`).join(', ')
        await f.writer.query('BEGIN')
        try {
          await f.writer.query("SET LOCAL lock_timeout = '2s'")
          await f.writer.query("SET LOCAL session_replication_role = 'origin'")
          await f.writer.query(`GRANT TRUNCATE ON TABLE ${relations} TO "${role}"`)
          await f.writer.query(`GRANT SELECT ON public.${command.first} TO "${role}"`)
          await f.writer.query("UPDATE haw70_truncate_sentinel SET value = 'must roll back'")
          await f.writer.query('SET LOCAL row_security = on')
          await f.writer.query(`SET LOCAL ROLE "${role}"`)
          assert.deepEqual((await f.writer.query(`SELECT rolname, rolsuper, rolbypassrls, rolinherit
            FROM pg_roles WHERE rolname = current_user`)).rows,
          [{ rolname: role, rolsuper: false, rolbypassrls: false, rolinherit: false }])
          assert.deepEqual(await privileges(), relationIds.map(oid => ({ oid, can_truncate: true })))
          assert.equal((await f.writer.query(`SELECT 1 FROM pg_class c WHERE c.oid = ANY($1::oid[])
            AND pg_has_role(current_user, c.relowner, 'USAGE')`, [relationIds])).rowCount, 0)
          assert.equal((await f.writer.query('SELECT row_security_active($1::oid) AS active', [rootId])).rows[0].active, true)
          assert.equal((await f.writer.query(`SELECT 1 FROM public.${command.first}`)).rowCount, 0)
          await assert.rejects(f.writer.query(command.sql), refuses(command.first))
        } finally { await f.writer.query('ROLLBACK') }
        assert.deepEqual(await privileges(), priorPrivileges, 'Temporary cascade grants must also roll back')
        assert.deepEqual((await f.writer.query('SELECT value FROM haw70_truncate_sentinel')).rows, [{ value: 'unchanged' }])
        assert.deepEqual(await readState(f.observer), before)
      }
    } finally {
      await f.writer.query('ROLLBACK')
      await f.writer.query('RESET ROLE')
      if ((await f.writer.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount) {
        await f.writer.query(`REVOKE ALL ON public.directory_audit_logs, public.sync_states, public.tenant_entra_snapshots FROM "${role}"`)
        await f.writer.query(`REVOKE ALL ON SCHEMA public FROM "${role}"`)
        await f.writer.query(`DROP ROLE "${role}"`)
      }
      assert.deepEqual(await triggerState(), guards)
    }
  })
