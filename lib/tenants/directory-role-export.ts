/** Client contract for the derived directory-roles export.
 *
 * These bytes are a *derived stored snapshot*. Nothing here claims provider
 * originality, cryptographic authenticity, or equivalence with any stored
 * digest, and nothing re-decides freshness: `status` is whatever the server's
 * reader already concluded as of its own read.
 *
 * Anything this module cannot fully validate is rejected. A partial file is
 * worse than no file, because a saved document outlives the screen that
 * explained it.
 */
import {
  parseDirectoryRoleResults,
  type DirectoryRoleResultsView,
} from './directory-role-results-view.ts'

export const DIRECTORY_ROLE_EXPORT_VERSION = 'directory-role-export/v1'
export const DIRECTORY_ROLE_EXPORT_QUALIFICATION = 'derived-stored-directory-snapshot'
export const DIRECTORY_ROLE_EXPORT_FILENAME = 'hawkview-directory-roles.json'
export const DIRECTORY_ROLE_EXPORT_UNAVAILABLE = 'DIRECTORY_ROLE_EXPORT_UNAVAILABLE'

export type DirectoryRoleExportRejection =
  | 'ENVELOPE_UNREADABLE'
  | 'VERSION_UNEXPECTED'
  | 'QUALIFICATION_UNEXPECTED'
  | 'TENANT_MISMATCH'
  | 'GENERATION_TIME_UNREADABLE'
  | 'RESULTS_UNREADABLE'

export type DirectoryRoleExportView = {
  readonly exportVersion: typeof DIRECTORY_ROLE_EXPORT_VERSION
  readonly qualification: typeof DIRECTORY_ROLE_EXPORT_QUALIFICATION
  readonly customerTenantId: string
  readonly generatedAt: Date
  readonly results: DirectoryRoleResultsView
  /** Exactly the received payload, re-serialised. The file carries what the
   *  server sent, not a projection of the parsed view. */
  readonly body: string
}

export type DirectoryRoleExportRead =
  | { readonly ok: true; readonly view: DirectoryRoleExportView }
  | { readonly ok: false; readonly rejection: DirectoryRoleExportRejection }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const instant = (value: unknown): Date | null => {
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

/** Validates the envelope against the tenant the view actually asked about, so
 * a response that arrived for a different tenant can never be saved. */
export function readDirectoryRoleExport(
  raw: unknown,
  expected: { customerTenantId: string }
): DirectoryRoleExportRead {
  const reject = (rejection: DirectoryRoleExportRejection): DirectoryRoleExportRead =>
    ({ ok: false, rejection })

  if (!isRecord(raw)) return reject('ENVELOPE_UNREADABLE')
  if (raw.exportVersion !== DIRECTORY_ROLE_EXPORT_VERSION) return reject('VERSION_UNEXPECTED')
  // The qualification is the sentence that stops these bytes being read as
  // provider-original data. A payload without it is not shown or saved.
  if (raw.qualification !== DIRECTORY_ROLE_EXPORT_QUALIFICATION) return reject('QUALIFICATION_UNEXPECTED')
  if (typeof raw.customerTenantId !== 'string' || raw.customerTenantId.length === 0) {
    return reject('ENVELOPE_UNREADABLE')
  }
  if (raw.customerTenantId !== expected.customerTenantId) return reject('TENANT_MISMATCH')

  const generatedAt = instant(raw.generatedAt)
  if (generatedAt === null) return reject('GENERATION_TIME_UNREADABLE')

  // The existing results parser is the authority on the projection itself.
  const results = parseDirectoryRoleResults(raw.results)
  if (!results) return reject('RESULTS_UNREADABLE')

  let body: string
  try {
    body = JSON.stringify(raw, null, 2)
  } catch {
    return reject('ENVELOPE_UNREADABLE')
  }
  if (typeof body !== 'string' || body.length === 0) return reject('ENVELOPE_UNREADABLE')

  return {
    ok: true,
    view: {
      exportVersion: DIRECTORY_ROLE_EXPORT_VERSION,
      qualification: DIRECTORY_ROLE_EXPORT_QUALIFICATION,
      customerTenantId: raw.customerTenantId,
      generatedAt,
      results,
      body,
    },
  }
}

export const EXPORT_REJECTION_COPY: Record<DirectoryRoleExportRejection, string> = {
  ENVELOPE_UNREADABLE: 'HawkView could not read the export it was sent, so nothing was saved.',
  VERSION_UNEXPECTED: 'This HawkView build does not recognise the export format, so nothing was saved.',
  QUALIFICATION_UNEXPECTED: 'The export did not identify itself as a stored HawkView snapshot, so nothing was saved.',
  TENANT_MISMATCH: 'The export was for a different customer tenant, so nothing was saved.',
  GENERATION_TIME_UNREADABLE: 'The export did not carry a readable generation time, so nothing was saved.',
  RESULTS_UNREADABLE: 'The stored results inside the export could not be read, so nothing was saved.',
}

/** Copy for a server refusal. Deliberately finite: a refusal is not a retryable
 * transport failure, and must not read as one. */
export const EXPORT_REFUSAL_COPY =
  'There is no verified complete observation to export for this tenant right now.'
export const EXPORT_TRANSPORT_COPY = 'The export could not be requested right now. Nothing was saved.'

export interface DownloadHost {
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
  anchor(): { href: string; download: string; click(): void; remove(): void }
}

/** Saves the bytes and always releases the object URL, including when the click
 * throws — a leaked blob URL pins the whole payload in memory for the life of
 * the document. */
export function emitDirectoryRoleExport(body: string, host: DownloadHost): void {
  const blob = new Blob([body], { type: 'application/json' })
  const url = host.createObjectURL(blob)
  try {
    const link = host.anchor()
    link.href = url
    link.download = DIRECTORY_ROLE_EXPORT_FILENAME
    try {
      link.click()
    } finally {
      link.remove()
    }
  } finally {
    host.revokeObjectURL(url)
  }
}

/** The browser host. Kept here so the button holds no DOM detail and the
 * helper stays testable against a recorded host.
 *
 * The object-URL functions are taken from the document's own window rather than
 * a global, so this works unchanged in a document that is not the ambient one. */
export function browserDownloadHost(documentRef: Document): DownloadHost {
  const view: { URL: typeof URL } = (documentRef.defaultView as unknown as { URL: typeof URL }) ?? { URL }
  return {
    createObjectURL: (blob: Blob) => view.URL.createObjectURL(blob),
    revokeObjectURL: (url: string) => { view.URL.revokeObjectURL(url) },
    anchor: () => {
      const element = documentRef.createElement('a')
      element.style.display = 'none'
      documentRef.body.appendChild(element)
      return element
    },
  }
}
