/**
 * Tenant-scoped audit-evidence reader and completeness policy.
 *
 * TWO LIMITS THE CALLER OWNS, recorded here because neither is detectable from
 * inside this module:
 *
 *   1. `asOf` is supplied, never acquired — this component deliberately holds no
 *      clock, so the existing caller keeps deciding the assessment time. A value
 *      far in the FUTURE would make `expires_at > asOf` exclude every stored
 *      row, and every tenant would then read as a complete empty window. That is
 *      indistinguishable here from a genuinely quiet fleet, so the caller must
 *      not pass an unvalidated or clock-skewed time.
 *   2. CAPPED rests on the store delivering the sentinel row, and a complete
 *      empty read rests on "no rows returned" meaning "no rows exist". A store
 *      that silently applies its OWN narrower window — tail truncation, or the
 *      current workspace-wide `take: 500` — cannot be detected from the result,
 *      and would read as COMPLETE. Only the statement this module builds carries
 *      the per-tenant cap, which is why the statement shape is asserted
 *      directly and why registered database verification remains a follow-up.
 *
 * INACTIVE. Nothing in the application imports this module. It prepares the
 * bounded tenant-evidence contract so the live mapper, list, verification and
 * history wiring can be changed later, under their own review. It performs no
 * history write, no current-pointer publication, no generation promotion, no
 * recovery and no provider call, and it changes no runtime, permission, quota
 * or cadence setting.
 *
 * WHY IT EXISTS. `tenants.service.ts` reads audit evidence with a single
 * workspace-wide `take: 500` ordered only by `eventDateTime desc`, across every
 * authorized tenant at once. Three consequences follow, and this module is
 * written to not reproduce any of them:
 *
 *   1. One noisy tenant's newest 500 events can consume the whole window, so a
 *      quieter tenant's older adverse event is never read. Here each tenant has
 *      its OWN cap.
 *   2. A tenant omitted from the result is indistinguishable from a tenant with
 *      no events: `mapTenant` defaults the array to `[]`. Here every requested
 *      scope is preserved in the result, and "no rows" is reported as a
 *      genuinely complete empty read, separately from a read that did not
 *      happen.
 *   3. Nothing downstream records whether the read was complete, capped or
 *      unread, so an incomplete read can support a clean assessment. Here the
 *      status is explicit and the policy below refuses to call an incomplete
 *      read complete.
 *
 * AUTHORIZATION. This helper does not grant, widen or re-derive authorization.
 * It accepts exact `(organizationId, customerTenantId)` pairs that the caller
 * has ALREADY authorized, and it matches on both columns together. A single
 * tenant id is never widened across organizations, and a returned row whose
 * pair was not requested is refused rather than trusted.
 *
 * WHAT "COMPLETE" DOES NOT MEAN. It means only that this persisted audit window
 * was read for that tenant without reaching its cap and without any value being
 * withheld. It is not source-version coherence, not provider-side completeness,
 * not authority admission, and not permission to assert that a tenant is
 * healthy.
 */

/** The existing event lower bound, unchanged: `tenants.service.ts` filters
 *  `eventDateTime >= asOf - 24h`. Event recency and saved retention remain two
 *  independent rules evaluated against ONE captured assessment time. */
export const AUDIT_EVIDENCE_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000

/** Each tenant gets its own window of the same size the shared read used. */
export const AUDIT_EVIDENCE_TENANT_CAP = 500
/** Read one more than the cap. The (cap + 1)th row is a SENTINEL: it is never
 *  returned as an observation, it only establishes that more qualifying events
 *  exist than the cap admits. */
export const AUDIT_EVIDENCE_SENTINEL_ROWS = AUDIT_EVIDENCE_TENANT_CAP + 1

/** At most this many exact scopes in one batch, one parameterized read each. */
export const AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH = 16

