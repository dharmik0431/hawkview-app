export type NotificationRequestScope = Readonly<{
  subject: string
  organizationId: string
}>

export type NotificationRequestTicket = Readonly<{
  scopeKey: string
  lane: string
  epoch: number
  sequence: number
}>

function clean(value: string | null | undefined) {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

export function notificationRequestScope(
  subject: string | null | undefined,
  organizationId: string | null | undefined
): NotificationRequestScope | null {
  const cleanSubject = clean(subject)
  const cleanOrganizationId = clean(organizationId)
  return cleanSubject && cleanOrganizationId
    ? { subject: cleanSubject, organizationId: cleanOrganizationId }
    : null
}

export function notificationRequestScopeKey(
  scope: NotificationRequestScope | null
) {
  if (!scope) return null
  return `${scope.subject}\u001f${scope.organizationId}`
}

/** Fences reads and writes by identity, workspace, operation, and generation. */
export class NotificationScopedRequestGuard {
  private activeScopeKey: string | null = null
  private epoch = 0
  private sequence = 0
  private readonly lanes = new Map<string, number>()

  setScope(scope: NotificationRequestScope | null) {
    const next = notificationRequestScopeKey(scope)
    if (next !== this.activeScopeKey) {
      this.activeScopeKey = next
      this.epoch += 1
      this.lanes.clear()
    }
  }

  begin(scope: NotificationRequestScope, lane: string): NotificationRequestTicket {
    this.setScope(scope)
    const sequence = ++this.sequence
    this.lanes.set(lane, sequence)
    return {
      scopeKey: notificationRequestScopeKey(scope)!,
      lane,
      epoch: this.epoch,
      sequence,
    }
  }

  invalidateLane(lane: string) {
    this.lanes.set(lane, ++this.sequence)
  }

  invalidate() {
    this.activeScopeKey = null
    this.epoch += 1
    this.lanes.clear()
  }

  isCurrent(
    ticket: NotificationRequestTicket,
    currentScope: NotificationRequestScope | null
  ) {
    if (!currentScope) return false
    const currentKey = notificationRequestScopeKey(currentScope)
    return (
      ticket.scopeKey === currentKey &&
      this.activeScopeKey === currentKey &&
      ticket.epoch === this.epoch &&
      this.lanes.get(ticket.lane) === ticket.sequence
    )
  }
}
