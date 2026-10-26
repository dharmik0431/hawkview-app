import { Prisma } from '../generated/prisma/client.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import type { DirectoryAuditReadStatus, TenantAuditEvent } from './tenant-health.js'

/**
 * A provisional per-tenant ceiling: health displays at most three audit
 * findings, so this allows non-finding events while bounding transfer. It is
 * not an assertion that every audit event was inspected. A 17th eligible
 * event turns only that tenant's window CAPPED.
 * At 1,000 tenants the SQL may return up to 17,000 small rows; measure the
 * actual plan, transfer, and latency in disposable CI before claiming scale.
 */
export const TENANT_DIRECTORY_AUDIT_LIMIT = 16
// SQL omits an over-budget row's JSONB before transfer. The independent Node
// limits still protect projection depth and aggregate size. SQL duration and
// tenant-list fanout remain release gates until measured in disposable CI.
export const TENANT_DIRECTORY_AUDIT_EVENT_BYTES = 16 * 1024
// Reserve room for UUIDs, timestamps, field names and protocol framing; the
// SQL test measures the projected scalar/JSON text, not the entire wire row.
const TENANT_DIRECTORY_AUDIT_SQL_TRANSFER_BYTES = TENANT_DIRECTORY_AUDIT_EVENT_BYTES - 1024
const TENANT_DIRECTORY_AUDIT_TENANT_BYTES = 64 * 1024
const TENANT_DIRECTORY_AUDIT_PAYLOAD_NODES = 2_048
const TENANT_DIRECTORY_AUDIT_PAYLOAD_DEPTH = 24

type AuthorizedTenant = { id: string; organizationId: string }
export type TenantDirectoryAuditWindow = {
  status: DirectoryAuditReadStatus
  events: TenantAuditEvent[]
}

type AuditRow = {
  organizationId: string
  customerTenantId: string
  eventId: string | null
  overflow?: boolean
  detailPresent?: boolean
  payloadTooLarge?: boolean
  microsoftAuditId: string | null
  eventDateTime: Date | null
  activityDisplayName: string | null
  category: string | null
  operationType: string | null
  result: string | null
  initiatedBy: unknown
  targetResources: unknown
}

