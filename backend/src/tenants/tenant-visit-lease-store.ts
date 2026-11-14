import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../generated/prisma/client.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'
import { assertTenantVisitLifecycleActive } from './tenant-visit-lifecycle.js'

/** Used by the default-OFF tenant-visit lifecycle and exact-owner writers. */
export interface TenantVisitLeaseScope {
  readonly organizationId: string
  readonly customerTenantId: string
}

export interface TenantVisitLeaseOwner extends TenantVisitLeaseScope {
  readonly token: string
  readonly generation: bigint
  readonly expiresAt: Date
}

interface LeaseRow { generation: string; expiresAt: Date }
interface LeaseQuery {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

function requireDuration(durationMs: number): string {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new Error('TENANT_VISIT_DURATION_INVALID')
  }
  return String(durationMs)
}

function isAdmissionLockContention(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } }
  return candidate.code === '55P03' || (candidate.code === 'P2010' && (
    candidate.meta?.code === '55P03' ||
    candidate.meta?.driverAdapterError?.cause?.originalCode === '55P03'
  ))
}

/** One scoped winner. The organization and tenant locks precede the lease row. */
export async function tryAcquireTenantVisitLease(
  database: Pick<PrismaClient, '$transaction'>,
  scope: TenantVisitLeaseScope,
  durationMs: number,
): Promise<TenantVisitLeaseOwner | null> {
  const duration = requireDuration(durationMs)
  const token = randomUUID()
  let admissionContention: unknown
  try {
    return await database.$transaction(async (transaction) => {
      try {
        await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '1s'")
        await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '2s'")
        const organizations = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id FROM organizations WHERE id=$1::uuid FOR KEY SHARE', scope.organizationId)
        if (organizations.length !== 1) throw new Error('TENANT_VISIT_SCOPE_UNAVAILABLE')
        const tenants = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id FROM customer_tenants WHERE id=$1::uuid AND organization_id=$2::uuid FOR KEY SHARE',
          scope.customerTenantId, scope.organizationId)
        if (tenants.length !== 1) throw new Error('TENANT_VISIT_SCOPE_UNAVAILABLE')
        const rows = await transaction.$queryRawUnsafe<LeaseRow[]>(`
          INSERT INTO tenant_sync_visit_leases
            (customer_tenant_id, organization_id, owner_token, generation, expires_at, updated_at)
          VALUES ($1::uuid, $2::uuid, $3::uuid, 1,
            clock_timestamp() + ($4::bigint * interval '1 millisecond'), clock_timestamp())
          ON CONFLICT (customer_tenant_id, organization_id) DO UPDATE
          SET owner_token=EXCLUDED.owner_token,
              generation = tenant_sync_visit_leases.generation + 1,
              expires_at=clock_timestamp() + ($4::bigint * interval '1 millisecond'),
              updated_at=clock_timestamp()
          WHERE tenant_sync_visit_leases.owner_token IS NULL
             OR tenant_sync_visit_leases.expires_at <= clock_timestamp()
          RETURNING generation::text AS generation, expires_at AS "expiresAt"`,
        scope.customerTenantId, scope.organizationId, token, duration)
        if (rows.length === 0) return null
        if (rows.length !== 1) throw new Error('TENANT_VISIT_ADMISSION_INVALID')
        return { ...scope, token, generation: BigInt(rows[0].generation), expiresAt: rows[0].expiresAt }
      } catch (error) {
        // A live writer can hold FOR SHARE longer than our admission budget.
        // Let Prisma roll back the aborted transaction before reporting busy.
        if (isAdmissionLockContention(error)) admissionContention = error
        throw error
      }
    }, { maxWait: 2000, timeout: 5000 })
  } catch (error) {
    // Never translate transaction-start, commit or connection uncertainty.
    // Only the exact SQL lock error observed inside admission means busy.
    if (admissionContention !== undefined && error === admissionContention) return null
    throw error
  }
}

/** Only an exact, still-live owner may extend its deadline. */
export async function renewTenantVisitLease(
  database: Pick<PrismaClient, '$queryRawUnsafe'>,
  owner: TenantVisitLeaseOwner,
  durationMs: number,
): Promise<TenantVisitLeaseOwner | null> {
  const duration = requireDuration(durationMs)
  const rows = await database.$queryRawUnsafe<LeaseRow[]>(`
    UPDATE tenant_sync_visit_leases
    SET expires_at=GREATEST(expires_at, clock_timestamp() + ($5::bigint * interval '1 millisecond')),
        updated_at=clock_timestamp()
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid
      AND owner_token=$3::uuid AND generation=$4::bigint
      AND expires_at > clock_timestamp()
    RETURNING generation::text AS generation, expires_at AS "expiresAt"`,
  owner.customerTenantId, owner.organizationId, owner.token, owner.generation.toString(), duration)
  if (rows.length === 0) return null
  if (rows.length !== 1) throw new Error('TENANT_VISIT_RENEWAL_INVALID')
  return { ...owner, expiresAt: rows[0].expiresAt }
}

/** Hold all three locks through the caller's materialization transaction. */
export async function assertTenantVisitLeaseOwner(
  transaction: LeaseQuery,
  owner: TenantVisitLeaseOwner,
): Promise<void> {
  assertTenantVisitLifecycleActive(owner)
  const organizations = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT id FROM organizations WHERE id=$1::uuid FOR KEY SHARE', owner.organizationId)
  if (organizations.length !== 1) throw new TenantVisitLeaseLostError()
  const tenants = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT id FROM customer_tenants WHERE id=$1::uuid AND organization_id=$2::uuid FOR NO KEY UPDATE',
    owner.customerTenantId, owner.organizationId)
  if (tenants.length !== 1) throw new TenantVisitLeaseLostError()
  const rows = await transaction.$queryRawUnsafe<Array<{ generation: string }>>(`
    SELECT generation::text AS generation FROM tenant_sync_visit_leases
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid
      AND owner_token=$3::uuid AND generation=$4::bigint
      AND expires_at > clock_timestamp() FOR SHARE`,
  owner.customerTenantId, owner.organizationId, owner.token, owner.generation.toString())
  if (rows.length !== 1) throw new TenantVisitLeaseLostError()
  assertTenantVisitLifecycleActive(owner)
}

/** Releasing an old generation cannot clear a successor's lease. */
export async function releaseTenantVisitLease(
  database: Pick<PrismaClient, '$queryRawUnsafe'>,
  owner: TenantVisitLeaseOwner,
): Promise<boolean> {
  const rows = await database.$queryRawUnsafe<Array<{ generation: string }>>(`
    UPDATE tenant_sync_visit_leases
    SET owner_token=NULL, expires_at=NULL, updated_at=clock_timestamp()
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid
      AND owner_token=$3::uuid AND generation=$4::bigint
    RETURNING generation::text AS generation`,
  owner.customerTenantId, owner.organizationId, owner.token, owner.generation.toString())
  return rows.length === 1
}
