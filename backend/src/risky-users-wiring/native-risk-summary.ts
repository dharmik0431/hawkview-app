import { SERVICE_FRESHNESS_WINDOWS } from '../tenants/service-sync-freshness.js'
import { decodeNativeRunRow, type RunRow, type ReadRunResult } from './read-run.js'
import { RUN_ENGINE_VERSION, RUN_STATUS } from './persist-run.js'

export const NATIVE_SUMMARY_TENANT_LIMIT = 100
export const NATIVE_SUMMARY_RUN_BYTES = 256 * 1024
export const NATIVE_SUMMARY_REASONS = ['NO_TENANTS', 'SCOPE_CAPPED', 'NOT_ENABLED_FOR_TENANT', 'EVALUATION_DISABLED', 'NO_CURRENT_RUN', 'INVALID_RUN', 'COUNT_WITHHELD', 'PARTIAL_ASSESSMENT', 'READ_LIMIT_EXCEEDED', 'STALE_ASSESSMENT', 'SOURCE_FRESHNESS_UNKNOWN', 'SOURCE_UNAVAILABLE'] as const
type Reason = typeof NATIVE_SUMMARY_REASONS[number]
type Accuracy = 'EXACT' | 'AT_LEAST' | 'NOT_AVAILABLE'
type Availability = 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE'
export type NativeSummaryScope = { totalTenants: number; tenants: Array<{ id: string; organizationId: string; gate: 'NOT_ENABLED_FOR_TENANT' | 'EVALUATION_DISABLED' | null }> }
type TenantSummary = { tenantId: string; availability: Availability; accuracy: Accuracy; distinctUserCount: number | null; evaluatedAt: string | null; windowStart: string | null; windowEnd: string | null; complete: boolean; limitations: Reason[] }
type BatchRow = Pick<RunRow, 'evaluationCoverage' | 'evaluationFindings'> & { organizationId: string; customerTenantId: string; completedAt: unknown; windowStart: unknown; windowEnd: unknown; expiresAt: unknown; readLimitExceeded: boolean; collectorStatus: unknown; collectorLastSuccessfulAt: unknown }
type Reader = { $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T> }
const unique = (reasons: Reason[]): Reason[] => [...new Set(reasons)].sort()
const date = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime())
// SQL returns text, not a timezone-sensitive driver timestamp type. Refuse any
// noncanonical/missing clock rather than interpreting it in the host timezone.
function utcClock(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null
  const parsed = new Date(value)
  return date(parsed) && parsed.toISOString() === value ? parsed : null
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 200)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000

/** Validate the verdict before using the legacy decoder's typed projection. */
function validVerdict(raw: unknown): boolean {
  if (!record(raw) || !record(raw.count) || !record(raw.claim)) return false
  const { count, claim } = raw
  if (typeof count.accuracy !== 'string' || !['EXACT', 'AT_LEAST', 'NOT_AVAILABLE'].includes(count.accuracy) ||
    (count.accuracy === 'NOT_AVAILABLE' ? count.value !== null : !integer(count.value)) || !record(count.scope)) return false
  const scope = count.scope
  if (!strings(scope.evidenceRequested) || !strings(scope.covered) || !Array.isArray(scope.notCovered) ||
    !scope.notCovered.every((item) => record(item) && strings([item.detectorId, item.because])) ||
    !Array.isArray(scope.setAside) || !scope.setAside.every((item) => record(item) &&
      typeof item.vocabulary === 'string' && ['DOES_NOT_APPLY', 'NOT_YET_CITED', 'UNKNOWN', 'UNPROCESSABLE'].includes(item.vocabulary) && strings([item.reason]) && integer(item.count))) return false
  return claim.permitted === true ? claim.withheld === undefined : claim.permitted === false &&
    Array.isArray(claim.withheld) && claim.withheld.length > 0 && claim.withheld.every((item) => record(item) &&
      (item.stream === null || strings([item.stream])) && strings([item.because]))
}

function safeDocument(value: unknown, depth = 0, budget = { remaining: 50_000 }): boolean {
  if (--budget.remaining < 0 || depth > 20) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => safeDocument(item, depth + 1, budget))
  return record(value) && Object.entries(value).every(([key, item]) =>
    !['__proto__', 'prototype', 'constructor'].includes(key) && safeDocument(item, depth + 1, budget))
}

/** Both native feeds read SIGN_INS. Reuse its existing freshness ceiling;
 * retention is a storage lifetime, not evidence of current coverage. */
