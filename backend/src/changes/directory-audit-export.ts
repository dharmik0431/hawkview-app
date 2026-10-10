/** Bounded download of the STORED, REDACTED directory-audit records.
 *
 * This is deliberately not "raw Microsoft logs". What the database holds is a
 * redacted, structure-preserving copy of the parsed Microsoft JSON — never wire
 * bytes — and this export carries a declared subset of that. The envelope says
 * so, because the file outlives the screen that could have explained it.
 *
 * Two independent ceilings, both of which refuse rather than truncate:
 *   - a conservative READ budget over the exact selected row representation,
 *     enforced inside PostgreSQL before any payload or classification value
 *     crosses into this process;
 *   - the exact serialized ENVELOPE ceiling, measured here before sending.
 */
import { BadRequestException, ConflictException } from '@nestjs/common'

export const DIRECTORY_AUDIT_EXPORT_VERSION = 'directory-audit-stored-export/v1'
export const DIRECTORY_AUDIT_EXPORT_QUALIFICATION = 'stored-redacted-directory-audit'
export const DIRECTORY_AUDIT_EXPORT_TOO_LARGE = 'DIRECTORY_AUDIT_EXPORT_TOO_LARGE'

/** A candidate/read cap applied BEFORE classification. It is not a quota of
 *  eligible rows: capping candidates and then reporting overflow about eligible
 *  rows would silently omit older eligible records. */
export const DIRECTORY_AUDIT_EXPORT_CANDIDATE_CAP = 500
export const DIRECTORY_AUDIT_EXPORT_READ_BUDGET_BYTES = 1_000_000
export const DIRECTORY_AUDIT_EXPORT_ENVELOPE_BYTES = 1_000_000

export type DirectoryAuditExportRefusal =
  | 'CANDIDATE_CAP_EXCEEDED'
  | 'READ_BUDGET_EXCEEDED'
  | 'ENVELOPE_CEILING_EXCEEDED'

/** Half-open `[since, until)`. Absolute UTC millisecond instants, or unbounded. */
export type DirectoryAuditExportWindow = {
  readonly since: string | null
  readonly until: string | null
}

export const UNBOUNDED_WINDOW: DirectoryAuditExportWindow = { since: null, until: null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Date, time, optional 1-3 fractional digits, and an explicit UTC designator or
 *  numeric offset. Date-only and offsetless input do not match, and four or more
 *  fractional digits do not match either — they are refused, never rounded. */
const SUPPORTED_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/
const OVER_PRECISE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{4,}(?:Z|[+-]\d{2}:\d{2})$/

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const leap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

const reject = (message: string): never => {
  throw new BadRequestException(message)
}

/** A repeated parameter is refused rather than reduced to its first value, and a
 *  present-but-blank value is refused rather than read as absent. */
export function singleExportValue(name: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) reject(`Supply ${name} at most once.`)
  if (typeof value !== 'string') reject(`Supply ${name} as a single value.`)
  const trimmed = (value as string).trim()
  if (trimmed.length === 0) reject(`Supply ${name} with a value, or omit it.`)
  return trimmed
}

export function parseExportTenantId(value: unknown): string {
  const tenantId = singleExportValue('tenantId', value)
  if (tenantId === undefined) reject('Select a tenant for this export.')
  if (!UUID.test(tenantId as string)) reject('Select a valid tenant for this export.')
  return (tenantId as string).toLowerCase()
}

function readSupportedInstant(name: string, raw: unknown): string | null {
  const value = singleExportValue(name, raw)
  if (value === undefined) return null
  if (OVER_PRECISE.test(value)) {
    // Rounding would shift a half-open bound against microsecond-stored event
    // times and include or exclude the wrong record.
    reject(`Supply ${name} with at most three fractional-second digits.`)
  }
  const parts = SUPPORTED_INSTANT.exec(value)
  if (!parts) {
    reject(`Supply ${name} as an ISO 8601 instant with a UTC designator or offset.`)
  }
  const [, year, month, day] = parts as RegExpExecArray
  const monthNumber = Number(month)
  const dayNumber = Number(day)
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1) {
    reject(`Supply ${name} as a real calendar date.`)
  }
  // Date.parse rolls an impossible day forward -- 2026-02-30 becomes March 2nd --
  // so the calendar is checked against the written fields.
  const limit = monthNumber === 2 && leap(Number(year)) ? 29 : DAYS_IN_MONTH[monthNumber - 1]
  if (dayNumber > limit) reject(`Supply ${name} as a real calendar date.`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) reject(`Supply ${name} as an ISO 8601 instant.`)
  return new Date(parsed).toISOString()
}

