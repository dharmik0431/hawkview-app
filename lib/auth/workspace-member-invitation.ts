export type WorkspaceInvitationResendCandidate = {
  membershipId?: unknown
  status?: unknown
  hasHawkViewAccount?: unknown
  disabled?: unknown
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuidIdentifier(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/**
 * An invitation may be resent only while an enabled, active membership is
 * still awaiting its HawkView account. Unknown or malformed evidence fails
 * closed so the UI never presents an action that the backend must reject.
 */
export function canResendInvitation(
  member: unknown,
  organizationId: unknown,
): member is WorkspaceInvitationResendCandidate & { membershipId: string } {
  if (!member || typeof member !== 'object' || Array.isArray(member)) {
    return false
  }

  const candidate = member as WorkspaceInvitationResendCandidate
  return (
    isUuidIdentifier(organizationId) &&
    isUuidIdentifier(candidate.membershipId) &&
    candidate.status === 'ACTIVE' &&
    candidate.disabled === false &&
    candidate.hasHawkViewAccount === false
  )
}
