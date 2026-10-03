import { parseDedupeKey, type ExistingAlertRow } from './reconciliation.js'

type NotificationRow = Pick<ExistingAlertRow,
  'id' | 'organizationId' | 'customerTenantId' | 'dedupeKey' | 'occurrenceCount' | 'resolvedAt'>
type AuditIdentity = { organizationId: string; customerTenantId: string; microsoftAuditId: string }
type AuditRow = AuditIdentity & {
  initiatedBy: unknown
  targetResources: unknown
  eventDateTime: Date
}
const notificationSelect = {
  id: true, organizationId: true, customerTenantId: true,
  dedupeKey: true, occurrenceCount: true, resolvedAt: true,
} as const
const auditSelect = {
  organizationId: true, customerTenantId: true, microsoftAuditId: true,
  initiatedBy: true, targetResources: true, eventDateTime: true,
} as const

export interface ReconciliationReader {
  notification: {
    findMany(args: { select: typeof notificationSelect }): Promise<NotificationRow[]>
  }
  directoryAuditLog: {
    findMany(args: { where: { OR: AuditIdentity[] }; select: typeof auditSelect }): Promise<AuditRow[]>
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function identity(organizationId: string, customerTenantId: string | null, microsoftAuditId: string | null): AuditIdentity | null {
  if (!UUID.test(organizationId) || typeof customerTenantId !== 'string' || !UUID.test(customerTenantId)
    || typeof microsoftAuditId !== 'string' || microsoftAuditId.length === 0 || microsoftAuditId.length > 200) return null
  return { organizationId: organizationId.toLowerCase(), customerTenantId: customerTenantId.toLowerCase(), microsoftAuditId }
}
const keyOf = (scope: AuditIdentity) => JSON.stringify([scope.organizationId, scope.customerTenantId, scope.microsoftAuditId])

/** Shared read adapter only: no operator writes or client construction. Keep the
 * two historical projections distinct; this repair changes evidence ownership. */
async function readRows(reader: ReconciliationReader, mode: 'dry-run' | 'apply') {
  const notifications = await reader.notification.findMany({ select: notificationSelect })
  const auditIds = notifications.map((row) => parseDedupeKey(row.dedupeKey).eventIdInKey)
  const scopes = notifications.map((row, index) => identity(row.organizationId, row.customerTenantId, auditIds[index]))
  const requested = new Map<string, AuditIdentity>()
  for (const scope of scopes) if (scope !== null) requested.set(keyOf(scope), scope)
  const found = new Map<string, AuditRow | null>()
  const tuples = [...requested.values()]
  // Bound query parameters while preserving exact tuples, not the Cartesian
  // product of independently collected tenant and audit-id lists.
  for (let offset = 0; offset < tuples.length; offset += 500) {
    const batch = tuples.slice(offset, offset + 500)
    const batchKeys = new Set(batch.map(keyOf))
    const audits = await reader.directoryAuditLog.findMany({ where: { OR: batch }, select: auditSelect })
    for (const audit of audits) {
      const scope = identity(audit.organizationId, audit.customerTenantId, audit.microsoftAuditId)
      if (scope === null || !batchKeys.has(keyOf(scope))) continue
      const key = keyOf(scope)
      // The schema makes this unique. Refuse ambiguous adapter output rather
      // than selecting a different winner when result order changes.
      found.set(key, found.has(key) ? null : audit)
    }
  }
  const rows: ExistingAlertRow[] = notifications.map((row, index) => {
    const scope = scopes[index]
    const audit = scope === null ? null : found.get(keyOf(scope)) ?? null
    return {
      ...row,
      occurredAt: audit?.eventDateTime ?? null,
      audit: audit === null ? null : {
        initiatedBy: typeof audit.initiatedBy === 'string' ? audit.initiatedBy
          : mode === 'dry-run' ? readString(audit.initiatedBy, ['user', 'userPrincipalName'])
            ?? readString(audit.initiatedBy, ['user', 'id']) : null,
        targetResources: mode === 'dry-run' ? readTargets(audit.targetResources) : [],
        privileged: null,
      },
    }
  })
  const named = auditIds.filter((id): id is string => id !== null)
  const auditRecordsFound = [...found.values()].filter((audit) => audit !== null).length
  return { rows, auditJoin: {
    keysNamingAnAuditRecord: named.length,
    distinctAuditIds: new Set(named).size,
    distinctAuditIdentities: requested.size,
    unscopedAuditKeys: scopes.filter((scope, index) => scope === null && auditIds[index] !== null).length,
    auditRecordsFound,
    // Counts scoped identities, so another tenant's matching ID cannot conceal
    // a missing join or turn this count negative.
    notJoined: requested.size - auditRecordsFound,
  } }
}

export const readDryRunReconciliationRows = (reader: ReconciliationReader) => readRows(reader, 'dry-run')
export const readApplyReconciliationRows = (reader: ReconciliationReader) => readRows(reader, 'apply')

function readString(value: unknown, path: readonly string[]): string | null {
  let cursor: unknown = value
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return typeof cursor === 'string' ? cursor : null
}
function readTargets(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => readString(entry, ['id']) ?? readString(entry, ['displayName']))
    .filter((id): id is string => id !== null)
}
