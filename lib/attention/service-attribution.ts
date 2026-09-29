import { readAttentionProvenance, type AttentionCollectorResource, type TenantFindingKind } from '../../backend/src/tenants/attention-provenance.ts'
import { customerAttention } from './customer-attention.ts'

export type ServiceKey = 'o365' | 'entra' | 'exchange' | 'sharepoint'
// Only these finding kinds establish identity/authentication scope. Generic
// application access and administrative role changes do not identify a workload.
const FINDING_SERVICE: Record<TenantFindingKind, ServiceKey | null> = {
  MICROSOFT_ACTIVE_RISK: 'entra', MFA_REGISTRATION_COVERAGE: 'entra',
  CONDITIONAL_ACCESS_CHANGE: 'entra', AUTHENTICATION_CHANGE: 'entra',
  APPLICATION_ACCESS_CHANGE: null, ADMINISTRATIVE_ROLE_CHANGE: null,
}
// Resource identities describe collection coverage, never a security finding or
// the party who must repair it. Cross-workload resources remain unattributed.
const COLLECTION_SERVICE: Record<AttentionCollectorResource, ServiceKey | null> = {
  USERS: 'entra', LICENSES: null, DOMAINS: null, GROUPS: 'entra',
  AUTH_REGISTRATIONS: 'entra', CONDITIONAL_ACCESS: 'entra', APPLICATIONS: 'entra',
  SERVICE_PRINCIPALS: 'entra', AUDIT_LOGS: 'entra', M365_AUDIT: 'o365',
  SIGN_INS: 'entra', SECURE_SCORES: null, DEVICES: 'entra', DIRECTORY_ROLES: 'entra',
  EXCHANGE_MAILBOXES: 'exchange', EXCHANGE_MAILBOX_SETTINGS: 'exchange',
  EXCHANGE_ACCEPTED_DOMAINS: 'exchange', EXCHANGE_MAILBOX_RULES: 'exchange',
  SHAREPOINT_SITES: 'sharepoint', SHAREPOINT_SETTINGS: 'sharepoint', SHAREPOINT_USAGE: 'sharepoint',
}
export function serviceAttribution(value: unknown) {
  const customer = customerAttention(value)
  const services: Record<ServiceKey, { finding: boolean; evidenceGap: boolean }> = {
    o365: { finding: false, evidenceGap: false }, entra: { finding: false, evidenceGap: false },
    exchange: { finding: false, evidenceGap: false }, sharepoint: { finding: false, evidenceGap: false },
  }
  let unattributed = customer.accessActions.length + customer.unknown.length
  for (const item of customer.findings) {
    const p = readAttentionProvenance(item.provenance)
    const service = p.origin === 'TENANT_FINDING' ? FINDING_SERVICE[p.kind] : null
    if (service) services[service].finding = true
    else unattributed++
  }
  for (const item of customer.operations) {
    const p = readAttentionProvenance((item as { provenance?: unknown })?.provenance)
    const service = p.origin === 'COLLECTION_OPERATION' ? COLLECTION_SERVICE[p.resourceType] : null
    if (service) services[service].evidenceGap = true
    else unattributed++
  }
  if (customer.limitations.length) services.entra.evidenceGap = true
  return { services, unattributed }
}