/**
 * TRANSFER BOUNDS, and exactly what they are.
 *
 * Rows and concurrency are not a byte bound. `initiatedBy` and
 * `targetResources` are `JsonB` with no column-level size limit, so a row count
 * alone leaves the transferred volume unbounded. These two fields are the only
 * unbounded values in the projection: every other selected column is
 * length-limited by its own type (`microsoft_audit_id` VarChar(200),
 * `activity_display_name` VarChar(500), `category` and `operation_type`
 * VarChar(100), `result` VarChar(50), two uuids and one timestamptz). The
 * unbounded `raw`, `additional_details` and `result_reason` columns are
 * deliberately NOT selected.
 *
 * Both bounds below are enforced INSIDE the parameterized projection, so an
 * oversized value is never sent to the driver at all:
 *
 *   - per field, per event: a value longer than the field cap is replaced by
 *     NULL in the projection and reported as withheld by its own flag. The
 *     oversize value's true size is deliberately NOT returned: it is not needed
 *     to classify the read, and projecting it would be one more number derived
 *     from data this component is trying not to transfer;
 *   - per tenant, per batch: a running total of the capped payload sizes, in
 *     the same deterministic order as the cap itself, withholds the payloads of
 *     every event past the tenant's payload budget while still returning that
 *     event's bounded fixed fields.
 *
 * Withholding, not dropping, is what keeps the second failure mode above
 * closed: a tenant whose very first event is oversized still returns rows, so
 * it can never be mistaken for a complete empty read.
 *
 * WHY THERE IS NO SHARED PER-BATCH BUDGET. The aggregate is bounded by
 * construction — scope count x per-tenant budget — and deliberately not by a
 * single budget shared across the batch. A shared budget would let one tenant's
 * payload volume withhold another tenant's evidence, which is the very
 * cross-tenant interference this component exists to remove; it would only move
 * the starvation bug from rows into bytes. The aggregate is reduced instead by
 * lowering the scope count or the per-tenant budget, both of which keep each
 * tenant's share independent.
 *
 * DERIVED WORST CASE for one full batch, as arithmetic and not a measurement:
 *
 *   payload   16 x (262144 + 2 x 4096)            =  4,325,376 bytes
 *   fixed     16 x 501 x 4096                     = 32,833,536 bytes
 *   total                                         = 37,158,912 bytes (~35.4 MiB)
 *
 * The payload term's `2 x 4096` is slack for the single event that may straddle
 * the budget. The fixed term dominates, and it is governed by the row cap, which
 * is fixed by the existing 500-event window rather than chosen here.
 *
 * That worst case assumes every VarChar column is full of 4-byte characters in
 * every one of 8,016 rows. For ASCII content the same batch is about 12.8 MiB.
 * Both figures are ceilings computed from column widths; neither is an observed
 * transfer size.
 *
 * These are conservative implementation limits chosen for an inactive
 * component. They are NOT a measured production capacity budget: they say
 * nothing about server-side work, query plans, peak resident memory, connection
 * count, latency or fleet cost, and they bound the result set transferred to
 * the client, not the work the database does to produce it. A size check
 * written in JavaScript after the driver has already allocated the value could
 * not establish even this much, which is why both checks are in the SQL.
 */
export const AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES = 4096
export const AUDIT_EVIDENCE_MAX_TENANT_PAYLOAD_BYTES = 262144
/**
 * Upper bound on one event's non-payload columns, in BYTES.
 *
 * `varchar(n)` limits CHARACTERS, not octets, so the byte ceiling is four times
 * the declared width for UTF-8. From `schema.prisma` and this projection:
 *
 *   microsoft_audit_id      varchar(200)  ->  800
 *   activity_display_name   varchar(500)  -> 2000
 *   category                varchar(100)  ->  400
 *   operation_type          varchar(100)  ->  400
 *   result                  varchar(50)   ->  200
 *   two uuids as text                     ->   72
 *   event_date_time as text               ->   32
 *   row_position (bigint as text)         ->   20
 *   four booleans                         ->   20
 *   per-column framing, 13 columns        ->   52
 *                                            ----
 *                                            3996
 *
 * Rounded up to the next power of two. An earlier value of 1024 was wrong: it
 * was below even the pure-ASCII sum of the declared widths.
 */
export const AUDIT_EVIDENCE_FIXED_FIELD_CEILING_BYTES = 4096
/** The declared VarChar widths this ceiling is derived from, so a test can
 *  recompute it from the schema instead of from the constant itself. */
export const AUDIT_EVIDENCE_PROJECTED_VARCHAR_WIDTHS: readonly number[] =
  Object.freeze([200, 500, 100, 100, 50])

/** Derived, not measured. See the note above. */
export const auditEvidenceBatchByteCeiling = (scopes: number): number =>
  scopes * (AUDIT_EVIDENCE_MAX_TENANT_PAYLOAD_BYTES + 2 * AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES) +
  scopes * AUDIT_EVIDENCE_SENTINEL_ROWS * AUDIT_EVIDENCE_FIXED_FIELD_CEILING_BYTES

export type AuditEvidenceScope = {
  readonly organizationId: string
  readonly customerTenantId: string
}

