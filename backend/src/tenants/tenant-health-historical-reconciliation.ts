import { createHash } from 'node:crypto'
import type { PrismaClient } from '../generated/prisma/client.js'

// Experimental lifecycle/audit boundary only. No application caller imports
// this module. A later complete writer protocol needs a new reviewed generation;
// this receipt must never authorize a production health reader.
export const HISTORICAL_RECONCILIATION_GENERATION = 'experimental-haw70-lifecycle-audit-v1'

const migrations = [
  ['20261109150000_tenant_health_source_authority_foundation', 'ce0df409a71bcaae640557748e4b023fce897b12ed3859472bb6693b14dc06c7'],
  ['20261109150100_tenant_health_exact_source_index', '426dab1e008e8188fa5c7196ab1a571bc8442712512b00a48f66d81e81622646'],
  ['20261109150200_tenant_health_attach_source_key', '6b84872e74f195bca528c22e2eca3e06bf1c7cc9f3778a0cd8669962fc058635'],
  ['20261109150300_tenant_health_source_authority_table', '107fa1aa16d1b85254893c4f9b972fcceeb70581dfc1fcc2461d723df01b66d7'],
  ['20261109150400_tenant_health_source_authority_backfill', 'ca7d4907b2db96076209b305442ae59ce234b85c9912ad48438281114b4a4917'],
  ['20261109150500_tenant_health_snapshot_constraint_validation', '7ff0babbe4bfbaa61ecc9233d96cbd5ecbe0b95cbaab2c29b62ac12346566f70'],
  ['20261113021500_tenant_health_tenant_deletion_tombstone', 'efb9ee3db27556af643e6dcc421ed6738cd54da616f822aa04a507eb24f78c8f'],
  ['20261113031300_tenant_health_audit_source_revision', 'ff87eac71fbd84aef782c63b415b405f8fb323a0f818a0a4fc2eb6c6b24d828b'],
  ['20261113144000_tenant_health_authority_on_tenant_insert', '32905bc2628d3c75f015ee819812164299ded402e2ece4e45ff8f18d91865a0a'],
  ['20261113170000_tenant_health_reconciliation_marker', '1d7aa9c81cd8712db3484eab6295f447517ed41fa2864adc17963ce2a1a66a1c'],
] as const

const triggers = [
  ['customer_tenants', 'tenant_health_authorize_on_tenant_insert'],
  ['customer_tenants', 'tenant_health_tombstone_on_tenant_delete'],
  ['directory_audit_logs', 'tenant_health_audit_insert_invalidate'],
  ['directory_audit_logs', 'tenant_health_audit_update_invalidate'],
  ['directory_audit_logs', 'tenant_health_audit_delete_invalidate'],
  ['tenant_health_reconciliation_generations', 'tenant_health_preserve_reconciliation_generation'],
] as const

const lockSql = `LOCK TABLE public.organizations, public.customer_tenants,
  public.directory_audit_logs, public.tenant_health_snapshots,
  public.tenant_health_source_authorities, public.tenant_health_reconciliation_generations
  IN EXCLUSIVE MODE NOWAIT`
const reconcileCurrentSql = `INSERT INTO public.tenant_health_source_authorities
  (organization_id, customer_tenant_id, incarnation, source_revision,
   live, current_snapshot_id, current_observation_sequence)
  SELECT organization_id, id, gen_random_uuid(), 1, true, NULL, 0
    FROM public.customer_tenants ORDER BY organization_id, id
  ON CONFLICT (organization_id, customer_tenant_id) DO UPDATE
    SET incarnation = gen_random_uuid(),
        source_revision = public.tenant_health_source_authorities.source_revision + 1,
        live = true, current_snapshot_id = NULL, current_observation_sequence = 0`
const tombstoneOrphansSql = `UPDATE public.tenant_health_source_authorities AS authority
  SET source_revision = authority.source_revision + 1, live = false,
      current_snapshot_id = NULL, current_observation_sequence = 0
  WHERE authority.live AND NOT EXISTS (
    SELECT 1 FROM public.customer_tenants tenant
    WHERE tenant.organization_id = authority.organization_id
      AND tenant.id = authority.customer_tenant_id)`
const invalidAuthoritySql = `SELECT EXISTS (
  SELECT 1 FROM public.customer_tenants tenant
  LEFT JOIN public.tenant_health_source_authorities authority
    ON authority.organization_id = tenant.organization_id AND authority.customer_tenant_id = tenant.id
  WHERE authority.customer_tenant_id IS NULL OR NOT authority.live
    OR authority.current_snapshot_id IS NOT NULL OR authority.current_observation_sequence <> 0
  UNION ALL
  SELECT 1 FROM public.tenant_health_source_authorities authority
  WHERE authority.current_snapshot_id IS NOT NULL OR (authority.live AND NOT EXISTS (
    SELECT 1 FROM public.customer_tenants tenant
    WHERE tenant.organization_id = authority.organization_id AND tenant.id = authority.customer_tenant_id))
) AS invalid`

export const HISTORICAL_RECONCILIATION_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify({ generation: HISTORICAL_RECONCILIATION_GENERATION,
    migrations, triggers, lockSql, reconcileCurrentSql, tombstoneOrphansSql, invalidAuthoritySql }))
  .digest('hex')

function isLockUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const value = error as { code?: unknown; meta?: { code?: unknown;
    driverAdapterError?: { cause?: { kind?: unknown; code?: unknown; originalCode?: unknown } } } }
  if (value.code === '55P03') return true
  if (value.code !== 'P2010') return false
  if (value.meta?.code === '55P03') return true
  const cause = value.meta?.driverAdapterError?.cause
  return cause?.kind === 'postgres' && (cause.code === '55P03' || cause.originalCode === '55P03')
}

export type HistoricalReconciliationAttempt =
  | { outcome: 'completed' | 'already_completed'; generation: string; fingerprint: string }
  | { outcome: 'deferred'; reason: 'source_lock_unavailable' }

/** One unused candidate attempt; no retry loop or migration-history writes. */
export async function attemptHistoricalHealthReconciliation(
  database: Pick<PrismaClient, '$transaction'>,
): Promise<HistoricalReconciliationAttempt> {
  let lockConflict: unknown
  try {
    return await database.$transaction(async (transaction): Promise<HistoricalReconciliationAttempt> => {
      // Exploratory bounds for registered CI, not a measured deployment budget.
      await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '2s'")
      try {
        await transaction.$executeRawUnsafe(lockSql)
      } catch (error) {
        if (isLockUnavailable(error)) lockConflict = error
        throw error // Leave the transaction before classifying a deferral.
      }
      const applied = await transaction.$queryRawUnsafe<Array<{
        migration_name: string; checksum: string; finished: boolean; rolled_back: boolean
      }>>(`SELECT migration_name, checksum, finished_at IS NOT NULL AS finished,
                  rolled_back_at IS NOT NULL AS rolled_back FROM public._prisma_migrations
           WHERE migration_name = ANY($1::text[])`, migrations.map(([name]) => name))
      if (migrations.some(([name, checksum]) => {
        const rows = applied.filter(row => row.migration_name === name)
        return rows.length !== 1 || !rows[0].finished || rows[0].rolled_back || rows[0].checksum !== checksum
      })) throw new Error('TENANT_HEALTH_RECONCILIATION_MIGRATIONS_UNVERIFIED')

      const installed = await transaction.$queryRawUnsafe<Array<{
        table_name: string; trigger_name: string; enabled: string
      }>>(`SELECT c.relname AS table_name, t.tgname AS trigger_name,
                  t.tgenabled::text AS enabled
             FROM pg_catalog.pg_trigger t
             JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND NOT t.tgisinternal
              AND t.tgname = ANY($1::text[])`, triggers.map(([, name]) => name))
      if (triggers.some(([table, name]) => !installed.some(row =>
        row.table_name === table && row.trigger_name === name && ['O', 'A'].includes(row.enabled)))) {
        throw new Error('TENANT_HEALTH_RECONCILIATION_TRIGGERS_UNVERIFIED')
      }
      const receipt = await transaction.$queryRawUnsafe<Array<{ protocol_fingerprint: string }>>(
        `SELECT protocol_fingerprint FROM public.tenant_health_reconciliation_generations
          WHERE generation = $1`, HISTORICAL_RECONCILIATION_GENERATION)
      if (receipt.length > 0) {
        if (receipt.length !== 1 || receipt[0].protocol_fingerprint !== HISTORICAL_RECONCILIATION_FINGERPRINT) {
          throw new Error('TENANT_HEALTH_RECONCILIATION_GENERATION_MISMATCH')
        }
        return { outcome: 'already_completed', generation: HISTORICAL_RECONCILIATION_GENERATION,
          fingerprint: HISTORICAL_RECONCILIATION_FINGERPRINT }
      }

      await transaction.$executeRawUnsafe(reconcileCurrentSql)
      await transaction.$executeRawUnsafe(tombstoneOrphansSql)
      const invariant = await transaction.$queryRawUnsafe<Array<{ invalid: boolean }>>(invalidAuthoritySql)
      if (invariant.length !== 1 || invariant[0].invalid !== false) {
        throw new Error('TENANT_HEALTH_RECONCILIATION_INVARIANT_FAILED')
      }
      const recorded = await transaction.$executeRawUnsafe(
        `INSERT INTO public.tenant_health_reconciliation_generations
          (generation, protocol_fingerprint) VALUES ($1, $2)`,
        HISTORICAL_RECONCILIATION_GENERATION, HISTORICAL_RECONCILIATION_FINGERPRINT)
      if (recorded !== 1) throw new Error('TENANT_HEALTH_RECONCILIATION_RECEIPT_MISSING')
      return { outcome: 'completed', generation: HISTORICAL_RECONCILIATION_GENERATION,
        fingerprint: HISTORICAL_RECONCILIATION_FINGERPRINT }
    }, { isolationLevel: 'ReadCommitted', maxWait: 2_000, timeout: 5_000 })
  } catch (error) {
    // A rollback/connection/commit failure must not be relabeled as contention.
    // Unknown Prisma error shapes fail closed until proved in registered CI.
    if (lockConflict !== undefined && error === lockConflict) {
      return { outcome: 'deferred', reason: 'source_lock_unavailable' }
    }
    throw error
  }
}
