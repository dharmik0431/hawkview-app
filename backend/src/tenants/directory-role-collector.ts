import type { AuthorityDatabase, ManagedAuthority } from '../microsoft/managed-connector-authority.js'
import type { ChangeEvidenceService } from '../changes/change-evidence.service.js'
import { captureRoleAttempt, completeRoleAttempt, finishRoleAttempt, type RoleIdentity } from './directory-role-receipt-store.js'
import { DirectoryRolePartialError, directoryRolePage, prepareDirectoryRoles, DIRECTORY_ROLE_MAX_ROWS } from './directory-role-collection-validation.js'

export const DIRECTORY_ROLE_URL = 'https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?$expand=roleDefinition($select=id,displayName,templateId)'
const MAX_PAGE_BYTES = 180000, MAX_WIRE_BYTES = 720000, MAX_PAGES = 100, COLLECTOR_MS = 120000
type Dependencies = {
  db: AuthorityDatabase
  token: (authority: ManagedAuthority, microsoftTenantId: string, deadlineAt: number) => Promise<string>
  fetchPage: (url: string, token: string, deadlineAt: number) => Promise<Response>
  read: (response: Response, maximumBytes: number, failureMessage: string, deadlineAt: number) => Promise<string>
  buildDifference: ChangeEvidenceService['buildSnapshotDifferenceEvidence']
  legacy: () => Promise<unknown>
}
function checkedUrl(value: string): string {
  const url = new URL(value)
  if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password || url.hash
    || url.pathname !== '/v1.0/roleManagement/directory/roleAssignments') throw new DirectoryRolePartialError()
  return url.href
}
/** One resource boundary shared by retry, inventory and audit reconciliation.
 * Legacy remains explicitly untrusted. Activated terminal effects belong solely
 * to the receipt store; notification integration/production activation are deferred.
 */
export async function collectDirectoryRoles(input: Omit<RoleIdentity, 'configurationRevision'>, deps: Dependencies) {
  const captured = await captureRoleAttempt(deps.db, input)
  if (captured.status === 'legacy') {
    await deps.legacy()
    return { status: 'legacy' as const }
  }
  if (captured.status === 'rejected') return captured
  const { attempt, authority } = captured
  // Local duration cap supplements, never substitutes for, the store's post-lock DB deadline.
  const deadlineAt = Date.now() + COLLECTOR_MS
  let collection: ReturnType<typeof prepareDirectoryRoles>
  try {
    const token = await deps.token(authority, attempt.microsoftTenantId, deadlineAt)
    const rows: unknown[] = [], seen = new Set<string>()
    let next: string | null = DIRECTORY_ROLE_URL, wireBytes = 0
    while (next !== null) {
      if (Date.now() >= deadlineAt) throw new DirectoryRolePartialError()
      const url = checkedUrl(next)
      if (seen.has(url) || seen.size >= MAX_PAGES) throw new DirectoryRolePartialError()
      seen.add(url)
      const response = await deps.fetchPage(url, token, deadlineAt)
      if (!response.ok) throw new Error('DIRECTORY_ROLE_PROVIDER_FAILED')
      const raw = await deps.read(response, MAX_PAGE_BYTES, 'DIRECTORY_ROLE_PAGE_TOO_LARGE', deadlineAt)
      wireBytes += Buffer.byteLength(raw, 'utf8')
      if (wireBytes > MAX_WIRE_BYTES || Date.now() >= deadlineAt) throw new DirectoryRolePartialError()
      let body: unknown
      try { body = JSON.parse(raw) } catch { throw new DirectoryRolePartialError() }
      const page = directoryRolePage(body)
      if (rows.length + page.rows.length > DIRECTORY_ROLE_MAX_ROWS) throw new DirectoryRolePartialError()
      rows.push(...page.rows)
      // Validate every accumulated page before retaining it or asking for more.
      collection = prepareDirectoryRoles(rows)
      next = page.next
    }
    collection = prepareDirectoryRoles(rows)
  } catch (error) {
    // No generic status writer, connection mutation or notification on this branch.
    return finishRoleAttempt(deps.db, attempt, error instanceof DirectoryRolePartialError ? 'PARTIAL' : 'FAILED')
  }
  // A DB/evidence failure rolls back atomically and propagates; do not convert an
  // uncertain commit into a second terminal mutation.
  return completeRoleAttempt(deps.db, attempt, collection, deps.buildDifference)
}
