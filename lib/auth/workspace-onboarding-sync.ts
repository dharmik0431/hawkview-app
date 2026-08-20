import type { HawkViewSession } from '@/lib/auth/types'

const CHANNEL_NAME = 'hawkview:workspace-profile:v1'
const STORAGE_KEY = 'hawkview:workspace-profile:signal'
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_SIGNAL_AGE_MS = 5 * 60 * 1000
const MAX_CLOCK_SKEW_MS = 10_000
let lastPublishedGeneration = 0

export type WorkspaceChangeSignal = {
  version: 1
  subject: string
  organizationId: string
  generation: number
  emittedAt: number
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null
}

export function normalizeWorkspaceChangeSignal(
  value: unknown,
  now = Date.now()
): WorkspaceChangeSignal | null {
  const record = plainRecord(value)
  if (!record || record.version !== 1) return null
  const subject = typeof record.subject === 'string' ? record.subject.trim() : ''
  const organizationId =
    typeof record.organizationId === 'string'
      ? record.organizationId.trim().toLowerCase()
      : ''
  const generation = record.generation
  const emittedAt = record.emittedAt
  if (
    !UUID_PATTERN.test(subject) ||
    !UUID_PATTERN.test(organizationId) ||
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    typeof emittedAt !== 'number' ||
    !Number.isSafeInteger(emittedAt) ||
    emittedAt > now + MAX_CLOCK_SKEW_MS ||
    now - emittedAt > MAX_SIGNAL_AGE_MS
  ) {
    return null
  }
  return { version: 1, subject, organizationId, generation, emittedAt }
}

export class WorkspaceChangeSignalGuard {
  private readonly seen = new Map<string, number>()

  accept(
    value: unknown,
    currentSubject: string | null | undefined,
    session: HawkViewSession | null | undefined,
    now = Date.now()
  ) {
    const signal = normalizeWorkspaceChangeSignal(value, now)
    if (!signal || !currentSubject || signal.subject !== currentSubject) return null
    const hasOrganization = (session?.user.memberships ?? []).some(
      (membership) =>
        membership.status === 'ACTIVE' &&
        membership.organization.status === 'ACTIVE' &&
        membership.organization.id.toLowerCase() === signal.organizationId
    )
    if (!hasOrganization) return null
    const key = `${signal.subject}:${signal.organizationId}`
    if ((this.seen.get(key) ?? 0) >= signal.generation) return null
    this.seen.set(key, signal.generation)
    return signal
  }
}

export class PassiveWorkspaceRefreshLimiter {
  private lastRefreshAt = 0

  allow(now = Date.now()) {
    if (now - this.lastRefreshAt < 5_000) return false
    this.lastRefreshAt = now
    return true
  }
}

export class WorkspaceBootstrapRefreshQueue {
  private requestedGeneration = 0

  async request<T>(
    inFlight: Promise<unknown> | null,
    refresh: () => Promise<T>
  ): Promise<T | null> {
    const generation = ++this.requestedGeneration
    if (inFlight) {
      try {
        await inFlight
      } catch {
        // A post-change refresh is still required after a failed old request.
      }
    }
    if (generation !== this.requestedGeneration) return null
    return refresh()
  }
}

export function publishWorkspaceChange(subject: string, organizationId: string) {
  if (typeof window === 'undefined') return
  const now = Date.now()
  const signal = normalizeWorkspaceChangeSignal(
    {
      version: 1,
      subject,
      organizationId,
      generation: Math.max(now, lastPublishedGeneration + 1),
      emittedAt: now,
    },
    now
  )
  if (!signal) return
  lastPublishedGeneration = signal.generation

  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CHANNEL_NAME)
    channel.postMessage(signal)
    channel.close()
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(signal))
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // BroadcastChannel may still have delivered the bounded signal.
  }
}

export function subscribeWorkspaceChanges(
  listener: (value: unknown) => void
) {
  if (typeof window === 'undefined') return () => undefined
  const channel =
    typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(CHANNEL_NAME)
      : null
  if (channel) channel.onmessage = (event) => listener(event.data)
  const storageListener = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    try {
      listener(JSON.parse(event.newValue))
    } catch {
      // Ignore malformed cross-tab values.
    }
  }
  window.addEventListener('storage', storageListener)
  return () => {
    channel?.close()
    window.removeEventListener('storage', storageListener)
  }
}
