const MAX_VALUES = 20
const MAX_TEXT_LENGTH = 320

export type ExchangeRuleDrawerFact = {
  key: string
  label: string
  values: string[]
  truncated: boolean
  emphasis: 'standard' | 'destination' | 'destructive'
}

export type ExchangeRuleDrawerModel = {
  name: string
  microsoftRuleName: string | null
  mailboxUpn: string | null
  enabled: boolean | null
  hasError: boolean | null
  isReadOnly: boolean | null
  priority: number | null
  configurationCollectedAt: string | null
  conditions: ExchangeRuleDrawerFact[]
  exceptions: ExchangeRuleDrawerFact[]
  actions: ExchangeRuleDrawerFact[]
  destinations: ExchangeRuleDestination[]
  otherActions: ExchangeRuleDrawerFact[]
}

export type ExchangeRuleDestination = {
  key: 'copyToFolder' | 'delete' | 'forwardAsAttachmentTo' | 'forwardTo' | 'moveToFolder' | 'redirectTo'
  label: string
  values: string[]
  kind: 'folder' | 'recipient' | 'deleted-items'
  truncated: boolean
}

export type ExchangeRuleCategory = 'Forward' | 'Redirect' | 'Delete' | 'Move' | 'Other'
export type ExchangeRuleEnabledState = 'enabled' | 'disabled' | 'unknown'

export type ExchangeRuleRelatedAuditEvent = {
  kind: 'possible_related_microsoft_audit_event'
  id: string
  operation: 'New-InboxRule' | 'Set-InboxRule' | 'Remove-InboxRule' | 'UpdateInboxRules'
  microsoftEventTime: string
  microsoftReportedActor: string | null
  result: string | null
  source: 'Microsoft 365 Unified Audit'
  matchBasis: 'exact_mailbox' | 'exact_mailbox_and_rule_name'
}

export type ExchangeRuleRelatedAuditResponse = {
  version: 1
  windowDays: 90
  events: ExchangeRuleRelatedAuditEvent[]
  truncated: boolean
  disclaimer: 'Possible related events do not prove that an event belongs to this exact current rule.'
}

const RELATED_AUDIT_OPERATIONS = new Set([
  'New-InboxRule', 'Set-InboxRule', 'Remove-InboxRule', 'UpdateInboxRules',
])
const RELATED_AUDIT_MATCH_BASES = new Set([
  'exact_mailbox', 'exact_mailbox_and_rule_name',
])
const RELATED_AUDIT_RESULT_LIMIT = 8

const CONDITION_LABELS = Object.freeze({
  bodyContains: 'Message body contains', bodyOrSubjectContains: 'Body or subject contains',
  categories: 'Message category is', fromAddresses: 'From', hasAttachments: 'Has attachments',
  headerContains: 'Message header contains', importance: 'Importance is',
  isApprovalRequest: 'Is an approval request', isAutomaticForward: 'Is automatically forwarded',
  isAutomaticReply: 'Is an automatic reply', isEncrypted: 'Is encrypted',
  isMeetingRequest: 'Is a meeting request', isMeetingResponse: 'Is a meeting response',
  isNonDeliveryReport: 'Is a non-delivery report', isPermissionControlled: 'Has restricted permissions',
  isReadReceipt: 'Is a read receipt', isSigned: 'Is digitally signed', isVoicemail: 'Is voicemail',
  messageActionFlag: 'Message action flag is', notSentToMe: 'Was not sent directly to this mailbox',
  recipientContains: 'Recipient address contains', senderContains: 'Sender contains',
  sensitivity: 'Sensitivity is', sentCcMe: 'Mailbox is copied (Cc)',
  sentOnlyToMe: 'Sent only to this mailbox', sentToAddresses: 'Sent to',
  sentToMe: 'Sent to this mailbox', sentToOrCcMe: 'Sent or copied to this mailbox',
  subjectContains: 'Subject contains', withinSizeRange: 'Message size range',
} as const)

const ACTIONS = Object.freeze({
  assignCategories: { label: 'Assign categories', emphasis: 'standard' },
  copyToFolder: { label: 'Copy to folder ID', emphasis: 'destination' },
  delete: { label: 'Move message to Deleted Items', emphasis: 'destructive' },
  forwardAsAttachmentTo: { label: 'Forward as attachment to', emphasis: 'destination' },
  forwardTo: { label: 'Forward to', emphasis: 'destination' },
  markAsRead: { label: 'Mark as read', emphasis: 'destructive' },
  markImportance: { label: 'Set importance to', emphasis: 'standard' },
  moveToFolder: { label: 'Move to folder ID', emphasis: 'destination' },
  permanentDelete: { label: 'Permanently delete message', emphasis: 'destructive' },
  redirectTo: { label: 'Redirect to', emphasis: 'destination' },
  stopProcessingRules: { label: 'Stop processing additional rules', emphasis: 'destructive' },
} as const)

