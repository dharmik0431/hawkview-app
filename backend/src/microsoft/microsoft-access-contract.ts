/**
 * Code-owned Microsoft access contract.
 *
 * This is the single source of truth for the permissions HawkView requests
 * and the datasets those permissions unlock. Permission verification is
 * resource-specific: an application role issued by Microsoft Graph is never
 * treated as an Office 365 Management API or Exchange Online role.
 */

export const MICROSOFT_ACCESS_CONTRACT_VERSION = 1 as const

export type MicrosoftAccessResource =
  | 'MICROSOFT_GRAPH'
  | 'OFFICE_365_MANAGEMENT_API'
  | 'EXCHANGE_ONLINE'

export type MicrosoftAccessTier = 'CORE' | 'CAPABILITY_OPTIONAL' | 'FALLBACK'
export type MicrosoftConsentMode = 'DEFAULT' | 'SEPARATE_OPT_IN'
export type MicrosoftLicensePrerequisite =
  | 'NONE'
  | 'ENTRA_ID_P1_OR_P2'
  | 'SHAREPOINT_SERVICE_PLAN'
  | 'EXCHANGE_SERVICE_PLAN'
  | 'UNIFIED_AUDIT_ENABLED'

export type MicrosoftApplicationPermission = {
  name: string
  resource: MicrosoftAccessResource
  description: string
  consentMode: MicrosoftConsentMode
  connectionRequired: boolean
}

export type MicrosoftAccessCapability = {
  key: string
  workloadKey: string
  label: string
  tier: MicrosoftAccessTier
  applicationPermissions: ReadonlyArray<{ resource: MicrosoftAccessResource; name: string }>
  /** ALL is the default. ANY is used only when the collector has code-owned alternative sources. */
  permissionMatch?: 'ALL' | 'ANY'
  /** Shared resource success cannot prove an optional enrichment ran successfully. */
  evidenceMode?: 'RESOURCE_STATE' | 'COMPOSITE_RESOURCE_STATE' | 'NOT_DURABLY_OBSERVED'
  /** Exact source choices for a composite collector; the top-level capability is satisfied by one. */
  sourceAlternatives?: ReadonlyArray<{
    key: string
    applicationPermissions: ReadonlyArray<{ resource: MicrosoftAccessResource; name: string }>
    licensePrerequisite: MicrosoftLicensePrerequisite
    endpointPatterns: readonly string[]
    documentationUrl: string
  }>
  licensePrerequisite: MicrosoftLicensePrerequisite
  fallbackCapabilityKey: string | null
  failureScope: 'DATASET_ONLY' | 'WORKLOAD'
  resourceTypes: readonly string[]
  endpointPatterns: readonly string[]
  documentationUrl: string
}

export const MICROSOFT_APPLICATION_PERMISSIONS = [
  { name: 'Organization.Read.All', resource: 'MICROSOFT_GRAPH', description: 'Read the Microsoft 365 organization identity, verified domains, and subscribed products.', consentMode: 'DEFAULT', connectionRequired: true },
  { name: 'User.Read.All', resource: 'MICROSOFT_GRAPH', description: 'Read users and their basic directory and mailbox-directory profile information.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'GroupMember.Read.All', resource: 'MICROSOFT_GRAPH', description: 'Read Microsoft 365 and security groups and their visible memberships.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'Member.Read.Hidden', resource: 'MICROSOFT_GRAPH', description: 'Read memberships for Microsoft groups whose membership list is hidden.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'AuditLog.Read.All', resource: 'MICROSOFT_GRAPH', description: 'Read Microsoft Entra directory audit and licensed sign-in activity.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'Directory.Read.All', resource: 'MICROSOFT_GRAPH', description: 'Read directory data required by Microsoft Entra audit and sign-in collectors.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'UserAuthenticationMethod.Read.All', resource: 'MICROSOFT_GRAPH', description: 'Read registered authentication-method types when the tenant registration report is unavailable.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'Policy.Read.All', resource: 'MICROSOFT_GRAPH', description: 'Read Conditional Access policies, named locations, and Security Defaults.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'Policy.Read.AuthenticationMethod', resource: 'MICROSOFT_GRAPH', description: 'Read the tenant authentication-method policy.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'Device.Read.All', resource: 'MICROSOFT_GRAPH', description: 'Read Microsoft Entra registered and managed devices.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'RoleManagement.Read.Directory', resource: 'MICROSOFT_GRAPH', description: 'Read Microsoft Entra directory role assignments.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'Application.Read.All', resource: 'MICROSOFT_GRAPH', description: 'Read applications and service principals and resolve application identifiers.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'Sites.Read.All', resource: 'MICROSOFT_GRAPH', description: 'Read SharePoint site inventory and document-library storage.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'SharePointTenantSettings.Read.All', resource: 'MICROSOFT_GRAPH', description: 'Read tenant-level SharePoint and OneDrive settings.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'Reports.Read.All', resource: 'MICROSOFT_GRAPH', description: 'Read Microsoft 365 usage reports for SharePoint, OneDrive, and Exchange.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'MailboxSettings.Read', resource: 'MICROSOFT_GRAPH', description: 'Read mailbox settings and inbox rules.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'ActivityFeed.Read', resource: 'OFFICE_365_MANAGEMENT_API', description: 'Read Microsoft 365 Unified Audit activity and the limited-license sign-in fallback.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'SecurityEvents.Read.All', resource: 'MICROSOFT_GRAPH', description: 'Read Microsoft Secure Score snapshots and improvement data.', consentMode: 'DEFAULT', connectionRequired: false },
  { name: 'Exchange.ManageAsAppV2', resource: 'EXCHANGE_ONLINE', description: 'Authorize the optional Exchange Admin API; Exchange RBAC separately limits the application.', consentMode: 'SEPARATE_OPT_IN', connectionRequired: false },
] as const satisfies readonly MicrosoftApplicationPermission[]

