import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
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

test('HAW-70 experimental reconciliation repairs history atomically and exact retry does not rotate again',
  { skip: !RUN, timeout: 60_000 }, async () => {
    const client = new pg.Client({ connectionString: URL! })
    const prisma = new PrismaService()
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
      const interrupted = new Error('synthetic interruption before commit')
      const aborting = {
        $transaction: (callback: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>,
          options: Parameters<typeof prisma.$transaction>[1]) => prisma.$transaction(async tx => {
          assert.equal((await callback(tx) as { outcome: string }).outcome, 'completed')
          assert.deepEqual(await readAuthorities(), before, 'Other connection sees only committed authority')
          assert.deepEqual(await readReceipt(), [], 'Other connection cannot see an uncommitted receipt')
          throw interrupted
        }, options),
      } as unknown as Pick<PrismaService, '$transaction'>
      await assert.rejects(reconcile(aborting), error => error === interrupted)
      assert.deepEqual(await readAuthorities(), before)
      assert.deepEqual(await readReceipt(), [], 'An interrupted transaction records no completion')

      assert.deepEqual(await reconcile(prisma), { outcome: 'completed',
        generation: repairGeneration, fingerprint: repairFingerprint })
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
    } finally {
      try {
        await client.query('ROLLBACK')
        await client.query('DELETE FROM organizations WHERE id = $1', [org])
        // Keep the immutable experimental receipt only in this disposable job.
      } finally { await prisma.$disconnect(); await client.end() }
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
