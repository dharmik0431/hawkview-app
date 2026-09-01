export const EVIDENCE_TRUST_CATALOG_VERSION = 1 as const

export type EvidenceTrustClass =
  | 'PRIMARY_CHANGE'
  | 'SECURITY_SUPPORTING_ACTIVITY'
  | 'INFORMATIONAL_ACTIVITY'
  | 'AUTHENTICATION_EVIDENCE'
  | 'SYSTEM_OR_COLLECTION_EVENT'

export type EvidenceTrustClassification =
  | 'configuration_change'
  | 'permission_change'
  | 'identity_change'
  | 'security_control_change'
  | 'administrative_action'
  | 'authentication_evidence'
  | 'security_supporting_activity'
  | 'system_or_collection_event'

export type EvidenceTrustDecision = Readonly<{
  version: 1
  evidenceClass: EvidenceTrustClass
  visibility: 'PRIMARY' | 'SUPPORTING' | 'INFORMATIONAL' | 'HIDDEN'
  classification: EvidenceTrustClassification
  catalogId: string
  category: 'Exchange' | 'SharePoint' | 'Groups' | 'Apps' | 'Roles' | 'Conditional Access' | 'MFA' | 'Passwords' | 'Users' | 'Devices' | 'Licenses' | 'Domains' | 'Organization' | 'Unknown'
  severity: 'Low' | 'Medium' | 'High'
  source: string
  provenance: string
  confidence: 'HIGH' | 'LOW'
}>

export type EvidenceTrustInput = {
  source?: string | null
  workload?: string | null
  operation?: string | null
  category?: string | null
  operationType?: string | null
  targetResourceTypes?: Array<string | null | undefined>
  actor?: string | null
  result?: string | null
  beforeState?: unknown
  afterState?: unknown
}