function boundedPayloadBytes(row: AuditRow): number | null {
  const values: Array<{ value: unknown; depth: number }> = [
    row.microsoftAuditId, row.activityDisplayName, row.category,
    row.operationType, row.result, row.initiatedBy, row.targetResources,
  ].map(value => ({ value, depth: 0 }))
  const seen = new Set<object>()
  let nodes = 0
  let bytes = 0
  while (values.length > 0) {
    const { value, depth } = values.pop()!
    if (++nodes > TENANT_DIRECTORY_AUDIT_PAYLOAD_NODES || depth > TENANT_DIRECTORY_AUDIT_PAYLOAD_DEPTH) return null
    if (typeof value === 'string') {
      if (value.length > TENANT_DIRECTORY_AUDIT_EVENT_BYTES - bytes) return null
      bytes += Buffer.byteLength(value, 'utf8')
    } else if (Array.isArray(value)) {
      if (seen.has(value) || value.length > TENANT_DIRECTORY_AUDIT_PAYLOAD_NODES - nodes - values.length) return null
      seen.add(value)
      for (const item of value) values.push({ value: item, depth: depth + 1 })
    } else if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return null
      seen.add(value)
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        if (key.length > TENANT_DIRECTORY_AUDIT_EVENT_BYTES - bytes) return null
        bytes += Buffer.byteLength(key, 'utf8')
        values.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 })
        if (values.length + nodes > TENANT_DIRECTORY_AUDIT_PAYLOAD_NODES) return null
      }
    } else {
      bytes += 8
    }
    if (bytes > TENANT_DIRECTORY_AUDIT_EVENT_BYTES) return null
  }
  return bytes
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
  if (new Set(pairs.map((pair) => `${pair.organization_id}:${pair.customer_tenant_id}`)).size !== pairs.length) {
    throw new Error('Directory audit read received a duplicate tenant scope.')
  }
  const since = new Date(asOf.getTime() - 24 * 60 * 60 * 1000)
  const rows = await prisma.$queryRaw<AuditRow[]>(Prisma.sql`
    /* tenant-directory:audit-fair-window */
    WITH sampled AS MATERIALIZED (
      SELECT requested.organization_id, requested.customer_tenant_id,
             audit.id AS event_id, audit.event_date_time,
             row_number() OVER (
               PARTITION BY requested.organization_id, requested.customer_tenant_id
               ORDER BY audit.event_date_time DESC NULLS LAST, audit.id DESC NULLS LAST
             ) AS event_rank
      FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb)
           AS requested(organization_id uuid, customer_tenant_id uuid)
      LEFT JOIN LATERAL (
        SELECT id, event_date_time
        FROM directory_audit_logs
        WHERE organization_id = requested.organization_id
          AND customer_tenant_id = requested.customer_tenant_id
          AND event_date_time >= ${since}
          AND expires_at > ${asOf}
        ORDER BY event_date_time DESC, id DESC
        LIMIT ${TENANT_DIRECTORY_AUDIT_LIMIT + 1}
      ) AS audit ON true
    )
    SELECT requested.organization_id AS "organizationId",
           requested.customer_tenant_id AS "customerTenantId",
           requested.event_id AS "eventId",
           (requested.event_rank > ${TENANT_DIRECTORY_AUDIT_LIMIT}) AS "overflow",
           (audit.id IS NOT NULL) AS "detailPresent",
           COALESCE(audit.payload_too_large, false) AS "payloadTooLarge",
           audit.microsoft_audit_id AS "microsoftAuditId",
           requested.event_date_time AS "eventDateTime",
           audit.activity_display_name AS "activityDisplayName",
           audit.category,
           audit.operation_type AS "operationType",
           audit.result,
           audit.initiated_by AS "initiatedBy",
           audit.target_resources AS "targetResources"
    FROM sampled AS requested
    LEFT JOIN LATERAL (
      SELECT detail.id, detail.event_date_time,
             CASE WHEN allowed.within_budget THEN detail.microsoft_audit_id ELSE NULL END AS microsoft_audit_id,
             CASE WHEN allowed.within_budget THEN detail.activity_display_name ELSE NULL END AS activity_display_name,
             CASE WHEN allowed.within_budget THEN detail.category ELSE NULL END AS category,
             CASE WHEN allowed.within_budget THEN detail.operation_type ELSE NULL END AS operation_type,
             CASE WHEN allowed.within_budget THEN detail.result ELSE NULL END AS result,
             CASE WHEN allowed.within_budget
                  THEN detail.initiated_by ELSE NULL END AS initiated_by,
             CASE WHEN allowed.within_budget
                  THEN detail.target_resources ELSE NULL END AS target_resources,
             NOT allowed.within_budget AS payload_too_large
      FROM directory_audit_logs AS detail
      CROSS JOIN LATERAL (
        SELECT COALESCE(octet_length(detail.microsoft_audit_id), 0)::bigint
             + COALESCE(octet_length(detail.activity_display_name), 0)
             + COALESCE(octet_length(detail.category), 0)
             + COALESCE(octet_length(detail.operation_type), 0)
             + COALESCE(octet_length(detail.result), 0)
             + COALESCE(octet_length(detail.initiated_by::text), 0)
             + COALESCE(octet_length(detail.target_resources::text), 0) AS payload_bytes
      ) AS measured
      CROSS JOIN LATERAL (
        SELECT measured.payload_bytes <= ${TENANT_DIRECTORY_AUDIT_SQL_TRANSFER_BYTES} AS within_budget
      ) AS allowed
      WHERE requested.event_rank <= ${TENANT_DIRECTORY_AUDIT_LIMIT}
        AND detail.id = requested.event_id
        AND detail.organization_id = requested.organization_id
        AND detail.customer_tenant_id = requested.customer_tenant_id
    ) AS audit ON true
    ORDER BY requested.organization_id, requested.customer_tenant_id,
             audit.event_date_time DESC NULLS LAST, audit.id DESC NULLS LAST
  `)

  const expected = new Map(tenants.map((tenant) => [
    `${tenant.organizationId}:${tenant.id}`,
    { status: 'COMPLETE' as DirectoryAuditReadStatus, events: [] as TenantAuditEvent[] },
  ]))
  const seen = new Set<string>()
  const payloadBytes = new Map<string, number>()
  for (const row of rows) {
    const key = `${row.organizationId}:${row.customerTenantId}`
    const window = expected.get(key)
    if (!window) throw new Error('Directory audit read returned an unauthorized tenant scope.')
    seen.add(key)
    if (row.eventId === null) continue
    if (window.status === 'NOT_READ') continue
    if (row.overflow === true || window.events.length >= TENANT_DIRECTORY_AUDIT_LIMIT) {
      window.status = 'CAPPED'
      continue
    }
    if (row.detailPresent === false || row.payloadTooLarge === true) {
      // The selected event was not safely returned; preserve any earlier
      // findings while refusing a complete or healthy audit verdict.
      window.status = 'NOT_READ'
      continue
    }
    if (typeof row.eventId !== 'string' || typeof row.microsoftAuditId !== 'string' ||
        !(row.eventDateTime instanceof Date) || Number.isNaN(row.eventDateTime.getTime()) ||
        typeof row.activityDisplayName !== 'string') {
      throw new Error('Directory audit read returned an invalid event.')
    }
    const eventBytes = boundedPayloadBytes(row)
    const nextBytes = (payloadBytes.get(key) ?? 0) + (eventBytes ?? 0)
    if (eventBytes === null || nextBytes > TENANT_DIRECTORY_AUDIT_TENANT_BYTES) {
      // Some evidence was unreadable within the projection budget. Do not
      // present a truncated or empty window as an authoritative healthy one.
      window.status = 'NOT_READ'
      continue
    }
    payloadBytes.set(key, nextBytes)
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