/** COMPLETE: this window was read for this tenant without reaching its cap and
 *  with nothing withheld. CAPPED: more qualifying events exist than the cap.
 *  UNREAD: the read did not produce trustworthy complete evidence. CAPPED and
 *  UNREAD are both "unknown" to the policy below; they are kept distinct
 *  because they call for different follow-up. */
export type AuditEvidenceStatus = 'COMPLETE' | 'CAPPED' | 'UNREAD'

/** Fixed vocabulary. A reason code never carries a source exception body, a
 *  database error, SQL text, a credential or an event payload. */
export type AuditEvidenceReason =
  | 'OK'
  | 'TENANT_EVENT_CAP_REACHED'
  | 'PAYLOAD_FIELD_OVERSIZE'
  | 'PAYLOAD_BYTES_WITHHELD'
  | 'READ_FAILED'
  | 'SCOPE_MISMATCH'
  | 'ROW_VALIDATION_FAILED'

const UNREAD_REASONS: ReadonlySet<AuditEvidenceReason> = new Set<AuditEvidenceReason>([
  'PAYLOAD_FIELD_OVERSIZE', 'PAYLOAD_BYTES_WITHHELD', 'READ_FAILED',
  'SCOPE_MISMATCH', 'ROW_VALIDATION_FAILED',
])

/**
 * One observation. `initiatedBy` and `targetResources` are `null` when the
 * value was withheld at the read boundary; `payloadWithheld` says so
 * explicitly, so a consumer can never read a withheld payload as an absent one.
 * That distinction matters because `tenant-health.ts` derives adverse findings
 * from `targetResources`.
 */
export type AuditEvidenceObservation = {
  readonly microsoftAuditId: string
  readonly eventDateTime: Date
  readonly activityDisplayName: string
  readonly category: string | null
  readonly operationType: string | null
  readonly result: string | null
  readonly initiatedBy: unknown
  readonly targetResources: unknown
  readonly payloadWithheld: boolean
}

export type AuditEvidenceForTenant = {
  readonly scope: AuditEvidenceScope
  readonly status: AuditEvidenceStatus
  readonly reason: AuditEvidenceReason
  /** At most `AUDIT_EVIDENCE_TENANT_CAP`, newest first, deterministically
   *  ordered. A possibly-incomplete subset unless `status` is COMPLETE. */
  readonly observations: readonly AuditEvidenceObservation[]
  /** True when the sentinel row was seen. */
  readonly capReached: boolean
  /** Count of returned observations whose payload was withheld. */
  readonly withheldPayloads: number
}

export type AuditEvidenceBatch = {
  /** One entry per REQUESTED scope, in the order requested. */
  readonly tenants: readonly AuditEvidenceForTenant[]
  readonly asOf: Date
}

/** The parameterized statement this module would issue. Exposed so a test can
 *  assert the actual query shape: a fake adapter's ordering cannot establish
 *  SQL semantics. */
export type AuditEvidenceQuery = {
  readonly sql: string
  readonly params: readonly unknown[]
}

/** The storage boundary. Deliberately the shape of a parameterized raw read, so
 *  the statement and its bound values are the contract rather than an ORM
 *  builder's private behaviour. */
export interface AuditEvidenceStore {
  query(sql: string, params: readonly unknown[]): Promise<readonly unknown[]>
}

export type AuditEvidenceReadMetrics = {
  /** Number of storage calls made. */
  reads: number
  /** Storage calls currently in flight through this metrics object. */
  activeReads: number
  /** Highest number of storage calls ever in flight at once. A sequential
   *  traversal keeps this at 1; it rises if a caller runs batches
   *  concurrently, which is how the instrument is shown not to be a
   *  constant. */
  peakActiveReads: number
}

/** A fresh counter set. */
export const newAuditEvidenceReadMetrics = (): AuditEvidenceReadMetrics =>
  ({ reads: 0, activeReads: 0, peakActiveReads: 0 })

