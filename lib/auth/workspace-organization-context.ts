import type { HawkViewMembership, HawkViewSession } from '@/lib/auth/types'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f<>]/

export type WorkspaceOrganizationOption = {
  id: string
  name: string
}

export type WorkspaceOrganizationContext =
  | {
      state: 'selected'
      organizations: WorkspaceOrganizationOption[]
      selected: WorkspaceOrganizationOption
    }
  | {
      state: 'selection-required' | 'unavailable'
      organizations: WorkspaceOrganizationOption[]
      selected: null
    }

export type WorkspaceOrganizationLoadTicket = {
  organizationId: string
  generation: number
}

export class WorkspaceOrganizationLoadGuard {
  private generation = 0

  begin(organizationId: string): WorkspaceOrganizationLoadTicket {
    return { organizationId, generation: ++this.generation }
  }

  invalidate() {
    this.generation += 1
  }

  isCurrent(
    ticket: WorkspaceOrganizationLoadTicket,
    selectedOrganizationId: string | null
  ) {
    return (
      ticket.generation === this.generation &&
      ticket.organizationId === selectedOrganizationId
    )
  }
}

function optionFromMembership(
  membership: HawkViewMembership
): WorkspaceOrganizationOption | null {
  const id = membership.organization.id?.trim().toLowerCase()
  const name = membership.organization.name?.trim().replace(/\s+/g, ' ')
  if (
    membership.role !== 'MSP_OWNER' ||
    membership.status !== 'ACTIVE' ||
    membership.organization.status !== 'ACTIVE' ||
    !UUID_PATTERN.test(id) ||
    !name ||
    name.length > 200 ||
    UNSAFE_TEXT.test(name)
  ) {
    return null
  }
  return { id, name }
}

export function activeOwnerOrganizations(
  session: HawkViewSession | null | undefined
) {
  const byId = new Map<string, WorkspaceOrganizationOption>()
  for (const membership of session?.user.memberships ?? []) {
    const option = optionFromMembership(membership)
    if (option && !byId.has(option.id)) byId.set(option.id, option)
  }
  return Array.from(byId.values()).sort(
    (left, right) =>
      left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }) ||
      left.id.localeCompare(right.id)
  )
}

export function workspaceOrganizationContext(
  session: HawkViewSession | null | undefined,
  requestedOrganizationId: unknown
): WorkspaceOrganizationContext {
  const organizations = activeOwnerOrganizations(session)
  if (organizations.length === 0) {
    return { state: 'unavailable', organizations, selected: null }
  }

  if (typeof requestedOrganizationId === 'string' && requestedOrganizationId.trim()) {
    const requested = requestedOrganizationId.trim().toLowerCase()
    const selected = UUID_PATTERN.test(requested)
      ? organizations.find((organization) => organization.id === requested) ?? null
      : null
    return selected
      ? { state: 'selected', organizations, selected }
      : { state: 'selection-required', organizations, selected: null }
  }

  if (organizations.length === 1) {
    return {
      state: 'selected',
      organizations,
      selected: organizations[0],
    }
  }

  return { state: 'selection-required', organizations, selected: null }
}
