import type { AuthorityDatabase } from '../microsoft/managed-connector-authority.js'
import { pimPlane, pimUuid, type ParsedObservationRow, type PimPlane, type PimReceipt } from './pim-schedule-contract.js'
import { receiptFromRecord, type PimAttemptRecord } from './pim-schedule-store.js'

export interface PimReadAuthorization {
  /** Trusted application boundary only; never construct from raw request fields.
   * Supplying this context from the real authenticated boundary remains an activation dependency. */
  readonly subjectId: string
  readonly organizationId: string
  readonly tenantMemberships: ReadonlySet<string>
}
export interface PimPlaneView extends PimReceipt { rows: readonly ParsedObservationRow[]; ageMs: number }
export type PimPlaneReadResult =
  | { status: 'observed'; view: PimPlaneView }
  | { status: 'never-collected'; plane: PimPlane }
  | { status: 'last-attempt-failed'; plane: PimPlane; view: PimPlaneView | null; failureKind: string }

export function authorizePimRead(auth: PimReadAuthorization, customerTenantId: string): PimReadAuthorization {
  const tenant = pimUuid(customerTenantId)
  if (!auth || typeof auth.subjectId !== 'string' || !auth.subjectId || !auth.tenantMemberships?.has(tenant)) throw new Error('PIM_FORBIDDEN')
  return Object.freeze({ subjectId: auth.subjectId, organizationId: pimUuid(auth.organizationId), tenantMemberships: new Set([tenant]) })
}
type StoredRow = { occurrence_ordinal: number; instance_id: string | null; plane: PimPlane;
  raw: ParsedObservationRow['raw']; observations: ParsedObservationRow['observations']; diagnostics: ParsedObservationRow['diagnostics'];
  provider_start_date_time: string | null; provider_end_date_time: string | null }

/** One statement snapshot keeps current receipt, its rows and latest attempt consistent.
 * This reader neither calls a provider nor infers tenant-wide absence from an empty array. */
export async function readPimSchedulePlane(db: AuthorityDatabase, authorization: PimReadAuthorization,
  request: { customerTenantId: string; plane: PimPlane }): Promise<PimPlaneReadResult> {
  const tenantId = pimUuid(request.customerTenantId), plane = pimPlane(request.plane)
  const auth = authorizePimRead(authorization, tenantId)
  return db.$transaction(async tx => {
    const results = await tx.$queryRawUnsafe<{ readAt: Date; current: PimAttemptRecord | null;
      latest: PimAttemptRecord | null; rows: StoredRow[] | null }[]>(`/* pim:read */
      SELECT clock_timestamp() AS "readAt",
        (SELECT to_jsonb(a) FROM pim_schedule_attempts a WHERE a.customer_tenant_id=t.id
          AND a.organization_id=t.organization_id AND a.plane=$3::pim_schedule_plane AND a.is_current) AS current,
        (SELECT to_jsonb(a) FROM pim_schedule_attempts a WHERE a.customer_tenant_id=t.id
          AND a.organization_id=t.organization_id AND a.plane=$3::pim_schedule_plane
          ORDER BY a.started_at DESC,a.id DESC LIMIT 1) AS latest,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.occurrence_ordinal)
          FROM pim_schedule_observation_rows r JOIN pim_schedule_attempts a ON a.id=r.attempt_id AND a.plane=r.plane
          WHERE a.customer_tenant_id=t.id AND a.organization_id=t.organization_id
            AND a.plane=$3::pim_schedule_plane AND a.is_current) AS rows
      FROM customer_tenants t WHERE t.id=$1::uuid AND t.organization_id=$2::uuid`, tenantId, auth.organizationId, plane)
    const data = results[0]
    let view: PimPlaneView | null = null
    if (data?.current) {
      const receipt = receiptFromRecord(data.current)
      const rows = (data.rows ?? []).map(r => ({ occurrenceOrdinal: r.occurrence_ordinal, instanceId: r.instance_id,
        plane: r.plane, raw: r.raw, observations: r.observations, diagnostics: r.diagnostics,
        providerStartDateTime: r.provider_start_date_time === null ? null : new Date(r.provider_start_date_time),
        providerEndDateTime: r.provider_end_date_time === null ? null : new Date(r.provider_end_date_time) }))
      if (rows.length !== receipt.observedRowCount || rows.some((r, i) => r.plane !== plane || r.occurrenceOrdinal !== i)) throw new Error('INVALID_PIM_PERSISTED_VIEW')
      view = { ...receipt, rows, ageMs: Math.max(0, new Date(data.readAt).getTime() - receipt.committedAt.getTime()) }
    }
    if (data?.latest?.outcome === 'FAILED' || data?.latest?.outcome === 'ABANDONED') {
      return { status: 'last-attempt-failed', plane, view, failureKind: data.latest.failure_kind ?? 'ABANDONED' }
    }
    return view ? { status: 'observed', view } : { status: 'never-collected', plane }
  }, { isolationLevel: 'ReadCommitted' })
}
