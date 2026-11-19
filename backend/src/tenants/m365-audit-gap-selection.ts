import type { AuditGapTransferTransaction, SelectedAuditGapClaim } from './m365-audit-gap-transfer.js'

// Inactive qualification constants, not deployment capacity or download policy.
export const AUDIT_GAP_SELECTION_MAX_ROWS = 1
export const AUDIT_GAP_SELECTION_URI_BYTES = 6 * 1024 * 1024
export const AUDIT_GAP_SELECTION_PAGE_BYTES = 8 * 1024 * 1024

export interface AuditGapSelectionInput {
  organizationId: string
  customerTenantId: string
  afterId: string | null
  limit: number
}

export interface AuditGapSelectionPage {
  observedAt: string
  examinedCount: 0 | 1
  lastExaminedId: string | null
  endOfPass: boolean
  candidates: SelectedAuditGapClaim[]
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const statuses = new Set(['PENDING', 'PROCESSING', 'RETRY', 'FAILED', 'INSUFFICIENT_CAPACITY'])
const claimKeys = ['organizationId', 'customerTenantId', 'id', 'microsoftContentId', 'contentType',
  'status', 'contentUri', 'attemptCount', 'updatedAt', 'discoveredAt', 'ledgerExpiresAt', 'contentExpiresAt']

class SelectionError extends Error {
  constructor(code: string) { super(`M365_AUDIT_GAP_SELECTION_${code}`) }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function validId(value: unknown): value is string { return typeof value === 'string' && uuid.test(value) }
function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && timestamp.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
}
function validText(value: unknown, maximum?: number): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
    && (maximum === undefined || value.length <= maximum)
}

// Select the logical page before testing expiry. No locks, mutations, owner
// callback, transaction opener or provider work. Physical query/transport proof
// is still required; these gates do not bound server or client heap/scan cost.
const selectionSql = `
  WITH page_row AS MATERIALIZED (
    SELECT id, organization_id, customer_tenant_id, microsoft_content_id, content_type,
      status, content_uri, attempt_count, updated_at, discovered_at, ledger_expires_at, content_expires_at
    FROM public.m365_activity_contents
    WHERE organization_id = $1::uuid AND customer_tenant_id = $2::uuid
      AND ($3::uuid IS NULL OR id > $3::uuid)
      AND status IN ('PENDING', 'PROCESSING', 'RETRY', 'FAILED', 'INSUFFICIENT_CAPACITY')
    ORDER BY id ASC LIMIT 1
  ), observed AS MATERIALIZED (
    SELECT clock_timestamp() AS at
  ), encoded AS MATERIALIZED (
    SELECT CASE
      WHEN current_setting('server_encoding') <> 'UTF8' OR current_setting('client_encoding') <> 'UTF8'
        THEN '{"refused":"ENCODING_UNSUPPORTED"}'
      WHEN octet_length(p.content_uri) > $4::integer THEN '{"refused":"URI_LIMIT"}'
      ELSE jsonb_build_object(
        'observedAt', to_char(o.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'expired', p.id IS NOT NULL AND
          LEAST(p.ledger_expires_at, p.discovered_at + interval '720 hours', p.content_expires_at) <= o.at,
        'row', CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id', p.id::text, 'organizationId', p.organization_id::text,
          'customerTenantId', p.customer_tenant_id::text,
          'microsoftContentId', p.microsoft_content_id, 'contentType', p.content_type,
          'status', p.status, 'contentUri', p.content_uri, 'attemptCount', p.attempt_count,
          'updatedAt', to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'discoveredAt', to_char(p.discovered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'ledgerExpiresAt', to_char(p.ledger_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'contentExpiresAt', to_char(p.content_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        ) END
      )::text END AS payload
    FROM observed o LEFT JOIN page_row p ON true
  )
  SELECT CASE WHEN octet_length(payload) > $5::integer
    THEN '{"refused":"PAGE_LIMIT"}' ELSE payload END AS page FROM encoded`

