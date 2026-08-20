import { safeExchangeMailboxRuleText } from './exchange-mailbox-rule-details.js'

export const RELATED_EXCHANGE_RULE_AUDIT_OPERATIONS = [
  'New-InboxRule',
  'Set-InboxRule',
  'Remove-InboxRule',
  'UpdateInboxRules',
] as const

export const RELATED_EXCHANGE_RULE_AUDIT_WINDOW_DAYS = 90
export const RELATED_EXCHANGE_RULE_AUDIT_CANDIDATE_LIMIT = 200
export const RELATED_EXCHANGE_RULE_AUDIT_RESULT_LIMIT = 8

type RelatedOperation = typeof RELATED_EXCHANGE_RULE_AUDIT_OPERATIONS[number]

export type RelatedExchangeRuleAuditRequest = {
  mailboxUpn: string
  ruleName: string | null
}

export type RelatedExchangeRuleAuditCandidate = {
  kind: 'possible_related_microsoft_audit_event'
  id: string
  operation: RelatedOperation
  microsoftEventTime: string
  microsoftReportedActor: string | null
  result: string | null
  source: 'Microsoft 365 Unified Audit'
  matchBasis: 'exact_mailbox' | 'exact_mailbox_and_rule_name'
}

export type RelatedExchangeRuleAuditResponse = {
  version: 1
  windowDays: 90
  events: RelatedExchangeRuleAuditCandidate[]
  truncated: boolean
  disclaimer: 'Possible related events do not prove that an event belongs to this exact current rule.'
}

type StoredAuditCandidate = {
  microsoftRecordId: unknown
  eventDateTime: unknown
  operation: unknown
  actorId: unknown
  result: unknown
  objectId?: unknown
  raw: unknown
}

const MAILBOX_PARAMETER_NAMES = new Set([
  'mailbox',
  'mailboxownerupn',
  'owner',
  'userprincipalname',
])
const RULE_NAME_PARAMETER_NAMES = new Set([
  'name',
  'rulename',
  'inboxrulename',
])
const OPERATION_SET = new Set<string>(RELATED_EXCHANGE_RULE_AUDIT_OPERATIONS)

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

function normalizedExact(value: string) {
  return value.trim().toLocaleLowerCase('en-US')
}

function parameterValues(raw: Record<string, unknown>, names: ReadonlySet<string>) {
  const parameters = own(raw, 'Parameters')
  if (!Array.isArray(parameters)) return [] as string[]
  const values: string[] = []
  for (const candidate of parameters.slice(0, 50)) {
    const parameter = plainRecord(candidate)
    if (!parameter) continue
    const name = safeExchangeMailboxRuleText(own(parameter, 'Name'))
    if (!name || !names.has(name.toLowerCase().replace(/[^a-z0-9]/g, ''))) continue
    const value = safeExchangeMailboxRuleText(own(parameter, 'Value'))
    if (value) values.push(value)
  }
  return values
}

function isoTime(value: unknown, now: Date) {
  const date = value instanceof Date
    ? value
    : typeof value === 'string'
      ? new Date(value)
      : null
  if (!date || !Number.isFinite(date.getTime()) || date.getTime() > now.getTime()) return null
  return date.toISOString()
}

export function normalizeRelatedExchangeRuleAuditRequest(
  mailboxUpn: unknown,
  ruleName: unknown,
): RelatedExchangeRuleAuditRequest | null {
  const mailbox = safeExchangeMailboxRuleText(mailboxUpn)
  if (
    !mailbox ||
    mailbox.length > 320 ||
    mailbox.includes(' ') ||
    mailbox.split('@').length !== 2 ||
    mailbox.startsWith('@') ||
    mailbox.endsWith('@')
  ) return null

  if (ruleName !== undefined && ruleName !== null && ruleName !== '') {
    const normalizedRuleName = safeExchangeMailboxRuleText(ruleName)
    if (!normalizedRuleName) return null
    return { mailboxUpn: mailbox, ruleName: normalizedRuleName }
  }
  return { mailboxUpn: mailbox, ruleName: null }
}

export function projectRelatedExchangeRuleAuditCandidate(
  value: StoredAuditCandidate,
  request: RelatedExchangeRuleAuditRequest,
  now = new Date(),
): RelatedExchangeRuleAuditCandidate | null {
  const operation = safeExchangeMailboxRuleText(value.operation)
  if (!operation || !OPERATION_SET.has(operation)) return null
  const id = safeExchangeMailboxRuleText(value.microsoftRecordId)
  const microsoftEventTime = isoTime(value.eventDateTime, now)
  const raw = plainRecord(value.raw)
  if (!id || !microsoftEventTime || !raw) return null

  const mailboxValues = [
    safeExchangeMailboxRuleText(own(raw, 'MailboxOwnerUPN')),
    safeExchangeMailboxRuleText(own(raw, 'TargetUserOrGroupName')),
    safeExchangeMailboxRuleText(value.objectId),
    safeExchangeMailboxRuleText(own(raw, 'ObjectId')),
    ...parameterValues(raw, MAILBOX_PARAMETER_NAMES),
  ].filter((entry): entry is string => Boolean(entry))
  const expectedMailbox = normalizedExact(request.mailboxUpn)
  if (!mailboxValues.some((entry) => normalizedExact(entry) === expectedMailbox)) return null

  const ruleNameValues = [
    safeExchangeMailboxRuleText(value.objectId),
    safeExchangeMailboxRuleText(own(raw, 'ObjectId')),
    ...parameterValues(raw, RULE_NAME_PARAMETER_NAMES),
  ].filter((entry): entry is string => Boolean(entry))
  const exactRuleName = request.ruleName
    ? ruleNameValues.some((entry) => normalizedExact(entry) === normalizedExact(request.ruleName!))
    : false

  return {
    kind: 'possible_related_microsoft_audit_event',
    id,
    operation: operation as RelatedOperation,
    microsoftEventTime,
    microsoftReportedActor: safeExchangeMailboxRuleText(value.actorId),
    result: safeExchangeMailboxRuleText(value.result),
    source: 'Microsoft 365 Unified Audit',
    matchBasis: exactRuleName ? 'exact_mailbox_and_rule_name' : 'exact_mailbox',
  }
}

export function buildRelatedExchangeRuleAuditResponse(
  values: StoredAuditCandidate[],
  request: RelatedExchangeRuleAuditRequest,
  options: { now?: Date; candidateScanTruncated?: boolean } = {},
): RelatedExchangeRuleAuditResponse {
  const now = options.now ?? new Date()
  const projected = values
    .map((value) => projectRelatedExchangeRuleAuditCandidate(value, request, now))
    .filter((event): event is RelatedExchangeRuleAuditCandidate => Boolean(event))
  return {
    version: 1,
    windowDays: RELATED_EXCHANGE_RULE_AUDIT_WINDOW_DAYS,
    events: projected.slice(0, RELATED_EXCHANGE_RULE_AUDIT_RESULT_LIMIT),
    truncated: Boolean(options.candidateScanTruncated) || projected.length > RELATED_EXCHANGE_RULE_AUDIT_RESULT_LIMIT,
    disclaimer: 'Possible related events do not prove that an event belongs to this exact current rule.',
  }
}
