/**
 * Maps Microsoft Entra directory-audit operations to the smallest HawkView
 * collection that can make the local projection current again. This is a
 * conservative routing table: events we do not recognize stay available in
 * What Changed, but do not cause an unrelated inventory refresh.
 */
export const AUDIT_RECONCILIATION_RESOURCES = [
  'ORGANIZATION_CONFIGURATION',
  'GROUPS',
  'LICENSES',
  'DOMAINS',
  'DOMAIN_DNS_HEALTH',
  'AUTH_REGISTRATIONS',
  'AUTH_METHOD_POLICIES',
  'CONDITIONAL_ACCESS',
  'NAMED_LOCATIONS',
  'DEVICES',
  'DIRECTORY_ROLES',
  'SERVICE_PRINCIPALS',
  'APPLICATIONS',
  'SECURITY_DEFAULTS',
  'EXCHANGE_MAILBOXES',
  'EXCHANGE_MAILBOX_SETTINGS',
  'EXCHANGE_MAILBOX_CONFIGURATION',
  'EXCHANGE_MAILBOX_USAGE',
  'EXCHANGE_ACCEPTED_DOMAINS',
  'EXCHANGE_MAILBOX_RULES',
  'SHAREPOINT_SITES',
  'SHAREPOINT_SETTINGS',
  'SHAREPOINT_USAGE',
] as const

export type AuditReconciliationResource =
  (typeof AUDIT_RECONCILIATION_RESOURCES)[number]

export type DirectoryAuditChange = {
  activityDisplayName: string
  category?: string | null
  loggedByService?: string | null
  targetResources?: unknown
}

function normalizedAuditText(change: DirectoryAuditChange) {
  const targets = Array.isArray(change.targetResources)
    ? change.targetResources
        .map((target) =>
          target && typeof target === 'object'
            ? Object.values(target as Record<string, unknown>).join(' ')
            : String(target ?? '')
        )
        .join(' ')
    : ''
  return [
    change.activityDisplayName,
    change.category,
    change.loggedByService,
    targets,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()
}

// Only these documented organization display-name/profile operations may
// refresh the organization-identity snapshot.  Do not infer an identity
// update from targets, categories, or broad "update tenant" text: those can
// describe unrelated policy, subscription, or service operations.
const ORGANIZATION_CONFIGURATION_ACTIVITY_NAMES = new Set([
  'update organization',
  'update organization name',
  'update organization profile',
  'update tenant name',
])

function normalizedActivityDisplayName(change: DirectoryAuditChange) {
  return change.activityDisplayName.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Return the collection-level refreshes warranted by one audit event. Multiple
 * events in a poll are de-duplicated by `deriveAuditReconciliationResources`.
 */
export function deriveAuditReconciliationResourcesForChange(
  change: DirectoryAuditChange
): AuditReconciliationResource[] {
  const text = normalizedAuditText(change)
  const resources = new Set<AuditReconciliationResource>()

  if (/group|membership|member|owner/.test(text)) resources.add('GROUPS')
  if (/license|licence|subscription|sku/.test(text)) resources.add('LICENSES')
  // Organization identity is a separate, lightweight snapshot. Keep it
  // distinct from domain inventory so an administrator rename does not imply
  // a verified-domain change.
  if (ORGANIZATION_CONFIGURATION_ACTIVITY_NAMES.has(normalizedActivityDisplayName(change))) {
    resources.add('ORGANIZATION_CONFIGURATION')
  }
  if (/domain|dns|verified domain/.test(text)) {
    resources.add('DOMAINS')
    resources.add('DOMAIN_DNS_HEALTH')
  }
  if (/authentication method|mfa|multifactor|passwordless|passkey/.test(text)) {
    resources.add('AUTH_REGISTRATIONS')
    resources.add('AUTH_METHOD_POLICIES')
  }
  if (/conditional access/.test(text)) resources.add('CONDITIONAL_ACCESS')
  if (/named location|trusted location/.test(text)) resources.add('NAMED_LOCATIONS')
  if (/security default/.test(text)) resources.add('SECURITY_DEFAULTS')
  if (/device/.test(text)) resources.add('DEVICES')
  if (/directory role|role assignment|administrator role/.test(text)) {
    resources.add('DIRECTORY_ROLES')
  }
  if (/service principal|enterprise application/.test(text)) {
    resources.add('SERVICE_PRINCIPALS')
  }
  if (/application registration|app registration|application object/.test(text)) {
    resources.add('APPLICATIONS')
  }
  if (/mailbox|inbox rule|mail flow|exchange/.test(text)) {
    resources.add('EXCHANGE_MAILBOXES')
    resources.add('EXCHANGE_MAILBOX_SETTINGS')
    resources.add('EXCHANGE_MAILBOX_CONFIGURATION')
    resources.add('EXCHANGE_MAILBOX_USAGE')
    resources.add('EXCHANGE_MAILBOX_RULES')
    resources.add('EXCHANGE_ACCEPTED_DOMAINS')
  }
  if (/sharepoint|onedrive|site collection|site /.test(text)) {
    resources.add('SHAREPOINT_SITES')
    resources.add('SHAREPOINT_SETTINGS')
    resources.add('SHAREPOINT_USAGE')
  }

  return [...resources]
}

export function deriveAuditReconciliationResources(
  changes: DirectoryAuditChange[]
): AuditReconciliationResource[] {
  const resources = new Set<AuditReconciliationResource>()
  for (const change of changes) {
    for (const resource of deriveAuditReconciliationResourcesForChange(change)) {
      resources.add(resource)
    }
  }
  return [...resources]
}