export class AuditEvidenceRequestError extends Error {
  constructor(readonly code:
    'BATCH_TOO_LARGE' | 'EMPTY_BATCH' | 'INVALID_SCOPE' | 'INVALID_AS_OF' | 'DUPLICATE_SCOPE') {
    super(code)
    this.name = 'AuditEvidenceRequestError'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const scopeKey = (scope: AuditEvidenceScope) =>
  `${scope.organizationId.toLowerCase()}\u0000${scope.customerTenantId.toLowerCase()}`

/**
 * Validate the request BEFORE any storage access, so an oversized or malformed
 * batch cannot reach the database at all, and an empty batch issues no query.
 */
function assertRequest(
  scopes: readonly AuditEvidenceScope[],
  asOf: Date,
  enforceBatchSize = true,
): void {
  if (!(asOf instanceof Date) || !Number.isFinite(asOf.getTime())) {
    throw new AuditEvidenceRequestError('INVALID_AS_OF')
  }
  if (scopes.length === 0) throw new AuditEvidenceRequestError('EMPTY_BATCH')
  if (enforceBatchSize && scopes.length > AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH) {
    throw new AuditEvidenceRequestError('BATCH_TOO_LARGE')
  }
  const seen = new Set<string>()
  for (const scope of scopes) {
    if (typeof scope?.organizationId !== 'string' || typeof scope?.customerTenantId !== 'string' ||
      !UUID.test(scope.organizationId) || !UUID.test(scope.customerTenantId)) {
      throw new AuditEvidenceRequestError('INVALID_SCOPE')
    }
    const key = scopeKey(scope)
    if (seen.has(key)) throw new AuditEvidenceRequestError('DUPLICATE_SCOPE')
    seen.add(key)
  }
}

/**
 * Build the single parameterized read for one batch.
 *
 * Every value is a bound parameter. The only text assembled from the request is
 * the fixed number of `($n::uuid, $n::uuid)` placeholder pairs, generated from
 * the already-validated scope COUNT: no identifier, table name, column name or
 * value is ever interpolated into the statement.
 *
 * Both scope columns are matched together, so one tenant id cannot match in
 * another organization. Order is `event_date_time DESC, microsoft_audit_id
 * DESC`; `(customer_tenant_id, microsoft_audit_id)` is unique, so that
 * tie-breaker is stable and total, and tied timestamps cannot reorder between
 * reads. The row-number window gives each tenant its own cap independently of
 * every other tenant in the batch.
 */
export function buildAuditEvidenceQuery(
  scopes: readonly AuditEvidenceScope[],
  asOf: Date,
): AuditEvidenceQuery {
  assertRequest(scopes, asOf)
  const params: unknown[] = [
    AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES,
    new Date(asOf.getTime() - AUDIT_EVIDENCE_EVENT_WINDOW_MS),
    asOf,
    AUDIT_EVIDENCE_SENTINEL_ROWS,
    AUDIT_EVIDENCE_MAX_TENANT_PAYLOAD_BYTES,
  ]
  const pairs = scopes.map((scope) => {
    params.push(scope.organizationId, scope.customerTenantId)
    return `($${params.length - 1}::uuid, $${params.length}::uuid)`
  })
  const sql = `
    WITH scoped AS (
      SELECT
        organization_id,
        customer_tenant_id,
        microsoft_audit_id,
        event_date_time,
        activity_display_name,
        category,
        operation_type,
        result,
        octet_length(coalesce(initiated_by::text, '')) AS initiated_by_bytes,
        octet_length(coalesce(target_resources::text, '')) AS target_resources_bytes,
        CASE WHEN octet_length(coalesce(initiated_by::text, '')) <= $1
          THEN initiated_by::text END AS initiated_by_text,
        CASE WHEN octet_length(coalesce(target_resources::text, '')) <= $1
          THEN target_resources::text END AS target_resources_text
      FROM directory_audit_logs
      WHERE (organization_id, customer_tenant_id) IN (${pairs.join(', ')})
        AND event_date_time >= $2
        AND expires_at > $3
    ),
    ranked AS (
      SELECT
        scoped.*,
        row_number() OVER tenant_window AS row_position,
        sum(least(initiated_by_bytes, $1) + least(target_resources_bytes, $1))
          OVER (tenant_window ROWS UNBOUNDED PRECEDING) AS running_payload_bytes
      FROM scoped
      WINDOW tenant_window AS (
        PARTITION BY customer_tenant_id
        ORDER BY event_date_time DESC, microsoft_audit_id DESC
      )
    )
    SELECT
      organization_id,
      customer_tenant_id,
      microsoft_audit_id,
      event_date_time,
      activity_display_name,
      category,
      operation_type,
      result,
      row_position,
      (initiated_by_bytes > $1 OR target_resources_bytes > $1) AS field_oversize,
      (running_payload_bytes > $5) AS over_payload_budget,
      -- Withholding is reported EXPLICITLY rather than inferred from a NULL
      -- value. Both columns are nullable, so a NULL text can mean the event
      -- genuinely has no payload; only these flags mean it was not sent.
      (initiated_by_bytes > $1 OR running_payload_bytes > $5) AS initiated_by_withheld,
      (target_resources_bytes > $1 OR running_payload_bytes > $5) AS target_resources_withheld,
      CASE WHEN initiated_by_bytes > $1 OR running_payload_bytes > $5
        THEN NULL ELSE initiated_by_text END AS initiated_by_text,
      CASE WHEN target_resources_bytes > $1 OR running_payload_bytes > $5
        THEN NULL ELSE target_resources_text END AS target_resources_text
    FROM ranked
    WHERE row_position <= $4
    ORDER BY customer_tenant_id ASC, event_date_time DESC, microsoft_audit_id DESC
  `
  return { sql, params }
}

type RawRow = {
  organization_id: unknown
  customer_tenant_id: unknown
  microsoft_audit_id: unknown
  event_date_time: unknown
  activity_display_name: unknown
  category: unknown
  operation_type: unknown
  result: unknown
  row_position: unknown
  field_oversize: unknown
  over_payload_budget: unknown
  initiated_by_withheld: unknown
  target_resources_withheld: unknown
  initiated_by_text: unknown
  target_resources_text: unknown
}

/**
 * `row_number()` is a Postgres `bigint`, and adapters render int8 differently:
 * Prisma's raw queries give a JS `BigInt`, while a node-postgres-shaped store
 * gives a decimal STRING by default. Accept all three renderings, and reject
 * anything else — including a float, a negative, or a value outside the
 * sentinel range.
 */
const asPosition = (value: unknown): number | null => {
  let numeric: number
  if (typeof value === 'bigint') numeric = Number(value)
  else if (typeof value === 'number') numeric = value
  else if (typeof value === 'string' && /^[0-9]{1,6}$/.test(value)) numeric = Number(value)
  else return null
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > AUDIT_EVIDENCE_SENTINEL_ROWS) return null
  return numeric
}

/**
 * Booleans must FAIL CLOSED. These four projected flags are the only thing
 * separating "withheld" from "genuinely absent", and adapters render `bool` as
 * a JS boolean, as 't'/'f', or as 1/0. A bare `=== true` would read every
 * unrecognized rendering as "nothing was withheld" — the one direction this
 * component exists to prevent — so an unrecognized value returns null and the
 * caller turns the batch into ROW_VALIDATION_FAILED rather than guessing.
 */
const asBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value
  if (value === 't' || value === 'true' || value === 1 || value === '1') return true
  if (value === 'f' || value === 'false' || value === 0 || value === '0') return false
  return null
}

