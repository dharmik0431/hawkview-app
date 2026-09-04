import { createHash } from 'node:crypto'
import { domainToASCII } from 'node:url'
import { isPlainRecord } from './identity-risk.validation.js'

export const MAILBOX_SOURCE_VERSION = 'mailbox-investigation-source/v1'
export const MAILBOX_SOURCE_MAX_AGE_MS = 36 * 60 * 60 * 1000
export const MAILBOX_PROJECTOR_MAX_BYTES = 2 * 1024 * 1024
export const MAILBOX_PROJECTOR_MAX_RULES = 2000
export const MAILBOX_SOURCE_RESOURCES = ['EXCHANGE_MAILBOX_RULES', 'EXCHANGE_ACCEPTED_DOMAINS'] as const
export type MailboxSourceResource = typeof MAILBOX_SOURCE_RESOURCES[number]
export type MailboxSourceScope = { organizationId: string; customerTenantId: string }

export function sourceAttestationKey(resource: MailboxSourceResource) {
  return `identity-risk/v1/${resource}`
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\u0000-\u0020\u007f]/.test(value)
}

export function verifiedDomain(value: unknown): string | null {
  if (!text(value, 253)) return null
  const domain = domainToASCII(value).toLowerCase()
  return domain.length <= 253 && domain.includes('.') && domain.split('.').every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? domain : null
}

export type ForwardingRule = { mailboxId: string; ruleId: string; enabled: boolean; recipients: string[] }
export function forwardingRule(value: unknown): ForwardingRule | null {
  if (!isPlainRecord(value) || !text(value.mailboxUserId, 128) || !text(value.id, 256) ||
    typeof value.isEnabled !== 'boolean' || value.hasError !== false || !isPlainRecord(value.actions)) return null
  const recipients: string[] = []
  for (const key of ['forwardTo', 'redirectTo', 'forwardAsAttachmentTo']) {
    const entries = value.actions[key]
    if (entries === undefined) continue
    if (!Array.isArray(entries) || entries.length > 100) return null
    for (const entry of entries) {
      if (!isPlainRecord(entry) || !isPlainRecord(entry.emailAddress) || !text(entry.emailAddress.address, 320)) return null
      const address = entry.emailAddress.address
      const parts = address.split('@')
      if (parts.length !== 2 || !/^[^<>"(),:;\\]+$/.test(parts[0]!) || !verifiedDomain(parts[1])) return null
      recipients.push(`${parts[0]}@${verifiedDomain(parts[1])}`)
    }
  }
  return { mailboxId: value.mailboxUserId, ruleId: value.id, enabled: value.isEnabled,
    recipients: [...new Set(recipients)].sort() }
}

/** An integrity digest, NOT an identity pseudonym. No digest is used as a subject. */
export function mailboxSourceDigest(scope: MailboxSourceScope, resource: MailboxSourceResource, observedAt: Date, payload: unknown): string | null {
  if (!Array.isArray(payload) || payload.length > (resource === 'EXCHANGE_MAILBOX_RULES' ? 50000 : 1000)) return null
  const hash = createHash('sha256')
  let bytes = 0
  let nodes = 0
  const token = (value: string) => {
    bytes += Buffer.byteLength(value)
    if (bytes > 16 * 1024 * 1024) throw new Error('Invalid source.')
    hash.update(String(Buffer.byteLength(value))).update(':').update(value)
  }
  const canonical = (value: unknown, depth = 0): void => {
    if (++nodes > 1000000) throw new Error('Invalid source.')
    if (depth > 12) throw new Error('Invalid source.')
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) { token(JSON.stringify(value)); return }
    if (typeof value === 'string' && value.length <= 8192 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) { token(`string:${value}`); return }
    if (Array.isArray(value) && value.length <= 50000) { token(`array:${value.length}`); for (const entry of value) canonical(entry, depth + 1); return }
    if (!isPlainRecord(value) || Object.keys(value).length > 100) throw new Error('Invalid source.')
    token(`object:${Object.keys(value).length}`)
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (['__proto__', 'constructor', 'prototype'].includes(key) || !descriptor || !('value' in descriptor)) throw new Error('Invalid source.')
      token(key)
      canonical(descriptor.value, depth + 1)
    }
  }
  try {
    token(JSON.stringify([MAILBOX_SOURCE_VERSION, scope.organizationId, scope.customerTenantId, resource, observedAt.toISOString()]))
    canonical(payload)
    if (resource === 'EXCHANGE_MAILBOX_RULES') {
      const ids = new Set<string>()
      for (const row of payload) {
        const rule = forwardingRule(row)
        if (!rule) return null
        const id = JSON.stringify([rule.mailboxId, rule.ruleId])
        if (ids.has(id)) return null
        ids.add(id)
      }
    } else {
      if (payload.length === 0) return null
      const domains = payload.map((row) => isPlainRecord(row) ? verifiedDomain(row.domain) : null)
      if (domains.some((domain) => !domain) || new Set(domains).size !== domains.length) return null
    }
    return hash.digest('hex')
  } catch { return null }
}

/** Validate the SAME existing organization response before any filtering occurs. */
export function verifiedOrganizationDomains(payload: unknown, microsoftTenantId: string): Record<string, unknown>[] {
  if (!isPlainRecord(payload) || !Array.isArray(payload.value) || payload.value.length !== 1 || payload['@odata.nextLink'] !== undefined) throw new Error('Microsoft verified-domain evidence is incomplete.')
  const organization = payload.value[0]
  if (!isPlainRecord(organization) || typeof organization.id !== 'string' || organization.id.toLowerCase() !== microsoftTenantId.toLowerCase() ||
    !Array.isArray(organization.verifiedDomains) || organization.verifiedDomains.length === 0 || organization.verifiedDomains.length > 1000) throw new Error('Microsoft verified-domain scope is invalid.')
  const seen = new Set<string>()
  return organization.verifiedDomains.map((entry: unknown) => {
    if (!isPlainRecord(entry)) throw new Error('Microsoft verified-domain evidence is invalid.')
    const domain = verifiedDomain(entry.name)
    if (!domain || seen.has(domain)) throw new Error('Microsoft verified-domain evidence is invalid.')
    seen.add(domain)
    return { id: entry.name, domain: entry.name,
      associationType: typeof entry.type === 'string' ? entry.type : null,
      capabilities: typeof entry.capabilities === 'string' ? entry.capabilities : null,
      isDefault: typeof entry.isDefault === 'boolean' ? entry.isDefault : null,
      isInitial: typeof entry.isInitial === 'boolean' ? entry.isInitial : null }
  })
}
