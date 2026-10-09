/** Derived export of an already-admitted directory-roles projection.
 *
 * This is a *derived stored snapshot*, not provider-original data. Everything
 * here is a pure function of what the existing reader already returned: no
 * provider call, no storage, no re-reading, and no second opinion about
 * freshness. In particular `status` is carried through verbatim — the reader
 * decided `current` or `stale` as of its own read, and nothing in this module
 * re-derives it from the generation clock.
 */
import { BadRequestException } from '@nestjs/common'
import {
  DIRECTORY_ROLE_CURRENT_MS,
  DIRECTORY_ROLE_RESPONSE_VERSION,
  DIRECTORY_ROLE_SOURCE,
  type DirectoryRoleResults,
} from './directory-role-reader.js'

export const DIRECTORY_ROLE_EXPORT_VERSION = 'directory-role-export/v1'
/** Names what the bytes are, so a reader cannot mistake them for provider wire data. */
export const DIRECTORY_ROLE_EXPORT_QUALIFICATION = 'derived-stored-directory-snapshot'
export const DIRECTORY_ROLE_EXPORT_UNAVAILABLE = 'DIRECTORY_ROLE_EXPORT_UNAVAILABLE'
/** Constant and caller-independent: no request text ever reaches the filename. */
export const DIRECTORY_ROLE_EXPORT_FILENAME = 'hawkview-directory-roles.json'
export const DIRECTORY_ROLE_EXPORT_MAX_ROWS = 1000
export const DIRECTORY_ROLE_EXPORT_MAX_BYTES = 256000

export interface DirectoryRoleExportEnvelope {
  readonly exportVersion: typeof DIRECTORY_ROLE_EXPORT_VERSION
  readonly qualification: typeof DIRECTORY_ROLE_EXPORT_QUALIFICATION
  readonly customerTenantId: string
  /** When these bytes were generated. Deliberately distinct from
   *  `results.observation.checkedAt`, which is when the collection completed. */
  readonly generatedAt: string
  readonly results: DirectoryRoleResults
}

export type DirectoryRoleExportRefusal =
  /** The reader's status is not an admitted one, or carries no observation. */
  | 'NOT_ADMITTED'
  /** The admitted result contradicts itself; exporting it would publish a lie. */
  | 'RESULT_INCOHERENT'
  | 'ROW_LIMIT_EXCEEDED'
  | 'BYTE_LIMIT_EXCEEDED'
  | 'GENERATION_TIME_UNUSABLE'
  | 'TENANT_REFERENCE_UNUSABLE'

export type DirectoryRoleExportOutcome =
  | {
      readonly ok: true
      readonly filename: typeof DIRECTORY_ROLE_EXPORT_FILENAME
      readonly envelope: DirectoryRoleExportEnvelope
      /** Byte length of `JSON.stringify(envelope)`, measured before sending. */
      readonly bytes: number
    }
  | {
      readonly ok: false
      readonly code: typeof DIRECTORY_ROLE_EXPORT_UNAVAILABLE
      readonly refusal: DirectoryRoleExportRefusal
    }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The export route takes its tenant from the path and its identity from the
 * verified request. Anything else in a body or query is a caller trying to
 * select a subject, so it is refused rather than ignored. */
export function assertNoExportInputs(body: unknown, query: unknown) {
  const empty = (value: unknown) => value === undefined || value === null ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
  if (!empty(body) || !empty(query)) {
    throw new BadRequestException('The directory-roles export does not accept body or query parameters.')
  }
}

const usableInstant = (value: unknown): boolean =>
  typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))

const nullableString = (value: unknown): boolean => value === null || typeof value === 'string'

function incoherent(results: DirectoryRoleResults): boolean {
  if (results.responseVersion !== DIRECTORY_ROLE_RESPONSE_VERSION) return true
  if (results.source !== DIRECTORY_ROLE_SOURCE) return true
  const observation = results.observation
  if (observation === null) return true
  if (!usableInstant(observation.checkedAt)) return true
  if (!Number.isInteger(observation.ageMs) || observation.ageMs < 0) return true
  if (!Array.isArray(observation.assignments)) return true
  // A count that disagrees with the rows is the exact defect an export would
  // launder into a document someone trusts.
  if (observation.observedCount !== observation.assignments.length) return true
  if (observation.verifiedCompleteEmpty !== (observation.assignments.length === 0)) return true
  // The reader's own status must agree with the reader's own age. This checks
  // internal coherence; it does not re-decide freshness from the export clock.
  const staleByAge = observation.ageMs > DIRECTORY_ROLE_CURRENT_MS
  if (results.status === 'current' && staleByAge) return true
  if (results.status === 'stale' && !staleByAge) return true
  for (const assignment of observation.assignments) {
    if (!assignment || typeof assignment !== 'object') return true
    if (typeof assignment.id !== 'string' || assignment.id.length === 0) return true
    if (!nullableString(assignment.principalId)) return true
    if (!nullableString(assignment.roleDefinitionId)) return true
    if (!nullableString(assignment.roleDisplayName)) return true
    if (!nullableString(assignment.directoryScopeId)) return true
    if (!nullableString(assignment.appScopeId)) return true
  }
  if (!results.latestAttempt || typeof results.latestAttempt !== 'object') return true
  if (!nullableString(results.latestAttempt.terminalAt)) return true
  return false
}

/** Builds the export, or refuses. Never truncates and never drops a row: an
 * oversized projection is an error, because a silently shortened export is
 * indistinguishable from a complete one. */
export function buildDirectoryRoleExport(input: {
  results: DirectoryRoleResults
  customerTenantId: string
  generatedAt: Date
}): DirectoryRoleExportOutcome {
  const refuse = (refusal: DirectoryRoleExportRefusal): DirectoryRoleExportOutcome =>
    ({ ok: false, code: DIRECTORY_ROLE_EXPORT_UNAVAILABLE, refusal })

  const { results, customerTenantId, generatedAt } = input

  if (typeof customerTenantId !== 'string' || !UUID.test(customerTenantId)) {
    return refuse('TENANT_REFERENCE_UNUSABLE')
  }
  if (!(generatedAt instanceof Date) || !Number.isFinite(generatedAt.getTime())) {
    return refuse('GENERATION_TIME_UNUSABLE')
  }
  // Only a trustworthy receipt with an actual observation may be exported.
  // 'stale' qualifies and is exported carrying that qualification.
  if (results.status !== 'current' && results.status !== 'stale') return refuse('NOT_ADMITTED')
  if (results.observation === null) return refuse('NOT_ADMITTED')
  if (incoherent(results)) return refuse('RESULT_INCOHERENT')
  if (results.observation.assignments.length > DIRECTORY_ROLE_EXPORT_MAX_ROWS) {
    return refuse('ROW_LIMIT_EXCEEDED')
  }

  const envelope: DirectoryRoleExportEnvelope = {
    exportVersion: DIRECTORY_ROLE_EXPORT_VERSION,
    qualification: DIRECTORY_ROLE_EXPORT_QUALIFICATION,
    customerTenantId,
    generatedAt: generatedAt.toISOString(),
    // The complete admitted projection, verbatim. No filtering, no window and
    // no subsetting, so there is no selection to misrepresent.
    results,
  }

  const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8')
  if (bytes > DIRECTORY_ROLE_EXPORT_MAX_BYTES) return refuse('BYTE_LIMIT_EXCEEDED')

  return { ok: true, filename: DIRECTORY_ROLE_EXPORT_FILENAME, envelope, bytes }
}