const CONDITION_BOOLEAN_KEYS = new Set([
  'hasAttachments', 'isApprovalRequest', 'isAutomaticForward', 'isAutomaticReply', 'isEncrypted',
  'isMeetingRequest', 'isMeetingResponse', 'isNonDeliveryReport', 'isPermissionControlled',
  'isReadReceipt', 'isSigned', 'isVoicemail', 'notSentToMe', 'sentCcMe', 'sentOnlyToMe',
  'sentToMe', 'sentToOrCcMe',
])
const ACTION_BOOLEAN_KEYS = new Set([
  'delete', 'markAsRead', 'permanentDelete', 'stopProcessingRules',
])

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_TEXT_LENGTH) return null
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
  if (/https:\/\/[^\s/]*@/i.test(inspected) || inspected.includes('#')) return null
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

function collectedAt(value: unknown, now: Date): string | null {
  if (typeof value !== 'string' || value.length > 40) return null
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() > now.getTime()) return null
  return parsed.toISOString() === value ? value : null
}

export function exchangeRuleEnabledState(value: unknown): ExchangeRuleEnabledState {
  const rule = record(value)
  const enabled = rule ? own(rule, 'enabled') : undefined
  return enabled === true ? 'enabled' : enabled === false ? 'disabled' : 'unknown'
}

export function exchangeRulePriority(value: unknown): number | null {
  const rule = record(value)
  const priority = rule ? own(rule, 'priority') : undefined
  return typeof priority === 'number' && Number.isSafeInteger(priority) && priority >= 0 && priority <= 1_000_000
    ? priority
    : null
}

export function compareExchangeRulePriority(left: unknown, right: unknown): number {
  const leftPriority = exchangeRulePriority(left)
  const rightPriority = exchangeRulePriority(right)
  if (leftPriority === null && rightPriority === null) return 0
  if (leftPriority === null) return 1
  if (rightPriority === null) return -1
  return leftPriority - rightPriority
}

export function classifyExchangeRule(value: unknown): ExchangeRuleCategory {
  const rule = record(value)
  if (!rule) return 'Other'
  const detailsValue = own(rule, 'details')
  const details = record(detailsValue)
  const actionKeys = new Set<string>()

  if (details) {
    for (const fact of normalizeFacts(own(details, 'actions'), ACTIONS, true)) actionKeys.add(fact.key)
  } else if (detailsValue === null || detailsValue === undefined) {
    // Bounded compatibility for pre-projection bundles. Names and descriptions are never evidence.
    const legacyActions = own(rule, 'actions')
    if (Array.isArray(legacyActions)) {
      for (const candidate of legacyActions.slice(0, 32)) {
        const key = text(candidate)
        if (key && Object.prototype.hasOwnProperty.call(ACTIONS, key)) actionKeys.add(key)
      }
    }
  }

  if (actionKeys.has('redirectTo')) return 'Redirect'
  if (actionKeys.has('forwardTo') || actionKeys.has('forwardAsAttachmentTo')) return 'Forward'
  if (actionKeys.has('permanentDelete') || actionKeys.has('delete')) return 'Delete'
  if (actionKeys.has('moveToFolder') || actionKeys.has('copyToFolder')) return 'Move'
  return 'Other'
}

function normalizeFacts(
  value: unknown,
  labels: Readonly<Record<string, string | { label: string; emphasis: string }>>,
  actionFacts: boolean,
): ExchangeRuleDrawerFact[] {
  if (!Array.isArray(value)) return []
  const facts: ExchangeRuleDrawerFact[] = []
  const seen = new Set<string>()
  for (const candidate of value.slice(0, 32)) {
    const item = record(candidate)
    const key = item ? text(own(item, 'key')) : null
    if (!item || !key || seen.has(key) || !Object.prototype.hasOwnProperty.call(labels, key)) continue
    const definition = labels[key]
    const candidateValues = own(item, 'values')
    const rawValues = Array.isArray(candidateValues) ? candidateValues : []
    const values = rawValues.slice(0, MAX_VALUES).map(text).filter((entry): entry is string => Boolean(entry))
    const valuesOptional = actionFacts ? ACTION_BOOLEAN_KEYS.has(key) : CONDITION_BOOLEAN_KEYS.has(key)
    if (!values.length && !valuesOptional) continue
    seen.add(key)
    facts.push({
      key,
      label: typeof definition === 'string' ? definition : definition.label,
      values,
      truncated: own(item, 'truncated') === true || rawValues.length > MAX_VALUES,
      emphasis: actionFacts && typeof definition !== 'string'
        ? definition.emphasis as ExchangeRuleDrawerFact['emphasis']
        : 'standard',
    })
  }
  return facts
}

