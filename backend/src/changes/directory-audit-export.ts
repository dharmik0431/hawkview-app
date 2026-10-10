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

/** The export takes its tenant and window from the query and its identity from
 *  the verified request. Anything else is a caller trying to widen the read. */
export function assertNoExportExtras(body: unknown, query: unknown) {
  const emptyBody = body === undefined || body === null ||
    (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0)
  if (!emptyBody) reject('The directory audit export does not accept a request body.')
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

/** Exactly the directory fields this export carries. `resultReason` is stored
 *  but NOT selected: it is unbounded text and no classifier reads it. Its
 *  absence is declared rather than left for a reader to discover. */
export const EXPORTED_DIRECTORY_FIELDS = [
  'id', 'microsoftAuditId', 'eventDateTime', 'activityDisplayName', 'category',
  'operationType', 'result', 'correlationId', 'loggedByService', 'initiatedBy',
  'targetResources', 'additionalDetails', 'raw', 'ingestedAt', 'expiresAt',
] as const

export const OMITTED_DIRECTORY_FIELDS = ['resultReason'] as const

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
    readonly redaction: string
    readonly includedFields: readonly string[]
    readonly omittedFields: readonly string[]
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
        'Stored redacted copies of the parsed Microsoft JSON. These are not original wire bytes and are not byte-for-byte Microsoft responses.',
      redaction:
        'Values under sensitive-named keys were replaced with "[REDACTED]" before storage and are exported as such.',
      includedFields: EXPORTED_DIRECTORY_FIELDS,
      omittedFields: OMITTED_DIRECTORY_FIELDS,
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