const asText = (value: unknown): string | null =>
  typeof value === 'string' ? value : null

/**
 * Withholding is read from the projection's explicit flag, never inferred from
 * a NULL value: `initiated_by` and `target_resources` are both nullable, so an
 * event may genuinely have no payload, and treating that as withheld would make
 * an ordinary complete read look incomplete.
 *
 * Parsing is best-effort. A parse failure is treated as withheld rather than
 * thrown, so malformed stored JSON can turn neither into a complete read nor
 * into an exception out of this reader.
 */
function parsePayload(value: unknown, withheld: boolean): { value: unknown; withheld: boolean } {
  if (withheld) return { value: null, withheld: true }
  if (value === null || value === undefined) return { value: null, withheld: false }
  if (typeof value !== 'string') return { value: null, withheld: true }
  try { return { value: JSON.parse(value) as unknown, withheld: false } }
  catch { return { value: null, withheld: true } }
}

/** Results hold a COPY of the scope. The caller's object is never retained: a
 *  consumer that reused one scope object across reads would otherwise find an
 *  earlier result's `scope` relabelled onto a later tenant's observations. */
const copyScope = (scope: AuditEvidenceScope): AuditEvidenceScope =>
  Object.freeze({ organizationId: scope.organizationId, customerTenantId: scope.customerTenantId })

function unread(scope: AuditEvidenceScope, reason: AuditEvidenceReason): AuditEvidenceForTenant {
  return {
    scope: copyScope(scope), status: 'UNREAD', reason,
    observations: Object.freeze([]), capReached: false, withheldPayloads: 0,
  }
}

/**
 * Read one bounded batch. At most `AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH` exact
 * scopes, exactly one storage call, and one assessment time shared by the event
 * window and the expiry rule for every scope in the batch.
 *
 * A storage failure, a row that fails validation, or a returned scope that was
 * not requested makes the affected scopes UNREAD. None of those can produce a
 * synthesized complete empty result, and no source exception body, database
 * error text or credential reaches the returned value.
 */
