// Inactive HAW-75 ordering rule. Eligibility, capacity, exact visit ownership,
// and durable turn advancement must be checked by the future admission writer.
export interface AuditReadyTenantTurn {
  customerTenantId: string
  ready: boolean
  originalReadyAt: Date
  lastCompletedTurn: bigint | null
}

/** Rank currently ready tenants without changing a hard cap or reserving work. */
export function orderAuditReadyTenantTurns(
  candidates: readonly AuditReadyTenantTurn[],
): string[] {
  const ids = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate.customerTenantId || ids.has(candidate.customerTenantId))
      throw new Error('M365_AUDIT_FAIR_TURN_IDENTITY_INVALID')
    ids.add(candidate.customerTenantId)
    if (!Number.isFinite(candidate.originalReadyAt.getTime()) ||
      (candidate.lastCompletedTurn !== null && candidate.lastCompletedTurn < 0n))
      throw new Error('M365_AUDIT_FAIR_TURN_STATE_INVALID')
  }

  return candidates.filter((candidate) => candidate.ready)
    .sort((left, right) => {
      if (left.lastCompletedTurn === null && right.lastCompletedTurn !== null) return -1
      if (left.lastCompletedTurn !== null && right.lastCompletedTurn === null) return 1
      if (left.lastCompletedTurn !== null && right.lastCompletedTurn !== null) {
        if (left.lastCompletedTurn < right.lastCompletedTurn) return -1
        if (left.lastCompletedTurn > right.lastCompletedTurn) return 1
      }
      const readyOrder = left.originalReadyAt.getTime() - right.originalReadyAt.getTime()
      return readyOrder || (left.customerTenantId < right.customerTenantId ? -1
        : left.customerTenantId > right.customerTenantId ? 1 : 0)
    })
    .map((candidate) => candidate.customerTenantId)
}
