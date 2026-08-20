import type { HawkViewSession } from './types'

const SCOPE_SEPARATOR = '\u001f'

export type AuthTransitionTicket = Readonly<{
  generation: number
  subject: string | null
}>

/**
 * Rejects late async bootstrap results after an identity transition.  The
 * subject is the Supabase user id, never an email address or display name.
 */
export class AuthTransitionGuard {
  private generation = 0
  private subject: string | null = null

  begin(subject: string | null): AuthTransitionTicket {
    this.generation += 1
    this.subject = subject
    return { generation: this.generation, subject }
  }

  current(): AuthTransitionTicket {
    return { generation: this.generation, subject: this.subject }
  }

  isCurrent(ticket: AuthTransitionTicket) {
    return (
      ticket.generation === this.generation && ticket.subject === this.subject
    )
  }
}

export function authDataScope(
  identitySubject: string | null | undefined,
  session: HawkViewSession | null | undefined
) {
  const subject = identitySubject?.trim()
  if (!subject) return 'signed-out'

  const organizationIds = (session?.user.memberships ?? [])
    .map((membership) => membership.organization.id.trim())
    .filter(Boolean)
    .sort()

  return organizationIds.length > 0
    ? `identity:${subject}:organizations:${organizationIds.join(',')}`
    : `identity:${subject}:bootstrap-pending`
}

export function scopedCacheKey(scope: string, resourceKey: string) {
  return `${scope}${SCOPE_SEPARATOR}${resourceKey}`
}

type CacheEntry<T> = { value: T; storedAt: number }

/** A small in-memory cache that cannot return a value from another scope. */
export class IdentityScopedMemoryCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>()

  get(scope: string, resourceKey: string, maxAgeMs = Number.POSITIVE_INFINITY) {
    const entry = this.entries.get(scopedCacheKey(scope, resourceKey))
    if (!entry) return null
    if (Date.now() - entry.storedAt > maxAgeMs) {
      this.entries.delete(scopedCacheKey(scope, resourceKey))
      return null
    }
    return entry.value
  }

  set(scope: string, resourceKey: string, value: T) {
    this.entries.set(scopedCacheKey(scope, resourceKey), {
      value,
      storedAt: Date.now(),
    })
  }

  clear() {
    this.entries.clear()
  }
}

const identityCacheResetters = new Set<() => void>()

export function registerIdentityCacheReset(reset: () => void) {
  identityCacheResetters.add(reset)
  return () => identityCacheResetters.delete(reset)
}

/** Called synchronously before the active identity is replaced. */
export function clearIdentityBoundCaches() {
  identityCacheResetters.forEach((reset) => reset())
}
