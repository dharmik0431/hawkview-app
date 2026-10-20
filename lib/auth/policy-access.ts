import type { HawkViewSession } from './types'

/** The policy library belongs to MSP workspace administrators. */
export function canManagePolicies(session: HawkViewSession | null): boolean {
  return Boolean(session?.user.memberships.some((membership) =>
    membership.status === 'ACTIVE' &&
    membership.organization.status === 'ACTIVE' &&
    (membership.role === 'MSP_OWNER' || membership.role === 'MSP_ADMIN')
  ))
}

export function manageablePolicyOrganizationIds(session: HawkViewSession | null): Set<string> {
  return new Set((session?.user.memberships ?? [])
    .filter((membership) =>
      membership.status === 'ACTIVE' &&
      membership.organization.status === 'ACTIVE' &&
      (membership.role === 'MSP_OWNER' || membership.role === 'MSP_ADMIN'))
    .map((membership) => membership.organization.id))
}
