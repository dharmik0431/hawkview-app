export type ManagementActivityRole =
  | 'primary_change'
  | 'security_supporting_activity'
  | 'routine_activity'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizedOperation(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

const routineOperation =
  /(?:userloggedin|userloginfailed|signin|logon|file(?:accessed|previewed|downloaded|modified|uploaded|synced|deleted|moved|renamed|copied|recycled|restored)|folder(?:accessed|modified|created|deleted|moved|renamed)|pageviewed|searchquery|searchsession|usage(?:report)?|report(?:downloaded|exported|viewed))/i

const genericChangeOperation =
  /(?:^|[-_. ])(?:new|set|add|added|remove|removed|update|updated|create|created|delete|deleted|enable|enabled|disable|disabled|grant|granted|revoke|revoked|assign|assigned|unassign|unassigned|change|changed|modify|modified|restore|restored|reset|install|installed|uninstall|uninstalled|activate|activated|deactivate|deactivated)(?:[-_. ]|$)|(?:policy|permission|consent|role|administrator|admin|sharing|anonymouslink|companylink|securelink|inboxrule|transportrule|forwarding|delegation|domain|license|mailbox|sitecollection|teamsetting|channelsetting)/i

const exchangeAdministrativeOperation =
  /(?:inboxrule|transportrule|mailboxpermission|recipientpermission|sendaspermission|forwarding|accepted.?domain|remote.?domain|organizationconfig|sharingpolicy|retentionpolicy|roleassignmentpolicy|journalrule|adminauditlog|malwarefilter|antiphish|hostedcontentfilter|safeattachment|safelink|quarantinepolicy|dlppolicy)|^(?:new|set|remove|enable|disable)-(?:mailbox|casmailbox)$/i

const exchangeSupportingOperations = new Set([
  'move',
  'delete',
  'movetodeleteditems',
  'softdelete',
  'harddelete',
  'sendas',
  'sendonbehalf',
  'mailitemsaccessed',
  'messageaccessed',
])

const exchangeRoutineItemOperations = new Set([
  'create',
  'update',
  'copy',
  'send',
])

/**
 * Classify Office 365 Management Activity records by their investigation role.
 *
 * The operation verb is not enough: Exchange uses generic verbs such as
 * `Create` and `Delete` for ordinary mailbox items. Those records can support
 * a compromise investigation, but they are not themselves tenant changes.
 */
export function classifyManagementActivity(
  record: unknown,
): ManagementActivityRole {
  const value = object(record)
  const operation = text(value.Operation) ?? ''
  const workload = text(value.Workload) ?? ''
  const result = (text(value.ResultStatus) ?? '').toLowerCase()
  if (!operation || /^(failed|failure|false)$/i.test(result)) {
    return 'routine_activity'
  }

  const compactOperation = normalizedOperation(operation)
  const isExchange = /exchange/i.test(workload)

  // Explicit Exchange administrative nouns win over generic telemetry rules.
  // This preserves inbox rules, forwarding, delegation, transport rules, and
  // tenant/mailbox configuration even if Microsoft uses a generic change verb.
  if (isExchange && exchangeAdministrativeOperation.test(operation)) {
    return 'primary_change'
  }

  if (isExchange && exchangeSupportingOperations.has(compactOperation)) {
    return 'security_supporting_activity'
  }

  if (isExchange && exchangeRoutineItemOperations.has(compactOperation)) {
    return 'routine_activity'
  }

  if (routineOperation.test(operation)) return 'routine_activity'

  const normalized = operation.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return genericChangeOperation.test(normalized)
    ? 'primary_change'
    : 'routine_activity'
}

export function managementActivityRoleFromEvidence(input: {
  operationName: string
  workload?: string | null
  raw?: unknown
}): ManagementActivityRole {
  const raw = object(input.raw)
  const recordedRole = text(raw.hawkviewEvidenceRole)
  if (
    recordedRole === 'primary_change' ||
    recordedRole === 'security_supporting_activity' ||
    recordedRole === 'routine_activity'
  ) {
    return recordedRole
  }
  return classifyManagementActivity({
    ...raw,
    Operation: text(raw.Operation) ?? input.operationName,
    Workload: text(raw.Workload) ?? input.workload,
  })
}
