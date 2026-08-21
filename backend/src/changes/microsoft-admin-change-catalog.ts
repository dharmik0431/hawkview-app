/**
 * The Phase 1, code-owned contract for the administrative-change evidence
 * HawkView can honestly present.  An entry is not a promise that every tenant
 * will return every event: Microsoft licensing, workload configuration, and
 * the quality of the source payload still apply.
 */
export type EvidenceOrigin =
  | 'microsoft_audit_event'
  | 'hawkview_snapshot_difference'
  | 'correlated_audit_and_snapshot'

export type MicrosoftAdminChangeCatalogEntry = {
  workload: string
  normalizedEventType: string
  microsoftSource: string
  requiredPermission: string
  licenseDependency: string
  actorAvailability: 'Microsoft audit when supplied' | 'Not supplied by snapshot' | 'Varies'
  targetAvailability: 'Microsoft audit when supplied' | 'Snapshot identifier when supplied' | 'Varies'
  beforeAfterAvailability: 'Microsoft audit when supplied' | 'Snapshot selected fields' | 'Varies'
  collectorStatus: 'active_audit' | 'active_snapshot_difference' | 'audit_only' | 'not_collected'
  testStatus: 'covered' | 'gap_documented'
}

export const MICROSOFT_ADMIN_CHANGE_CATALOG: readonly MicrosoftAdminChangeCatalogEntry[] = [
  {
    workload: 'Microsoft 365 organization', normalizedEventType: 'organization_identity_difference',
    microsoftSource: 'Microsoft Graph /organization snapshot (id and displayName)', requiredPermission: 'Organization.Read.All',
    licenseDependency: 'No HawkView licensing assumption', actorAvailability: 'Not supplied by snapshot', targetAvailability: 'Snapshot identifier when supplied', beforeAfterAvailability: 'Snapshot selected fields', collectorStatus: 'active_snapshot_difference', testStatus: 'covered',
  },
  {
    workload: 'Microsoft Entra ID', normalizedEventType: 'user_group_role_and_license_change',
    microsoftSource: 'Microsoft Graph /auditLogs/directoryAudits', requiredPermission: 'AuditLog.Read.All',
    licenseDependency: 'Directory audit availability varies by tenant/license', actorAvailability: 'Microsoft audit when supplied', targetAvailability: 'Microsoft audit when supplied', beforeAfterAvailability: 'Microsoft audit when supplied', collectorStatus: 'active_audit', testStatus: 'covered',
  },
  {
    workload: 'Microsoft Entra ID', normalizedEventType: 'mfa_authentication_method_conditional_access_security_defaults_change',
    microsoftSource: 'Microsoft Graph /auditLogs/directoryAudits plus policy snapshots', requiredPermission: 'AuditLog.Read.All; Policy.Read.All; Policy.Read.AuthenticationMethod',
    licenseDependency: 'Conditional Access availability depends on tenant licensing', actorAvailability: 'Varies', targetAvailability: 'Varies', beforeAfterAvailability: 'Varies', collectorStatus: 'active_audit', testStatus: 'covered',
  },
  {
    workload: 'Microsoft Entra ID', normalizedEventType: 'application_service_principal_admin_consent_permission_change',
    microsoftSource: 'Microsoft Graph /auditLogs/directoryAudits plus applications/service principals snapshots', requiredPermission: 'AuditLog.Read.All; Application.Read.All',
    licenseDependency: 'No HawkView licensing assumption', actorAvailability: 'Varies', targetAvailability: 'Varies', beforeAfterAvailability: 'Varies', collectorStatus: 'active_audit', testStatus: 'covered',
  },
  {
    workload: 'Microsoft 365 domains', normalizedEventType: 'domain_default_or_verified_domain_difference',
    microsoftSource: 'Microsoft Graph /organization?$select=verifiedDomains snapshot (name, isDefault, isInitial only)', requiredPermission: 'Organization.Read.All',
    licenseDependency: 'No HawkView licensing assumption', actorAvailability: 'Not supplied by snapshot', targetAvailability: 'Snapshot identifier when supplied', beforeAfterAvailability: 'Snapshot selected fields', collectorStatus: 'active_snapshot_difference', testStatus: 'covered',
  },
  {
    workload: 'Microsoft 365 licensing', normalizedEventType: 'tenant_sku_capacity_or_status_difference',
    microsoftSource: 'Microsoft Graph /subscribedSkus snapshot', requiredPermission: 'Organization.Read.All',
    licenseDependency: 'No HawkView licensing assumption', actorAvailability: 'Not supplied by snapshot', targetAvailability: 'Snapshot identifier when supplied', beforeAfterAvailability: 'Snapshot selected fields', collectorStatus: 'active_snapshot_difference', testStatus: 'covered',
  },
  {
    workload: 'Exchange Online', normalizedEventType: 'mailbox_rule_or_accepted_domain_difference',
    microsoftSource: 'Microsoft Graph /users/{id}/mailFolders/inbox/messageRules and /organization?$select=verifiedDomains snapshots', requiredPermission: 'MailboxSettings.Read; Organization.Read.All',
    licenseDependency: 'Mailbox rule API availability varies by mailbox', actorAvailability: 'Not supplied by snapshot', targetAvailability: 'Snapshot identifier when supplied', beforeAfterAvailability: 'Snapshot selected fields', collectorStatus: 'active_snapshot_difference', testStatus: 'covered',
  },
  {
    workload: 'SharePoint and OneDrive', normalizedEventType: 'site_lifecycle_or_tenant_sharing_setting_difference',
    microsoftSource: 'Microsoft Graph /sites and /admin/sharepoint/settings snapshots', requiredPermission: 'Sites.Read.All; SharePointTenantSettings.Read.All',
    licenseDependency: 'Some report fields require Microsoft 365 usage reporting availability', actorAvailability: 'Not supplied by snapshot', targetAvailability: 'Snapshot identifier when supplied', beforeAfterAvailability: 'Snapshot selected fields', collectorStatus: 'active_snapshot_difference', testStatus: 'covered',
  },
  {
    workload: 'Teams and tenant-wide Microsoft 365 settings', normalizedEventType: 'administrative_configuration_change',
    microsoftSource: 'Not collected in Phase 1 from a reliable change source', requiredPermission: 'See Unified Audit Log gap report',
    licenseDependency: 'Varies by workload and audit licensing', actorAvailability: 'Varies', targetAvailability: 'Varies', beforeAfterAvailability: 'Varies', collectorStatus: 'not_collected', testStatus: 'gap_documented',
  },
] as const

