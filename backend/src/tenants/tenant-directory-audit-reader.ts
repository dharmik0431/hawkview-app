import { Prisma } from '../generated/prisma/client.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import type { DirectoryAuditReadStatus, TenantAuditEvent } from './tenant-health.js'

/**
 * A provisional per-tenant ceiling: health displays at most three audit
 * findings, so this allows non-finding events while bounding transfer. It is
 * not an assertion that every audit event was inspected. A 17th eligible
 * event turns only that tenant's window CAPPED.
 * At 1,000 tenants the SQL may return up to 17,000 rows; measure the actual
 * plan, row widths, and latency in disposable CI before claiming that scale.
 */
export const TENANT_DIRECTORY_AUDIT_LIMIT = 16

type AuthorizedTenant = { id: string; organizationId: string }
export type TenantDirectoryAuditWindow = {
  status: DirectoryAuditReadStatus
  events: TenantAuditEvent[]
}

type AuditRow = {
  organizationId: string
  customerTenantId: string
  eventId: string | null
  microsoftAuditId: string | null
  eventDateTime: Date | null
  activityDisplayName: string | null
  category: string | null
  operationType: string | null
  result: string | null
  initiatedBy: unknown
  targetResources: unknown
}

/**
 * The caller supplies only pairs returned by the authorized tenant query.
 * Both IDs are compared inside the lateral subquery; a tenant ID alone must
 * never cause an audit row from another organization to join. Eligibility is
 * applied before ORDER BY/LIMIT, so expired rows cannot consume the bound.
 * LEFT JOIN produces a coverage witness even for a tenant with zero events.
 */
export async function readTenantDirectoryAuditWindows(
  prisma: Pick<PrismaService, '$queryRaw'>,
  tenants: AuthorizedTenant[],
  asOf: Date,
): Promise<Map<string, TenantDirectoryAuditWindow>> {
  if (tenants.length === 0) return new Map()
  const pairs = tenants.map(({ id, organizationId }) => ({
    organization_id: organizationId,
    customer_tenant_id: id,
  }))
  const since = new Date(asOf.getTime() - 24 * 60 * 60 * 1000)
  const rows = await prisma.$queryRaw<AuditRow[]>(Prisma.sql`
    /* tenant-directory:audit-fair-window */
    SELECT requested.organization_id AS "organizationId",
           requested.customer_tenant_id AS "customerTenantId",
           audit.id AS "eventId",
           audit.microsoft_audit_id AS "microsoftAuditId",
           audit.event_date_time AS "eventDateTime",
           audit.activity_display_name AS "activityDisplayName",
           audit.category,
           audit.operation_type AS "operationType",
           audit.result,
           audit.initiated_by AS "initiatedBy",
           audit.target_resources AS "targetResources"
    FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb)
         AS requested(organization_id uuid, customer_tenant_id uuid)
    LEFT JOIN LATERAL (
      SELECT id, microsoft_audit_id, event_date_time, activity_display_name,
             category, operation_type, result, initiated_by, target_resources
      FROM directory_audit_logs
      WHERE organization_id = requested.organization_id
        AND customer_tenant_id = requested.customer_tenant_id
        AND event_date_time >= ${since}
        AND expires_at > ${asOf}
      ORDER BY event_date_time DESC, id DESC
      LIMIT ${TENANT_DIRECTORY_AUDIT_LIMIT + 1}
    ) AS audit ON true
    ORDER BY requested.organization_id, requested.customer_tenant_id,
             audit.event_date_time DESC NULLS LAST, audit.id DESC NULLS LAST
  `)

  const expected = new Map(tenants.map((tenant) => [
    `${tenant.organizationId}:${tenant.id}`,
    { status: 'COMPLETE' as DirectoryAuditReadStatus, events: [] as TenantAuditEvent[] },
  ]))
  const seen = new Set<string>()
  for (const row of rows) {
    const key = `${row.organizationId}:${row.customerTenantId}`
    const window = expected.get(key)
    if (!window) throw new Error('Directory audit read returned an unauthorized tenant scope.')
    seen.add(key)
    if (row.eventId === null) continue
    if (typeof row.eventId !== 'string' || typeof row.microsoftAuditId !== 'string' ||
        !(row.eventDateTime instanceof Date) || Number.isNaN(row.eventDateTime.getTime()) ||
        typeof row.activityDisplayName !== 'string') {
      throw new Error('Directory audit read returned an invalid event.')
    }
    if (window.events.length >= TENANT_DIRECTORY_AUDIT_LIMIT) {
      window.status = 'CAPPED'
      continue
    }
    window.events.push({
      microsoftAuditId: row.microsoftAuditId,
      eventDateTime: row.eventDateTime,
      activityDisplayName: row.activityDisplayName,
      category: row.category,
      operationType: row.operationType,
      result: row.result,
      initiatedBy: row.initiatedBy,
      targetResources: row.targetResources,
    })
  }
  if (seen.size !== expected.size) throw new Error('Directory audit read omitted a tenant coverage witness.')
  return new Map(tenants.map((tenant) => [tenant.id, expected.get(`${tenant.organizationId}:${tenant.id}`)!]))
}