function freshnessReasons(run: Extract<ReadRunResult, { present: true }>, row: BatchRow, now: Date): Reason[] {
  const reasons: Reason[] = []
  const stale = (clock: Date) => now.getTime() - clock.getTime() > SERVICE_FRESHNESS_WINDOWS.incremental.agingMs
  if (stale(run.completedAt) || stale(run.windowEnd)) reasons.push('STALE_ASSESSMENT')
  for (const { stream } of run.streams) {
    if (!['GRAPH_SIGN_INS', 'M365_AUDIT_STS'].includes(stream)) {
      reasons.push('SOURCE_FRESHNESS_UNKNOWN')
      continue
    }
    const sources = run.sources.filter((source) => record(source) && source.source === stream)
    if (sources.length !== 1) {
      reasons.push('SOURCE_FRESHNESS_UNKNOWN')
      continue
    }
    const source = sources[0]
    const success = utcClock(source.lastSuccessfulCollectionAt)
    if (!success || success > run.completedAt) reasons.push('SOURCE_FRESHNESS_UNKNOWN')
    else if (stale(success)) reasons.push('STALE_ASSESSMENT')
    if (source.status === 'STALE') reasons.push('STALE_ASSESSMENT')
    else if (!['SUCCESS', 'EMPTY'].includes(source.status)) reasons.push('SOURCE_UNAVAILABLE')
  }
  // Only collector metadata is projected, never raw provider errors or identities.
  const currentSuccess = utcClock(row.collectorLastSuccessfulAt)
  if (!currentSuccess || currentSuccess > now) reasons.push('SOURCE_FRESHNESS_UNKNOWN')
  else if (stale(currentSuccess)) reasons.push('STALE_ASSESSMENT')
  if (row.collectorStatus === null || row.collectorStatus === undefined) reasons.push('SOURCE_FRESHNESS_UNKNOWN')
  else if (!['IDLE', 'RUNNING', 'SUCCEEDED'].includes(String(row.collectorStatus))) reasons.push('SOURCE_UNAVAILABLE')
  return unique(reasons)
}

/** Bounded at the SQL projection BEFORE JSON leaves PostgreSQL; never load a fleet of identities. */
export const NATIVE_SUMMARY_SQL = `WITH authorized AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS s("organizationId" uuid, id uuid)
), latest AS (
  SELECT selected.id FROM authorized s JOIN LATERAL (
    SELECT r.id FROM identity_risk_evaluation_runs r
    WHERE r.organization_id=s."organizationId" AND r.customer_tenant_id=s.id
      AND r.status=$2 AND r.engine_version=$3 AND r.expires_at>$4::timestamptz
    ORDER BY r.completed_at DESC,r.id DESC LIMIT 1
  ) selected ON true
)
SELECT r.organization_id AS "organizationId",r.customer_tenant_id AS "customerTenantId",
 ss.status::text AS "collectorStatus",
 to_char(ss.last_successful_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "collectorLastSuccessfulAt",
 to_char(r.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "completedAt",
 to_char(r.window_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "windowStart",
 to_char(r.window_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "windowEnd",
 to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt",
 (coalesce(octet_length(r.evaluation_coverage::text),0)+coalesce(octet_length(r.evaluation_findings::text),0)>$5) AS "readLimitExceeded",
 CASE WHEN coalesce(octet_length(r.evaluation_coverage::text),0)+coalesce(octet_length(r.evaluation_findings::text),0)<=$5 THEN r.evaluation_coverage ELSE NULL END AS "evaluationCoverage",
 CASE WHEN coalesce(octet_length(r.evaluation_coverage::text),0)+coalesce(octet_length(r.evaluation_findings::text),0)<=$5 THEN r.evaluation_findings ELSE NULL END AS "evaluationFindings"
FROM identity_risk_evaluation_runs r JOIN latest l ON l.id=r.id
LEFT JOIN sync_states ss ON ss.organization_id=r.organization_id AND ss.customer_tenant_id=r.customer_tenant_id
 AND ss.resource_type='SIGN_INS'`

