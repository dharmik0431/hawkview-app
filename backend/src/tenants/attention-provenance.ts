/** Provenance is independent of severity, evidence completeness and routing. */
export const ATTENTION_COLLECTOR_RESOURCES = [
  'USERS', 'LICENSES', 'DOMAINS', 'GROUPS', 'AUTH_REGISTRATIONS', 'CONDITIONAL_ACCESS',
  'APPLICATIONS', 'SERVICE_PRINCIPALS', 'AUDIT_LOGS', 'M365_AUDIT', 'SIGN_INS',
  'SECURE_SCORES', 'DEVICES', 'DIRECTORY_ROLES', 'EXCHANGE_MAILBOXES',
  'EXCHANGE_MAILBOX_SETTINGS', 'EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOX_RULES',
  'SHAREPOINT_SITES', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE',
] as const
export type AttentionCollectorResource = typeof ATTENTION_COLLECTOR_RESOURCES[number]
type Owner = 'CUSTOMER_ADMIN' | 'HAWKVIEW_OPERATIONS' | 'UNDETERMINED'
export type TenantFindingKind = 'MICROSOFT_ACTIVE_RISK' | 'MFA_REGISTRATION_COVERAGE' |
  'CONDITIONAL_ACCESS_CHANGE' | 'AUTHENTICATION_CHANGE' | 'APPLICATION_ACCESS_CHANGE' | 'ADMINISTRATIVE_ROLE_CHANGE'
export type AttentionProvenance = { version: 1 } & (
  | { origin: 'TENANT_FINDING'; kind: TenantFindingKind; remediationOwner: 'CUSTOMER_ADMIN' }
  | { origin: 'ACCESS_CONFIGURATION'; kind: 'CONNECTION_UNAVAILABLE' | 'AUTHORIZATION_REQUIRED'; remediationOwner: 'CUSTOMER_ADMIN' | 'UNDETERMINED' }
  | { origin: 'COLLECTION_OPERATION'; kind: 'COLLECTOR_ATTENTION'; resourceType: AttentionCollectorResource; remediationOwner: 'HAWKVIEW_OPERATIONS' | 'UNDETERMINED' }
  | { origin: 'EVIDENCE_LIMITATION'; kind: 'LIMITED_SIGN_IN_EVIDENCE'; remediationOwner: 'UNDETERMINED' }
  | { origin: 'UNKNOWN'; kind: 'UNKNOWN'; remediationOwner: 'UNDETERMINED' }
)
export const unknownAttentionProvenance = (): AttentionProvenance => ({ version: 1, origin: 'UNKNOWN', kind: 'UNKNOWN', remediationOwner: 'UNDETERMINED' })
export const tenantFindingProvenance = (kind: TenantFindingKind): AttentionProvenance => ({ version: 1, origin: 'TENANT_FINDING', kind, remediationOwner: 'CUSTOMER_ADMIN' })
export function accessProvenance(kind: 'CONNECTION_UNAVAILABLE' | 'AUTHORIZATION_REQUIRED', customerActionSupported: boolean): AttentionProvenance {
  return { version: 1, origin: 'ACCESS_CONFIGURATION', kind, remediationOwner: customerActionSupported ? 'CUSTOMER_ADMIN' : 'UNDETERMINED' }
}
const operatorCodes = new Set(['MICROSOFT_TRANSIENT', 'MICROSOFT_THROTTLED', 'MICROSOFT_NETWORK_TIMEOUT',
  'MICROSOFT_DELTA_RESET_REQUIRED', 'HAWKVIEW_CAPACITY_GUARD', 'MICROSOFT_INVALID_RESPONSE',
  'HAWKVIEW_INTERNAL_FAILURE', 'sign-ins-record-validation-partial'])
export function collectorAttentionProvenance(resource: string, reasonCode: string | null): AttentionProvenance {
  if (!(ATTENTION_COLLECTOR_RESOURCES as readonly string[]).includes(resource)) return unknownAttentionProvenance()
  // Permission/credential failures alone do not identify who controls remediation.
  const knownOperatorIssue = operatorCodes.has(reasonCode ?? '') &&
    (reasonCode !== 'sign-ins-record-validation-partial' || resource === 'SIGN_INS')
  return { version: 1, origin: 'COLLECTION_OPERATION', kind: 'COLLECTOR_ATTENTION',
    resourceType: resource as AttentionCollectorResource,
    remediationOwner: knownOperatorIssue ? 'HAWKVIEW_OPERATIONS' : 'UNDETERMINED' }
}
export const limitedEvidenceProvenance = (): AttentionProvenance => ({ version: 1, origin: 'EVIDENCE_LIMITATION', kind: 'LIMITED_SIGN_IN_EVIDENCE', remediationOwner: 'UNDETERMINED' })

/** Historical/malformed/future tags are unclassified, not permission to drop an item. */
export function readAttentionProvenance(value: unknown): AttentionProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknownAttentionProvenance()
  const v = value as Record<string, unknown>
  if (v.version !== 1) return unknownAttentionProvenance()
  const keys = Object.keys(v).sort().join(',')
  const basicKeys = 'kind,origin,remediationOwner,version'
  const owner = v.remediationOwner as Owner
  if (keys === basicKeys && v.origin === 'TENANT_FINDING' && owner === 'CUSTOMER_ADMIN' && typeof v.kind === 'string' &&
    ['MICROSOFT_ACTIVE_RISK', 'MFA_REGISTRATION_COVERAGE', 'CONDITIONAL_ACCESS_CHANGE', 'AUTHENTICATION_CHANGE', 'APPLICATION_ACCESS_CHANGE', 'ADMINISTRATIVE_ROLE_CHANGE'].includes(v.kind)) return tenantFindingProvenance(v.kind as TenantFindingKind)
  if (keys === basicKeys && v.origin === 'ACCESS_CONFIGURATION' && ['CUSTOMER_ADMIN', 'UNDETERMINED'].includes(owner) &&
    (v.kind === 'CONNECTION_UNAVAILABLE' || v.kind === 'AUTHORIZATION_REQUIRED')) return accessProvenance(v.kind, owner === 'CUSTOMER_ADMIN')
  if (keys === 'kind,origin,remediationOwner,resourceType,version' && v.origin === 'COLLECTION_OPERATION' && v.kind === 'COLLECTOR_ATTENTION' &&
    typeof v.resourceType === 'string' && (ATTENTION_COLLECTOR_RESOURCES as readonly string[]).includes(v.resourceType) &&
    ['HAWKVIEW_OPERATIONS', 'UNDETERMINED'].includes(owner)) return { version: 1, origin: 'COLLECTION_OPERATION', kind: 'COLLECTOR_ATTENTION', resourceType: v.resourceType as AttentionCollectorResource, remediationOwner: owner as 'HAWKVIEW_OPERATIONS' | 'UNDETERMINED' }
  if (keys === basicKeys && v.origin === 'EVIDENCE_LIMITATION' && v.kind === 'LIMITED_SIGN_IN_EVIDENCE' && owner === 'UNDETERMINED') return limitedEvidenceProvenance()
  return unknownAttentionProvenance()
}