export async function readTenantAuditEvidenceBatch(
  store: AuditEvidenceStore,
  scopes: readonly AuditEvidenceScope[],
  asOf: Date,
  metrics?: AuditEvidenceReadMetrics,
): Promise<AuditEvidenceBatch> {
  // Snapshot BOTH inputs before any await. `asOf` is the caller's Date and
  // `scopes` the caller's array: a caller that mutated either during the
  // in-flight read could otherwise shift the window between pages, or make a
  // scope that was never validated, never bound and never read appear in the
  // result as a complete empty one.
  const frozenAsOf = new Date(asOf.getTime())
  const requestedScopes: readonly AuditEvidenceScope[] = scopes.map((scope) => ({
    organizationId: scope?.organizationId, customerTenantId: scope?.customerTenantId,
  }))
  const query = buildAuditEvidenceQuery(requestedScopes, frozenAsOf)

  let rows: readonly unknown[]
  if (metrics) {
    metrics.reads += 1
    metrics.activeReads += 1
    metrics.peakActiveReads = Math.max(metrics.peakActiveReads, metrics.activeReads)
  }
  try {
    rows = await store.query(query.sql, query.params)
  } catch {
    // The caught value is deliberately never read, inspected or forwarded.
    return { asOf: frozenAsOf, tenants: requestedScopes.map((scope) => unread(scope, 'READ_FAILED')) }
  } finally {
    if (metrics) metrics.activeReads -= 1
  }
  if (!Array.isArray(rows)) {
    return { asOf: frozenAsOf, tenants: requestedScopes.map((scope) => unread(scope, 'ROW_VALIDATION_FAILED')) }
  }

  const requested = new Map(requestedScopes.map((scope) => [scopeKey(scope), scope]))
  const collected = new Map<string, {
    rows: Array<{ position: number; observation: AuditEvidenceObservation }>
    capReached: boolean
    withheld: number
    fieldOversize: boolean
    budgetExceeded: boolean
    positions: Set<number>
    maxPosition: number
  }>()
  const rowValidationFailed = (): AuditEvidenceBatch => ({
    asOf: frozenAsOf,
    tenants: requestedScopes.map((scope) => unread(scope, 'ROW_VALIDATION_FAILED')),
  })

  try {
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') {
      return { asOf: frozenAsOf, tenants: requestedScopes.map((scope) => unread(scope, 'ROW_VALIDATION_FAILED')) }
    }
    const candidate = raw as RawRow
    const organizationId = candidate.organization_id
    const customerTenantId = candidate.customer_tenant_id
    if (typeof organizationId !== 'string' || typeof customerTenantId !== 'string') {
      return { asOf: frozenAsOf, tenants: requestedScopes.map((scope) => unread(scope, 'ROW_VALIDATION_FAILED')) }
    }
    const key = scopeKey({ organizationId, customerTenantId })
    // A row for a pair that was not requested means the statement or the
    // adapter did not honour the scope filter. Refuse the whole batch rather
    // than silently keeping the rows that happen to match.
    if (!requested.has(key)) {
      return { asOf: frozenAsOf, tenants: requestedScopes.map((scope) => unread(scope, 'SCOPE_MISMATCH')) }
    }
    const position = asPosition(candidate.row_position)
    const eventDateTime = candidate.event_date_time
    const activityDisplayName = candidate.activity_display_name
    const microsoftAuditId = candidate.microsoft_audit_id
    if (position === null || typeof microsoftAuditId !== 'string' ||
      typeof activityDisplayName !== 'string' || !(eventDateTime instanceof Date) ||
      !Number.isFinite(eventDateTime.getTime())) {
      return { asOf: frozenAsOf, tenants: requestedScopes.map((scope) => unread(scope, 'ROW_VALIDATION_FAILED')) }
    }
    for (const optional of [candidate.category, candidate.operation_type, candidate.result]) {
      if (!(optional === null || optional === undefined || typeof optional === 'string')) {
        return { asOf: frozenAsOf, tenants: requestedScopes.map((scope) => unread(scope, 'ROW_VALIDATION_FAILED')) }
      }
    }

    // Every projected boolean is coerced fail-closed. An unrecognized rendering
    // is a validation failure, never a silent "nothing was withheld".
    const fieldOversize = asBoolean(candidate.field_oversize)
    const overBudget = asBoolean(candidate.over_payload_budget)
    const initiatedWithheld = asBoolean(candidate.initiated_by_withheld)
    const targetWithheld = asBoolean(candidate.target_resources_withheld)
    if (fieldOversize === null || overBudget === null ||
      initiatedWithheld === null || targetWithheld === null) {
      return rowValidationFailed()
    }

    const bucket = collected.get(key) ?? {
      rows: [], capReached: false, withheld: 0,
      fieldOversize: false, budgetExceeded: false,
      positions: new Set<number>(), maxPosition: 0,
    }
    collected.set(key, bucket)
    // A repeated row position for one tenant means the window did not produce a
    // total order. Refuse rather than guess which row is real.
    if (bucket.positions.has(position)) return rowValidationFailed()
    bucket.positions.add(position)
    bucket.maxPosition = Math.max(bucket.maxPosition, position)

    // The sentinel is never an observation: it only proves the cap was reached.
    // Its own flags are deliberately NOT absorbed, because nothing of it is
    // returned, so no evidence is withheld from the caller on its account.
    if (position === AUDIT_EVIDENCE_SENTINEL_ROWS) { bucket.capReached = true; continue }

    if (fieldOversize) bucket.fieldOversize = true
    if (overBudget) bucket.budgetExceeded = true
    const initiated = parsePayload(candidate.initiated_by_text, initiatedWithheld)
    const target = parsePayload(candidate.target_resources_text, targetWithheld)
    const payloadWithheld = initiated.withheld || target.withheld
    if (payloadWithheld) bucket.withheld += 1
    bucket.rows.push({
      position,
      observation: {
        microsoftAuditId,
        eventDateTime: new Date(eventDateTime.getTime()),
        activityDisplayName,
        category: asText(candidate.category),
        operationType: asText(candidate.operation_type),
        result: asText(candidate.result),
        initiatedBy: initiated.value,
        targetResources: target.value,
        payloadWithheld,
      },
    })
  }
  } catch {
    // A returned row can be a driver object with lazily decoding accessors, a
    // Proxy, or anything else, so reading a property may throw. That must
    // become UNREAD like any other validation failure, never an exception out
    // of this reader carrying a raw driver message.
    return rowValidationFailed()
  }

  const tenants = requestedScopes.map((scope): AuditEvidenceForTenant => {
    const bucket = collected.get(scopeKey(scope))
    // No rows for a requested scope is a genuinely complete empty read. It is
    // reachable only here, never from a failure, a mismatch or a withheld
    // value, each of which returns UNREAD above or below.
    if (!bucket) {
      return {
        scope: copyScope(scope), status: 'COMPLETE', reason: 'OK',
        observations: Object.freeze([]), capReached: false, withheldPayloads: 0,
      }
    }
    if (bucket.rows.length > AUDIT_EVIDENCE_TENANT_CAP) {
      return unread(scope, 'ROW_VALIDATION_FAILED')
    }
    // `row_number()` is dense from 1 within a partition, so the positions for a
    // tenant must be exactly {1..max}. Duplicates were already refused, so a
    // count below the maximum means rows went missing in transit — which would
    // otherwise read as a smaller, COMPLETE window.
    if (bucket.positions.size !== bucket.maxPosition) {
      return unread(scope, 'ROW_VALIDATION_FAILED')
    }
    // Order is ours, taken from the validated positions, not from the order the
    // store happened to deliver.
    const base = {
      scope: copyScope(scope),
      observations: Object.freeze(
        [...bucket.rows].sort((left, right) => left.position - right.position)
          .map((entry) => entry.observation)) as readonly AuditEvidenceObservation[],
      capReached: bucket.capReached,
      withheldPayloads: bucket.withheld,
    }
    // Precedence: a withheld value is reported ahead of the cap, because a cap
    // says "there are more" while a withheld value says "what you have is not
    // what is stored". Both are unknown to the policy; neither is COMPLETE.
    if (bucket.fieldOversize) return { ...base, status: 'UNREAD', reason: 'PAYLOAD_FIELD_OVERSIZE' }
    if (bucket.budgetExceeded || bucket.withheld > 0) {
      return { ...base, status: 'UNREAD', reason: 'PAYLOAD_BYTES_WITHHELD' }
    }
    if (bucket.capReached) return { ...base, status: 'CAPPED', reason: 'TENANT_EVENT_CAP_REACHED' }
    return { ...base, status: 'COMPLETE', reason: 'OK' }
  })

  return { asOf: frozenAsOf, tenants }
}