export async function readNativeRiskSummary(client: Reader, scope: NativeSummaryScope, now: Date) {
  if (!date(now) || !Number.isSafeInteger(scope.totalTenants) || scope.totalTenants < scope.tenants.length || scope.tenants.length > NATIVE_SUMMARY_TENANT_LIMIT || new Set(scope.tenants.map((t) => t.id)).size !== scope.tenants.length) throw new Error('Invalid summary scope')
  const eligible = scope.tenants.filter((tenant) => tenant.gate === null)
  const rows = eligible.length ? await client.$queryRawUnsafe<BatchRow[]>(NATIVE_SUMMARY_SQL, JSON.stringify(eligible.map(({ id, organizationId }) => ({ id, organizationId }))), RUN_STATUS, RUN_ENGINE_VERSION, now.toISOString(), NATIVE_SUMMARY_RUN_BYTES) : []
  if (rows.length > eligible.length) throw new Error('Invalid summary read')
  const pairs = new Set(eligible.map((tenant) => `${tenant.organizationId}:${tenant.id}`))
  const byTenant = new Map<string, BatchRow>()
  for (const row of rows) {
    const key = `${row.organizationId}:${row.customerTenantId}`
    if (!pairs.has(key) || byTenant.has(key)) throw new Error('Invalid summary read')
    byTenant.set(key, row)
  }
  let assessedTenants = 0
  const tenants: TenantSummary[] = scope.tenants.map((tenant) => {
    const unavailable = (reason: Reason): TenantSummary => ({ tenantId: tenant.id, availability: 'UNAVAILABLE', accuracy: 'NOT_AVAILABLE', distinctUserCount: null, evaluatedAt: null, windowStart: null, windowEnd: null, complete: false, limitations: [reason] })
    if (tenant.gate) return unavailable(tenant.gate)
    const row = byTenant.get(`${tenant.organizationId}:${tenant.id}`)
    if (!row) return unavailable('NO_CURRENT_RUN')
    const completedAt = utcClock(row.completedAt), windowStart = utcClock(row.windowStart), windowEnd = utcClock(row.windowEnd), expiresAt = utcClock(row.expiresAt)
    if (expiresAt && expiresAt <= now) return unavailable('NO_CURRENT_RUN')
    if (row.readLimitExceeded) return unavailable('READ_LIMIT_EXCEEDED')
    if (!completedAt || !windowStart || !windowEnd || !expiresAt || windowStart > windowEnd || windowEnd > completedAt || completedAt > now) return unavailable('INVALID_RUN')
    // Defense in depth for alternate clients/tests; production SQL has already bounded transfer.
    let size: number
    try { size = Buffer.byteLength(JSON.stringify(row.evaluationCoverage)) + Buffer.byteLength(JSON.stringify(row.evaluationFindings)) } catch { return unavailable('INVALID_RUN') }
    if (size > NATIVE_SUMMARY_RUN_BYTES) return unavailable('READ_LIMIT_EXCEEDED')
    if (!safeDocument(row.evaluationCoverage) || !safeDocument(row.evaluationFindings) || !validVerdict(row.evaluationFindings)) return unavailable('INVALID_RUN')
    const run = decodeNativeRunRow({ ...row, completedAt, windowStart, windowEnd })
    if (!run.present) return unavailable('INVALID_RUN')
    const count = run.count
    if (count.accuracy !== 'NOT_AVAILABLE' && (!Number.isSafeInteger(count.value) || count.value < 0 || count.value > 1_000_000)) return unavailable('INVALID_RUN')
    assessedTenants++
    const clocks = { evaluatedAt: run.completedAt.toISOString(), windowStart: run.windowStart.toISOString(), windowEnd: run.windowEnd.toISOString() }
    const freshness = freshnessReasons(run, row, now)
    if (count.accuracy === 'NOT_AVAILABLE') return { ...unavailable('COUNT_WITHHELD'), ...clocks, limitations: unique(['COUNT_WITHHELD', ...freshness]) }
    const complete = count.accuracy === 'EXACT' && run.complete && run.claim.permitted && count.scope.notCovered.length === 0 &&
      run.streams.length > 0 && count.scope.covered.length > 0 && count.scope.evidenceRequested.length > 0
    if (complete && freshness.length === 0) return { tenantId: tenant.id, availability: 'AVAILABLE', accuracy: 'EXACT', distinctUserCount: count.value, ...clocks, complete: true, limitations: [] }
    return { tenantId: tenant.id, availability: freshness.length > 0 && count.value === 0 ? 'UNAVAILABLE' : 'PARTIAL', accuracy: count.value > 0 ? 'AT_LEAST' : 'NOT_AVAILABLE', distinctUserCount: count.value > 0 ? count.value : null, ...clocks, complete: false, limitations: unique([...freshness, ...(!complete ? ['PARTIAL_ASSESSMENT' as const] : [])]) }
  })
  const scopeComplete = tenants.length === scope.totalTenants
  const complete = scopeComplete && tenants.length > 0 && tenants.every((tenant) => tenant.complete)
  const known = tenants.reduce((sum, tenant) => sum + (tenant.distinctUserCount ?? 0), 0)
  const limitations = unique([...tenants.flatMap((tenant) => tenant.limitations), ...(!scopeComplete ? ['SCOPE_CAPPED' as const] : []), ...(scope.totalTenants === 0 ? ['NO_TENANTS' as const] : [])])
  return { contractVersion: 'hawkview-native-risk-summary/v1' as const, source: 'HAWKVIEW_NATIVE_ASSESSMENT' as const, countUnit: 'TENANT_USER_IDENTITIES' as const, generatedAt: now.toISOString(),
    fleet: { availability: (complete ? 'AVAILABLE' : known > 0 ? 'PARTIAL' : 'UNAVAILABLE') as Availability, accuracy: (complete ? 'EXACT' : known > 0 ? 'AT_LEAST' : 'NOT_AVAILABLE') as Accuracy, distinctUserCount: complete || known > 0 ? known : null, assessedTenants, totalTenants: scope.totalTenants, enumeratedTenants: tenants.length, scopeComplete, limitations }, tenants }
}
