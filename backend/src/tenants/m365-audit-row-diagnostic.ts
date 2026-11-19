import type { AuditGapTransferTransaction } from './m365-audit-gap-transfer.js'
import { AUDIT_GAP_SELECTION_URI_BYTES } from './m365-audit-gap-selection.js'

// Inactive observation only. No production caller, durable diagnostic or resolver.
export const AUDIT_GAP_DIAGNOSTIC_RESPONSE_BYTES = 1024

export interface AuditGapDiagnosticInput {
  organizationId: string
  customerTenantId: string
  afterId: string | null
}

export interface AuditGapRowDiagnostic {
  observedAt: string
  row: {
    id: string
    organizationId: string
    customerTenantId: string
    uriExceedsLimit: boolean
  } | null
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const rowKeys = ['id', 'organizationId', 'customerTenantId', 'uriExceedsLimit']

class DiagnosticError extends Error {
  constructor(code: string) { super(`M365_AUDIT_GAP_DIAGNOSTIC_${code}`) }
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

// Same logical scan as the selector, but no URI-bearing projection. The fixed
// response cap does not bound server detoasting, scan cost or driver overhead.
const diagnosticSql = `
  WITH page_row AS MATERIALIZED (
    SELECT id, organization_id, customer_tenant_id,
      octet_length(content_uri) > $4::integer AS uri_exceeds_limit
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
      ELSE jsonb_build_object(
        'observedAt', to_char(o.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'row', CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id', p.id::text, 'organizationId', p.organization_id::text,
          'customerTenantId', p.customer_tenant_id::text, 'uriExceedsLimit', p.uri_exceeds_limit
        ) END
      )::text END AS payload
    FROM observed o LEFT JOIN page_row p ON true
  )
  SELECT CASE WHEN octet_length(payload) > $5::integer
    THEN '{"refused":"RESPONSE_LIMIT"}' ELSE payload END AS diagnostic FROM encoded`

/** Observe the CURRENT first scoped row, not the identity of a prior refusal.
 * Neither a row nor absence is a claim, safe disposition or permission to advance.
 * A false URI flag says nothing about page escaping, invalid fields or expiry.
 */
export async function observeAuditGapRowDiagnostic(
  transaction: AuditGapTransferTransaction,
  input: Readonly<AuditGapDiagnosticInput>,
): Promise<AuditGapRowDiagnostic> {
  try {
    const { organizationId, customerTenantId, afterId } = input
    if (!validId(organizationId) || !validId(customerTenantId) || (afterId !== null && !validId(afterId)))
      throw new DiagnosticError('INPUT_INVALID')
    const rows = await transaction.$queryRawUnsafe<unknown>(diagnosticSql,
      organizationId, customerTenantId, afterId, AUDIT_GAP_SELECTION_URI_BYTES, AUDIT_GAP_DIAGNOSTIC_RESPONSE_BYTES)
    if (!Array.isArray(rows) || rows.length !== 1 || !record(rows[0])
        || !exactKeys(rows[0], ['diagnostic']) || typeof rows[0].diagnostic !== 'string')
      throw new DiagnosticError('RESULT_INVALID')
    const payload = rows[0].diagnostic
    if (Buffer.byteLength(payload, 'utf8') > AUDIT_GAP_DIAGNOSTIC_RESPONSE_BYTES)
      throw new DiagnosticError('RESPONSE_LIMIT')
    let decoded: unknown
    try { decoded = JSON.parse(payload) } catch { throw new DiagnosticError('RESULT_INVALID') }
    if (!record(decoded)) throw new DiagnosticError('RESULT_INVALID')
    if (exactKeys(decoded, ['refused'])) {
      if (decoded.refused === 'ENCODING_UNSUPPORTED' || decoded.refused === 'RESPONSE_LIMIT')
        throw new DiagnosticError(decoded.refused)
      throw new DiagnosticError('RESULT_INVALID')
    }
    if (!exactKeys(decoded, ['observedAt', 'row']) || !validTimestamp(decoded.observedAt))
      throw new DiagnosticError('RESULT_INVALID')
    if (decoded.row === null) return { observedAt: decoded.observedAt, row: null }
    const row = decoded.row
    if (!record(row) || !exactKeys(row, rowKeys) || !validId(row.id)
        || row.organizationId !== organizationId || row.customerTenantId !== customerTenantId
        || (afterId !== null && row.id <= afterId) || typeof row.uriExceedsLimit !== 'boolean')
      throw new DiagnosticError('RESULT_INVALID')
    return { observedAt: decoded.observedAt,
      row: { id: row.id, organizationId, customerTenantId, uriExceedsLimit: row.uriExceedsLimit } }
  } catch (error) {
    if (error instanceof DiagnosticError) throw error
    // Never return driver/parser text, parameters, raw source or a nested cause.
    throw new DiagnosticError('QUERY_FAILED')
  }
}
