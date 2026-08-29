export type WorkspaceAuditMemberReference = {
  userId: string
  email: string
  displayName?: string | null
}

export type WorkspaceAuditEvidenceReference = {
  actorUserId?: string | null
  actorEmail?: string | null
  targetUserId?: string | null
  targetEmail?: string | null
  targetType?: string | null
  targetOpaqueId?: string | null
  requestId?: string | null
  operationId?: string | null
  stage?: string | null
  errorCode?: string | null
  metadata?: Record<string, unknown> | null
}

const SAFE_METADATA_LABELS: Record<string, string> = {
  changedFields: 'Changed fields',
  delivery: 'Delivery type',
  factorsRemoved: 'Factors removed',
  idempotent: 'Idempotent retry',
  priorRole: 'Previous role',
  priorStatus: 'Previous status',
  role: 'Role',
  status: 'Status',
}

const safeText = (value: unknown, max = 128) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null

const memberLabel = (member: WorkspaceAuditMemberReference) =>
  member.displayName?.trim() || member.email

export function workspaceAuditActorLabel(
  entry: WorkspaceAuditEvidenceReference,
  members: WorkspaceAuditMemberReference[]
) {
  const current = members.find((member) => member.userId === entry.actorUserId)
  if (current) return memberLabel(current)
  return safeText(entry.actorEmail, 320) || 'System / unavailable actor'
}

export function workspaceAuditTargetLabel(
  entry: WorkspaceAuditEvidenceReference,
  members: WorkspaceAuditMemberReference[]
) {
  const current = members.find((member) => member.userId === entry.targetUserId)
  if (current) return memberLabel(current)
  const legacyEmail = safeText(entry.targetEmail, 320)
  if (legacyEmail) return legacyEmail
  const type = safeText(entry.targetType, 50)
    ?.replaceAll('_', ' ')
    .toLowerCase()
  const opaque = safeText(entry.targetOpaqueId, 128)
  const suffix = opaque ? ` · ${opaque.slice(-8)}` : ''
  return type ? `${type}${suffix}` : 'Workspace'
}

export function workspaceAuditMetadataRows(
  metadata: Record<string, unknown> | null | undefined
) {
  if (!metadata) return []
  return Object.entries(SAFE_METADATA_LABELS).flatMap(([key, label]) => {
    const value = Object.prototype.hasOwnProperty.call(metadata, key)
      ? metadata[key]
      : undefined
    if (typeof value === 'string') {
      const safe = safeText(value, 100)
      return safe ? [{ key, label, value: safe }] : []
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return [{ key, label, value: String(value) }]
    }
    if (typeof value === 'boolean') {
      return [{ key, label, value: value ? 'Yes' : 'No' }]
    }
    if (Array.isArray(value)) {
      const safe = value
        .map((entry) => safeText(entry, 100))
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, 20)
      return safe.length ? [{ key, label, value: safe.join(', ') }] : []
    }
    return []
  })
}

export function workspaceAuditSafeIdentifier(value: unknown) {
  return safeText(value, 128) || 'Not reported'
}
