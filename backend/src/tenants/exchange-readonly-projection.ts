const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CONTROL_OR_SECRET = /[\u0000-\u001f\u007f]|(?:access[_-]?token|client[_-]?secret|password|authorization|bearer\s+|sig=)/i
const MAX_TEXT = 500
const MAX_DELEGATES = 256

function ownRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null
}

function own(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

function safeText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > max || CONTROL_OR_SECRET.test(normalized)) return null
  return normalized
}

function safeUuid(value: unknown): string | null {
  const normalized = safeText(value, 36)
  return normalized && UUID.test(normalized) ? normalized.toLowerCase() : null
}

function safeList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_DELEGATES) return null
  const projected: string[] = []
  for (const entry of value) {
    const safe = typeof entry === 'string' ? safeText(entry) : (() => {
      const record = ownRecord(entry)
      if (!record) return null
      const address = safeText(own(record, 'PrimarySmtpAddress'))
      const displayName = safeText(own(record, 'DisplayName'))
      return displayName && address
        ? `${displayName} <${address}>`
        : address ?? displayName ??
          safeText(own(record, 'Name')) ??
          safeText(own(record, 'Identity'))
    })()
    if (!safe) return null
    projected.push(safe)
  }
  return [...new Set(projected)]
}

export type ExchangeReadOnlyMailbox = {
  externalDirectoryObjectId: string | null
  userPrincipalName: string | null
  primarySmtpAddress: string | null
  displayName: string | null
  recipientType: string | null
  recipientTypeDetails: string | null
  maxSendSize: string | null
  sendOnBehalfTo: string[] | null
}

/**
 * The Admin API is currently Preview and may emit the full Get-Mailbox object.
 * HawkView persists only Microsoft's documented stable response fields. Raw
 * cmdlet output, arbitrary nested objects, and unsupported preview properties
 * never cross this boundary.
 */
export function projectExchangeReadOnlyMailbox(value: unknown): ExchangeReadOnlyMailbox | null {
  const row = ownRecord(value)
  if (!row) return null
  const externalDirectoryObjectId = safeUuid(own(row, 'ExternalDirectoryObjectId'))
  const userPrincipalName = safeText(own(row, 'UserPrincipalName'), 320)
  const primarySmtpAddress = safeText(own(row, 'PrimarySmtpAddress'), 320)
  if (!externalDirectoryObjectId && !userPrincipalName && !primarySmtpAddress) return null

  const delegatesWithDisplayNames = own(row, 'GrantSendOnBehalfToWithDisplayNames')
  const delegates = own(row, 'GrantSendOnBehalfTo')
  const reportedDelegates = Array.isArray(delegatesWithDisplayNames)
    ? delegatesWithDisplayNames
    : Array.isArray(delegates)
      ? delegates
      : null

  return {
    externalDirectoryObjectId,
    userPrincipalName,
    primarySmtpAddress,
    displayName: safeText(own(row, 'DisplayName'), 256),
    recipientType: safeText(own(row, 'RecipientType'), 100),
    recipientTypeDetails: safeText(own(row, 'RecipientTypeDetails'), 100),
    maxSendSize: safeText(own(row, 'MaxSendSize'), 100),
    sendOnBehalfTo: reportedDelegates === null ? null : safeList(reportedDelegates),
  }
}

export function projectExchangeReadOnlyPage(value: unknown, limit = 20_000) {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error('Microsoft Exchange returned an invalid or oversized mailbox page.')
  }
  return value
    .map(projectExchangeReadOnlyMailbox)
    .filter((row): row is ExchangeReadOnlyMailbox => row !== null)
}