/**
 * Traverse an arbitrary number of scopes as bounded sequential pages.
 *
 * One page is in flight at a time and each page is yielded before the next read
 * begins, so the consumer can process and release it. This generator keeps no
 * reference to a page it has already yielded: it never accumulates the fleet's
 * raw events, and there is no per-tenant `Promise.all`. The caller's own
 * assessment time is threaded unchanged, so every page in a traversal shares
 * one `asOf`.
 *
 * It yields an entry for every scope, including scopes whose page failed, so a
 * partial traversal cannot be mistaken for a smaller fleet.
 *
 * The WHOLE scope list is validated once, before the first page, and the list
 * and the assessment time are both snapshotted. Validating per page would let a
 * malformed scope in the middle of a long list throw after earlier pages had
 * already been yielded — leaving the consumer with a short result and no entry
 * for the remaining scopes — and would let a duplicate that straddles a page
 * boundary through, which a per-batch check refuses inside one page.
 */
export async function* readTenantAuditEvidencePages(
  store: AuditEvidenceStore,
  scopes: readonly AuditEvidenceScope[],
  asOf: Date,
  metrics?: AuditEvidenceReadMetrics,
  pageSize: number = AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH,
): AsyncGenerator<AuditEvidenceBatch, void, undefined> {
  const frozenAsOf = new Date(asOf instanceof Date ? asOf.getTime() : Number.NaN)
  const allScopes: readonly AuditEvidenceScope[] = Array.from(scopes ?? [], (scope) => ({
    organizationId: scope?.organizationId, customerTenantId: scope?.customerTenantId,
  }))
  assertRequest(allScopes, frozenAsOf, false)
  const size = auditEvidencePageSize(pageSize)
  for (let offset = 0; offset < allScopes.length; offset += size) {
    yield await readTenantAuditEvidenceBatch(
      store, allScopes.slice(offset, offset + size), frozenAsOf, metrics)
  }
}