/** Read one advisory page. A returned continuation is never durable progress. */
export async function selectExpiredAuditGapPage(
  transaction: AuditGapTransferTransaction,
  input: Readonly<AuditGapSelectionInput>,
): Promise<AuditGapSelectionPage> {
  try {
    // Capture primitives before the first await; later caller mutation cannot
    // change the query scope or the validation of its response.
    const { organizationId, customerTenantId, afterId, limit } = input
    if (!validId(organizationId) || !validId(customerTenantId)
        || (afterId !== null && !validId(afterId)) || limit !== AUDIT_GAP_SELECTION_MAX_ROWS)
      throw new SelectionError('INPUT_INVALID')
    const rows = await transaction.$queryRawUnsafe<unknown>(selectionSql,
      organizationId, customerTenantId, afterId, AUDIT_GAP_SELECTION_URI_BYTES, AUDIT_GAP_SELECTION_PAGE_BYTES)
    if (!Array.isArray(rows) || rows.length !== 1 || !record(rows[0])
        || !exactKeys(rows[0], ['page']) || typeof rows[0].page !== 'string')
      throw new SelectionError('RESULT_INVALID')
    const payload = rows[0].page
    // Defensive decoder checks are additional to the SQL pretransport gates,
    // never a substitute for their future physical witness.
    if (Buffer.byteLength(payload, 'utf8') > AUDIT_GAP_SELECTION_PAGE_BYTES)
      throw new SelectionError('PAGE_LIMIT')
    let decoded: unknown
    try { decoded = JSON.parse(payload) } catch { throw new SelectionError('RESULT_INVALID') }
    if (!record(decoded)) throw new SelectionError('RESULT_INVALID')
    if (exactKeys(decoded, ['refused'])) {
      if (decoded.refused === 'URI_LIMIT' || decoded.refused === 'PAGE_LIMIT'
          || decoded.refused === 'ENCODING_UNSUPPORTED') throw new SelectionError(decoded.refused)
      throw new SelectionError('RESULT_INVALID')
    }
    if (!exactKeys(decoded, ['observedAt', 'expired', 'row']) || !validTimestamp(decoded.observedAt)
        || typeof decoded.expired !== 'boolean') throw new SelectionError('RESULT_INVALID')
    if (decoded.row === null) {
      if (decoded.expired) throw new SelectionError('RESULT_INVALID')
      return { observedAt: decoded.observedAt, examinedCount: 0, lastExaminedId: null, endOfPass: true, candidates: [] }
    }
    const row = decoded.row
    if (!record(row) || !exactKeys(row, claimKeys) || !validId(row.id)
        || row.organizationId !== organizationId || row.customerTenantId !== customerTenantId
        || (afterId !== null && row.id <= afterId)
        || !validText(row.microsoftContentId, 500) || !validText(row.contentType, 80)
        || typeof row.status !== 'string' || !statuses.has(row.status)
        || !validText(row.contentUri) || Buffer.byteLength(row.contentUri, 'utf8') > AUDIT_GAP_SELECTION_URI_BYTES
        || !Number.isInteger(row.attemptCount) || (row.attemptCount as number) < 0 || (row.attemptCount as number) > 2_147_483_647
        || ![row.updatedAt, row.discoveredAt, row.ledgerExpiresAt].every(validTimestamp)
        || (row.contentExpiresAt !== null && !validTimestamp(row.contentExpiresAt)))
      throw new SelectionError('RESULT_INVALID')
    const selected = row as unknown as SelectedAuditGapClaim
    return { observedAt: decoded.observedAt, examinedCount: 1, lastExaminedId: selected.id,
      endOfPass: false, candidates: decoded.expired ? [selected] : [] }
  } catch (error) {
    // Parser/driver exceptions can contain URI-bearing text. Preserve only
    // private fixed codes and never attach a raw message or cause.
    if (error instanceof SelectionError) throw error
    throw new SelectionError('QUERY_FAILED')
  }
}
