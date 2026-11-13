import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'

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
    const [org, otherOrg, tenant, microsoftTenant, incarnation, snapshot] =
      Array.from({ length: 6 }, () => randomUUID())
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
      await client.query(
        `INSERT INTO tenant_health_source_authorities
           (organization_id, customer_tenant_id, incarnation, source_revision)
         VALUES ($1, $2, $3, 1)`, [org, tenant, incarnation])
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

// Held until the audit writer migration is present. This test deliberately
// fails against the migration-only foundation and must run in disposable CI.
test('HAW-70 audit insert and delete invalidate current health in the same transaction',
  {
    skip: !RUN || process.env.HAWKVIEW_HAW70_AUDIT_WRITER_WITNESS !== '1',
    timeout: 30_000,
  }, async () => {
    const writer = new pg.Client({ connectionString: URL! })
    const reader = new pg.Client({ connectionString: URL! })
    const [org, tenant, microsoftTenant, initialIncarnation, firstSnapshot, secondSnapshot, auditLog] =
      Array.from({ length: 7 }, () => randomUUID())
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
        await writer.query(
          `INSERT INTO tenant_health_source_authorities
             (organization_id, customer_tenant_id, incarnation, source_revision)
           VALUES ($1, $2, $3, 1)
           ON CONFLICT (organization_id, customer_tenant_id) DO NOTHING`,
          [org, tenant, initialIncarnation])
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
        await writer.query('DELETE FROM directory_audit_logs WHERE id = $1', [auditLog])
        assert.deepEqual(await current(writer), {
          source_revision: (sourceRevision + 2n).toString(), current_snapshot_id: null,
        }, 'The audit delete must invalidate the pointer before its transaction commits')
        await writer.query('ROLLBACK')
        assert.deepEqual(await current(reader), {
          source_revision: (sourceRevision + 1n).toString(), current_snapshot_id: secondSnapshot,
        }, 'A rolled-back audit delete must preserve the previous authority')
        const retained = await reader.query(
          'SELECT id FROM directory_audit_logs WHERE id = $1', [auditLog])
        assert.equal(retained.rowCount, 1)

        await writer.query('BEGIN')
        await writer.query('DELETE FROM directory_audit_logs WHERE id = $1', [auditLog])
        assert.deepEqual(await current(writer), {
          source_revision: (sourceRevision + 2n).toString(), current_snapshot_id: null,
        })
        await writer.query('COMMIT')
        assert.deepEqual(await current(reader), {
          source_revision: (sourceRevision + 2n).toString(), current_snapshot_id: null,
        })
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

// The registered disposable job enables this after the tenant lifecycle
// writer migration. Deletion must retain an authority tombstone even though
// its health snapshot cascades away.
test('HAW-70 tenant deletion clears current health and retains a dead authority',
  {
    skip: !RUN || process.env.HAWKVIEW_HAW70_TENANT_DELETE_WITNESS !== '1',
    timeout: 30_000,
  }, async () => {
    const client = new pg.Client({ connectionString: URL! })
    const [org, tenant, microsoftTenant, initialIncarnation, snapshot] =
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
        `INSERT INTO tenant_health_source_authorities
           (organization_id, customer_tenant_id, incarnation, source_revision)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (organization_id, customer_tenant_id) DO NOTHING`,
        [org, tenant, initialIncarnation])
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
      assert.deepEqual(deleted.rows, [{
        live: false,
        source_revision: (sourceRevision + 1n).toString(),
        current_snapshot_id: null,
      }], 'Deletion must tombstone and invalidate authority in the same transaction')
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