export type SnapshotDifferenceSpec = {
  workload: string
  category: string
  severity: 'Low' | 'Medium' | 'High'
  operationName: string
  microsoftSource: string
  identifierFields: readonly string[]
  /** A stable identity formed from every listed field (for example mailbox + rule id). */
  compoundIdentifierFields?: readonly string[]
  trackedFields: readonly string[]
  impactCategory?: 'identity' | 'domain' | 'license' | 'audit_visibility' | 'exchange_configuration'
  /** Stable product-owned identifier. It is the only guidance field clients may trust. */
  impactId?: 'organization.identity_changed' | 'domains.configuration_changed' | 'licenses.subscription_changed'
  impactGuidance?: string
}

/**
 * This is deliberately a code-owned product statement, not source data.
 * It is derived only after the persisted evidence matches a known snapshot
 * resource and its static catalog metadata.
 */
export type ProductGuidance = Readonly<{
  kind: 'product_guidance'
  impactId: NonNullable<SnapshotDifferenceSpec['impactId']>
}>

// Only fields representing administrative state are compared.  Collection
// timestamps, report counters, and transient health data are intentionally
// absent so an inventory refresh cannot produce a fake change.
export const SNAPSHOT_DIFFERENCE_SPECS: Readonly<Record<string, SnapshotDifferenceSpec>> = {
  LICENSES: { workload: 'Microsoft 365 licensing', category: 'Licenses', severity: 'Medium', operationName: 'Microsoft 365 subscription changed', microsoftSource: 'Microsoft Graph /subscribedSkus', identifierFields: ['skuId', 'skuPartNumber'], trackedFields: ['skuPartNumber', 'prepaidUnits', 'capabilityStatus'], impactCategory: 'license', impactId: 'licenses.subscription_changed', impactGuidance: 'Subscription availability, purchased capacity, or service capability changed. Review service access and licensing allocation; this does not establish a billing event or a per-user or group assignment.' },
  ORGANIZATION_CONFIGURATION: { workload: 'Microsoft 365 organization', category: 'Organization', severity: 'Medium', operationName: 'Microsoft 365 organization identity changed', microsoftSource: 'Microsoft Graph /organization', identifierFields: ['id'], trackedFields: ['displayName', 'tenantId'], impactCategory: 'identity', impactId: 'organization.identity_changed', impactGuidance: 'Tenant identity information changed. Confirm the change is expected because it can affect administrator recognition and tenant communications.' },
  DOMAINS: { workload: 'Microsoft 365 domains', category: 'Domains', severity: 'Medium', operationName: 'Microsoft 365 domain configuration changed', microsoftSource: 'Microsoft Graph /organization verifiedDomains', identifierFields: ['name'], trackedFields: ['name', 'isDefault', 'isInitial'], impactCategory: 'domain', impactId: 'domains.configuration_changed', impactGuidance: 'Verified-domain routing or default-domain state changed. Review identity and email-routing implications; this does not prove an external DNS change.' },
  GROUPS: { workload: 'Microsoft Entra ID', category: 'Groups', severity: 'Medium', operationName: 'Microsoft Entra group configuration changed', microsoftSource: 'Microsoft Graph /groups', identifierFields: ['id'], trackedFields: ['displayName', 'mailEnabled', 'securityEnabled', 'groupTypes', 'visibility', 'onPremisesSyncEnabled'] },
  AUTH_METHOD_POLICIES: { workload: 'Microsoft Entra ID', category: 'MFA', severity: 'High', operationName: 'Authentication method policy changed', microsoftSource: 'Microsoft Graph /policies/authenticationMethodsPolicy', identifierFields: ['id'], trackedFields: ['state', 'includeTargets', 'excludeTargets', 'policyMigrationState'] },
  CONDITIONAL_ACCESS: { workload: 'Microsoft Entra ID', category: 'Conditional Access', severity: 'High', operationName: 'Conditional Access policy changed', microsoftSource: 'Microsoft Graph /identity/conditionalAccess/policies', identifierFields: ['id'], trackedFields: ['displayName', 'state', 'conditions', 'grantControls', 'sessionControls'] },
  NAMED_LOCATIONS: { workload: 'Microsoft Entra ID', category: 'Conditional Access', severity: 'High', operationName: 'Conditional Access named location changed', microsoftSource: 'Microsoft Graph /identity/conditionalAccess/namedLocations', identifierFields: ['id'], trackedFields: ['displayName', 'isTrusted', 'countriesAndRegions', 'ipRanges'] },
  DIRECTORY_ROLES: { workload: 'Microsoft Entra ID', category: 'Roles', severity: 'High', operationName: 'Directory role assignment changed', microsoftSource: 'Microsoft Graph /roleManagement/directory/roleAssignments', identifierFields: ['id'], trackedFields: ['principalId', 'roleDefinitionId', 'directoryScopeId', 'appScopeId'] },
  SERVICE_PRINCIPALS: { workload: 'Microsoft Entra ID', category: 'Apps', severity: 'High', operationName: 'Service principal configuration changed', microsoftSource: 'Microsoft Graph /servicePrincipals', identifierFields: ['id', 'appId'], trackedFields: ['displayName', 'accountEnabled', 'appRoleAssignmentRequired', 'servicePrincipalType', 'tags'] },
  APPLICATIONS: { workload: 'Microsoft Entra ID', category: 'Apps', severity: 'High', operationName: 'Application registration changed', microsoftSource: 'Microsoft Graph /applications', identifierFields: ['id', 'appId'], trackedFields: ['displayName', 'signInAudience', 'requiredResourceAccess', 'appRoles', 'passwordCredentials', 'keyCredentials'] },
  SECURITY_DEFAULTS: { workload: 'Microsoft Entra ID', category: 'Conditional Access', severity: 'High', operationName: 'Security Defaults changed', microsoftSource: 'Microsoft Graph /policies/identitySecurityDefaultsEnforcementPolicy', identifierFields: ['id'], trackedFields: ['isEnabled'] },
  // `lastModifiedDateTime` is content activity, not an administrative change.
  // It must not turn an ordinary document edit into a What Changed event.
  SHAREPOINT_SITES: { workload: 'SharePoint and OneDrive', category: 'SharePoint', severity: 'Medium', operationName: 'SharePoint site configuration changed', microsoftSource: 'Microsoft Graph /sites', identifierFields: ['id', 'webUrl'], trackedFields: ['displayName', 'webUrl', 'createdDateTime', 'siteCollection'] },
  SHAREPOINT_SETTINGS: { workload: 'SharePoint and OneDrive', category: 'SharePoint', severity: 'High', operationName: 'SharePoint tenant sharing setting changed', microsoftSource: 'Microsoft Graph /admin/sharepoint/settings', identifierFields: ['id'], trackedFields: ['isLegacyAuthProtocolsEnabled', 'isUnmanagedSyncAppForTenantRestricted', 'sharingCapability', 'oneDriveForBusinessRestrictions'] },
  // The current verifiedDomains collector deliberately retains only the
  // Organization.Read.All shape. Full domain attributes are a separately
  // permission-blocked coverage gap below.
  EXCHANGE_ACCEPTED_DOMAINS: { workload: 'Exchange Online', category: 'Exchange', severity: 'Medium', operationName: 'Exchange accepted domain changed', microsoftSource: 'Microsoft Graph /organization verifiedDomains', identifierFields: ['id', 'domain'], trackedFields: ['id', 'isDefault', 'isInitial'] },
  EXCHANGE_MAILBOX_RULES: { workload: 'Exchange Online', category: 'Exchange', severity: 'High', operationName: 'Exchange inbox rule changed', microsoftSource: 'Microsoft Graph /users/{id}/mailFolders/inbox/messageRules', identifierFields: ['id'], compoundIdentifierFields: ['mailboxUserId', 'id'], trackedFields: ['displayName', 'sequence', 'isEnabled', 'conditions', 'actions', 'exceptions'] },
} as const

