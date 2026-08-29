import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'

const databaseIntegrationEnabled =
  process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'

const migrationUrl = new URL(
  '../../prisma/migrations/20260829150000_add_workspace_audit_evidence/migration.sql',
  import.meta.url,
)

test(
  'legacy workspace audit rows are backfilled, bounded, pruned, and organization isolated',
  { skip: !databaseIntegrationEnabled },
  async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    await client.query("SET TIME ZONE 'UTC'")
    const schema = `workspace_audit_${randomUUID().replaceAll('-', '')}`
    const organizationA = randomUUID()
    const organizationB = randomUUID()
    const visibleId = randomUUID()
    const expiredId = randomUUID()
    const foreignId = randomUUID()
    const now = new Date('2026-08-29T12:00:00.000Z')

    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      await client.query(`
        CREATE TABLE "workspace_admin_audit_logs" (
          "id" UUID PRIMARY KEY,
          "organization_id" UUID NOT NULL,
          "actor_user_id" UUID,
          "actor_email" VARCHAR(320),
          "target_user_id" UUID,
          "target_email" VARCHAR(320),
          "action" VARCHAR(100) NOT NULL,
          "outcome" VARCHAR(30) NOT NULL DEFAULT 'SUCCEEDED',
          "metadata" JSONB,
          "created_at" TIMESTAMPTZ(6) NOT NULL
        )
      `)
      await client.query(
        `INSERT INTO "workspace_admin_audit_logs"
          ("id", "organization_id", "actor_email", "target_email", "action", "created_at")
         VALUES
          ($1, $2, 'legacy-owner@example.invalid', 'legacy-target@example.invalid', 'VISIBLE', $3),
          ($4, $2, 'legacy-owner@example.invalid', 'legacy-target@example.invalid', 'EXPIRED', $5),
          ($6, $7, 'foreign-owner@example.invalid', 'foreign-target@example.invalid', 'FOREIGN', $5)`,
        [
          visibleId,
          organizationA,
          new Date('2026-08-01T12:00:00.000Z'),
          expiredId,
          new Date('2025-08-01T12:00:00.000Z'),
          foreignId,
          organizationB,
        ],
      )

      await client.query(await readFile(migrationUrl, 'utf8'))

      const backfilled = await client.query<{
        created_at: Date
        expires_at: Date
        id: string
      }>(
        `SELECT "id", "created_at", "expires_at"
         FROM "workspace_admin_audit_logs"
         ORDER BY "id"`,
      )
      assert.equal(backfilled.rowCount, 3)
      for (const row of backfilled.rows) {
        assert.equal(
          row.expires_at.getTime() - row.created_at.getTime(),
          365 * 24 * 60 * 60 * 1000,
        )
      }

      const visibleBeforePrune = await client.query<{ id: string }>(
        `SELECT "id" FROM "workspace_admin_audit_logs"
         WHERE "organization_id" = $1 AND "expires_at" > $2`,
        [organizationA, now],
      )
      assert.deepEqual(visibleBeforePrune.rows.map((row) => row.id), [visibleId])

      const pruned = await client.query(
        `DELETE FROM "workspace_admin_audit_logs"
         WHERE "organization_id" = $1 AND "expires_at" <= $2`,
        [organizationA, now],
      )
      assert.equal(pruned.rowCount, 1)

      const organizationARows = await client.query<{ id: string }>(
        `SELECT "id" FROM "workspace_admin_audit_logs"
         WHERE "organization_id" = $1 ORDER BY "id"`,
        [organizationA],
      )
      assert.deepEqual(organizationARows.rows.map((row) => row.id), [visibleId])
      const foreignRows = await client.query<{ id: string }>(
        `SELECT "id" FROM "workspace_admin_audit_logs"
         WHERE "organization_id" = $1`,
        [organizationB],
      )
      assert.deepEqual(foreignRows.rows.map((row) => row.id), [foreignId])

      await assert.rejects(
        client.query(
          `INSERT INTO "workspace_admin_audit_logs"
            ("id", "organization_id", "action", "created_at")
           VALUES ($1, $2, 'NULL_EXPIRY', $3)`,
          [randomUUID(), organizationA, now],
        ),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          (error as { code?: unknown }).code === '23502',
      )
    } finally {
      await client.query('RESET search_path')
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await client.end()
    }
  },
)