export function parseExportWindow(since: unknown, until: unknown): DirectoryAuditExportWindow {
  const window = {
    since: readSupportedInstant('since', since),
    until: readSupportedInstant('until', until),
  }
  if (window.since !== null && window.until !== null) {
    // Half-open: equal bounds would select nothing at all.
    if (Date.parse(window.since) >= Date.parse(window.until)) {
      reject('Supply a date range whose start is before its end.')
    }
  }
  return window
}

function singleHeader(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined
  return typeof value === 'string' ? value : undefined
}

/** An explicitly supplied JSON `{}` is a supplied body; nothing sent is not.
 *  A parsed value cannot tell those apart -- both arrive as an empty object
 *  under some parser configurations -- so the question is answered from the
 *  request FRAMING. A declared zero-length body is treated as absent, because
 *  no JSON document was supplied. */
export function exportRequestSuppliedBody(request: {
  headers?: Record<string, unknown>
  body?: unknown
}): boolean {
  const headers = request.headers ?? {}
  const declared = Number(singleHeader(headers['content-length']))
  if (Number.isFinite(declared) && declared > 0) return true
  const chunked = singleHeader(headers['transfer-encoding'])
  if (chunked !== undefined && chunked.trim().length > 0) return true
  // Fallback for a parser that consumed the framing: a non-empty parsed body.
  const body = request.body
  if (body === undefined || body === null) return false
  if (Array.isArray(body)) return body.length > 0
  if (typeof body === 'object') return Object.keys(body).length > 0
  return String(body).length > 0
}

/** The export takes its tenant and window from the query and its identity from
 *  the verified request. Anything else is a caller trying to widen the read. */
export function assertNoExportExtras(
  request: { headers?: Record<string, unknown>; body?: unknown },
  query: unknown
) {
  if (exportRequestSuppliedBody(request)) {
    reject('The directory audit export does not accept a request body.')
  }
  if (query !== undefined && query !== null) {
    if (typeof query !== 'object' || Array.isArray(query)) {
      reject('The directory audit export does not accept those parameters.')
    }
    const allowed = new Set(['tenantId', 'since', 'until'])
    for (const key of Object.keys(query as Record<string, unknown>)) {
      if (!allowed.has(key)) reject(`The directory audit export does not accept ${key}.`)
    }
  }
}

/** The SAME sensitive-name rule the storage-time helper applies, mirrored here
 *  deliberately: this is an export read safeguard for a shape that rule cannot
 *  see, not a widening of the policy. `sensitiveNameRuleAgrees` is exported so a
 *  test can pin the two against each other and catch silent divergence. */
const SENSITIVE_NAME =
  /(?:password|secret|token|authorization|credential|private.?key|client.?secret|assertion|certificate)/i

/** Property names that NAME a detail, and the ones that carry its value.
 *  Microsoft emits both `key`/`value` details and
 *  `displayName`/`oldValue`/`newValue` modified properties, and casing varies
 *  between the structured columns and the parsed `raw` copy. */
const DETAIL_NAME_PROPERTIES = new Set([
  'key', 'name', 'displayname', 'property', 'propertyname', 'field', 'header', 'headername',
])
const DETAIL_VALUE_PROPERTIES = new Set([
  'value', 'values', 'newvalue', 'oldvalue', 'newvalues', 'oldvalues',
])

export const DIRECTORY_AUDIT_EXPORT_REDACTED = '[REDACTED]'

export function sensitiveNameRuleAgrees(name: string): boolean {
  return SENSITIVE_NAME.test(name)
}

/** A detail whose NAME is sensitive hides its secret in an ordinary `value`
 *  property, so property-name redaction walks straight past it:
 *  `{ key: 'Authorization', value: 'Bearer ...' }` survives it untouched. This
 *  replaces the value of such a pair, recursively, including where the pair sits
 *  nested inside the parsed `raw` copy. Every other property is preserved. */
export function redactSensitiveDetailPairs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveDetailPairs)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const named = Object.entries(source).some(([key, candidate]) =>
    DETAIL_NAME_PROPERTIES.has(key.toLowerCase())
    && typeof candidate === 'string'
    && SENSITIVE_NAME.test(candidate))
  const redacted: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(source)) {
    redacted[key] = named && DETAIL_VALUE_PROPERTIES.has(key.toLowerCase())
      ? DIRECTORY_AUDIT_EXPORT_REDACTED
      : redactSensitiveDetailPairs(nested)
  }
  return redacted
}

const instantToken = (value: string | null, unbounded: string) =>
  value === null ? unbounded : value.replaceAll(':', '-')

/** Filesystem-safe, and carrying the exact window rather than a date: two
 *  windows inside one day must not share a filename. */