/** Implementation and remaining-limit record for the Office 365 Management
 * Activity API. Polling is authoritative; optional webhooks are not required
 * for correctness. */
export const UNIFIED_AUDIT_LOG_GAP_REPORT = {
  source: 'Office 365 Management Activity API / Microsoft Purview Unified Audit Log',
  leastPrivilegeApplicationPermission: 'ActivityFeed.Read (Office 365 Management APIs, not Microsoft Graph)',
  adminConsentRequired: true,
  licensing: 'Audit retention and some advanced audit events depend on Microsoft 365 / Purview licensing and tenant configuration.',
  subscriptions: 'Requires per-content-type audit subscriptions. HawkView can create subscriptions, poll their content endpoints, then retrieve content URIs with durable checkpoints; this polling flow is independent of webhook delivery. Webhooks are optional and have their own callback validation and renewal lifecycle, which must not be conflated with polling-subscription lifecycle.',
  latency: 'Microsoft audit content is asynchronous and can arrive with service-dependent delay; it is not a real-time causal feed.',
  throttling: 'Implemented with tenant-scoped content-ID checkpoints, retry-after handling, exponential backoff, response/page/record ceilings, and a bounded per-run blob budget.',
  retention: 'The content API exposes at most the previous seven days. HawkView retains collected, redacted administrative evidence for six calendar months under its current policy.',
  workloadsUnlocked: ['Exchange administration and mailbox configuration activity', 'SharePoint/OneDrive sharing and administration activity', 'Teams administration activity', 'Microsoft 365 administration activity', 'some application consent and security events'],
  currentActivityFeedUse: 'ActivityFeed.Read is already consented. HawkView creates and verifies the four core audit subscriptions and polls content with a durable at-least-once ledger. Genuine administrative/security/configuration evidence is projected into What Changed. A bounded set of destructive Exchange mailbox actions is retained only as grouped investigation support; routine file access and sign-in activity remain excluded from What Changed.',
  remainingLimitations: 'Microsoft can delay or omit content depending on unified-auditing configuration and licensing. First content can take hours, events can arrive out of order, and Microsoft provides no real-time delivery guarantee. DLP.All and optional webhooks are not enabled.',
  status: 'implemented_polling',
} as const

