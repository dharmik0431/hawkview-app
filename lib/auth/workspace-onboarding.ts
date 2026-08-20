import type { HawkViewSession } from '@/lib/auth/types'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DOMAIN_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const CONTROL_OR_MARKUP =
  /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff<>]/
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/

function isIpLiteralDomain(value: string) {
  try {
    const hostname = new URL(`http://${value}`).hostname
    return (
      IPV4_LITERAL.test(hostname) ||
      hostname.includes(':') ||
      hostname.startsWith('[')
    )
  } catch {
    return true
  }
}

export type WorkspaceOnboarding = {
  required: boolean
  organizationId: string | null
  organizationName: string | null
  businessDomain: string | null
  businessDomainVerification: 'UNVERIFIED_INFORMATIONAL'
  timeZone: string | null
}

export type WorkspaceOnboardingState =
  | { state: 'legacy'; onboarding: null }
  | { state: 'unavailable'; onboarding: null }
  | { state: 'ready'; onboarding: WorkspaceOnboarding }

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  return value as Record<string, unknown>
}

function own(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined
}

function safeString(value: unknown, maximum: number) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (
    !normalized ||
    normalized.length > maximum ||
    CONTROL_OR_MARKUP.test(normalized)
  ) {
    return null
  }
  return normalized
}

export function normalizeBusinessDomain(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (
    !normalized ||
    normalized.length > 253 ||
    normalized.endsWith('.') ||
    normalized.includes('://') ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    normalized.includes('%') ||
    normalized.includes('@') ||
    normalized.includes(':') ||
    normalized.includes('[') ||
    normalized.includes(']') ||
    isIpLiteralDomain(normalized) ||
    CONTROL_OR_MARKUP.test(normalized)
  ) {
    return undefined
  }
  const labels = normalized.split('.')
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label))) {
    return undefined
  }
  return normalized
}

export function normalizeTimeZone(value: unknown) {
  const candidate = safeString(value, 100)
  if (!candidate) return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: candidate })
      .resolvedOptions()
      .timeZone
  } catch {
    return null
  }
}

export function browserTimeZone() {
  if (typeof Intl === 'undefined') return 'UTC'
  return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC'
}

export function workspaceOnboardingState(
  session: HawkViewSession | null | undefined
): WorkspaceOnboardingState {
  if (!session || !Object.prototype.hasOwnProperty.call(session, 'workspaceOnboarding')) {
    return { state: 'legacy', onboarding: null }
  }

  const candidate = plainRecord(session.workspaceOnboarding)
  if (!candidate || typeof own(candidate, 'required') !== 'boolean') {
    return { state: 'unavailable', onboarding: null }
  }

  const required = own(candidate, 'required') as boolean
  const organizationIdValue = own(candidate, 'organizationId')
  const organizationNameValue = own(candidate, 'organizationName')
  const businessDomainValue = own(candidate, 'businessDomain')
  const businessDomainVerificationValue = own(
    candidate,
    'businessDomainVerification'
  )
  const timeZoneValue = own(candidate, 'timeZone')
  const organizationId =
    typeof organizationIdValue === 'string' && UUID_PATTERN.test(organizationIdValue.trim())
      ? organizationIdValue.trim().toLowerCase()
      : null
  const organizationName = safeString(organizationNameValue, 200)
  const domainValue = normalizeBusinessDomain(businessDomainValue)
  const businessDomain = domainValue === undefined ? null : domainValue
  const timeZone = normalizeTimeZone(timeZoneValue)

  const malformedNullableField =
    (organizationIdValue !== null && !organizationId) ||
    (organizationNameValue !== null && !organizationName) ||
    domainValue === undefined ||
    businessDomainVerificationValue !== 'UNVERIFIED_INFORMATIONAL' ||
    (timeZoneValue !== null && !timeZone)
  const organizationIsActiveOwner =
    organizationId === null ||
    (session.user.memberships ?? []).some(
      (membership) =>
        membership.role === 'MSP_OWNER' &&
        membership.status === 'ACTIVE' &&
        membership.organization.status === 'ACTIVE' &&
        membership.organization.id.toLowerCase() === organizationId
    )

  if (
    malformedNullableField ||
    !organizationIsActiveOwner ||
    (required && (!organizationId || !organizationName))
  ) {
    return { state: 'unavailable', onboarding: null }
  }

  return {
    state: 'ready',
    onboarding: {
      required,
      organizationId,
      organizationName,
      businessDomain,
      businessDomainVerification: 'UNVERIFIED_INFORMATIONAL',
      timeZone,
    },
  }
}

export function organizationProfileFromWorkspace(value: unknown) {
  const candidate = plainRecord(value)
  if (!candidate) return null
  const organizationIdValue = own(candidate, 'id')
  const organizationNameValue = own(candidate, 'name')
  const domainValue = normalizeBusinessDomain(own(candidate, 'businessDomain'))
  const verificationValue = own(candidate, 'businessDomainVerification')
  const timeZoneValue = own(candidate, 'timeZone')
  const completedAtValue = own(candidate, 'onboardingCompletedAt')
  const organizationId =
    typeof organizationIdValue === 'string' && UUID_PATTERN.test(organizationIdValue.trim())
      ? organizationIdValue.trim().toLowerCase()
      : null
  const organizationName = safeString(organizationNameValue, 200)
  const timeZone = normalizeTimeZone(timeZoneValue)
  const completedAt =
    typeof completedAtValue === 'string' ? new Date(completedAtValue) : null
  if (
    !organizationId ||
    !organizationName ||
    domainValue === undefined ||
    verificationValue !== 'UNVERIFIED_INFORMATIONAL' ||
    (timeZoneValue !== null && !timeZone) ||
    !completedAt ||
    Number.isNaN(completedAt.getTime()) ||
    completedAt.getTime() > Date.now() + 5 * 60 * 1000
  ) {
    return null
  }
  return {
    required: false,
    organizationId,
    organizationName,
    businessDomain: domainValue,
    businessDomainVerification: 'UNVERIFIED_INFORMATIONAL' as const,
    timeZone,
  }
}

export function organizationSettingsPayload(input: {
  organizationId: string
  organizationName: string
  businessDomain: string
  timeZone: string
}) {
  const organizationId = input.organizationId.trim().toLowerCase()
  const organizationName = safeString(input.organizationName, 200)
  const businessDomain = normalizeBusinessDomain(input.businessDomain)
  const timeZone = normalizeTimeZone(input.timeZone)

  if (!UUID_PATTERN.test(organizationId)) {
    return { error: 'HawkView could not verify your organization. Refresh and try again.' } as const
  }
  if (!organizationName || organizationName.length < 2) {
    return { error: 'Enter your MSP or organization name.' } as const
  }
  if (businessDomain === undefined) {
    return { error: 'Enter a business domain such as example.com, or leave it blank.' } as const
  }
  if (!timeZone) {
    return { error: 'Select a valid time zone.' } as const
  }

  return {
    payload: {
      organizationId,
      organizationName,
      businessDomain,
      timeZone,
    },
  } as const
}
