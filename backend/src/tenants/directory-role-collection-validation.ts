import { createHash } from 'node:crypto'
import type { PreparedRoleCollection } from './directory-role-receipt-store.js'

export const DIRECTORY_ROLE_MAX_ROWS = 1000
export const DIRECTORY_ROLE_MAX_BYTES = 180000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export class DirectoryRolePartialError extends Error {
  constructor() { super('DIRECTORY_ROLE_COLLECTION_INCOMPLETE') }
}
function fail(): never { throw new DirectoryRolePartialError() }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return fail()
  return value
}
function uuid(value: unknown): string {
  const result = text(value)
  return UUID.test(result) ? result.toLowerCase() : fail()
}
function scope(value: unknown): string | null {
  if (value == null) return null
  const result = text(value)
  return result.startsWith('/') ? result : fail()
}
/** Closed projection; malformed or duplicate assignments invalidate the entire collection.
 * Empty is authoritative only after the collector proves a terminal, valid page.
 */
export function prepareDirectoryRoles(values: readonly unknown[]): PreparedRoleCollection {
  if (!Array.isArray(values) || values.length > DIRECTORY_ROLE_MAX_ROWS) return fail()
  const ids = new Set<string>()
  const rows = values.map(value => {
    const raw = record(value), id = text(raw.id)
    if (ids.has(id)) return fail()
    ids.add(id)
    const principalId = uuid(raw.principalId), roleDefinitionId = uuid(raw.roleDefinitionId)
    const directoryScopeId = scope(raw.directoryScopeId), appScopeId = scope(raw.appScopeId)
    if ((directoryScopeId === null) === (appScopeId === null)) return fail()
    const definition = record(raw.roleDefinition)
    if (uuid(definition.id) !== roleDefinitionId) return fail()
    const roleDefinition = { id: roleDefinitionId, displayName: text(definition.displayName),
      templateId: definition.templateId == null ? null : uuid(definition.templateId) }
    return { id, principalId, roleDefinitionId, directoryScopeId, appScopeId, roleDefinition }
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const json = JSON.stringify(rows)
  if (Buffer.byteLength(json, 'utf8') > DIRECTORY_ROLE_MAX_BYTES) return fail()
  return { rows, contentDigest: createHash('sha256').update(json).digest('hex') }
}

export function directoryRolePage(value: unknown): { rows: unknown[]; next: string | null } {
  const page = record(value)
  if (!Array.isArray(page.value) || page.error != null || page['@odata.deltaLink'] != null) return fail()
  const link = page['@odata.nextLink']
  if (link !== undefined && (typeof link !== 'string' || !link)) return fail()
  return { rows: page.value, next: link === undefined ? null : link as string }
}
