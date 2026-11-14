import type { NotificationIncident } from '../notifications/notifications.service.js'

export interface DirectoryAuditIncidentSource {
  microsoftAuditId: string
  eventDateTime: Date
  activityDisplayName: string
  result: string | null
  category: string | null
}

const AUTHENTICATION_TERMS = ['authentication method', 'mfa'] as const
const PASSWORD_TERMS = ['password'] as const
const APPLICATION_TERMS = ['application', 'service principal'] as const
const ROLE_TERMS = ['role', 'administrator'] as const

/** Shared with the retained-row repair selector; keep its SQL scan in sync. */
export const DIRECTORY_AUDIT_SECURITY_SEARCH_TERMS = [
  ...AUTHENTICATION_TERMS,
  ...PASSWORD_TERMS,
  ...APPLICATION_TERMS,
  ...ROLE_TERMS,
] as const

function containsAny(activity: string, terms: readonly string[]) {
  return terms.some((term) => activity.includes(term))
}

/** One classification and payload contract for collected and persisted audit rows. */
export function directoryAuditSecurityIncident(
  tenant: { id: string; organizationId: string },
  record: DirectoryAuditIncidentSource,
): (NotificationIncident & { customerTenantId: string }) | null {
  const activity = record.activityDisplayName.toLowerCase()
  const securityEvent =
    containsAny(activity, AUTHENTICATION_TERMS)
      ? { severity: 'critical' as const, label: 'Authentication methods changed' }
      : containsAny(activity, PASSWORD_TERMS)
        ? { severity: 'high' as const, label: 'Password-related change detected' }
        : containsAny(activity, APPLICATION_TERMS)
          ? { severity: 'high' as const, label: 'Application registration changed' }
          : containsAny(activity, ROLE_TERMS)
            ? { severity: 'critical' as const, label: 'Administrative role changed' }
            : null
  if (!securityEvent) return null

  return {
    organizationId: tenant.organizationId,
    customerTenantId: tenant.id,
    eventType: 'security.directory_change',
    category: securityEvent.severity === 'critical' ? 'error' : 'warning',
    severity: securityEvent.severity,
    // Only a successful audit result establishes that a change occurred.
    // Keep severity/routing policy unchanged for failed or unknown outcomes.
    title: record.result?.toLowerCase() === 'success'
      ? securityEvent.label
      : record.result?.toLowerCase() === 'failure'
        ? 'Directory security operation failed'
        : 'Directory security activity detected',
    description: record.activityDisplayName,
    dedupeKey: `security:directory-audit:${record.microsoftAuditId}`,
    source: 'microsoft.directoryAudit',
    actionUrl: `/what-changed?tenantId=${encodeURIComponent(tenant.id)}&from=${encodeURIComponent(record.eventDateTime.toISOString())}`,
    actionLabel: 'Investigate change',
    metadata: {
      microsoftAuditId: record.microsoftAuditId,
      eventDateTime: record.eventDateTime.toISOString(),
      result: record.result,
      category: record.category,
    },
  }
}