function projectDestinations(actions: ExchangeRuleDrawerFact[]): ExchangeRuleDestination[] {
  const destinations: ExchangeRuleDestination[] = []
  for (const action of actions) {
    if (action.key === 'delete') {
      destinations.push({
        key: 'delete', label: 'Move to Deleted Items', values: ['Deleted Items'],
        kind: 'deleted-items', truncated: false,
      })
      continue
    }
    if (action.key === 'moveToFolder' || action.key === 'copyToFolder') {
      destinations.push({
        key: action.key, label: action.label, values: action.values,
        kind: 'folder', truncated: action.truncated,
      })
      continue
    }
    if (action.key === 'forwardTo' || action.key === 'redirectTo' || action.key === 'forwardAsAttachmentTo') {
      destinations.push({
        key: action.key, label: action.label, values: action.values,
        kind: 'recipient', truncated: action.truncated,
      })
    }
  }
  return destinations
}

const DESTINATION_ACTION_KEYS = new Set([
  'copyToFolder', 'delete', 'forwardAsAttachmentTo', 'forwardTo', 'moveToFolder', 'redirectTo',
])

export function normalizeExchangeRuleDrawer(value: unknown, now = new Date()): ExchangeRuleDrawerModel | null {
  const rule = record(value)
  if (!rule) return null
  const details = record(own(rule, 'details'))
  const rawPriority = own(rule, 'priority')
  const microsoftRuleName = text(own(rule, 'microsoftRuleName'))
  const displayName = text(own(rule, 'name'))
  const actions = normalizeFacts(details ? own(details, 'actions') : null, ACTIONS, true)
  return {
    name: displayName ?? microsoftRuleName ?? 'Unnamed inbox rule',
    microsoftRuleName,
    mailboxUpn: text(own(rule, 'mailboxUpn')),
    enabled: typeof own(rule, 'enabled') === 'boolean' ? own(rule, 'enabled') as boolean : null,
    hasError: typeof own(rule, 'hasError') === 'boolean' ? own(rule, 'hasError') as boolean : null,
    isReadOnly: typeof own(rule, 'isReadOnly') === 'boolean' ? own(rule, 'isReadOnly') as boolean : null,
    priority: typeof rawPriority === 'number' && Number.isSafeInteger(rawPriority) && rawPriority >= 0 && rawPriority <= 1_000_000
      ? rawPriority
      : null,
    configurationCollectedAt: collectedAt(own(rule, 'configurationCollectedAt'), now),
    conditions: normalizeFacts(details ? own(details, 'conditions') : null, CONDITION_LABELS, false),
    exceptions: normalizeFacts(details ? own(details, 'exceptions') : null, CONDITION_LABELS, false),
    actions,
    destinations: projectDestinations(actions),
    otherActions: actions.filter((action) => !DESTINATION_ACTION_KEYS.has(action.key)),
  }
}

export function exchangeRuleRelatedAuditParams(
  rule: ExchangeRuleDrawerModel | null,
): Record<string, string> | null {
  if (!rule?.mailboxUpn) return null
  return rule.microsoftRuleName
    ? { mailboxUpn: rule.mailboxUpn, ruleName: rule.microsoftRuleName }
    : { mailboxUpn: rule.mailboxUpn }
}

export function normalizeExchangeRuleRelatedAuditResponse(
  value: unknown,
  now = new Date(),
): ExchangeRuleRelatedAuditResponse | null {
  const response = record(value)
  if (!response || own(response, 'version') !== 1 || own(response, 'windowDays') !== 90) return null
  const rawEvents = own(response, 'events')
  if (!Array.isArray(rawEvents) || rawEvents.length > RELATED_AUDIT_RESULT_LIMIT) return null

  const events: ExchangeRuleRelatedAuditEvent[] = []
  const seen = new Set<string>()
  for (const candidate of rawEvents) {
    const event = record(candidate)
    const id = event ? text(own(event, 'id')) : null
    const operation = event ? text(own(event, 'operation')) : null
    const microsoftEventTime = event ? collectedAt(own(event, 'microsoftEventTime'), now) : null
    const source = event ? own(event, 'source') : null
    const matchBasis = event ? text(own(event, 'matchBasis')) : null
    if (
      !event ||
      own(event, 'kind') !== 'possible_related_microsoft_audit_event' ||
      !id || seen.has(id) ||
      !operation || !RELATED_AUDIT_OPERATIONS.has(operation) ||
      !microsoftEventTime ||
      source !== 'Microsoft 365 Unified Audit' ||
      !matchBasis || !RELATED_AUDIT_MATCH_BASES.has(matchBasis)
    ) continue
    seen.add(id)
    events.push({
      kind: 'possible_related_microsoft_audit_event',
      id,
      operation: operation as ExchangeRuleRelatedAuditEvent['operation'],
      microsoftEventTime,
      microsoftReportedActor: text(own(event, 'microsoftReportedActor')),
      result: text(own(event, 'result')),
      source: 'Microsoft 365 Unified Audit',
      matchBasis: matchBasis as ExchangeRuleRelatedAuditEvent['matchBasis'],
    })
  }

  return {
    version: 1,
    windowDays: 90,
    events,
    truncated: own(response, 'truncated') === true,
    disclaimer: 'Possible related events do not prove that an event belongs to this exact current rule.',
  }
}
