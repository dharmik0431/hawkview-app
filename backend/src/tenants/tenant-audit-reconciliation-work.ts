import type { PrismaClient } from '../generated/prisma/client.js'
import {
  AUDIT_RECONCILIATION_RESOURCES,
  type AuditReconciliationResource,
} from './audit-change-reconciliation.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'
import {
  assertTenantVisitLeaseOwner,
  type TenantVisitLeaseOwner,
  type TenantVisitLeaseScope,
} from './tenant-visit-lease-store.js'

export interface PendingAuditReconciliationWork {
  readonly resourceType: AuditReconciliationResource
  readonly requestedRevision: bigint
}

const knownResources = new Set<string>(AUDIT_RECONCILIATION_RESOURCES)

/**
 * Inactive read seam for a future bounded, owner-bearing audit replay. This
 * selects durable unfinished work even if the provider's next page is empty;
 * it does not run collectors or claim that any resource completed.
 */
export async function selectPendingAuditReconciliationWork(
  database: Pick<PrismaClient, '$transaction'>,
  scope: TenantVisitLeaseScope,
  owner: TenantVisitLeaseOwner,
  limit: number,
): Promise<PendingAuditReconciliationWork[]> {
  if (owner.organizationId !== scope.organizationId ||
      owner.customerTenantId !== scope.customerTenantId) {
    throw new TenantVisitLeaseLostError()
  }
  if (!Number.isSafeInteger(limit) || limit < 1 ||
      limit > AUDIT_RECONCILIATION_RESOURCES.length) {
    throw new Error('TENANT_AUDIT_RECONCILIATION_WORK_LIMIT_INVALID')
  }

  return database.$transaction(async (transaction) => {
    await assertTenantVisitLeaseOwner(transaction, owner)
    const rows = await transaction.$queryRawUnsafe<Array<{
      resourceType: string
      requestedRevision: string
    }>>(`
      SELECT resource_type::text AS "resourceType",
             requested_revision::text AS "requestedRevision"
      FROM tenant_audit_reconciliation_work
      WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid
        AND requested_revision > completed_revision
      ORDER BY resource_type ASC
      LIMIT $3::int`, scope.organizationId, scope.customerTenantId, limit)
    return rows.map((row) => {
      if (!knownResources.has(row.resourceType) ||
          !/^[1-9]\d*$/.test(row.requestedRevision)) {
        throw new Error('TENANT_AUDIT_RECONCILIATION_WORK_ROW_INVALID')
      }
      return {
        resourceType: row.resourceType as AuditReconciliationResource,
        requestedRevision: BigInt(row.requestedRevision),
      }
    })
  })
}

/**
 * Inactive completion seam. A future caller must first obtain a durable,
 * source-specific successful refresh receipt; a fulfilled collector promise
 * is not enough. Exact revision comparison keeps a newer request pending.
 */
export async function advanceAuditReconciliationCompletion(
  database: Pick<PrismaClient, '$transaction'>,
  scope: TenantVisitLeaseScope,
  owner: TenantVisitLeaseOwner,
  resourceType: AuditReconciliationResource,
  requestedRevision: bigint,
): Promise<boolean> {
  if (owner.organizationId !== scope.organizationId ||
      owner.customerTenantId !== scope.customerTenantId) {
    throw new TenantVisitLeaseLostError()
  }
  if (!knownResources.has(resourceType)) {
    throw new Error('TENANT_AUDIT_RECONCILIATION_WORK_RESOURCE_INVALID')
  }
  if (typeof requestedRevision !== 'bigint' || requestedRevision < 1n ||
      requestedRevision > 9223372036854775807n) {
    throw new Error('TENANT_AUDIT_RECONCILIATION_WORK_REVISION_INVALID')
  }

  return database.$transaction(async (transaction) => {
    await assertTenantVisitLeaseOwner(transaction, owner)
    const rows = await transaction.$queryRawUnsafe<Array<{ completedRevision: string }>>(`
      UPDATE tenant_audit_reconciliation_work
      SET completed_revision=$4::bigint,
          last_completed_at=clock_timestamp(),
          updated_at=clock_timestamp()
      WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid
        AND resource_type=$3::"SyncResourceType"
        AND requested_revision=$4::bigint
        AND completed_revision < $4::bigint
      RETURNING completed_revision::text AS "completedRevision"`,
    scope.organizationId, scope.customerTenantId, resourceType, requestedRevision.toString())
    if (rows.length > 1 || (rows.length === 1 &&
        rows[0].completedRevision !== requestedRevision.toString())) {
      throw new Error('TENANT_AUDIT_RECONCILIATION_WORK_COMPLETION_INVALID')
    }
    return rows.length === 1
  })
}