function words(value: string | null | undefined) {
  return (value ?? '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
}

function meaningful(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (Array.isArray(value)) return value.some(meaningful)
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(meaningful)
  return true
}

function hasExplicitNonSuccessfulResult(value: string | null | undefined) {
  if (!value?.trim()) return false
  return !['success', 'succeeded', 'completed', 'true', 'partially succeeded'].includes(words(value))
}

export function isReadOnlyEvidenceOperation(operation: string | null | undefined, operationType?: string | null) {
  const operationWords = words(operation)
  const typeWords = words(operationType)
  const tokens = new Set(`${operationWords} ${typeWords}`.split(/\s+/).filter(Boolean))
  return ['get', 'list', 'read', 'report', 'export', 'view', 'search', 'query', 'lookup'].some((token) => tokens.has(token)) ||
    /(?:^|[_\-.])(get|list|read|report|export|view|search)(?:$|[_\-.])/i.test(operation ?? '') ||
    /(?:get|list|read|report|export|view|search)(?:async)?$/i.test((operation ?? '').replace(/[^a-z0-9]/gi, ''))
}

function decision(
  input: EvidenceTrustInput,
  values: Omit<EvidenceTrustDecision, 'version' | 'source' | 'provenance'>,
): EvidenceTrustDecision {
  const source = input.source?.trim() || 'Microsoft evidence'
  return Object.freeze({ version: EVIDENCE_TRUST_CATALOG_VERSION, source, provenance: source, ...values })
}

function hidden(input: EvidenceTrustInput, catalogId: string, confidence: 'HIGH' | 'LOW' = 'HIGH') {
  return decision(input, {
    evidenceClass: 'SYSTEM_OR_COLLECTION_EVENT', visibility: 'HIDDEN',
    classification: 'system_or_collection_event', catalogId, category: 'Unknown', severity: 'Low', confidence,
  })
}

type PrimaryClassification = Extract<EvidenceTrustClassification,
  'configuration_change' | 'permission_change' | 'identity_change' | 'security_control_change' | 'administrative_action'>
type KnownCategory = Exclude<EvidenceTrustDecision['category'], 'Unknown'>

function primary(
  input: EvidenceTrustInput,
  catalogId: string,
  classification: PrimaryClassification,
  category: KnownCategory,
  severity: 'Medium' | 'High',
) {
  return decision(input, {
    evidenceClass: 'PRIMARY_CHANGE', visibility: 'PRIMARY', classification,
    catalogId, category, severity, confidence: 'HIGH',
  })
}

const SNAPSHOT_OPERATIONS: Readonly<Record<string, readonly [PrimaryClassification, KnownCategory, 'Medium' | 'High']>> = Object.freeze({
  'microsoft 365 subscription changed': ['configuration_change', 'Licenses', 'Medium'],
  'microsoft 365 organization identity changed': ['configuration_change', 'Organization', 'Medium'],
  'microsoft 365 domain configuration changed': ['configuration_change', 'Domains', 'Medium'],
  'microsoft entra group configuration changed': ['identity_change', 'Groups', 'Medium'],
  'authentication method policy changed': ['security_control_change', 'MFA', 'High'],
  'conditional access policy changed': ['security_control_change', 'Conditional Access', 'High'],
  'conditional access named location changed': ['security_control_change', 'Conditional Access', 'High'],
  'directory role assignment changed': ['administrative_action', 'Roles', 'High'],
  'service principal configuration changed': ['permission_change', 'Apps', 'High'],
  'application registration changed': ['permission_change', 'Apps', 'High'],
  'security defaults changed': ['security_control_change', 'Conditional Access', 'High'],
  'sharepoint site configuration changed': ['configuration_change', 'SharePoint', 'Medium'],
  'sharepoint tenant sharing setting changed': ['configuration_change', 'SharePoint', 'High'],
  'exchange accepted domain changed': ['configuration_change', 'Exchange', 'Medium'],
  'exchange inbox rule changed': ['configuration_change', 'Exchange', 'High'],
})

function classifySnapshot(input: EvidenceTrustInput, operationWords: string) {
  const entry = SNAPSHOT_OPERATIONS[operationWords]
  return entry
    ? primary(input, `snapshot.${operationWords.replaceAll(' ', '-')}`, entry[0], entry[1], entry[2])
    : hidden(input, 'system.unreviewed-snapshot', 'LOW')
}

function classifyDirectoryAudit(input: EvidenceTrustInput, operationWords: string) {
  const operationType = words(input.operationType)
  const targetTypes = words((input.targetResourceTypes ?? []).filter(Boolean).join(' '))
  if (!['add', 'assign', 'create', 'delete', 'remove', 'update'].includes(operationType)) {
    return hidden(input, 'system.directory-nonmutation')
  }

  if (/\b(conditional access|named location|sign in frequency|authentication method|security info|strong authentication|security default|mfa)\b/.test(operationWords) &&
      /\b(conditional access|named location|authentication method|identity security defaults|policy)\b/.test(targetTypes)) {
    return primary(input, 'entra.security-control', 'security_control_change', /authentication method|security info|strong authentication|mfa/.test(operationWords) ? 'MFA' : 'Conditional Access', 'High')
  }
  if (/\b(application|service principal|app registration|credential|consent|permission|app role)\b/.test(operationWords) &&
      /\b(application|service principal|oauth|app role|permission grant)\b/.test(targetTypes)) {
    return primary(input, 'entra.application-permission', 'permission_change', 'Apps', 'High')
  }
  if (/\b(role assignment|directory role|administrator|eligible assignment)\b/.test(operationWords) &&
      /\b(role|role assignment|unified role|directory role)\b/.test(targetTypes)) {
    return primary(input, 'entra.role-administration', 'administrative_action', 'Roles', 'High')
  }
  if (/\b(add|remove|delete)\b.*\b(member|owner)\b.*\bgroup\b|\b(add|remove) member to group\b/.test(operationWords) &&
      /\b(group|user)\b/.test(targetTypes)) {
    return primary(input, 'entra.group-membership', 'identity_change', 'Groups', 'Medium')
  }
  if (/\b(create|update|delete|disable) user\b|\breset (user )?password\b/.test(operationWords) && /\buser\b/.test(targetTypes)) {
    return primary(input, 'entra.user-administration', 'administrative_action', /password/.test(operationWords) ? 'Passwords' : 'Users', 'High')
  }
  if (/\b(add|remove|update|assign)\b.*\blicense\b/.test(operationWords) && /\b(user|license|assigned license)\b/.test(targetTypes)) {
    return primary(input, 'entra.license-administration', 'configuration_change', 'Licenses', 'Medium')
  }
  if (/\b(update|set|change)\b.*\b(directory )?synchronization configuration\b/.test(operationWords) && /\b(synchronization job|synchronization schema|synchronization)\b/.test(targetTypes)) {
    return primary(input, 'entra.synchronization-configuration', 'configuration_change', 'Organization', 'High')
  }
  if (/\bset company information\b/.test(operationWords) && /\b(company|organization|tenant)\b/.test(targetTypes) &&
      (meaningful(input.beforeState) || meaningful(input.afterState))) {
    return primary(input, 'entra.company-information', 'identity_change', 'Organization', 'Medium')
  }
  return hidden(input, 'system.unreviewed-directory-operation', 'LOW')
}

const LEGACY_DIRECTORY_PROJECTIONS: Readonly<Record<string, readonly [PrimaryClassification, KnownCategory, 'Medium' | 'High']>> = Object.freeze({
  'update application|apps': ['permission_change', 'Apps', 'High'],
  'update application credential|apps': ['permission_change', 'Apps', 'High'],
  'add application|apps': ['permission_change', 'Apps', 'High'],
  'add app role assignment|apps': ['permission_change', 'Apps', 'High'],
  'update group|groups': ['identity_change', 'Groups', 'Medium'],
  'add group|groups': ['identity_change', 'Groups', 'Medium'],
  'add member to group|groups': ['identity_change', 'Groups', 'Medium'],
  'reset user password|passwords': ['administrative_action', 'Passwords', 'High'],
  'update user|users': ['identity_change', 'Users', 'Medium'],
  'update organization|organization': ['configuration_change', 'Organization', 'Medium'],
})

/**
 * Explicit compatibility catalog for retained normalized directory projections
 * created before structured operation metadata was persisted. Raw directory
 * audit rows never use this path.
 */
export function classifyLegacyDirectoryProjection(input: EvidenceTrustInput): EvidenceTrustDecision {
  if (hasExplicitNonSuccessfulResult(input.result)) return hidden(input, 'system.failed-legacy-directory', 'LOW')
  if (/microsoft azure ad internal|microsoft entra internal/.test(words(input.actor))) {
    return hidden(input, 'system.microsoft-service')
  }
  const key = `${words(input.operation)}|${words(input.category)}`
  const entry = LEGACY_DIRECTORY_PROJECTIONS[key]
  return entry
    ? primary(input, `legacy-directory.${key.replaceAll(' ', '-').replace('|', '.')}`, entry[0], entry[1], entry[2])
    : hidden(input, 'system.unreviewed-legacy-directory', 'LOW')
}

function classifyManagementActivity(input: EvidenceTrustInput, operationWords: string, workloadWords: string) {
  if (/microsoft to do|todo/.test(workloadWords) || /\b(task|todo)\b/.test(operationWords)) {
    return decision(input, { evidenceClass: 'INFORMATIONAL_ACTIVITY', visibility: 'INFORMATIONAL', classification: 'system_or_collection_event', catalogId: 'informational.todo-task', category: 'Unknown', severity: 'Low', confidence: 'HIGH' })
  }
  if (/teams/.test(workloadWords) && /\b(message|chat|reaction|call|meeting|recording|transcript)\b/.test(operationWords)) {
    return decision(input, { evidenceClass: 'INFORMATIONAL_ACTIVITY', visibility: 'INFORMATIONAL', classification: 'system_or_collection_event', catalogId: 'informational.teams-collaboration', category: 'Unknown', severity: 'Low', confidence: 'HIGH' })
  }
  if (/\b(sync|synchronization|usage|telemetry|collector|heartbeat|poll|refresh|inventory)\b/.test(operationWords) &&
      !/\b(update|set|change|configure|configuration|policy|schedule)\b/.test(operationWords)) {
    return hidden(input, 'system.collection-telemetry')
  }
  if (/microsoft azure ad internal|microsoft exchange hosted organizations|systemmailbox|healthmailbox/.test(words(input.actor))) {
    return hidden(input, 'system.microsoft-service')
  }

  const exchangeAdmin = /\b(inbox rule|transport rule|mailbox permission|recipient permission|send as permission|forwarding|accepted domain|remote domain|organization config|sharing policy|retention policy|role assignment policy|journal rule|admin audit log|malware filter|anti phish|hosted content filter|safe attachment|safe link|quarantine policy|dlp policy)\b|^(?:new|set|remove|enable|disable) (?:mailbox|cas mailbox)$/
  if (/exchange/.test(workloadWords) && exchangeAdmin.test(operationWords)) {
    return primary(input, 'exchange.administration', 'configuration_change', 'Exchange', 'High')
  }
  if (/exchange/.test(workloadWords) && /^(move|delete|move to deleted items|soft delete|hard delete|send as|send on behalf|mail items accessed|message accessed)$/.test(operationWords)) {
    return decision(input, { evidenceClass: 'SECURITY_SUPPORTING_ACTIVITY', visibility: 'SUPPORTING', classification: 'security_supporting_activity', catalogId: 'exchange.supporting-mailbox-activity', category: 'Exchange', severity: 'Low', confidence: 'HIGH' })
  }
  if (/share ?point/.test(workloadWords) && /\b(site collection admin added|sharing set|added to secure link|set spo tenant)\b/.test(operationWords)) {
    return primary(input, 'sharepoint.administration', 'configuration_change', 'SharePoint', 'High')
  }
  if (/teams/.test(workloadWords) && /\b(team setting changed|member added|member removed|channel deleted|team created)\b/.test(operationWords)) {
    return primary(input, 'teams.administration', /member added|member removed/.test(operationWords) ? 'identity_change' : 'configuration_change', 'Groups', 'Medium')
  }
  if (/azure active directory|azure ad|entra/.test(workloadWords) && /\b(conditional access|named location|authentication method|security default)\b/.test(operationWords)) {
    return primary(input, 'entra.security-control', 'security_control_change', /authentication method/.test(operationWords) ? 'MFA' : 'Conditional Access', 'High')
  }
  if (/azure active directory|azure ad|entra/.test(workloadWords) && /\b(service principal|application|app registration|credential|consent|permission|app role)\b/.test(operationWords) && /\b(add|remove|update|set|grant|revoke|consent|create|delete)\b/.test(operationWords)) {
    return primary(input, 'entra.application-permission', 'permission_change', 'Apps', 'High')
  }
  if (/azure active directory|azure ad|entra/.test(workloadWords) && /\b(role assignment|directory role|administrator|eligible assignment)\b/.test(operationWords) && /\b(add|remove|update|assign|unassign|activate|deactivate)\b/.test(operationWords)) {
    return primary(input, 'entra.role-administration', 'administrative_action', 'Roles', 'High')
  }
  if (/azure active directory|azure ad|entra/.test(workloadWords) && /\b(add|remove)\b.*\b(member|owner)\b.*\bgroup\b/.test(operationWords)) {
    return primary(input, 'entra.group-membership', 'identity_change', 'Groups', 'Medium')
  }
  return hidden(input, 'system.unreviewed-management-operation', 'LOW')
}

/**
 * Versioned, source-aware and fail-closed classification. Only exact reviewed
 * source/workload/operation/resource combinations can reach primary change or
 * high-risk surfaces. Presentation strings and arbitrary payload keywords are
 * never classification inputs.
 */
export function classifyEvidenceTrust(input: EvidenceTrustInput): EvidenceTrustDecision {
  const operation = input.operation?.trim() ?? ''
  const operationWords = words(operation)
  const workloadWords = words(input.workload)
  const sourceWords = words(input.source)

  if (sourceWords === 'sign in') {
    return decision(input, { evidenceClass: 'AUTHENTICATION_EVIDENCE', visibility: 'SUPPORTING', classification: 'authentication_evidence', catalogId: 'authentication.sign-in', category: 'Unknown', severity: 'Low', confidence: 'HIGH' })
  }
  if (!operation) return hidden(input, 'system.invalid-or-failed', 'LOW')
  if (isReadOnlyEvidenceOperation(operation, input.operationType)) return hidden(input, 'system.read-only')
  if (sourceWords === 'snapshot difference') return classifySnapshot(input, operationWords)
  if (hasExplicitNonSuccessfulResult(input.result)) return hidden(input, 'system.invalid-or-failed', 'LOW')
  if (sourceWords === 'directory audit') return classifyDirectoryAudit(input, operationWords)
  if (sourceWords.includes('office 365 management activity api') || sourceWords === 'm365 unified audit') {
    return classifyManagementActivity(input, operationWords, workloadWords)
  }
  return hidden(input, 'system.unreviewed-source', 'LOW')
}
