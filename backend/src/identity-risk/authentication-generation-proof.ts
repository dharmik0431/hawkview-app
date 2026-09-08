import type { AuthScope } from '../risky-users-auth/contract.js'
import type { AuthenticationWindow } from './authentication-source-readiness.js'

export const AUTHENTICATION_ROW_MAX = 10_000
export const AUTHENTICATION_ROW_BYTES = 16_384
export const AUTHENTICATION_BATCH_BYTES = 4 * 1024 * 1024
/** Identical bounded predicate at read and commit. Hashing stays in PostgreSQL;
 * no private record, source ID, address or credential becomes a proof field.
 * Include BOTH feeds and unknown-source rows so concurrent insert/conflict or
 * source replacement cannot be hidden by the source-selection predicate. */
export const AUTHENTICATION_GENERATION_SQL = `WITH bounded AS MATERIALIZED (
  SELECT id, event_date_time, ingested_at, expires_at, raw
  FROM sign_in_logs WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid
    AND event_date_time >= $3::timestamptz AND event_date_time <= $4::timestamptz
    AND expires_at > $5::timestamptz ORDER BY id LIMIT 10001
), sizes AS (
  SELECT count(*)::integer AS count, coalesce(sum(octet_length(raw::text)),0)::bigint AS bytes,
    coalesce(max(octet_length(raw::text)),0)::integer AS largest FROM bounded
)
SELECT count, bytes::text, largest,
  CASE WHEN count<=10000 AND bytes<=4194304 AND largest<=16384 THEN
    (SELECT encode(sha256(convert_to(coalesce(string_agg(
      id::text || ':' || event_date_time::text || ':' || ingested_at::text || ':' || expires_at::text || ':' ||
      encode(sha256(convert_to(raw::text,'UTF8')),'hex'), '|' ORDER BY id),''),'UTF8')),'hex') FROM bounded)
    ELSE NULL END AS digest FROM sizes`
export type AuthenticationGeneration = { count: number; bytes: string; largest: number; digest: string | null }
export function authenticationGenerationValid(value: AuthenticationGeneration | undefined): value is AuthenticationGeneration & { digest: string } {
  return !!value && Number.isInteger(value.count) && value.count >= 0 && value.count <= AUTHENTICATION_ROW_MAX &&
    /^\d{1,10}$/.test(value.bytes) && Number(value.bytes) <= AUTHENTICATION_BATCH_BYTES &&
    Number.isInteger(value.largest) && value.largest >= 0 && value.largest <= AUTHENTICATION_ROW_BYTES && /^[a-f0-9]{64}$/.test(value.digest ?? '')
}
export const authenticationGenerationParameters = (scope: Pick<AuthScope, 'organizationId' | 'customerTenantId'>, window: AuthenticationWindow, asOf: Date) =>
  [scope.organizationId, scope.customerTenantId, window.start, window.end, asOf] as const