/**
 * Deliberate least-privilege boundary: Phase 1 does not request Domain.Read.All.
 * Existing Organization.Read.All collection only establishes verified-domain
 * name/default/initial state; it cannot attest to full Domain entity fields
 * such as isVerified or supportedServices.
 */
export const DOMAIN_DETAIL_COVERAGE_GAP = {
  source: 'Microsoft Graph /domains',
  requiredApplicationPermission: 'Domain.Read.All',
  adminConsentRequired: true,
  currentCollector: 'Microsoft Graph /organization?$select=verifiedDomains under Organization.Read.All',
  unavailableFields: ['isVerified', 'supportedServices', 'authenticationType', 'state'],
  decision: 'permission_blocked_not_implemented',
} as const

export function productGuidanceForSnapshot(input: {
  source: string
  resourceType?: string | null
  workload?: string | null
  category?: string | null
  operationName?: string | null
}): ProductGuidance | undefined {
  if (input.source !== 'SNAPSHOT_DIFFERENCE' || !input.resourceType) return undefined
  const spec = SNAPSHOT_DIFFERENCE_SPECS[input.resourceType]
  if (
    !spec?.impactCategory ||
    !spec.impactId ||
    input.workload !== spec.workload ||
    input.category !== spec.category ||
    input.operationName !== spec.operationName
  ) return undefined
  return {
    kind: 'product_guidance',
    impactId: spec.impactId,
  }
}

