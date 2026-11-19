import { createHash, randomUUID } from 'node:crypto'

// Inactive transaction body. The future caller must already hold HAW-21's real
// scoped live-owner fence, retain it through outcome/commit, and roll back on
// every rejection. This interface and the tenant lock below do NOT prove owner
// validity. There is deliberately no production caller or transaction opener.
export interface AuditGapTransferTransaction {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

export interface SelectedAuditGapClaim {
  organizationId: string
  customerTenantId: string
  id: string
  microsoftContentId: string
  contentType: string
  status: string
  contentUri: string
  attemptCount: number
  // Preserve the database's microseconds. A JavaScript Date is insufficient
  // for a revision/expiry equality predicate on timestamptz(6).
  updatedAt: string
  discoveredAt: string
  ledgerExpiresAt: string
  contentExpiresAt: string | null
}

type ExpiryReason = 'LEDGER_EXPIRED' | 'PROVIDER_URL_EXPIRED' | 'URL_AGE_EXPIRED'
// On a retained-gap retry, reason describes this source deadline; it does not
// replace or describe the retained gap's original persisted reason.
export type StagedAuditGapTransfer =
  | { staged: true; reason: ExpiryReason }
  | { staged: false; reason: 'TENANT_ABSENT' | 'SOURCE_CHANGED_OR_ABSENT' | 'NOT_EXPIRED' }

interface StateRow { organizationId: string; generation: bigint }
interface GapRow { organizationId: string; contentType: string; resolvedAt: unknown | null }
interface ExpiryRow { observedAt: string; sourceExpiredAt: string; expired: boolean; reason: ExpiryReason }

const unresolvedStatuses = new Set(['PENDING', 'PROCESSING', 'RETRY', 'FAILED', 'INSUFFICIENT_CAPACITY'])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/
const reasons = new Set<ExpiryReason>(['LEDGER_EXPIRED', 'PROVIDER_URL_EXPIRED', 'URL_AGE_EXPIRED'])

class GapTransferError extends Error {
  constructor(code: string) { super(`M365_AUDIT_GAP_${code}`) }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && timestamp.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
}

function validateClaim(claim: SelectedAuditGapClaim) {
  if (![claim.id, claim.organizationId, claim.customerTenantId].every((id) => typeof id === 'string' && uuid.test(id))
      || typeof claim.microsoftContentId !== 'string' || !claim.microsoftContentId.length || claim.microsoftContentId.length > 500
      || typeof claim.contentType !== 'string' || !claim.contentType.length || claim.contentType.length > 80
      || !unresolvedStatuses.has(claim.status)
      || typeof claim.contentUri !== 'string' || !claim.contentUri.length
      || !Number.isSafeInteger(claim.attemptCount) || claim.attemptCount < 0 || claim.attemptCount > 2_147_483_647
      || ![claim.updatedAt, claim.discoveredAt, claim.ledgerExpiresAt].every(validTimestamp)
      || (claim.contentExpiresAt !== null && !validTimestamp(claim.contentExpiresAt))) {
    throw new GapTransferError('SELECTED_CLAIM_INVALID')
  }
}

// Static SQL with positional parameters, shared by the lock and final deletion.
// No normalization: the digest and predicate use the already stored ID.
const exactClaimPredicate = `id = $1::uuid AND organization_id = $2::uuid AND customer_tenant_id = $3::uuid
  AND microsoft_content_id = $4 AND content_type = $5 AND status = $6 AND content_uri = $7
  AND attempt_count = $8::integer AND updated_at = $9::timestamptz
  AND discovered_at = $10::timestamptz AND ledger_expires_at = $11::timestamptz
  AND content_expires_at IS NOT DISTINCT FROM $12::timestamptz`

/** Stage one expired unresolved row; only the outer transaction can commit it. */
export async function stageExpiredAuditGapTransfer(
  transaction: AuditGapTransferTransaction,
  selected: SelectedAuditGapClaim,
): Promise<StagedAuditGapTransfer> {
  // Capture immutable primitive values before the first await. Callers cannot
  // change the selected claim while a lock is waiting.
  const claim = { ...selected }
  validateClaim(claim)
  const values = [claim.id, claim.organizationId, claim.customerTenantId, claim.microsoftContentId,
    claim.contentType, claim.status, claim.contentUri, claim.attemptCount, claim.updatedAt,
    claim.discoveredAt, claim.ledgerExpiresAt, claim.contentExpiresAt]
  const digest = createHash('sha256').update(claim.microsoftContentId, 'utf8').digest('hex')
  try {
    const tenants = await transaction.$queryRawUnsafe<Array<{ id: string }>>(`
      SELECT id FROM public.customer_tenants
      WHERE id = $1::uuid AND organization_id = $2::uuid FOR UPDATE`,
    claim.customerTenantId, claim.organizationId)
    if (tenants.length === 0) return { staged: false, reason: 'TENANT_ABSENT' }
    if (tenants.length !== 1) throw new GapTransferError('TENANT_INVALID')

    // Lock optional rows only after the existing tenant row. Absent gap/state
    // rows alone cannot serialize first-gap creation.
    const states = await transaction.$queryRawUnsafe<StateRow[]>(`
      SELECT organization_id::text AS "organizationId", generation
      FROM public.m365_audit_coverage_states WHERE customer_tenant_id = $1::uuid FOR UPDATE`,
    claim.customerTenantId)
    if (states.length > 1 || (states[0] && states[0].organizationId !== claim.organizationId))
      throw new GapTransferError('STATE_SCOPE_INVALID')
    const gaps = await transaction.$queryRawUnsafe<GapRow[]>(`
      SELECT organization_id::text AS "organizationId", content_type AS "contentType", resolved_at AS "resolvedAt"
      FROM public.m365_audit_coverage_gaps
      WHERE customer_tenant_id = $1::uuid AND content_id_sha256 = $2::char(64) FOR UPDATE`,
    claim.customerTenantId, digest)
    if (gaps.length > 1 || (gaps[0] && (gaps[0].organizationId !== claim.organizationId
        || gaps[0].contentType !== claim.contentType))) throw new GapTransferError('IDENTITY_CONFLICT')
    if (gaps[0]?.resolvedAt !== undefined && gaps[0].resolvedAt !== null)
      throw new GapTransferError('RESOLVED_IDENTITY_CONFLICT')
    if (gaps.length && !states.length) throw new GapTransferError('STICKY_STATE_MISSING')

    const rows = await transaction.$queryRawUnsafe<Array<{ id: string }>>(`
      SELECT id FROM public.m365_activity_contents WHERE ${exactClaimPredicate} FOR UPDATE`, ...values)
    if (rows.length === 0) return { staged: false, reason: 'SOURCE_CHANGED_OR_ABSENT' }
    if (rows.length !== 1) throw new GapTransferError('SOURCE_INVALID')

    // Separate statement AFTER all row waits. Text values preserve microseconds
    // for later inserts; SQL, not a rounded JS Date, decides exact-boundary expiry.
    const expiry = await transaction.$queryRawUnsafe<ExpiryRow[]>(`
      WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS at), deadline AS (
        SELECT LEAST(ledger_expires_at, discovered_at + interval '720 hours', content_expires_at) AS at,
          ledger_expires_at, content_expires_at
        FROM public.m365_activity_contents WHERE id = $1::uuid
          AND organization_id = $2::uuid AND customer_tenant_id = $3::uuid
      )
      SELECT to_char(observed.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "observedAt",
        to_char(deadline.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sourceExpiredAt",
        deadline.at <= observed.at AS expired,
        CASE WHEN deadline.at = content_expires_at THEN 'PROVIDER_URL_EXPIRED'
          WHEN deadline.at = ledger_expires_at THEN 'LEDGER_EXPIRED'
          ELSE 'URL_AGE_EXPIRED' END AS reason FROM observed CROSS JOIN deadline`,
    claim.id, claim.organizationId, claim.customerTenantId)
    if (expiry.length !== 1 || typeof expiry[0].expired !== 'boolean'
        || !reasons.has(expiry[0].reason)
        || !validTimestamp(expiry[0].observedAt) || !validTimestamp(expiry[0].sourceExpiredAt))
      throw new GapTransferError('CLOCK_INVALID')
    const clock = expiry[0]
    if (!clock.expired) return { staged: false, reason: 'NOT_EXPIRED' }

    if (!gaps.length) {
      const inserted = await transaction.$queryRawUnsafe<Array<{ id: string }>>(`
        INSERT INTO public.m365_audit_coverage_gaps
          (id, organization_id, customer_tenant_id, content_type, content_id_sha256,
           source_status, reason, source_expired_at, first_observed_at)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::char(64), $6, $7, $8::timestamptz, $9::timestamptz)
        RETURNING id`, randomUUID(), claim.organizationId, claim.customerTenantId, claim.contentType,
      digest, claim.status, clock.reason, clock.sourceExpiredAt, clock.observedAt)
      if (inserted.length !== 1) throw new GapTransferError('INSERT_LOST')
      const updated = states.length
        ? await transaction.$queryRawUnsafe<Array<{ id: string }>>(`
          UPDATE public.m365_audit_coverage_states SET generation = generation + 1,
            last_gap_at = GREATEST(last_gap_at, $3::timestamptz)
          WHERE customer_tenant_id = $1::uuid AND organization_id = $2::uuid AND generation = $4::bigint
          RETURNING customer_tenant_id AS id`,
        claim.customerTenantId, claim.organizationId, clock.observedAt, states[0].generation)
        : await transaction.$queryRawUnsafe<Array<{ id: string }>>(`
          INSERT INTO public.m365_audit_coverage_states
            (customer_tenant_id, organization_id, generation, incomplete_since, last_gap_at)
          VALUES ($1::uuid, $2::uuid, 1, $3::timestamptz, $3::timestamptz)
          RETURNING customer_tenant_id AS id`, claim.customerTenantId, claim.organizationId, clock.observedAt)
      if (updated.length !== 1) throw new GapTransferError('STATE_WRITE_LOST')
    }
    // A retained unresolved gap is left untouched: no refreshed observation,
    // generation bump, reopened resolution or purged-marker clearance.
    const deleted = await transaction.$queryRawUnsafe<Array<{ id: string }>>(`
      DELETE FROM public.m365_activity_contents WHERE ${exactClaimPredicate} RETURNING id`, ...values)
    if (deleted.length !== 1) throw new GapTransferError('DELETE_LOST')
    return { staged: true, reason: clock.reason }
  } catch (error) {
    // Driver errors may echo parameters (including provider URLs). Do not expose
    // them as a message/cause. Rejection requires the caller to roll back.
    if (error instanceof GapTransferError) throw error
    throw new GapTransferError('STAGE_FAILED')
  }
}
