import { BadRequestException } from '@nestjs/common'
import { isIP } from 'node:net'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DOMAIN_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const CONTROL_OR_MARKUP = /[\u0000-\u001f\u007f<>]/
const UNICODE_FORMAT_CONTROLS =
  /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/

export type OrganizationSettingsInput = {
  organizationId: string
  organizationName: string
  businessDomain: string | null
  timeZone: string
}

function record(body: unknown): Record<string, unknown> {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    (Object.getPrototypeOf(body) !== Object.prototype &&
      Object.getPrototypeOf(body) !== null)
  ) {
    throw new BadRequestException('Organization setup details are required.')
  }
  return body as Record<string, unknown>
}

function own(payload: Record<string, unknown>, name: string) {
  return Object.prototype.hasOwnProperty.call(payload, name)
    ? payload[name]
    : undefined
}

function organizationName(value: unknown) {
  if (typeof value !== 'string') {
    throw new BadRequestException('Enter your MSP or organization name.')
  }
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (
    normalized.length < 2 ||
    normalized.length > 200 ||
    CONTROL_OR_MARKUP.test(normalized) ||
    UNICODE_FORMAT_CONTROLS.test(normalized)
  ) {
    throw new BadRequestException('Enter a valid MSP or organization name.')
  }
  return normalized
}

function isIpLiteralDomain(value: string) {
  if (isIP(value) !== 0) return true
  try {
    return isIP(new URL(`http://${value}`).hostname) !== 0
  } catch {
    return false
  }
}

function businessDomain(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new BadRequestException('Enter a valid business domain or leave it blank.')
  }
  const normalized = value.trim().toLowerCase()
  if (
    normalized.length > 253 ||
    normalized.endsWith('.') ||
    normalized.includes('://') ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    normalized.includes(':') ||
    normalized.includes('%') ||
    normalized.includes('@') ||
    CONTROL_OR_MARKUP.test(normalized) ||
    UNICODE_FORMAT_CONTROLS.test(normalized) ||
    isIpLiteralDomain(normalized)
  ) {
    throw new BadRequestException('Enter a valid business domain or leave it blank.')
  }
  const labels = normalized.split('.')
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label))) {
    throw new BadRequestException('Enter a valid business domain or leave it blank.')
  }
  return normalized
}

function timeZone(value: unknown) {
  if (typeof value !== 'string') {
    throw new BadRequestException('Select a valid IANA time zone.')
  }
  const candidate = value.trim()
  if (
    !candidate ||
    candidate.length > 100 ||
    CONTROL_OR_MARKUP.test(candidate) ||
    UNICODE_FORMAT_CONTROLS.test(candidate)
  ) {
    throw new BadRequestException('Select a valid IANA time zone.')
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: candidate })
      .resolvedOptions()
      .timeZone
  } catch {
    throw new BadRequestException('Select a valid IANA time zone.')
  }
}

export function parseOrganizationSettings(body: unknown): OrganizationSettingsInput {
  const payload = record(body)
  const organizationId = parseOrganizationId(own(payload, 'organizationId'))
  return {
    organizationId,
    organizationName: organizationName(own(payload, 'organizationName')),
    businessDomain: businessDomain(own(payload, 'businessDomain')),
    timeZone: timeZone(own(payload, 'timeZone')),
  }
}

export function parseOrganizationId(value: unknown) {
  const organizationId =
    typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!UUID_PATTERN.test(organizationId)) {
    throw new BadRequestException('Select a valid HawkView organization.')
  }
  return organizationId
}

export function sameOrganizationSettings(
  organization: {
    name: string
    businessDomain: string | null
    timeZone: string | null
  },
  input: OrganizationSettingsInput,
) {
  return (
    organization.name === input.organizationName &&
    organization.businessDomain === input.businessDomain &&
    organization.timeZone === input.timeZone
  )
}

export function workspaceOnboardingView(organization: {
  id: string
  name: string
  businessDomain: string | null
  timeZone: string | null
  onboardingCompletedAt: Date | null
}) {
  return {
    required: organization.onboardingCompletedAt === null,
    organizationId: organization.id,
    organizationName: organization.name,
    businessDomain: organization.businessDomain,
    businessDomainVerification: 'UNVERIFIED_INFORMATIONAL' as const,
    timeZone: organization.timeZone,
  }
}