/** P0-5 configuration coverage. Exchange tenant cmdlets remain explicitly
 * source-dependent until the existing app-only Exchange RBAC path is verified
 * for these read commands; a collector failure is never an admin change. */
export const PHASE_ONE_CONFIGURATION_COVERAGE = [
  { setting: 'Organization display name and tenant identity', workload: 'Microsoft 365 organization', source: 'Microsoft Graph /organization', permission: 'Organization.Read.All', status: 'implemented_snapshot' },
  { setting: 'Verified-domain add/remove/default/initial state', workload: 'Microsoft 365 domains', source: 'Microsoft Graph /organization.verifiedDomains', permission: 'Organization.Read.All', status: 'implemented_snapshot' },
  { setting: 'Tenant subscribed SKU add/remove/capacity/status', workload: 'Microsoft 365 licensing', source: 'Microsoft Graph /subscribedSkus', permission: 'Organization.Read.All', status: 'implemented_snapshot' },
  { setting: 'Exchange organization customization (IsDehydrated)', workload: 'Exchange Online', source: 'Exchange app-only administrative source', permission: 'Not requested in HawkView standard mode', status: 'source_dependent_not_collected' },
  { setting: 'Unified audit ingestion (UnifiedAuditLogIngestionEnabled)', workload: 'Exchange Online / Purview', source: 'Exchange app-only administrative source', permission: 'Not requested in HawkView standard mode', status: 'source_dependent_not_collected' },
  { setting: 'SharePoint and OneDrive tenant settings', workload: 'SharePoint and OneDrive', source: 'Microsoft Graph /admin/sharepoint/settings', permission: 'SharePointTenantSettings.Read.All', status: 'implemented_snapshot' },
  { setting: 'Teams tenant administration', workload: 'Teams', source: 'Unified Audit or workload-specific supported source', permission: 'ActivityFeed.Read / source dependent', status: 'not_collected' },
] as const

/**
 * Code-owned semantics for Exchange organization settings. These mappings are
 * intentionally usable by a future verified read collector, but are not
 * emitted as evidence until that collector can assert a complete response.
 */
export function describeExchangeOrganizationCustomization(isDehydrated: boolean) {
  return isDehydrated
    ? {
        operationName: 'Exchange organization customization disabled',
        state: 'disabled',
        impactCategory: 'exchange_configuration' as const,
        impactGuidance: 'Exchange organization customization is unavailable. Review whether required Exchange configuration can be managed as expected.',
      }
    : {
        operationName: 'Exchange organization customization enabled',
        state: 'enabled',
        impactCategory: 'exchange_configuration' as const,
        impactGuidance: 'Exchange organization customization is enabled. Review the resulting tenant-wide Exchange configuration through approved change control.',
      }
}

export function describeUnifiedAuditIngestion(enabled: boolean) {
  return enabled
    ? {
        operationName: 'Unified Audit ingestion enabled',
        state: 'enabled',
        impactCategory: 'audit_visibility' as const,
        impactGuidance: 'Audit visibility begins or provisions for future Microsoft 365 activity. This does not establish that historic audit data was recovered.',
      }
    : {
        operationName: 'Unified Audit ingestion disabled',
        state: 'disabled',
        impactCategory: 'audit_visibility' as const,
        impactGuidance: 'Future Microsoft 365 audit evidence may be unavailable or delayed. Review the change with the tenant administrator.',
      }
}