export function directoryAuditExportFilename(
  customerTenantId: string,
  window: DirectoryAuditExportWindow
): string {
  return (
    `hawkview_directory_audit_stored_redacted_${customerTenantId}` +
    `_${instantToken(window.since, 'earliest')}` +
    `_to_${instantToken(window.until, 'latest')}.json`
  )
}

/** Exactly the directory fields this export carries. The top-level
 *  `resultReason` COLUMN is stored but not selected: it is unbounded text and
 *  no classifier reads it. That omission is scoped to the column -- the same
 *  text can still appear inside the exported `raw` copy, which is preserved
 *  rather than stripped to make a tidier-sounding claim. */
export const EXPORTED_DIRECTORY_FIELDS = [
  'id', 'microsoftAuditId', 'eventDateTime', 'activityDisplayName', 'category',
  'operationType', 'result', 'correlationId', 'loggedByService', 'initiatedBy',
  'targetResources', 'additionalDetails', 'raw', 'ingestedAt', 'expiresAt',
] as const

export const OMITTED_TOP_LEVEL_DIRECTORY_FIELDS = ['resultReason'] as const

export type DirectoryAuditExportEnvelope = {
  readonly exportVersion: typeof DIRECTORY_AUDIT_EXPORT_VERSION
  readonly qualification: typeof DIRECTORY_AUDIT_EXPORT_QUALIFICATION
  readonly customerTenantId: string
  readonly generatedAt: string
  readonly window: DirectoryAuditExportWindow
  readonly candidateCap: number
  /** Every retained in-window candidate, all of which were classified. */
  readonly candidates: number
  readonly eligible: number
  readonly returned: number
  readonly excludedByClassification: number
  readonly records: readonly Record<string, unknown>[]
  readonly fidelity: {
    readonly storedRepresentation: string
    readonly redactionAtWrite: string
    readonly redactionOnRead: string
    readonly includedFields: readonly string[]
    readonly omittedTopLevelFields: readonly string[]
    readonly omissionScope: string
    readonly availability: string
    readonly coverage: string
  }
}

export function buildDirectoryAuditExportEnvelope(input: {
  customerTenantId: string
  generatedAt: Date
  window: DirectoryAuditExportWindow
  candidates: number
  records: readonly Record<string, unknown>[]
  excludedByClassification: number
}): DirectoryAuditExportEnvelope {
  return {
    exportVersion: DIRECTORY_AUDIT_EXPORT_VERSION,
    qualification: DIRECTORY_AUDIT_EXPORT_QUALIFICATION,
    customerTenantId: input.customerTenantId,
    generatedAt: input.generatedAt.toISOString(),
    window: input.window,
    candidateCap: DIRECTORY_AUDIT_EXPORT_CANDIDATE_CAP,
    candidates: input.candidates,
    eligible: input.records.length,
    returned: input.records.length,
    excludedByClassification: input.excludedByClassification,
    records: input.records,
    fidelity: {
      storedRepresentation:
        'Stored redacted copies of the parsed Microsoft JSON. These are not original wire bytes, are not byte-for-byte Microsoft responses, and are not the complete stored row.',
      redactionAtWrite:
        'Only the parsed "raw" copy was redacted by sensitive object property name before it was stored. "initiatedBy", "targetResources" and "additionalDetails" were stored as they were received.',
      redactionOnRead:
        'This export applies sensitive object property name redaction again to every exported JSON field, and additionally replaces the value of sensitive-named key/value and modified-property detail pairs, which property-name redaction cannot see. That is a safeguard applied while producing this file; it does not alter or correct what remains stored.',
      includedFields: EXPORTED_DIRECTORY_FIELDS,
      omittedTopLevelFields: OMITTED_TOP_LEVEL_DIRECTORY_FIELDS,
      omissionScope:
        'Only the top-level "resultReason" column is omitted. The same text may still be present inside the exported "raw" copy, which is preserved rather than stripped.',
      availability:
        'Availability is bounded by the stored six-month expiry, measured from ingestion rather than from when the event occurred.',
      coverage:
        'Covers the requested window and eligible change classifications only. This says nothing about whether collection ran, and is not a claim that every retained Microsoft event is included.',
    },
  }
}

export function refuseDirectoryAuditExport(
  refusal: DirectoryAuditExportRefusal,
  detail: Record<string, unknown>
): never {
  throw new ConflictException({
    statusCode: 409,
    code: DIRECTORY_AUDIT_EXPORT_TOO_LARGE,
    refusal,
    ...detail,
  })
}

/** Measured on the exact bytes that would be sent. */
export function envelopeByteLength(envelope: DirectoryAuditExportEnvelope): number {
  return Buffer.byteLength(JSON.stringify(envelope), 'utf8')
}