/** Clamp a requested page size into range. A non-finite value falls back to the
 *  default rather than propagating NaN through `Math.max`/`Math.min`, which
 *  would otherwise turn a whole traversal into an EMPTY_BATCH rejection
 *  reporting that a non-empty input was empty. */
export const auditEvidencePageSize = (
  pageSize: number = AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH,
): number => {
  const requested = Math.trunc(pageSize)
  if (!Number.isFinite(requested)) return AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH
  return Math.max(1, Math.min(AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH, requested))
}

/** Pages needed to traverse `count` scopes. 1,001 scopes at 16 per page is 63. */
export const auditEvidencePageCount = (
  count: number,
  pageSize: number = AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH,
): number => Number.isFinite(count) ? Math.ceil(Math.max(0, Math.trunc(count)) / auditEvidencePageSize(pageSize)) : 0

/**
 * The completeness policy, kept separate from the reader.
 *
 * `auditWindowComplete` is true only for a COMPLETE read. CAPPED and UNREAD are
 * both represented as unknown, and unknown never authorizes a clean audit
 * assessment. Adverse findings already observed are carried through unchanged:
 * an incomplete read must not erase what was seen, and must not be read as
 * evidence that nothing adverse exists.
 */
export type AuditEvidenceAssessment = {
  readonly status: AuditEvidenceStatus
  readonly reason: AuditEvidenceReason
  /** Only a COMPLETE read sets this. */
  readonly auditWindowComplete: boolean
  /** CAPPED and UNREAD are both unknown. */
  readonly auditWindowUnknown: boolean
  /** A COMPLETE read with nothing adverse observed. Never true for CAPPED or
   *  UNREAD, and never true while an adverse finding survives. This is a
   *  necessary condition for a clean audit assessment, not permission to assert
   *  that a tenant is healthy overall. */
  readonly auditAssessmentClean: boolean
  /** Preserved as given, for every status. */
  readonly adverseFindings: readonly string[]
  readonly observedCount: number
  readonly withheldPayloads: number
}

export function assessTenantAuditEvidence(
  evidence: AuditEvidenceForTenant,
  observedAdverseFindings: readonly string[] = [],
): AuditEvidenceAssessment {
  const complete = evidence.status === 'COMPLETE'
  const adverseFindings = [...observedAdverseFindings]
  return {
    status: evidence.status,
    reason: evidence.reason,
    auditWindowComplete: complete,
    auditWindowUnknown: !complete,
    auditAssessmentClean: complete && adverseFindings.length === 0 && evidence.withheldPayloads === 0,
    adverseFindings,
    observedCount: evidence.observations.length,
    withheldPayloads: evidence.withheldPayloads,
  }
}

/** True only when `status` is one that leaves the window unknown. Exported so a
 *  consumer cannot re-derive the set incorrectly. */
export const auditEvidenceStatusIsUnknown = (status: AuditEvidenceStatus): boolean =>
  status !== 'COMPLETE'

/** True when the reason belongs to the UNREAD vocabulary. */
export const auditEvidenceReasonIsUnread = (reason: AuditEvidenceReason): boolean =>
  UNREAD_REASONS.has(reason)