const GRAPH_DOCS = 'https://learn.microsoft.com/graph/api/overview'
const REPORTS_DOCS = 'https://learn.microsoft.com/graph/api/resources/report'
const ACTIVITY_DOCS = 'https://learn.microsoft.com/office/office-365-management-api/office-365-management-activity-api-reference'
const EXCHANGE_DOCS = 'https://learn.microsoft.com/exchange/permissions-exo/application-rbac'

export const MICROSOFT_ACCESS_CAPABILITIES = [
  { key: 'microsoft_admin_consent', workloadKey: 'connection', label: 'Microsoft administrator consent', tier: 'CORE', applicationPermissions: [], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'WORKLOAD', resourceTypes: [], endpointPatterns: ['GET https://login.microsoftonline.com/{tenantId}/v2.0/adminconsent'], documentationUrl: 'https://learn.microsoft.com/entra/identity-platform/v2-admin-consent' },
  { key: 'microsoft_token_acquisition', workloadKey: 'connection', label: 'Microsoft application token acquisition', tier: 'CORE', applicationPermissions: [], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'WORKLOAD', resourceTypes: [], endpointPatterns: ['POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token'], documentationUrl: 'https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow' },
  { key: 'microsoft_organization_verification', workloadKey: 'connection', label: 'Connected organization verification', tier: 'CORE', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'Organization.Read.All' }], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'WORKLOAD', resourceTypes: [], endpointPatterns: ['GET /v1.0/organization?$select=id,displayName,verifiedDomains'], documentationUrl: 'https://learn.microsoft.com/graph/api/organization-get' },
  { key: 'microsoft_graph_continuation', workloadKey: 'connection', label: 'Microsoft Graph pagination and delta continuation', tier: 'CORE', applicationPermissions: [], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: [], endpointPatterns: ['GET Microsoft Graph @odata.nextLink/@odata.deltaLink (validated graph.microsoft.com HTTPS URL)'], documentationUrl: 'https://learn.microsoft.com/graph/paging' },
  { key: 'entra_directory_audit', workloadKey: 'entra_directory_audit', label: 'Directory audit events', tier: 'CORE', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'AuditLog.Read.All' }, { resource: 'MICROSOFT_GRAPH', name: 'Directory.Read.All' }], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['AUDIT_LOGS'], endpointPatterns: ['GET /v1.0/auditLogs/directoryAudits'], documentationUrl: 'https://learn.microsoft.com/graph/api/directoryaudit-list' },
  { key: 'entra_sign_ins_graph', workloadKey: 'sign_ins', label: 'Licensed Microsoft Graph sign-ins', tier: 'CORE', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'AuditLog.Read.All' }, { resource: 'MICROSOFT_GRAPH', name: 'Directory.Read.All' }], licensePrerequisite: 'ENTRA_ID_P1_OR_P2', fallbackCapabilityKey: 'entra_sign_ins_activity_feed', failureScope: 'DATASET_ONLY', resourceTypes: ['SIGN_INS'], endpointPatterns: ['GET /v1.0/auditLogs/signIns'], documentationUrl: 'https://learn.microsoft.com/graph/api/signin-list' },
  { key: 'entra_sign_ins_activity_feed', workloadKey: 'sign_ins', label: 'Limited-license sign-in fallback', tier: 'FALLBACK', applicationPermissions: [{ resource: 'OFFICE_365_MANAGEMENT_API', name: 'ActivityFeed.Read' }], licensePrerequisite: 'UNIFIED_AUDIT_ENABLED', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['SIGN_INS'], endpointPatterns: ['GET /api/v1.0/{tenantId}/activity/feed/content'], documentationUrl: ACTIVITY_DOCS },
  { key: 'entra_users', workloadKey: 'entra_directory', label: 'Users', tier: 'CORE', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'User.Read.All' }], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['USERS'], endpointPatterns: ['GET /v1.0/users', 'GET /v1.0/users/delta'], documentationUrl: 'https://learn.microsoft.com/graph/api/user-list' },
  { key: 'entra_groups', workloadKey: 'entra_directory', label: 'Groups and visible memberships', tier: 'CORE', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'GroupMember.Read.All' }], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['GROUPS'], endpointPatterns: ['GET /v1.0/groups', 'GET /v1.0/groups/{id}/members', 'GET /v1.0/groups/{id}/owners'], documentationUrl: 'https://learn.microsoft.com/graph/api/group-list' },
  { key: 'entra_hidden_group_members', workloadKey: 'entra_directory', label: 'Hidden group memberships', tier: 'CORE', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'Member.Read.Hidden' }], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['GROUPS'], endpointPatterns: ['GET /v1.0/groups/{id}/members'], documentationUrl: 'https://learn.microsoft.com/graph/api/group-list-members' },
  { key: 'entra_devices', workloadKey: 'entra_directory', label: 'Devices', tier: 'CORE', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'Device.Read.All' }], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['DEVICES'], endpointPatterns: ['GET /v1.0/devices'], documentationUrl: 'https://learn.microsoft.com/graph/api/device-list' },
  { key: 'entra_directory_roles', workloadKey: 'entra_directory', label: 'Directory role assignments', tier: 'CORE', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'RoleManagement.Read.Directory' }], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['DIRECTORY_ROLES'], endpointPatterns: ['GET /v1.0/roleManagement/directory/roleAssignments'], documentationUrl: 'https://learn.microsoft.com/graph/api/rbacapplication-list-roleassignments' },
  { key: 'entra_authentication_registration_coverage', workloadKey: 'entra_security_configuration', label: 'Authentication registration coverage', tier: 'CORE', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'AuditLog.Read.All' }, { resource: 'MICROSOFT_GRAPH', name: 'UserAuthenticationMethod.Read.All' }], permissionMatch: 'ANY', evidenceMode: 'COMPOSITE_RESOURCE_STATE', sourceAlternatives: [{ key: 'user_registration_details_report', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'AuditLog.Read.All' }], licensePrerequisite: 'ENTRA_ID_P1_OR_P2', endpointPatterns: ['GET /v1.0/reports/authenticationMethods/userRegistrationDetails'], documentationUrl: 'https://learn.microsoft.com/graph/api/authenticationmethodsroot-list-userregistrationdetails' }, { key: 'per_user_authentication_methods', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'UserAuthenticationMethod.Read.All' }], licensePrerequisite: 'NONE', endpointPatterns: ['POST /v1.0/$batch (users/{id}/authentication/methods)'], documentationUrl: 'https://learn.microsoft.com/graph/api/authentication-list-methods' }], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['AUTH_REGISTRATIONS'], endpointPatterns: ['GET /v1.0/reports/authenticationMethods/userRegistrationDetails', 'POST /v1.0/$batch (users/{id}/authentication/methods)'], documentationUrl: 'https://learn.microsoft.com/graph/api/resources/authenticationmethods-overview' },
  { key: 'entra_per_user_mfa_requirements', workloadKey: 'entra_security_configuration', label: 'Legacy per-user MFA requirement state', tier: 'CAPABILITY_OPTIONAL', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'Policy.Read.All' }], evidenceMode: 'NOT_DURABLY_OBSERVED', licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['AUTH_REGISTRATIONS'], endpointPatterns: ['POST /beta/$batch (users/{id}/authentication/requirements)'], documentationUrl: 'https://learn.microsoft.com/graph/api/authentication-get' },
  { key: 'entra_authentication_policy', workloadKey: 'entra_security_configuration', label: 'Authentication method policy', tier: 'CORE', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'Policy.Read.AuthenticationMethod' }], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['AUTH_METHOD_POLICIES'], endpointPatterns: ['GET /v1.0/policies/authenticationMethodsPolicy'], documentationUrl: 'https://learn.microsoft.com/graph/api/authenticationmethodspolicy-get' },
  { key: 'entra_conditional_access', workloadKey: 'entra_security_configuration', label: 'Conditional Access and named locations', tier: 'CORE', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'Policy.Read.All' }], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['CONDITIONAL_ACCESS', 'NAMED_LOCATIONS', 'SECURITY_DEFAULTS'], endpointPatterns: ['GET /v1.0/identity/conditionalAccess/policies', 'GET /v1.0/identity/conditionalAccess/namedLocations', 'GET /v1.0/policies/identitySecurityDefaultsEnforcementPolicy'], documentationUrl: 'https://learn.microsoft.com/graph/api/conditionalaccessroot-list-policies' },
  { key: 'entra_applications', workloadKey: 'entra_security_configuration', label: 'Applications and service principals', tier: 'CORE', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'Application.Read.All' }], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['APPLICATIONS', 'SERVICE_PRINCIPALS'], endpointPatterns: ['GET /v1.0/applications', 'GET /v1.0/servicePrincipals'], documentationUrl: 'https://learn.microsoft.com/graph/api/application-list' },
  { key: 'entra_secure_scores', workloadKey: 'entra_security_configuration', label: 'Microsoft Secure Score', tier: 'CAPABILITY_OPTIONAL', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'SecurityEvents.Read.All' }], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['SECURE_SCORES'], endpointPatterns: ['GET /v1.0/security/secureScores'], documentationUrl: 'https://learn.microsoft.com/graph/api/security-list-securescores' },
  { key: 'm365_organization_configuration', workloadKey: 'office_365_tenant_configuration', label: 'Organization, domains, and subscriptions', tier: 'CORE', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'Organization.Read.All' }], licensePrerequisite: 'NONE', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['ORGANIZATION_CONFIGURATION', 'DOMAINS', 'LICENSES'], endpointPatterns: ['GET /v1.0/organization', 'GET /v1.0/subscribedSkus'], documentationUrl: 'https://learn.microsoft.com/graph/api/organization-get' },
  { key: 'sharepoint_site_inventory', workloadKey: 'sharepoint_onedrive', label: 'SharePoint site inventory', tier: 'CORE', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'Sites.Read.All' }], licensePrerequisite: 'SHAREPOINT_SERVICE_PLAN', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['SHAREPOINT_SITES'], endpointPatterns: ['GET /v1.0/sites/root', 'GET /v1.0/sites?search=*'], documentationUrl: 'https://learn.microsoft.com/graph/api/site-list' },
  { key: 'sharepoint_tenant_settings', workloadKey: 'sharepoint_onedrive', label: 'SharePoint and OneDrive tenant settings', tier: 'CAPABILITY_OPTIONAL', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'SharePointTenantSettings.Read.All' }], licensePrerequisite: 'SHAREPOINT_SERVICE_PLAN', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['SHAREPOINT_SETTINGS'], endpointPatterns: ['GET /v1.0/admin/sharepoint/settings'], documentationUrl: 'https://learn.microsoft.com/graph/api/sharepointsettings-get' },
  { key: 'sharepoint_usage_reports', workloadKey: 'sharepoint_onedrive', label: 'SharePoint and OneDrive usage reports', tier: 'CAPABILITY_OPTIONAL', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'Reports.Read.All' }], licensePrerequisite: 'SHAREPOINT_SERVICE_PLAN', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['SHAREPOINT_USAGE'], endpointPatterns: ["GET /v1.0/reports/getSharePointSiteUsageDetail(period='D180')", "GET /v1.0/reports/getOneDriveUsageAccountDetail(period='D30')", 'GET {Microsoft Graph report Location URL} (HTTPS, no bearer token)'], documentationUrl: REPORTS_DOCS },
  { key: 'exchange_mailbox_inventory', workloadKey: 'exchange', label: 'Mailbox directory', tier: 'CORE', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'User.Read.All' }], licensePrerequisite: 'EXCHANGE_SERVICE_PLAN', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['EXCHANGE_MAILBOXES'], endpointPatterns: ['GET /v1.0/users'], documentationUrl: 'https://learn.microsoft.com/graph/api/user-list' },
  { key: 'exchange_mailbox_settings_rules', workloadKey: 'exchange', label: 'Mailbox settings and inbox rules', tier: 'CAPABILITY_OPTIONAL', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'MailboxSettings.Read' }], licensePrerequisite: 'EXCHANGE_SERVICE_PLAN', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['EXCHANGE_MAILBOX_SETTINGS', 'EXCHANGE_MAILBOX_RULES'], endpointPatterns: ['GET /v1.0/users/{id}/mailboxSettings', 'GET /v1.0/users/{id}/mailFolders/inbox/messageRules'], documentationUrl: 'https://learn.microsoft.com/graph/api/mailfolder-list-messagerules' },
  { key: 'exchange_usage_reports', workloadKey: 'exchange', label: 'Mailbox usage report', tier: 'CAPABILITY_OPTIONAL', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'Reports.Read.All' }], licensePrerequisite: 'EXCHANGE_SERVICE_PLAN', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['EXCHANGE_MAILBOX_USAGE'], endpointPatterns: ["GET /v1.0/reports/getMailboxUsageDetail(period='D30')", 'GET {Microsoft Graph report Location URL} (HTTPS, no bearer token)'], documentationUrl: REPORTS_DOCS },
  { key: 'exchange_tenant_domains', workloadKey: 'exchange', label: 'Tenant-associated domains', tier: 'CAPABILITY_OPTIONAL', applicationPermissions: [{ resource: 'MICROSOFT_GRAPH', name: 'Organization.Read.All' }], licensePrerequisite: 'EXCHANGE_SERVICE_PLAN', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['EXCHANGE_ACCEPTED_DOMAINS'], endpointPatterns: ['GET /v1.0/organization?$select=verifiedDomains'], documentationUrl: 'https://learn.microsoft.com/graph/api/organization-get' },
  { key: 'exchange_admin_configuration', workloadKey: 'exchange', label: 'Optional Exchange Admin configuration', tier: 'CAPABILITY_OPTIONAL', applicationPermissions: [{ resource: 'EXCHANGE_ONLINE', name: 'Exchange.ManageAsAppV2' }], licensePrerequisite: 'EXCHANGE_SERVICE_PLAN', fallbackCapabilityKey: null, failureScope: 'DATASET_ONLY', resourceTypes: ['EXCHANGE_MAILBOX_CONFIGURATION'], endpointPatterns: ['GET /adminapi/v2.0/{tenantId}/Mailbox'], documentationUrl: EXCHANGE_DOCS },
  { key: 'm365_unified_audit', workloadKey: 'm365_unified_audit', label: 'Microsoft 365 Unified Audit', tier: 'CORE', applicationPermissions: [{ resource: 'OFFICE_365_MANAGEMENT_API', name: 'ActivityFeed.Read' }], licensePrerequisite: 'UNIFIED_AUDIT_ENABLED', fallbackCapabilityKey: null, failureScope: 'WORKLOAD', resourceTypes: ['M365_AUDIT'], endpointPatterns: ['GET /api/v1.0/{tenantId}/activity/feed/subscriptions/list', 'POST /api/v1.0/{tenantId}/activity/feed/subscriptions/start', 'GET /api/v1.0/{tenantId}/activity/feed/subscriptions/content', 'GET contentUri'], documentationUrl: ACTIVITY_DOCS },
] as const satisfies readonly MicrosoftAccessCapability[]

