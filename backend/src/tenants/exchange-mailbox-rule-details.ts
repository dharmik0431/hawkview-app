const MAX_FACTS = 32
const MAX_VALUES = 20
const MAX_VALUE_LENGTH = 320

type RuleFactEmphasis = 'standard' | 'destination' | 'destructive'

export type ExchangeMailboxRuleFact = {
  key: string
  label: string
  values: string[]
  truncated: boolean
  emphasis: RuleFactEmphasis
}

export type ExchangeMailboxRuleDetails = {
  conditions: ExchangeMailboxRuleFact[]
  exceptions: ExchangeMailboxRuleFact[]
  actions: ExchangeMailboxRuleFact[]
}

type FactDefinition = {
  label: string
  kind: 'strings' | 'recipients' | 'boolean' | 'text' | 'sizeRange'
  emphasis?: RuleFactEmphasis
}

const CONDITION_DEFINITIONS: Readonly<Record<string, FactDefinition>> = Object.freeze({
  bodyContains: { label: 'Message body contains', kind: 'strings' },
  bodyOrSubjectContains: { label: 'Body or subject contains', kind: 'strings' },
  categories: { label: 'Message category is', kind: 'strings' },
  fromAddresses: { label: 'From', kind: 'recipients' },
  hasAttachments: { label: 'Has attachments', kind: 'boolean' },
  headerContains: { label: 'Message header contains', kind: 'strings' },
  importance: { label: 'Importance is', kind: 'text' },
  isApprovalRequest: { label: 'Is an approval request', kind: 'boolean' },
  isAutomaticForward: { label: 'Is automatically forwarded', kind: 'boolean' },
  isAutomaticReply: { label: 'Is an automatic reply', kind: 'boolean' },
  isEncrypted: { label: 'Is encrypted', kind: 'boolean' },
  isMeetingRequest: { label: 'Is a meeting request', kind: 'boolean' },
  isMeetingResponse: { label: 'Is a meeting response', kind: 'boolean' },
  isNonDeliveryReport: { label: 'Is a non-delivery report', kind: 'boolean' },
  isPermissionControlled: { label: 'Has restricted permissions', kind: 'boolean' },
  isReadReceipt: { label: 'Is a read receipt', kind: 'boolean' },
  isSigned: { label: 'Is digitally signed', kind: 'boolean' },
  isVoicemail: { label: 'Is voicemail', kind: 'boolean' },
  messageActionFlag: { label: 'Message action flag is', kind: 'text' },
  notSentToMe: { label: 'Was not sent directly to this mailbox', kind: 'boolean' },
  recipientContains: { label: 'Recipient address contains', kind: 'strings' },
  senderContains: { label: 'Sender contains', kind: 'strings' },
  sensitivity: { label: 'Sensitivity is', kind: 'text' },
  sentCcMe: { label: 'Mailbox is copied (Cc)', kind: 'boolean' },
  sentOnlyToMe: { label: 'Sent only to this mailbox', kind: 'boolean' },
  sentToAddresses: { label: 'Sent to', kind: 'recipients' },
  sentToMe: { label: 'Sent to this mailbox', kind: 'boolean' },
  sentToOrCcMe: { label: 'Sent or copied to this mailbox', kind: 'boolean' },
  subjectContains: { label: 'Subject contains', kind: 'strings' },
  withinSizeRange: { label: 'Message size range', kind: 'sizeRange' },
})

const ACTION_DEFINITIONS: Readonly<Record<string, FactDefinition>> = Object.freeze({
  assignCategories: { label: 'Assign categories', kind: 'strings' },
  copyToFolder: { label: 'Copy to folder ID', kind: 'text', emphasis: 'destination' },
  delete: { label: 'Move message to Deleted Items', kind: 'boolean', emphasis: 'destructive' },
  forwardAsAttachmentTo: { label: 'Forward as attachment to', kind: 'recipients', emphasis: 'destination' },
  forwardTo: { label: 'Forward to', kind: 'recipients', emphasis: 'destination' },
  markAsRead: { label: 'Mark as read', kind: 'boolean', emphasis: 'destructive' },
  markImportance: { label: 'Set importance to', kind: 'text' },
  moveToFolder: { label: 'Move to folder ID', kind: 'text', emphasis: 'destination' },
  permanentDelete: { label: 'Permanently delete message', kind: 'boolean', emphasis: 'destructive' },
  redirectTo: { label: 'Redirect to', kind: 'recipients', emphasis: 'destination' },
  stopProcessingRules: { label: 'Stop processing additional rules', kind: 'boolean', emphasis: 'destructive' },
})

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

function safeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_VALUE_LENGTH) return null
  let inspected = normalized
  for (let depth = 0; depth < 2 && /%[0-9a-f]{2}/i.test(inspected); depth += 1) {
    try {
      inspected = decodeURIComponent(inspected)
    } catch {
      return null
    }
  }
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(inspected)) return null
  if (/\bBearer\s+\S+/i.test(inspected)) return null
  if (/(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|password|credential)\s*[:=]/i.test(inspected)) return null
  if (/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/.test(inspected)) return null
  if (/^(?:javascript|data|vbscript|file|blob):/i.test(inspected)) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(inspected) && !/^https:\/\//i.test(inspected)) return null
  if (/[?&](?:credential|password|secret|token|sig|code|api[_-]?key)=/i.test(inspected)) return null
  if (/https:\/\/[^\s/]*@/i.test(inspected)) return null
  if (inspected.includes('#')) return null
  if (/^https:\/\//i.test(inspected)) {
    try {
      const parsed = new URL(inspected)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) return null
      let unsafeQuery = false
      parsed.searchParams.forEach((parameterValue, key) => {
        if (/(?:credential|password|secret|token|sig|code|api[_-]?key)/i.test(key)) unsafeQuery = true
        if (/\bBearer\s+\S+|(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|password|credential)\s*[:=]/i.test(parameterValue)) unsafeQuery = true
      })
      if (unsafeQuery) return null
    } catch {
      return null
    }
  }
  return normalized
}

export function safeExchangeMailboxRuleText(value: unknown): string | null {
  return safeText(value)
}

export function safeExchangeMailboxRuleCollectedAt(
  value: unknown,
  now = new Date(),
): string | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null
  if (
    typeof value === 'string' &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      /[\u0000-\u001f\u007f-\u009f]/.test(value))
  ) return null
  const collectedAt = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(collectedAt.getTime()) || collectedAt.getTime() > now.getTime()) return null
  const iso = collectedAt.toISOString()
  return iso.length <= 40 && (typeof value !== 'string' || value === iso) ? iso : null
}

function safeArray(value: unknown, projector: (item: unknown) => string | null) {
  if (!Array.isArray(value)) return { values: [] as string[], truncated: false }
  const projected: string[] = []
  const seen = new Set<string>()
  for (const item of value.slice(0, MAX_VALUES)) {
    const candidate = projector(item)
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    projected.push(candidate)
  }
  return { values: projected, truncated: value.length > MAX_VALUES }
}

function safeRecipient(value: unknown): string | null {
  const recipient = plainRecord(value)
  const email = recipient ? plainRecord(own(recipient, 'emailAddress')) : null
  if (!email) return null
  const address = safeText(own(email, 'address'))
  const name = safeText(own(email, 'name'))
  if (!address && !name) return null
  return name && address ? `${name} <${address}>` : (address ?? name)
}

function factValue(definition: FactDefinition, value: unknown) {
  if (definition.kind === 'boolean') {
    return value === true ? { values: [] as string[], truncated: false } : null
  }
  if (definition.kind === 'text') {
    const projected = safeText(value)
    return projected ? { values: [projected], truncated: false } : null
  }
  if (definition.kind === 'strings') {
    const projected = safeArray(value, safeText)
    return projected.values.length ? projected : null
  }
  if (definition.kind === 'recipients') {
    const projected = safeArray(value, safeRecipient)
    return projected.values.length ? projected : null
  }
  const size = plainRecord(value)
  if (!size) return null
  const minimum = own(size, 'minimumSize')
  const maximum = own(size, 'maximumSize')
  const values: string[] = []
  if (typeof minimum === 'number' && Number.isSafeInteger(minimum) && minimum >= 0) values.push(`Minimum ${minimum} KB`)
  if (typeof maximum === 'number' && Number.isSafeInteger(maximum) && maximum >= 0) values.push(`Maximum ${maximum} KB`)
  return values.length ? { values, truncated: false } : null
}

function projectFacts(value: unknown, definitions: Readonly<Record<string, FactDefinition>>): ExchangeMailboxRuleFact[] {
  const record = plainRecord(value)
  if (!record) return []
  const facts: ExchangeMailboxRuleFact[] = []
  for (const [key, definition] of Object.entries(definitions)) {
    const projected = factValue(definition, own(record, key))
    if (!projected) continue
    facts.push({
      key,
      label: definition.label,
      values: projected.values,
      truncated: projected.truncated,
      emphasis: definition.emphasis ?? 'standard',
    })
    if (facts.length >= MAX_FACTS) break
  }
  return facts
}

export function projectExchangeMailboxRuleDetails(rule: unknown): ExchangeMailboxRuleDetails {
  const record = plainRecord(rule)
  return {
    conditions: projectFacts(record ? own(record, 'conditions') : null, CONDITION_DEFINITIONS),
    exceptions: projectFacts(record ? own(record, 'exceptions') : null, CONDITION_DEFINITIONS),
    actions: projectFacts(record ? own(record, 'actions') : null, ACTION_DEFINITIONS),
  }
}

export function exchangeMailboxRuleCompoundId(rule: unknown): string | null {
  const record = plainRecord(rule)
  if (!record) return null
  const mailboxUserId = safeText(own(record, 'mailboxUserId'))
  const ruleId = safeText(own(record, 'id'))
  if (mailboxUserId && ruleId) return `${mailboxUserId}::${ruleId}`
  return ruleId ?? null
}

export function summarizeExchangeMailboxRuleActions(details: ExchangeMailboxRuleDetails): string | null {
  const summaries = details.actions.slice(0, 4).map((fact) => (
    fact.values.length ? `${fact.label}: ${fact.values.join(', ')}` : fact.label
  ))
  if (!summaries.length) return null
  const summary = summaries.join('; ')
  return summary.length <= 500 ? summary : `${summary.slice(0, 497)}...`
}