export const DEFAULT_REQUIRED_PERMISSIONS: string[] = MICROSOFT_APPLICATION_PERMISSIONS
  .filter((permission) => permission.consentMode === 'DEFAULT')
  .map((permission) => permission.name)

export const CONNECTION_REQUIRED_PERMISSIONS: string[] = MICROSOFT_APPLICATION_PERMISSIONS
  .filter((permission) => permission.connectionRequired)
  .map((permission) => permission.name)

export const PERMISSION_DESCRIPTIONS = Object.fromEntries(
  MICROSOFT_APPLICATION_PERMISSIONS.map((permission) => [permission.name, permission.description]),
) as Readonly<Record<string, string>>

export const capabilityByKey = (key: string) =>
  MICROSOFT_ACCESS_CAPABILITIES.find((capability) => capability.key === key)

export const capabilitiesForWorkload = (workloadKey: string) =>
  MICROSOFT_ACCESS_CAPABILITIES.filter((capability) => capability.workloadKey === workloadKey)

// Kept explicit so contract tests can prove every Microsoft-backed collector
// has a registered capability without assuming every Prisma enum is Microsoft.
export const MICROSOFT_COLLECTOR_RESOURCE_TYPES = [...new Set(
  MICROSOFT_ACCESS_CAPABILITIES.flatMap((capability) => capability.resourceTypes),
)].sort()

export const MICROSOFT_GRAPH_DOCUMENTATION = GRAPH_DOCS
