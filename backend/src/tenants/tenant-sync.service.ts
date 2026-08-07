import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import { MicrosoftConsentService } from '../microsoft/microsoft-consent.service.js'
import { getMicrosoftSkuName } from '../microsoft/microsoft-sku-names.js'
import { Prisma } from '../generated/prisma/client.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { resolveDomainDnsHealth } from './domain-dns-health.js'
import { collectGroupMemberships } from './group-membership-sync.js'
import {
  IpGeolocationService,
  type SignInLocation,
} from './ip-geolocation.service.js'

const TENANT_ADMIN_ROLES = ['MSP_OWNER', 'MSP_ADMIN'] as const
const USER_SELECT =
  'id,displayName,userPrincipalName,mail,accountEnabled,userType,assignedLicenses'
const MANAGEMENT_ACTIVITY_SOURCE = 'MICROSOFT_365_MANAGEMENT_ACTIVITY'
const MANAGEMENT_ACTIVITY_MAX_LOOKBACK_DAYS = 7

const AUTH_METHOD_NAMES: Record<string, string> = {
  fido2: 'Passkey (FIDO2)',
  microsoftAuthenticator: 'Microsoft Authenticator',
  sms: 'SMS',
  temporaryAccessPass: 'Temporary Access Pass',
  email: 'Email OTP',
  x509Certificate: 'Certificate-based authentication',
  voice: 'Voice call',
  softwareOath: 'Software OATH token',
  hardwareOath: 'Hardware OATH token',
  qrCodePin: 'QR code PIN',
}

function formatAuthenticationMethodName(id: unknown) {
  if (typeof id !== 'string' || !id) return 'Authentication method'
  return AUTH_METHOD_NAMES[id] ?? id.replace(/([a-z])([A-Z])/g, '$1 $2')
}

function summarizeAuthenticationMethodTargets(method: any) {
  const targets = Array.isArray(method?.includeTargets)
    ? method.includeTargets
    : []
  if (targets.some((target: any) => target?.id === 'all_users')) {
    return 'All users'
  }
  const ids = targets
    .map((target: any) => target?.id)
    .filter((id: unknown): id is string => typeof id === 'string')
  return ids.length > 0
    ? `${ids.length} selected group(s)`
    : 'No users targeted'
}

function parseCsvRows(csv: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        field += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      row.push(field)
      field = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && csv[index + 1] === '\n') index += 1
      row.push(field)
      if (row.some((value) => value.length > 0)) rows.push(row)
      row = []
      field = ''
    } else {
      field += character
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  const [rawHeaders, ...values] = rows
  if (!rawHeaders) return []
  const headers = rawHeaders.map((header, index) =>
    (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim()
  )
  return values.map((columns) =>
    Object.fromEntries(
      headers.map((header, index) => [header, columns[index]?.trim() ?? ''])
    )
  )
}

function normalizeSharePointUrl(value: unknown) {
  if (typeof value !== 'string') return ''
  const raw = value.trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    url.hash = ''
    url.search = ''
    return decodeURIComponent(url.toString())
      .replace(/\/$/, '')
      .toLowerCase()
  } catch {
    return raw.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase()
  }
}

function normalizeSharePointSiteId(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/[{}]/g, '').toLowerCase()
}

function isCustomerFacingSharePointSite(site: any) {
  const url = normalizeSharePointUrl(site?.webUrl)
  if (!url) return true
  return !(
    url.includes('/contentstorage/') ||
    url.endsWith('/sites/contenttypehub') ||
    url.includes('/sites/contenttypehub/')
  )
}

function managementActivityExtendedProperty(record: any, ...names: string[]) {
  const expected = new Set(names.map((name) => name.toLowerCase()))
  const property = (
    Array.isArray(record?.ExtendedProperties) ? record.ExtendedProperties : []
  ).find(
    (item: any) =>
      typeof item?.Name === 'string' && expected.has(item.Name.toLowerCase())
  )
  return property?.Value
}

function isManagementActivityLogin(record: any) {
  const recordType = Number(record?.RecordType)
  if (recordType === 9 || recordType === 15) return true
  const operation = String(record?.Operation ?? '').toLowerCase()
  return /(login|logon|sign.?in)/.test(operation)
}

function managementActivityLoginSucceeded(record: any) {
  const loginStatus =
    record?.LoginStatus ??
    managementActivityExtendedProperty(record, 'LoginStatus')
  if (loginStatus !== undefined && loginStatus !== null && loginStatus !== '') {
    return Number(loginStatus) === 0
  }
  const errorCode =
    record?.ErrorCode ?? managementActivityExtendedProperty(record, 'ErrorCode')
  if (errorCode !== undefined && errorCode !== null && errorCode !== '') {
    return Number(errorCode) === 0
  }
  if (String(record?.Operation ?? '') === 'UserLoggedIn') return true
  return ['success', 'succeeded'].includes(
    String(record?.ResultStatus ?? '').toLowerCase()
  )
}

interface GraphUser {
  id?: string
  displayName?: string | null
  userPrincipalName?: string | null
  mail?: string | null
  accountEnabled?: boolean | null
  userType?: string | null
  assignedLicenses?: Array<{ skuId?: string | null }> | null
  '@removed'?: { reason?: string }
}

interface GraphUsersPage {
  value?: GraphUser[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
}

interface GraphSubscribedSku {
  skuId?: string
  skuPartNumber?: string | null
  consumedUnits?: number | null
  capabilityStatus?: string | null
  prepaidUnits?: {
    enabled?: number | null
    warning?: number | null
    suspended?: number | null
    lockedOut?: number | null
  } | null
}

interface GraphOrganization {
  displayName?: string | null
  verifiedDomains?: Array<{
    name?: string | null
    isDefault?: boolean | null
    isInitial?: boolean | null
  }>
}

interface GraphGroup {
  id?: string
  displayName?: string | null
  description?: string | null
  mail?: string | null
  mailNickname?: string | null
  mailEnabled?: boolean | null
  securityEnabled?: boolean | null
  groupTypes?: string[] | null
  visibility?: string | null
  onPremisesSyncEnabled?: boolean | null
  owners?: Array<{
    id?: string
    displayName?: string | null
    userPrincipalName?: string | null
  }>
}

interface GraphGroupsPage {
  value?: GraphGroup[]
  '@odata.nextLink'?: string
}

interface GraphGroupMembersPage {
  value?: Array<{ id?: string }>
  '@odata.nextLink'?: string
}

type EntraSnapshotResource =
  | 'AUTH_REGISTRATIONS'
  | 'AUTH_METHOD_POLICIES'
  | 'CONDITIONAL_ACCESS'
  | 'NAMED_LOCATIONS'
  | 'DEVICES'
  | 'DIRECTORY_ROLES'
  | 'SERVICE_PRINCIPALS'
  | 'APPLICATIONS'
  | 'SECURITY_DEFAULTS'
  | 'GROUPS'
  | 'SHAREPOINT_SITES'
  | 'SHAREPOINT_SETTINGS'
  | 'SHAREPOINT_USAGE'
  | 'EXCHANGE_MAILBOXES'
  | 'EXCHANGE_MAILBOX_CONFIGURATION'
  | 'EXCHANGE_MAILBOX_USAGE'
  | 'EXCHANGE_ACCEPTED_DOMAINS'
  | 'EXCHANGE_MAILBOX_RULES'
  | 'DOMAIN_DNS_HEALTH'

interface GraphCollectionPage {
  value?: unknown[]
  '@odata.nextLink'?: string
}

interface GraphBatchResponse {
  responses?: Array<{
    id?: string
    status?: number
    body?: { value?: Array<Record<string, unknown>>; error?: unknown }
  }>
}

function sanitizeGraphErrorField(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return null
  const sanitized = value.replace(/[\r\n\t]+/g, ' ').trim()
  return sanitized ? sanitized.slice(0, maxLength) : null
}

async function describeGraphError(response: Response) {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown }
    }
    const code = sanitizeGraphErrorField(body?.error?.code, 160)
    const message = sanitizeGraphErrorField(body?.error?.message, 500)
    if (!code && !message) return ''
    return ` [${[code, message].filter(Boolean).join(': ')}]`
  } catch {
    return ''
  }
}

const LOG_RETENTION_MONTHS = 6
const INITIAL_LOG_LOOKBACK_DAYS = 30
const LOG_SYNC_OVERLAP_MINUTES = 10

function logExpirationDate(ingestedAt: Date) {
  const expiresAt = new Date(ingestedAt)
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + LOG_RETENTION_MONTHS)
  return expiresAt
}

interface TenantSyncTarget {
  id: string
  organizationId: string
  microsoftTenantId: string
  displayName: string | null
  primaryDomain: string | null
  status: string
  connection: {
    status: string
    connectionMode: string
    clientId: string | null
    credentialReference: string | null
    lastVerifiedAt: Date | null
  } | null
}

@Injectable()
export class TenantSyncService {
  private readonly logger = new Logger(TenantSyncService.name)

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(MicrosoftConsentService)
    private readonly microsoftConsent: MicrosoftConsentService,
    @Inject(IpGeolocationService)
    private readonly ipGeolocation: IpGeolocationService,
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService
  ) {}

  private async getAuthorizedTenant(
    identity: AuthenticatedIdentity,
    customerTenantId: string
  ) {
    const user = await this.prisma.user.findUnique({
      where: { authProviderUserId: identity.subject },
      select: {
        disabledAt: true,
        memberships: {
          where: {
            status: 'ACTIVE',
            role: { in: [...TENANT_ADMIN_ROLES] },
            organization: { status: 'ACTIVE' },
          },
          select: { organizationId: true },
        },
      },
    })
    if (!user || user.disabledAt) {
      throw new ForbiddenException(
        'This HawkView account cannot access tenants.'
      )
    }

    const organizationIds = user.memberships.map(
      (membership) => membership.organizationId
    )
    const tenant = await this.prisma.customerTenant.findFirst({
      where: {
        id: customerTenantId,
        organizationId: { in: organizationIds },
      },
      select: {
        id: true,
        organizationId: true,
        microsoftTenantId: true,
        displayName: true,
        primaryDomain: true,
        status: true,
        connection: {
          select: {
            status: true,
            connectionMode: true,
            clientId: true,
            credentialReference: true,
            lastVerifiedAt: true,
          },
        },
      },
    })
    if (!tenant) {
      throw new NotFoundException('Customer tenant was not found.')
    }
    return tenant
  }

  async getBundleForIdentity(
    identity: AuthenticatedIdentity,
    customerTenantId: string
  ) {
    const tenant = await this.getAuthorizedTenant(identity, customerTenantId)
    return this.buildBundle(tenant)
  }

  async syncUsersForIdentity(
    identity: AuthenticatedIdentity,
    customerTenantId: string
  ) {
    const tenant = await this.getAuthorizedTenant(identity, customerTenantId)
    const result = await this.syncConnectedTenant(tenant, true)
    return result.bundle
  }

  async syncDueTenants() {
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000)
    const limit = Math.max(
      1,
      Math.min(25, Number(process.env.SCHEDULED_SYNC_BATCH_SIZE ?? 10) || 10)
    )
    const tenants = await this.prisma.customerTenant.findMany({
      where: {
        status: 'ACTIVE',
        connection: { status: 'CONNECTED' },
        OR: [
          { syncStates: { none: { resourceType: 'USERS' } } },
          {
            syncStates: {
              some: {
                resourceType: 'USERS',
                OR: [
                  { lastSuccessfulAt: null },
                  { lastSuccessfulAt: { lt: staleBefore } },
                  { status: 'FAILED' },
                ],
              },
            },
          },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: {
        id: true,
        organizationId: true,
        microsoftTenantId: true,
        displayName: true,
        primaryDomain: true,
        status: true,
        connection: {
          select: {
            status: true,
            connectionMode: true,
            clientId: true,
            credentialReference: true,
            lastVerifiedAt: true,
          },
        },
      },
    })

    const results: Array<Record<string, unknown>> = []
    for (const tenant of tenants) {
      try {
        const result = await this.syncConnectedTenant(tenant, false)
        results.push({
          tenantId: tenant.id,
          microsoftTenantId: tenant.microsoftTenantId,
          status: result.status,
          failedResources: result.failedResources,
        })
      } catch (error) {
        results.push({
          tenantId: tenant.id,
          microsoftTenantId: tenant.microsoftTenantId,
          status: 'FAILED',
          error:
            error instanceof Error
              ? error.message.slice(0, 500)
              : 'Tenant synchronization failed.',
        })
      }
    }

    const summary = {
      checkedAt: new Date().toISOString(),
      due: tenants.length,
      succeeded: results.filter((result) => result.status === 'SUCCEEDED')
        .length,
      partial: results.filter((result) => result.status === 'PARTIAL').length,
      failed: results.filter((result) => result.status === 'FAILED').length,
      skipped: results.filter((result) => result.status === 'SKIPPED').length,
      results,
    }
    this.logger.log(
      `Scheduled tenant synchronization: ${JSON.stringify(summary)}`
    )
    return summary
  }

  private async syncConnectedTenant(
    tenant: TenantSyncTarget,
    throwWhenBusy: boolean
  ) {
    if (
      tenant.status !== 'ACTIVE' ||
      tenant.connection?.status !== 'CONNECTED'
    ) {
      throw new ConflictException(
        'Connect and authorize this Microsoft tenant before synchronization.'
      )
    }

    const existingState = await this.prisma.syncState.findUnique({
      where: {
        customerTenantId_resourceType: {
          customerTenantId: tenant.id,
          resourceType: 'USERS',
        },
      },
    })
    const now = new Date()
    const staleLeaseBefore = new Date(now.getTime() - 15 * 60 * 1000)
    let claimed = false
    if (existingState) {
      const claim = await this.prisma.syncState.updateMany({
        where: {
          id: existingState.id,
          OR: [
            { status: { not: 'RUNNING' } },
            { lastAttemptAt: null },
            { lastAttemptAt: { lt: staleLeaseBefore } },
          ],
        },
        data: {
          status: 'RUNNING',
          lastAttemptAt: now,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      })
      claimed = claim.count === 1
    } else {
      try {
        await this.prisma.syncState.create({
          data: {
            organizationId: tenant.organizationId,
            customerTenantId: tenant.id,
            resourceType: 'USERS',
            status: 'RUNNING',
            lastAttemptAt: now,
          },
        })
        claimed = true
      } catch (error) {
        const competingClaim = await this.prisma.syncState.findUnique({
          where: {
            customerTenantId_resourceType: {
              customerTenantId: tenant.id,
              resourceType: 'USERS',
            },
          },
          select: { id: true },
        })
        if (!competingClaim) throw error
        claimed = false
      }
    }
    if (!claimed) {
      if (throwWhenBusy) {
        throw new ConflictException(
          'A tenant synchronization is already running.'
        )
      }
      return {
        bundle: null,
        status: 'SKIPPED',
        failedResources: [] as string[],
      }
    }

    try {
      const accessToken = await this.microsoftConsent.getTenantAccessToken({
        microsoftTenantId: tenant.microsoftTenantId,
        connectionMode:
          tenant.connection.connectionMode === 'CUSTOMER_MANAGED'
            ? 'CUSTOMER_MANAGED'
            : 'HAWKVIEW_MANAGED',
        clientId: tenant.connection.clientId,
        credentialReference: tenant.connection.credentialReference,
      })
      const result = await this.synchronizeUsers(
        tenant,
        accessToken,
        existingState?.deltaLink ?? null
      )
      const completedAt = new Date()

      await this.prisma.$transaction([
        this.prisma.syncState.update({
          where: {
            customerTenantId_resourceType: {
              customerTenantId: tenant.id,
              resourceType: 'USERS',
            },
          },
          data: {
            status: 'SUCCEEDED',
            deltaLink: result.deltaLink,
            lastSuccessfulAt: completedAt,
            lastErrorCode: null,
            lastErrorMessage: null,
            consecutiveFailures: 0,
          },
        }),
        this.prisma.tenantConnection.update({
          where: {
            customerTenantId_organizationId: {
              customerTenantId: tenant.id,
              organizationId: tenant.organizationId,
            },
          },
          data: { lastVerifiedAt: completedAt },
        }),
      ])
    } catch (error) {
      await this.markConnectionUnavailable(tenant, error)
      await this.prisma.syncState.update({
        where: {
          customerTenantId_resourceType: {
            customerTenantId: tenant.id,
            resourceType: 'USERS',
          },
        },
        data: {
          status: 'FAILED',
          lastErrorCode: 'users-sync-failed',
          lastErrorMessage:
            error instanceof Error
              ? error.message.slice(0, 2000)
              : 'Microsoft users synchronization failed.',
          consecutiveFailures: { increment: 1 },
        },
      })
      if (error instanceof ConflictException) throw error
      throw new BadGatewayException(
        error instanceof Error
          ? error.message
          : 'Microsoft users synchronization failed.'
      )
    }

    let snapshotAccessToken: string
    try {
      snapshotAccessToken = await this.microsoftConsent.getTenantAccessToken({
        microsoftTenantId: tenant.microsoftTenantId,
        connectionMode:
          tenant.connection.connectionMode === 'CUSTOMER_MANAGED'
            ? 'CUSTOMER_MANAGED'
            : 'HAWKVIEW_MANAGED',
        clientId: tenant.connection.clientId,
        credentialReference: tenant.connection.credentialReference,
      })
    } catch (error) {
      await this.markConnectionUnavailable(tenant, error)
      throw new BadGatewayException(
        'HawkView could not access this Microsoft tenant. Reauthorize the connection or remove the tenant.'
      )
    }
    // Every secondary dataset is independent. A missing permission or timeout
    // in one Microsoft endpoint must not prevent the remaining datasets from
    // refreshing or recording their own diagnostic SyncState.
    const snapshotModules: Array<{
      resource: string
      synchronize: () => Promise<unknown>
    }> = [
      {
        resource: 'LICENSES',
        synchronize: () => this.syncLicenses(tenant, snapshotAccessToken),
      },
      {
        resource: 'DOMAINS',
        synchronize: () => this.syncDomains(tenant, snapshotAccessToken),
      },
      {
        resource: 'GROUPS',
        synchronize: () => this.syncGroups(tenant, snapshotAccessToken),
      },
      {
        resource: 'SHAREPOINT_SITES',
        synchronize: () =>
          this.syncSharePointSites(tenant, snapshotAccessToken),
      },
      {
        resource: 'SHAREPOINT_SETTINGS',
        synchronize: () =>
          this.syncSharePointSettings(tenant, snapshotAccessToken),
      },
      {
        resource: 'SHAREPOINT_USAGE',
        synchronize: () =>
          this.syncSharePointUsage(tenant, snapshotAccessToken),
      },
      {
        resource: 'EXCHANGE_MAILBOXES',
        synchronize: () =>
          this.syncExchangeMailboxDirectory(tenant, snapshotAccessToken),
      },
      {
        resource: 'EXCHANGE_MAILBOX_CONFIGURATION',
        synchronize: () => this.syncExchangeMailboxConfiguration(tenant),
      },
      {
        resource: 'EXCHANGE_ACCEPTED_DOMAINS',
        synchronize: () =>
          this.syncExchangeAcceptedDomains(tenant, snapshotAccessToken),
      },
      {
        resource: 'EXCHANGE_MAILBOX_USAGE',
        synchronize: () =>
          this.syncExchangeMailboxUsage(tenant, snapshotAccessToken),
      },
      {
        resource: 'EXCHANGE_MAILBOX_RULES',
        synchronize: () =>
          this.syncExchangeMailboxRules(tenant, snapshotAccessToken),
      },
    ]
    const snapshotResults = await Promise.allSettled(
      snapshotModules.map((module) => module.synchronize())
    )
    snapshotResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        const resource = snapshotModules[index]?.resource ?? 'UNKNOWN'
        this.logger.warn(
          `${resource} synchronization was unavailable for tenant ${tenant.id}: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`
        )
      }
    })

    // Run after Microsoft domain discovery so DNS checks always use the
    // latest database-backed domain inventory.
    try {
      await this.syncDomainDnsHealth(tenant)
    } catch (error) {
      this.logger.warn(
        `DOMAIN_DNS_HEALTH synchronization was unavailable for tenant ${tenant.id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    const entraModules: Array<Promise<unknown>> = [
      this.syncAuthenticationRegistrations(tenant, snapshotAccessToken),
      this.syncAuthenticationMethodPolicy(tenant, snapshotAccessToken),
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'CONDITIONAL_ACCESS',
        'https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies'
      ),
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'NAMED_LOCATIONS',
        'https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations'
      ),
      this.syncSignInLogs(tenant, snapshotAccessToken),
      this.syncDirectoryAuditLogs(tenant, snapshotAccessToken),
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'DEVICES',
        'https://graph.microsoft.com/v1.0/devices?$select=id,deviceId,displayName,operatingSystem,operatingSystemVersion,trustType,isCompliant,isManaged,accountEnabled,approximateLastSignInDateTime&$expand=registeredOwners($select=id)'
      ),
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'DIRECTORY_ROLES',
        'https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?$expand=roleDefinition($select=id,displayName)'
      ),
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'SERVICE_PRINCIPALS',
        'https://graph.microsoft.com/v1.0/servicePrincipals?' +
          '$select=id,appId,displayName,description,servicePrincipalType,' +
          'accountEnabled,appRoleAssignmentRequired,createdDateTime,homepage,' +
          'loginUrl,publisherName,verifiedPublisher,tags,' +
          'preferredSingleSignOnMode,notificationEmailAddresses,appRoles,' +
          'oauth2PermissionScopes&' +
          '$expand=appRoleAssignedTo($select=id,principalId,principalType,principalDisplayName,appRoleId)'
      ),
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'APPLICATIONS',
        'https://graph.microsoft.com/v1.0/applications?' +
          '$select=id,appId,displayName,description,createdDateTime,' +
          'signInAudience,publisherDomain,identifierUris,web,' +
          'passwordCredentials,keyCredentials,requiredResourceAccess&' +
          '$expand=owners($select=id,displayName,userPrincipalName)'
      ),
      this.syncSecurityDefaults(tenant, snapshotAccessToken),
    ]
    const entraResults = await Promise.allSettled(entraModules)
    entraResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        const resource = [
          'AUTH_REGISTRATIONS',
          'AUTH_METHOD_POLICIES',
          'CONDITIONAL_ACCESS',
          'NAMED_LOCATIONS',
          'SIGN_INS',
          'AUDIT_LOGS',
          'DEVICES',
          'DIRECTORY_ROLES',
          'SERVICE_PRINCIPALS',
          'APPLICATIONS',
          'SECURITY_DEFAULTS',
        ][index]
        this.logger.warn(
          `${resource} synchronization was unavailable for tenant ${tenant.id}: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`
        )
      }
    })

    const attemptedStates = await this.prisma.syncState.findMany({
      where: {
        customerTenantId: tenant.id,
        lastAttemptAt: { gte: now },
      },
      select: { resourceType: true, status: true },
    })
    const failedResources = attemptedStates
      .filter((state) => state.status === 'FAILED')
      .map((state) => state.resourceType)
    const initialSync = !existingState?.lastSuccessfulAt
    if (initialSync) {
      await this.notifications.publishIncident({
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        eventType:
          failedResources.length > 0
            ? 'tenant.initial_sync_partial'
            : 'tenant.initial_sync_completed',
        category: failedResources.length > 0 ? 'warning' : 'success',
        severity: failedResources.length > 0 ? 'medium' : 'info',
        title:
          failedResources.length > 0
            ? 'Initial tenant sync completed with gaps'
            : 'Initial tenant sync completed',
        description:
          failedResources.length > 0
            ? `${failedResources.length} data source${failedResources.length === 1 ? '' : 's'} could not be collected. HawkView will retry automatically.`
            : 'HawkView finished collecting the tenant data required for monitoring.',
        dedupeKey: `tenant:${tenant.id}:initial-sync`,
        source: 'tenant-sync',
        actionUrl: `/tenants/${tenant.id}`,
        actionLabel: 'View tenant',
        metadata: { failedResources },
      })
    }
    return {
      bundle: await this.buildBundle(tenant),
      status: failedResources.length > 0 ? 'PARTIAL' : 'SUCCEEDED',
      failedResources,
    }
  }

  private async markConnectionUnavailable(
    tenant: { id: string; organizationId: string },
    error: unknown
  ) {
    const message =
      error instanceof Error ? error.message : 'Microsoft tenant access failed.'
    const failedAt = new Date()

    await this.prisma.$transaction([
      this.prisma.customerTenant.update({
        where: { id: tenant.id },
        data: { status: 'SUSPENDED' },
      }),
      this.prisma.tenantConnection.update({
        where: {
          customerTenantId_organizationId: {
            customerTenantId: tenant.id,
            organizationId: tenant.organizationId,
          },
        },
        data: {
          status: 'ERROR',
          consentedPermissions: [],
          lastVerifiedAt: failedAt,
          lastErrorCode: 'microsoft-access-failed',
          lastErrorMessage: message.slice(0, 2000),
        },
      }),
    ])
    await this.notifications.publishIncident({
      organizationId: tenant.organizationId,
      customerTenantId: tenant.id,
      eventType: 'tenant.connection_lost',
      category: 'error',
      severity: 'critical',
      title: 'Microsoft 365 connection lost',
      description: message,
      dedupeKey: `tenant:${tenant.id}:connection`,
      source: 'microsoft-verification',
      actionUrl: `/tenants/${tenant.id}/settings`,
      actionLabel: 'Reconnect tenant',
    })
  }

  private async runSnapshotSync(
    tenant: { id: string; organizationId: string },
    resourceType:
      | 'LICENSES'
      | 'DOMAINS'
      | 'GROUPS'
      | 'SIGN_INS'
      | 'AUDIT_LOGS'
      | EntraSnapshotResource,
    synchronize: () => Promise<void>
  ) {
    const lastAttemptAt = new Date()
    await this.prisma.syncState.upsert({
      where: {
        customerTenantId_resourceType: {
          customerTenantId: tenant.id,
          resourceType,
        },
      },
      create: {
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        resourceType,
        status: 'RUNNING',
        lastAttemptAt,
      },
      update: {
        status: 'RUNNING',
        lastAttemptAt,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    })

    try {
      await synchronize()
      await this.prisma.syncState.update({
        where: {
          customerTenantId_resourceType: {
            customerTenantId: tenant.id,
            resourceType,
          },
        },
        data: {
          status: 'SUCCEEDED',
          lastSuccessfulAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
          consecutiveFailures: 0,
        },
      })
      await this.notifications.resolveIncident(
        tenant.organizationId,
        `tenant:${tenant.id}:sync:${resourceType}`,
        {
          customerTenantId: tenant.id,
          eventType: 'tenant.sync_recovered',
          category: 'success',
          severity: 'info',
          title: `${resourceType.replaceAll('_', ' ')} synchronization recovered`,
          description: 'HawkView is receiving this Microsoft 365 data again.',
          source: 'tenant-sync',
          actionUrl: `/tenants/${tenant.id}`,
          actionLabel: 'View tenant',
        }
      )
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Microsoft ${resourceType.toLowerCase()} synchronization failed.`
      const state = await this.prisma.syncState.update({
        where: {
          customerTenantId_resourceType: {
            customerTenantId: tenant.id,
            resourceType,
          },
        },
        data: {
          status: 'FAILED',
          lastErrorCode: `${resourceType.toLowerCase()}-sync-failed`,
          lastErrorMessage: message.slice(0, 2000),
          consecutiveFailures: { increment: 1 },
        },
      })
      if (state.consecutiveFailures >= 2) {
        await this.notifications.publishIncident({
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          eventType: 'tenant.sync_failed',
          category: 'warning',
          severity: state.consecutiveFailures >= 4 ? 'high' : 'medium',
          title: `${resourceType.replaceAll('_', ' ')} synchronization failed`,
          description: message,
          dedupeKey: `tenant:${tenant.id}:sync:${resourceType}`,
          source: 'tenant-sync',
          actionUrl: `/tenants/${tenant.id}`,
          actionLabel: 'Review tenant',
          metadata: { resourceType, consecutiveFailures: state.consecutiveFailures },
        })
      }
      throw new BadGatewayException(message)
    }
  }

  private async syncLicenses(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'LICENSES', async () => {
      const response = await fetch(
        'https://graph.microsoft.com/v1.0/subscribedSkus',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(20_000),
        }
      )
      if (!response.ok) {
        throw new Error(
          `Microsoft license synchronization returned ${response.status}.`
        )
      }
      const body = (await response.json()) as { value?: GraphSubscribedSku[] }
      const observedAt = new Date()
      const rows = (body.value ?? []).filter(
        (sku) =>
          typeof sku.skuId === 'string' && typeof sku.skuPartNumber === 'string'
      )

      await this.prisma.$transaction(async (transaction) => {
        for (const sku of rows) {
          await transaction.tenantLicense.upsert({
            where: {
              customerTenantId_microsoftSkuId: {
                customerTenantId: tenant.id,
                microsoftSkuId: sku.skuId as string,
              },
            },
            create: {
              organizationId: tenant.organizationId,
              customerTenantId: tenant.id,
              microsoftSkuId: sku.skuId as string,
              skuPartNumber: (sku.skuPartNumber as string).trim(),
              consumedUnits: Math.max(0, sku.consumedUnits ?? 0),
              enabledUnits: Math.max(0, sku.prepaidUnits?.enabled ?? 0),
              warningUnits: Math.max(0, sku.prepaidUnits?.warning ?? 0),
              suspendedUnits: Math.max(0, sku.prepaidUnits?.suspended ?? 0),
              lockedOutUnits: Math.max(0, sku.prepaidUnits?.lockedOut ?? 0),
              capabilityStatus: sku.capabilityStatus?.trim() || null,
              lastSeenAt: observedAt,
            },
            update: {
              skuPartNumber: (sku.skuPartNumber as string).trim(),
              consumedUnits: Math.max(0, sku.consumedUnits ?? 0),
              enabledUnits: Math.max(0, sku.prepaidUnits?.enabled ?? 0),
              warningUnits: Math.max(0, sku.prepaidUnits?.warning ?? 0),
              suspendedUnits: Math.max(0, sku.prepaidUnits?.suspended ?? 0),
              lockedOutUnits: Math.max(0, sku.prepaidUnits?.lockedOut ?? 0),
              capabilityStatus: sku.capabilityStatus?.trim() || null,
              lastSeenAt: observedAt,
            },
          })
        }
        await transaction.tenantLicense.deleteMany({
          where: {
            customerTenantId: tenant.id,
            lastSeenAt: { lt: observedAt },
          },
        })
      })
    })
  }

  private async syncDomains(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'DOMAINS', async () => {
      const response = await fetch(
        'https://graph.microsoft.com/v1.0/organization?$select=displayName,verifiedDomains',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(20_000),
        }
      )
      if (!response.ok) {
        throw new Error(
          `Microsoft domain synchronization returned ${response.status}.`
        )
      }
      const body = (await response.json()) as { value?: GraphOrganization[] }
      const organization = body.value?.[0]
      if (!organization) {
        throw new Error('Microsoft did not return organization information.')
      }
      const observedAt = new Date()
      const domains = (organization.verifiedDomains ?? []).filter(
        (domain) => typeof domain.name === 'string' && domain.name.trim()
      )
      const primaryDomain =
        domains.find((domain) => domain.isDefault)?.name?.trim() ??
        domains.find((domain) => domain.isInitial)?.name?.trim() ??
        null

      await this.prisma.$transaction(async (transaction) => {
        for (const domain of domains) {
          const name = (domain.name as string).trim().toLowerCase()
          await transaction.tenantDomain.upsert({
            where: {
              customerTenantId_name: {
                customerTenantId: tenant.id,
                name,
              },
            },
            create: {
              organizationId: tenant.organizationId,
              customerTenantId: tenant.id,
              name,
              isDefault: domain.isDefault === true,
              isInitial: domain.isInitial === true,
              lastSeenAt: observedAt,
            },
            update: {
              isDefault: domain.isDefault === true,
              isInitial: domain.isInitial === true,
              lastSeenAt: observedAt,
            },
          })
        }
        await transaction.tenantDomain.deleteMany({
          where: {
            customerTenantId: tenant.id,
            lastSeenAt: { lt: observedAt },
          },
        })
        await transaction.customerTenant.update({
          where: { id: tenant.id },
          data: {
            displayName: organization.displayName?.trim() || undefined,
            primaryDomain,
          },
        })
      })
    })
  }

  private async syncDomainDnsHealth(tenant: {
    id: string
    organizationId: string
  }) {
    return this.runSnapshotSync(tenant, 'DOMAIN_DNS_HEALTH', async () => {
      const domains = await this.prisma.tenantDomain.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        select: { name: true },
      })
      if (domains.length === 0) {
        throw new Error(
          'No synchronized Microsoft domains are available for DNS checks.'
        )
      }
      const results = await Promise.all(
        domains.map(({ name }) => resolveDomainDnsHealth(name))
      )
      await this.saveSnapshot(tenant, 'DOMAIN_DNS_HEALTH', results)
    })
  }

  private async syncGroups(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'GROUPS', async () => {
      const groups: GraphGroup[] = []
      let groupsUrl =
        'https://graph.microsoft.com/v1.0/groups?' +
        '$select=id,displayName,description,mail,mailNickname,mailEnabled,' +
        'securityEnabled,groupTypes,visibility,onPremisesSyncEnabled&' +
        '$expand=owners($select=id,displayName,userPrincipalName)&$top=999'

      while (groupsUrl) {
        if (!groupsUrl.startsWith('https://graph.microsoft.com/')) {
          throw new Error('Microsoft returned an invalid groups link.')
        }
        const response = await fetch(groupsUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(20_000),
        })
        if (!response.ok) {
          throw new Error(
            `Microsoft groups synchronization returned ${response.status}.`
          )
        }
        const page = (await response.json()) as GraphGroupsPage
        groups.push(
          ...(page.value ?? []).filter(
            (group) =>
              typeof group.id === 'string' &&
              typeof group.displayName === 'string'
          )
        )
        groupsUrl = page['@odata.nextLink'] ?? ''
      }

      const fetchGroupMemberIds = async (groupId: string) => {
        const memberIds: string[] = []
        let membersUrl =
          `https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(groupId)}` +
          '/members?$select=id&$top=999'
        while (membersUrl) {
          if (!membersUrl.startsWith('https://graph.microsoft.com/')) {
            throw new Error('Microsoft returned an invalid group-members link.')
          }
          const response = await fetch(membersUrl, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(20_000),
          })
          if (!response.ok) {
            const detail = await describeGraphError(response)
            const requestId =
              response.headers.get('request-id') ??
              response.headers.get('client-request-id')
            throw new Error(
              `Microsoft group membership synchronization returned ${response.status}${detail}` +
                (requestId ? ` (request ${requestId})` : '')
            )
          }
          const page = (await response.json()) as GraphGroupMembersPage
          memberIds.push(
            ...(page.value ?? [])
              .map((member) => member.id)
              .filter((id): id is string => typeof id === 'string')
          )
          membersUrl = page['@odata.nextLink'] ?? ''
        }
        return memberIds
      }

      // Keep concurrency bounded to avoid overwhelming Microsoft Graph while
      // still making the initial snapshot practical for tenants with many groups.
      const membershipTargets = groups.map((group) => ({
        id: group.id as string,
        displayName: group.displayName,
      }))
      const { memberIdsByGroupId, failures: membershipFailures } =
        await collectGroupMemberships(membershipTargets, (group) =>
          fetchGroupMemberIds(group.id)
        )
      for (const failure of membershipFailures) {
        const message =
          failure.error instanceof Error
            ? failure.error.message
            : String(failure.error)
        this.logger.warn(
          `Skipped membership refresh for Microsoft group ${failure.groupName} (${failure.groupId}) in tenant ${tenant.id}: ${message}`
        )
      }

      const directoryUsers = await this.prisma.directoryUser.findMany({
        where: {
          customerTenantId: tenant.id,
          deletedAt: null,
        },
        select: {
          id: true,
          microsoftUserId: true,
        },
      })
      const directoryUserIdByMicrosoftId = new Map(
        directoryUsers.map((user) => [user.microsoftUserId, user.id])
      )
      const observedAt = new Date()

      await this.prisma.$transaction(async (transaction) => {
        for (const group of groups) {
          const microsoftGroupId = group.id as string
          const directoryGroup = await transaction.directoryGroup.upsert({
            where: {
              customerTenantId_microsoftGroupId: {
                customerTenantId: tenant.id,
                microsoftGroupId,
              },
            },
            create: {
              organizationId: tenant.organizationId,
              customerTenantId: tenant.id,
              microsoftGroupId,
              displayName: group.displayName?.trim() || microsoftGroupId,
              description: group.description?.trim() || null,
              mail: group.mail?.trim() || null,
              mailNickname: group.mailNickname?.trim() || null,
              mailEnabled: group.mailEnabled === true,
              securityEnabled: group.securityEnabled === true,
              groupTypes: group.groupTypes ?? [],
              visibility: group.visibility?.trim() || null,
              lastSeenAt: observedAt,
            },
            update: {
              displayName: group.displayName?.trim() || microsoftGroupId,
              description: group.description?.trim() || null,
              mail: group.mail?.trim() || null,
              mailNickname: group.mailNickname?.trim() || null,
              mailEnabled: group.mailEnabled === true,
              securityEnabled: group.securityEnabled === true,
              groupTypes: group.groupTypes ?? [],
              visibility: group.visibility?.trim() || null,
              lastSeenAt: observedAt,
            },
          })

          if (!memberIdsByGroupId.has(microsoftGroupId)) {
            continue
          }

          await transaction.directoryGroupMembership.deleteMany({
            where: { directoryGroupId: directoryGroup.id },
          })
          const memberships = (memberIdsByGroupId.get(microsoftGroupId) ?? [])
            .map((microsoftUserId) => ({
              directoryUserId:
                directoryUserIdByMicrosoftId.get(microsoftUserId),
            }))
            .filter(
              (
                membership
              ): membership is {
                directoryUserId: string
              } => Boolean(membership.directoryUserId)
            )
            .map((membership) => ({
              organizationId: tenant.organizationId,
              customerTenantId: tenant.id,
              directoryGroupId: directoryGroup.id,
              directoryUserId: membership.directoryUserId,
              lastSeenAt: observedAt,
            }))
          if (memberships.length > 0) {
            await transaction.directoryGroupMembership.createMany({
              data: memberships,
              skipDuplicates: true,
            })
          }
        }

        await transaction.directoryGroup.deleteMany({
          where: {
            customerTenantId: tenant.id,
            lastSeenAt: { lt: observedAt },
          },
        })
      })

      await this.saveSnapshot(tenant, 'GROUPS', groups)
    })
  }

  private async syncEntraCollection(
    tenant: { id: string; organizationId: string },
    accessToken: string,
    resourceType: EntraSnapshotResource,
    initialUrl: string
  ) {
    return this.runSnapshotSync(tenant, resourceType, async () => {
      const rows: unknown[] = []
      let nextUrl = initialUrl
      while (nextUrl) {
        if (!nextUrl.startsWith('https://graph.microsoft.com/')) {
          throw new Error(`Microsoft returned an invalid ${resourceType} link.`)
        }
        const response = await fetch(nextUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) {
          const graphRequestId = response.headers.get('request-id')
          const graphError = await describeGraphError(response)
          throw new Error(
            `Microsoft ${resourceType.toLowerCase()} synchronization returned ${response.status}${
              graphRequestId ? ` (request ${graphRequestId})` : ''
            }${graphError}.`
          )
        }
        const page = (await response.json()) as GraphCollectionPage
        rows.push(...(page.value ?? []))
        nextUrl = page['@odata.nextLink'] ?? ''
      }
      await this.prisma.tenantEntraSnapshot.upsert({
        where: {
          customerTenantId_resourceType: {
            customerTenantId: tenant.id,
            resourceType,
          },
        },
        create: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          resourceType,
          payload: rows as never,
          observedAt: new Date(),
        },
        update: {
          payload: rows as never,
          observedAt: new Date(),
        },
      })
    })
  }

  private async syncSecurityDefaults(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'SECURITY_DEFAULTS', async () => {
      const response = await fetch(
        'https://graph.microsoft.com/v1.0/policies/identitySecurityDefaultsEnforcementPolicy',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(30_000),
        }
      )
      if (!response.ok) {
        const graphRequestId = response.headers.get('request-id')
        const graphError = await describeGraphError(response)
        throw new Error(
          `Microsoft security defaults synchronization returned ${response.status}${
            graphRequestId ? ` (request ${graphRequestId})` : ''
          }${graphError}.`
        )
      }
      const policy = (await response.json()) as Record<string, unknown>
      await this.saveEntraSnapshot(tenant, 'SECURITY_DEFAULTS', [policy])
    })
  }

  private async saveEntraSnapshot(
    tenant: { id: string; organizationId: string },
    resourceType: EntraSnapshotResource,
    rows: unknown[]
  ) {
    await this.prisma.tenantEntraSnapshot.upsert({
      where: {
        customerTenantId_resourceType: {
          customerTenantId: tenant.id,
          resourceType,
        },
      },
      create: {
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        resourceType,
        payload: rows as never,
        observedAt: new Date(),
      },
      update: {
        payload: rows as never,
        observedAt: new Date(),
      },
    })
  }

  private async syncAuthenticationRegistrations(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    try {
      return await this.syncEntraCollection(
        tenant,
        accessToken,
        'AUTH_REGISTRATIONS',
        'https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails'
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        !message.includes(
          'Authentication_RequestFromNonPremiumTenantOrB2CTenant'
        )
      ) {
        throw error
      }
      this.logger.log(
        `Tenant ${tenant.id} does not have premium MFA reporting; using the per-user authentication-method fallback.`
      )
      return this.syncPerUserAuthenticationMethods(tenant, accessToken)
    }
  }

  private async syncPerUserAuthenticationMethods(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'AUTH_REGISTRATIONS', async () => {
      const users = await this.prisma.directoryUser.findMany({
        where: { customerTenantId: tenant.id, deletedAt: null },
        select: { microsoftUserId: true, userPrincipalName: true },
        orderBy: { microsoftUserId: 'asc' },
      })
      const registrations: Array<Record<string, unknown>> = []
      const methodLabels: Record<string, string> = {
        '#microsoft.graph.fido2AuthenticationMethod':
          'FIDO2 security key or passkey',
        '#microsoft.graph.microsoftAuthenticatorAuthenticationMethod':
          'Microsoft Authenticator',
        '#microsoft.graph.phoneAuthenticationMethod': 'Phone',
        '#microsoft.graph.softwareOathAuthenticationMethod':
          'Software OATH token',
        '#microsoft.graph.windowsHelloForBusinessAuthenticationMethod':
          'Windows Hello for Business',
        '#microsoft.graph.temporaryAccessPassAuthenticationMethod':
          'Temporary Access Pass',
        '#microsoft.graph.platformCredentialAuthenticationMethod':
          'Platform credential',
        '#microsoft.graph.hardwareOathAuthenticationMethod':
          'Hardware OATH token',
      }

      for (let offset = 0; offset < users.length; offset += 20) {
        const batchUsers = users.slice(offset, offset + 20)
        const response = await fetch(
          'https://graph.microsoft.com/v1.0/$batch',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              requests: batchUsers.map((user, index) => ({
                id: String(index + 1),
                method: 'GET',
                url: `/users/${encodeURIComponent(user.microsoftUserId)}/authentication/methods`,
              })),
            }),
            signal: AbortSignal.timeout(30_000),
          }
        )
        if (!response.ok) {
          const graphError = await describeGraphError(response)
          throw new Error(
            `Microsoft per-user authentication-method synchronization returned ${response.status}${graphError}.`
          )
        }
        const batch = (await response.json()) as GraphBatchResponse
        const responsesById = new Map(
          (batch.responses ?? []).map((item) => [item.id, item])
        )
        batchUsers.forEach((user, index) => {
          const item = responsesById.get(String(index + 1))
          if (item?.status !== 200) {
            throw new Error(
              `Microsoft per-user authentication-method synchronization returned ${item?.status ?? 'an invalid response'}. Confirm UserAuthenticationMethod.Read.All application permission.`
            )
          }
          const methods = (item.body?.value ?? [])
            .map((method) => method['@odata.type'])
            .filter((type): type is string => typeof type === 'string')
          const registeredMfaMethods = [
            ...new Set(
              methods.map((type) => methodLabels[type]).filter(Boolean)
            ),
          ]
          registrations.push({
            id: user.microsoftUserId,
            userPrincipalName: user.userPrincipalName,
            isMfaRegistered: registeredMfaMethods.length > 0,
            isMfaCapable: registeredMfaMethods.length > 0,
            methodsRegistered: registeredMfaMethods,
            collectionSource: 'per-user-authentication-methods',
          })
        })
      }
      await this.saveEntraSnapshot(tenant, 'AUTH_REGISTRATIONS', registrations)
    })
  }

  private async syncAuthenticationMethodPolicy(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'AUTH_METHOD_POLICIES', async () => {
      const response = await fetch(
        'https://graph.microsoft.com/v1.0/policies/authenticationMethodsPolicy',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(30_000),
        }
      )
      if (!response.ok) {
        const graphError = await describeGraphError(response)
        throw new Error(
          `Microsoft authentication-method policy synchronization returned ${response.status}${graphError}.`
        )
      }
      const policy = (await response.json()) as {
        authenticationMethodConfigurations?: unknown[]
      }
      await this.saveEntraSnapshot(
        tenant,
        'AUTH_METHOD_POLICIES',
        policy.authenticationMethodConfigurations ?? []
      )
    })
  }

  private async fetchGraphCollection(
    initialUrl: string,
    accessToken: string,
    resourceLabel: string
  ) {
    const rows: any[] = []
    let nextUrl = initialUrl
    while (nextUrl) {
      if (!nextUrl.startsWith('https://graph.microsoft.com/')) {
        throw new Error(`Microsoft returned an invalid ${resourceLabel} link.`)
      }
      const response = await fetch(nextUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        const requestId = response.headers.get('request-id')
        const graphError = await describeGraphError(response)
        throw new Error(
          `Microsoft ${resourceLabel} synchronization returned ${response.status}${
            requestId ? ` (request ${requestId})` : ''
          }${graphError}.`
        )
      }
      const page = (await response.json()) as GraphCollectionPage
      rows.push(...(page.value ?? []))
      nextUrl = page['@odata.nextLink'] ?? ''
    }
    return rows
  }

  private async logSyncStart(
    customerTenantId: string,
    resourceType: 'SIGN_INS' | 'AUDIT_LOGS'
  ) {
    const latest =
      resourceType === 'SIGN_INS'
        ? await this.prisma.signInLog.findFirst({
            where: { customerTenantId },
            orderBy: { eventDateTime: 'desc' },
            select: { eventDateTime: true },
          })
        : await this.prisma.directoryAuditLog.findFirst({
            where: { customerTenantId },
            orderBy: { eventDateTime: 'desc' },
            select: { eventDateTime: true },
          })
    return latest
      ? new Date(
          latest.eventDateTime.getTime() - LOG_SYNC_OVERLAP_MINUTES * 60_000
        )
      : new Date(Date.now() - INITIAL_LOG_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  }

  private async syncSignInLogs(tenant: TenantSyncTarget, accessToken: string) {
    return this.runSnapshotSync(tenant, 'SIGN_INS', async () => {
      const start = await this.logSyncStart(tenant.id, 'SIGN_INS')
      const end = new Date()
      const filter = encodeURIComponent(
        `createdDateTime ge ${start.toISOString()} and createdDateTime le ${end.toISOString()}`
      )
      let rows: any[]
      let limited = false
      try {
        rows = await this.fetchGraphCollection(
          `https://graph.microsoft.com/v1.0/auditLogs/signIns?$filter=${filter}&$top=1000`,
          accessToken,
          'sign-in logs'
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (
          !message.includes(
            'Authentication_RequestFromNonPremiumTenantOrB2CTenant'
          ) &&
          !message.includes("doesn't have premium license")
        ) {
          throw error
        }
        rows = await this.fetchLimitedLoginActivity(tenant, start, end)
        limited = true
      }
      const inferredLocations = limited
        ? await this.enrichLimitedSignInLocations(rows)
        : new Map<string, SignInLocation>()
      const ingestedAt = new Date()
      const expiresAt = logExpirationDate(ingestedAt)
      const records = rows
        .filter(
          (row) =>
            typeof row?.id === 'string' &&
            typeof row?.createdDateTime === 'string' &&
            Number.isFinite(new Date(row.createdDateTime).getTime())
        )
        .map((row) => ({
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          microsoftSignInId: limited ? `management:${row.id}` : row.id,
          eventDateTime: new Date(row.createdDateTime),
          userId: typeof row.userId === 'string' ? row.userId : null,
          userDisplayName:
            typeof row.userDisplayName === 'string'
              ? row.userDisplayName
              : null,
          userPrincipalName:
            typeof row.userPrincipalName === 'string'
              ? row.userPrincipalName.toLowerCase()
              : null,
          appId: typeof row.appId === 'string' ? row.appId : null,
          appDisplayName:
            typeof row.appDisplayName === 'string' ? row.appDisplayName : null,
          resourceDisplayName:
            typeof row.resourceDisplayName === 'string'
              ? row.resourceDisplayName
              : null,
          ipAddress: typeof row.ipAddress === 'string' ? row.ipAddress : null,
          clientAppUsed:
            typeof row.clientAppUsed === 'string' ? row.clientAppUsed : null,
          conditionalAccessStatus:
            typeof row.conditionalAccessStatus === 'string'
              ? row.conditionalAccessStatus
              : null,
          isInteractive:
            typeof row.isInteractive === 'boolean' ? row.isInteractive : null,
          riskLevel:
            typeof row.riskLevelAggregated === 'string'
              ? row.riskLevelAggregated
              : typeof row.riskLevelDuringSignIn === 'string'
                ? row.riskLevelDuringSignIn
                : null,
          statusErrorCode:
            row?.status?.errorCode === undefined
              ? null
              : String(row.status.errorCode),
          failureReason:
            typeof row?.status?.failureReason === 'string'
              ? row.status.failureReason
              : null,
          location: row.location ?? undefined,
          deviceDetail: row.deviceDetail ?? undefined,
          raw: limited
            ? {
                ...row,
                hawkviewSource: MANAGEMENT_ACTIVITY_SOURCE,
                hawkviewLimited: true,
              }
            : row,
          ingestedAt,
          expiresAt,
        }))
      if (records.length > 0) {
        await this.prisma.signInLog.createMany({
          data: records as never,
          skipDuplicates: true,
        })
      }
      if (limited && inferredLocations.size > 0) {
        await this.backfillLimitedSignInLocations(
          tenant.id,
          inferredLocations
        )
      }
      await this.prisma.signInLog.deleteMany({
        where: { customerTenantId: tenant.id, expiresAt: { lte: ingestedAt } },
      })
    })
  }

  private async enrichLimitedSignInLocations(rows: any[]) {
    const locations = new Map<string, SignInLocation>()
    const uniqueIps = [
      ...new Set(
        rows
          .filter((row) => !this.hasCompleteSignInLocation(row?.location))
          .map((row) =>
            typeof row?.ipAddress === 'string' ? row.ipAddress.trim() : ''
          )
          .filter(Boolean)
      ),
    ]

    await Promise.all(
      uniqueIps.map(async (ipAddress) => {
        const location = await this.ipGeolocation.lookup(ipAddress)
        if (location) locations.set(ipAddress, location)
      })
    )

    for (const row of rows) {
      if (
        this.hasCompleteSignInLocation(row?.location) ||
        typeof row?.ipAddress !== 'string'
      ) {
        continue
      }
      const location = locations.get(row.ipAddress.trim())
      if (location) row.location = this.mergeSignInLocations(row.location, location)
    }

    return locations
  }

  private hasCompleteSignInLocation(location: unknown) {
    if (!location || typeof location !== 'object' || Array.isArray(location)) {
      return false
    }
    const value = location as Record<string, unknown>
    const coordinates = value.geoCoordinates
    return Boolean(
      this.locationText(value.city) &&
        this.locationText(value.countryOrRegion ?? value.country) &&
        coordinates &&
        typeof coordinates === 'object' &&
        !Array.isArray(coordinates) &&
        typeof (coordinates as Record<string, unknown>).latitude === 'number' &&
        typeof (coordinates as Record<string, unknown>).longitude === 'number'
    )
  }

  private locationText(value: unknown) {
    if (typeof value !== 'string') return null
    const text = value.trim()
    if (!text || ['unknown', 'undefined', 'null'].includes(text.toLowerCase())) {
      return null
    }
    return text
  }

  private mergeSignInLocations(
    microsoftLocation: unknown,
    inferredLocation: SignInLocation
  ): SignInLocation {
    const microsoft =
      microsoftLocation &&
      typeof microsoftLocation === 'object' &&
      !Array.isArray(microsoftLocation)
        ? (microsoftLocation as Record<string, unknown>)
        : {}
    const coordinates = microsoft.geoCoordinates
    const validCoordinates =
      coordinates &&
      typeof coordinates === 'object' &&
      !Array.isArray(coordinates) &&
      typeof (coordinates as Record<string, unknown>).latitude === 'number' &&
      typeof (coordinates as Record<string, unknown>).longitude === 'number'

    return {
      city: this.locationText(microsoft.city) ?? inferredLocation.city,
      state:
        this.locationText(microsoft.state ?? microsoft.region) ??
        inferredLocation.state,
      countryOrRegion:
        this.locationText(microsoft.countryOrRegion ?? microsoft.country) ??
        inferredLocation.countryOrRegion,
      geoCoordinates: validCoordinates
        ? (coordinates as SignInLocation['geoCoordinates'])
        : inferredLocation.geoCoordinates,
      source: inferredLocation.source,
    }
  }

  private async backfillLimitedSignInLocations(
    customerTenantId: string,
    inferredLocations: Map<string, SignInLocation>
  ) {
    const existing = await this.prisma.signInLog.findMany({
      where: {
        customerTenantId,
        microsoftSignInId: { startsWith: 'management:' },
        ipAddress: { in: [...inferredLocations.keys()] },
      },
      select: { id: true, ipAddress: true, location: true },
    })

    await Promise.all(
      existing.map((record) => {
        const inferred = record.ipAddress
          ? inferredLocations.get(record.ipAddress.trim())
          : undefined
        if (!inferred || this.hasCompleteSignInLocation(record.location)) {
          return Promise.resolve()
        }
        return this.prisma.signInLog.update({
          where: { id: record.id },
          data: {
            location: this.mergeSignInLocations(record.location, inferred),
          } as never,
        })
      })
    )
  }

  private async fetchLimitedLoginActivity(
    tenant: TenantSyncTarget,
    requestedStart: Date,
    end: Date
  ) {
    if (!tenant.connection) {
      throw new Error('The Microsoft tenant connection is incomplete.')
    }
    const token =
      await this.microsoftConsent.getTenantManagementActivityAccessToken({
        microsoftTenantId: tenant.microsoftTenantId,
        connectionMode:
          tenant.connection.connectionMode === 'CUSTOMER_MANAGED'
            ? 'CUSTOMER_MANAGED'
            : 'HAWKVIEW_MANAGED',
        clientId: tenant.connection.clientId,
        credentialReference: tenant.connection.credentialReference,
      })
    const baseUrl = `https://manage.office.com/api/v1.0/${encodeURIComponent(tenant.microsoftTenantId)}/activity/feed`
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    }
    const contentType = 'Audit.AzureActiveDirectory'
    const subscriptionIsEnabled = async () => {
      const response = await fetch(`${baseUrl}/subscriptions/list`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) {
        const body = (await response.text()).slice(0, 500)
        throw new Error(
          `Microsoft 365 activity subscription verification returned HTTP ${response.status}${body ? `: ${body}` : '.'}`
        )
      }
      const subscriptions = (await response.json()) as Array<{
        contentType?: string
        status?: string
      }>
      return subscriptions.some(
        (subscription) =>
          subscription.contentType === contentType &&
          subscription.status?.toLowerCase() === 'enabled'
      )
    }

    if (!(await subscriptionIsEnabled())) {
      const startResponse = await fetch(
        `${baseUrl}/subscriptions/start?contentType=${encodeURIComponent(contentType)}`,
        { method: 'POST', headers, signal: AbortSignal.timeout(20_000) }
      )
      if (!startResponse.ok) {
        const body = (await startResponse.text()).slice(0, 500)
        // Microsoft can return HTTP 400 when another worker enabled the same
        // subscription between our list and start requests. Verify the actual
        // state before treating that race as a sync failure.
        if (startResponse.status !== 400 || !(await subscriptionIsEnabled())) {
          if (/tenant [^\s]+ does not exist/i.test(body)) {
            throw new Error(
              'Microsoft unified audit logging is not provisioned for this tenant. Turn on auditing in Microsoft Purview, wait for Microsoft to finish provisioning it, and then retry synchronization.'
            )
          }
          throw new Error(
            `Microsoft 365 activity subscription could not be started (HTTP ${startResponse.status})${body ? `: ${body}` : '.'}`
          )
        }
      }
    }

    const earliest = new Date(
      Date.now() - MANAGEMENT_ACTIVITY_MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    )
    let windowStart = requestedStart > earliest ? requestedStart : earliest
    const contentUris: string[] = []
    while (windowStart < end) {
      const windowEnd = new Date(
        Math.min(end.getTime(), windowStart.getTime() + 23 * 60 * 60 * 1000)
      )
      let pageUrl = `${baseUrl}/subscriptions/content?contentType=${encodeURIComponent(contentType)}&startTime=${encodeURIComponent(windowStart.toISOString())}&endTime=${encodeURIComponent(windowEnd.toISOString())}`
      while (pageUrl) {
        const response = await fetch(pageUrl, {
          headers,
          signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) {
          throw new Error(
            `Microsoft 365 limited login activity returned HTTP ${response.status}.`
          )
        }
        const items = (await response.json()) as Array<{ contentUri?: string }>
        for (const item of items) {
          if (typeof item.contentUri === 'string')
            contentUris.push(item.contentUri)
        }
        pageUrl = response.headers.get('NextPageUri') ?? ''
        if (pageUrl && !pageUrl.startsWith('https://manage.office.com/')) {
          throw new Error(
            'Microsoft returned an invalid activity-feed page URL.'
          )
        }
      }
      windowStart = new Date(windowEnd.getTime() + 1)
    }

    const records: any[] = []
    for (const contentUri of [...new Set(contentUris)]) {
      if (!contentUri.startsWith('https://manage.office.com/')) continue
      const response = await fetch(contentUri, {
        headers,
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) continue
      const content = (await response.json()) as any[]
      records.push(...content)
    }

    return records
      .filter(isManagementActivityLogin)
      .filter(
        (record) =>
          typeof record?.Id === 'string' &&
          typeof record?.CreationTime === 'string' &&
          Number.isFinite(new Date(record.CreationTime).getTime())
      )
      .map((record) => {
        const succeeded = managementActivityLoginSucceeded(record)
        const userPrincipalName =
          typeof record.UserId === 'string' ? record.UserId.toLowerCase() : null
        const countryOrRegion =
          typeof record.Country === 'string'
            ? record.Country
            : typeof record.CountryOrRegion === 'string'
              ? record.CountryOrRegion
              : null
        const city = typeof record.City === 'string' ? record.City : null
        return {
          id: record.Id,
          createdDateTime: record.CreationTime,
          userId:
            typeof record.ObjectId === 'string'
              ? record.ObjectId
              : typeof record.UserKey === 'string'
                ? record.UserKey
                : null,
          userDisplayName:
            typeof record.UserDisplayName === 'string'
              ? record.UserDisplayName
              : null,
          userPrincipalName,
          appId: null,
          appDisplayName:
            typeof record.Application === 'string'
              ? record.Application
              : 'Microsoft 365',
          resourceDisplayName: record.Workload ?? null,
          ipAddress:
            typeof record.ClientIP === 'string' ? record.ClientIP : null,
          clientAppUsed: record.Application ?? null,
          conditionalAccessStatus: null,
          isInteractive: null,
          riskLevelAggregated: null,
          status: {
            errorCode: succeeded
              ? 0
              : String(record.LoginStatus ?? record.ErrorCode ?? 1),
            failureReason: succeeded
              ? null
              : String(
                  record.LogonError ??
                    managementActivityExtendedProperty(
                      record,
                      'LoginError',
                      'LogonError'
                    ) ??
                    record.Operation
                ),
          },
          location: countryOrRegion || city ? { countryOrRegion, city } : null,
          deviceDetail: null,
          managementActivityRecord: record,
        }
      })
  }

  private async syncDirectoryAuditLogs(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'AUDIT_LOGS', async () => {
      const start = await this.logSyncStart(tenant.id, 'AUDIT_LOGS')
      const end = new Date()
      const filter = encodeURIComponent(
        `activityDateTime ge ${start.toISOString()} and activityDateTime le ${end.toISOString()}`
      )
      const rows = await this.fetchGraphCollection(
        `https://graph.microsoft.com/v1.0/auditLogs/directoryAudits?$filter=${filter}&$top=1000`,
        accessToken,
        'directory audit logs'
      )
      const ingestedAt = new Date()
      const expiresAt = logExpirationDate(ingestedAt)
      const records = rows
        .filter(
          (row) =>
            typeof row?.id === 'string' &&
            typeof row?.activityDateTime === 'string' &&
            typeof row?.activityDisplayName === 'string' &&
            Number.isFinite(new Date(row.activityDateTime).getTime())
        )
        .map((row) => ({
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          microsoftAuditId: row.id,
          eventDateTime: new Date(row.activityDateTime),
          activityDisplayName: row.activityDisplayName,
          category: typeof row.category === 'string' ? row.category : null,
          operationType:
            typeof row.operationType === 'string' ? row.operationType : null,
          result: typeof row.result === 'string' ? row.result : null,
          resultReason:
            typeof row.resultReason === 'string' ? row.resultReason : null,
          correlationId:
            typeof row.correlationId === 'string' ? row.correlationId : null,
          loggedByService:
            typeof row.loggedByService === 'string'
              ? row.loggedByService
              : null,
          initiatedBy: row.initiatedBy ?? undefined,
          targetResources: row.targetResources ?? undefined,
          additionalDetails: row.additionalDetails ?? undefined,
          raw: row,
          ingestedAt,
          expiresAt,
        }))
      const existingAuditIds =
        records.length > 0
          ? new Set(
              (
                await this.prisma.directoryAuditLog.findMany({
                  where: {
                    customerTenantId: tenant.id,
                    microsoftAuditId: {
                      in: records.map((record) => record.microsoftAuditId),
                    },
                  },
                  select: { microsoftAuditId: true },
                })
              ).map((record) => record.microsoftAuditId)
            )
          : new Set<string>()
      const newRecords = records.filter(
        (record) => !existingAuditIds.has(record.microsoftAuditId)
      )
      if (records.length > 0) {
        await this.prisma.directoryAuditLog.createMany({
          data: records as never,
          skipDuplicates: true,
        })
      }
      for (const record of newRecords) {
        const activity = record.activityDisplayName.toLowerCase()
        const securityEvent =
          activity.includes('authentication method') || activity.includes('mfa')
            ? {
                severity: 'critical' as const,
                label: 'Authentication methods changed',
              }
            : activity.includes('password')
              ? {
                  severity: 'high' as const,
                  label: 'Password-related change detected',
                }
              : activity.includes('application') ||
                  activity.includes('service principal')
                ? {
                    severity: 'high' as const,
                    label: 'Application registration changed',
                  }
                : activity.includes('role') ||
                    activity.includes('administrator')
                  ? {
                      severity: 'critical' as const,
                      label: 'Administrative role changed',
                    }
                  : null
        if (!securityEvent) continue
        await this.notifications.publishIncident({
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          eventType: 'security.directory_change',
          category:
            securityEvent.severity === 'critical' ? 'error' : 'warning',
          severity: securityEvent.severity,
          title: securityEvent.label,
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
        })
      }
      await this.prisma.directoryAuditLog.deleteMany({
        where: { customerTenantId: tenant.id, expiresAt: { lte: ingestedAt } },
      })
    })
  }

  private async saveSnapshot(
    tenant: { id: string; organizationId: string },
    resourceType: EntraSnapshotResource,
    rows: unknown[]
  ) {
    await this.prisma.tenantEntraSnapshot.upsert({
      where: {
        customerTenantId_resourceType: {
          customerTenantId: tenant.id,
          resourceType,
        },
      },
      create: {
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        resourceType,
        payload: rows as never,
        observedAt: new Date(),
      },
      update: { payload: rows as never, observedAt: new Date() },
    })
  }

  private async syncExchangeMailboxDirectory(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'EXCHANGE_MAILBOXES', async () => {
      const rows: unknown[] = []
      let nextUrl =
        'https://graph.microsoft.com/v1.0/users?$select=id,displayName,userPrincipalName,mail,proxyAddresses,accountEnabled,assignedLicenses&$top=999'
      while (nextUrl) {
        if (!nextUrl.startsWith('https://graph.microsoft.com/')) {
          throw new Error(
            'Microsoft returned an invalid users pagination link.'
          )
        }
        const response = await fetch(nextUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) {
          throw new Error(
            `Microsoft mailbox directory synchronization returned ${response.status}. Confirm User.Read.All application permission.`
          )
        }
        const page = (await response.json()) as GraphCollectionPage
        rows.push(
          ...(page.value ?? [])
            .filter(
              (user: any) =>
                typeof user?.mail === 'string' ||
                (Array.isArray(user?.assignedLicenses) &&
                  user.assignedLicenses.length > 0)
            )
            .map((user: any) => ({
              id: user.id,
              displayName: user.displayName,
              userPrincipalName: user.userPrincipalName,
              mail: user.mail,
              proxyAddresses: user.proxyAddresses ?? [],
              accountEnabled: user.accountEnabled !== false,
            }))
        )
        nextUrl = page['@odata.nextLink'] ?? ''
      }
      await this.saveSnapshot(tenant, 'EXCHANGE_MAILBOXES', rows)
    })
  }

  private async syncExchangeMailboxConfiguration(tenant: TenantSyncTarget) {
    return this.runSnapshotSync(
      tenant,
      'EXCHANGE_MAILBOX_CONFIGURATION',
      async () => {
        if (!tenant.connection) {
          throw new Error('The Microsoft tenant connection is incomplete.')
        }

        const accessToken =
          await this.microsoftConsent.getTenantExchangeAccessToken({
            microsoftTenantId: tenant.microsoftTenantId,
            connectionMode: tenant.connection.connectionMode as
              | 'HAWKVIEW_MANAGED'
              | 'CUSTOMER_MANAGED',
            clientId: tenant.connection.clientId,
            credentialReference: tenant.connection.credentialReference,
          })
        const requestBody = {
          CmdletInput: {
            CmdletName: 'Get-Mailbox',
            Parameters: {
              ResultSize: 'Unlimited',
              IncludeGrantSendOnBehalfTowithDisplayNames: true,
            },
          },
        }
        const rows: unknown[] = []
        let nextUrl = `https://outlook.office365.com/adminapi/v2.0/${encodeURIComponent(tenant.microsoftTenantId)}/Mailbox`
        const anchorMailbox = `APP:SystemMailbox{bb558c35-97f1-4cb9-8ff7-d53741dc928c}@${tenant.microsoftTenantId}`

        while (nextUrl) {
          if (!nextUrl.startsWith('https://outlook.office365.com/')) {
            throw new Error(
              'Microsoft returned an invalid Exchange pagination link.'
            )
          }
          const response = await fetch(nextUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'X-AnchorMailbox': anchorMailbox,
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(60_000),
          })
          if (!response.ok) {
            const details = (await response.text()).slice(0, 1_000)
            throw new Error(
              `Microsoft Exchange mailbox configuration synchronization returned ${response.status}. Confirm Exchange.ManageAsAppV2 and the Recipient Management Exchange RBAC role. ${details}`
            )
          }
          const page = (await response.json()) as GraphCollectionPage
          rows.push(...(Array.isArray(page.value) ? page.value : []))
          nextUrl =
            typeof page['@odata.nextLink'] === 'string'
              ? page['@odata.nextLink']
              : ''
        }

        await this.saveSnapshot(
          tenant,
          'EXCHANGE_MAILBOX_CONFIGURATION',
          rows
        )
      }
    )
  }

  private async syncExchangeAcceptedDomains(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(
      tenant,
      'EXCHANGE_ACCEPTED_DOMAINS',
      async () => {
        const response = await fetch(
          'https://graph.microsoft.com/v1.0/domains?$select=id,isDefault,isInitial,isVerified,supportedServices',
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(30_000),
          }
        )
        if (!response.ok) {
          throw new Error(
            `Microsoft accepted-domain synchronization returned ${response.status}. Confirm Domain.Read.All application permission.`
          )
        }
        const page = (await response.json()) as GraphCollectionPage
        const domains = (page.value ?? [])
          .filter(
            (domain: any) =>
              domain?.isVerified !== false &&
              (!Array.isArray(domain?.supportedServices) ||
                domain.supportedServices.includes('Email'))
          )
          .map((domain: any) => ({
            id: domain.id,
            domain: domain.id,
            type: 'Authoritative',
            isDefault: Boolean(domain.isDefault),
            isInitial: Boolean(domain.isInitial),
          }))
        await this.saveSnapshot(tenant, 'EXCHANGE_ACCEPTED_DOMAINS', domains)
      }
    )
  }

  private async syncExchangeMailboxUsage(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'EXCHANGE_MAILBOX_USAGE', async () => {
      const response = await fetch(
        "https://graph.microsoft.com/v1.0/reports/getMailboxUsageDetail(period='D30')",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'text/csv',
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        }
      )
      let csv = ''
      if (response.ok) csv = await response.text()
      else if (response.status === 302) {
        const location = response.headers.get('location')
        if (!location?.startsWith('https://'))
          throw new Error(
            'Microsoft returned an invalid mailbox usage report link.'
          )
        const download = await fetch(location, {
          signal: AbortSignal.timeout(30_000),
        })
        if (!download.ok)
          throw new Error(
            `Microsoft mailbox usage report download returned ${download.status}.`
          )
        csv = await download.text()
      } else {
        throw new Error(
          `Microsoft mailbox usage synchronization returned ${response.status}.`
        )
      }
      await this.saveSnapshot(
        tenant,
        'EXCHANGE_MAILBOX_USAGE',
        parseCsvRows(csv)
      )
    })
  }

  private async syncExchangeMailboxRules(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'EXCHANGE_MAILBOX_RULES', async () => {
      const users = await this.prisma.directoryUser.findMany({
        where: { customerTenantId: tenant.id, deletedAt: null },
        select: { microsoftUserId: true, userPrincipalName: true },
        take: 500,
      })
      const rows: unknown[] = []
      for (let index = 0; index < users.length; index += 5) {
        const batch = users.slice(index, index + 5)
        const results = await Promise.all(
          batch.map(async (user) => {
            const response = await fetch(
              `https://graph.microsoft.com/v1.0/users/${user.microsoftUserId}/mailFolders/inbox/messageRules`,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: 'application/json',
                },
                signal: AbortSignal.timeout(20_000),
              }
            )
            if (response.status === 404) return []
            if (!response.ok) {
              throw new Error(
                `Microsoft inbox rules synchronization returned ${response.status}. Confirm MailboxSettings.Read application permission.`
              )
            }
            const body = (await response.json()) as GraphCollectionPage
            return (body.value ?? []).map((rule: any) => ({
              ...rule,
              mailboxUserId: user.microsoftUserId,
              mailboxUpn: user.userPrincipalName,
            }))
          })
        )
        rows.push(...results.flat())
      }
      await this.saveSnapshot(tenant, 'EXCHANGE_MAILBOX_RULES', rows)
    })
  }

  private async syncSharePointSites(
    tenant: TenantSyncTarget,
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'SHAREPOINT_SITES', async () => {
      const sites: any[] = []
      const siteFields =
        'id,name,displayName,webUrl,createdDateTime,lastModifiedDateTime,root,siteCollection'

      // Microsoft Graph site search can return an empty collection even when
      // the tenant's root SharePoint site exists. Fetch the root explicitly so
      // a provisioned tenant never appears as an empty SharePoint environment.
      const rootResponse = await fetch(
        `https://graph.microsoft.com/v1.0/sites/root?$select=${siteFields}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(30_000),
        }
      )
      if (rootResponse.ok) {
        sites.push((await rootResponse.json()) as any)
      } else if (rootResponse.status !== 404) {
        throw new Error(
          `Microsoft SharePoint root site synchronization returned ${rootResponse.status}.`
        )
      }

      let nextUrl = `https://graph.microsoft.com/v1.0/sites?search=*&$select=${siteFields}`
      while (nextUrl) {
        if (!nextUrl.startsWith('https://graph.microsoft.com/')) {
          throw new Error(
            'Microsoft returned an invalid SharePoint sites link.'
          )
        }
        const response = await fetch(nextUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) {
          throw new Error(
            `Microsoft SharePoint sites synchronization returned ${response.status}.`
          )
        }
        const page = (await response.json()) as GraphCollectionPage
        sites.push(...((page.value ?? []) as any[]))
        nextUrl = page['@odata.nextLink'] ?? ''
      }

      const uniqueSites = Array.from(
        new Map(
          sites
            .filter((site) => typeof site?.id === 'string')
            .map((site) => [site.id, site])
        ).values()
      )
      const sharePointHost = uniqueSites
        .map((site) => this.getSharePointSiteUrl(site?.webUrl)?.hostname)
        .find((host): host is string => Boolean(host))
      let sharePointAccessToken: string | null = null
      if (sharePointHost && tenant.connection) {
        try {
          sharePointAccessToken =
            await this.microsoftConsent.getTenantSharePointAccessToken({
              microsoftTenantId: tenant.microsoftTenantId,
              connectionMode:
                tenant.connection.connectionMode === 'CUSTOMER_MANAGED'
                  ? 'CUSTOMER_MANAGED'
                  : 'HAWKVIEW_MANAGED',
              clientId: tenant.connection.clientId,
              credentialReference: tenant.connection.credentialReference,
              sharePointHost,
            })
        } catch (error) {
          this.logger.warn(
            `SharePoint site access metadata token unavailable for tenant ${tenant.id}: ${error instanceof Error ? error.message : 'unknown error'}`
          )
        }
      }
      const enrichedSites: any[] = []
      for (let index = 0; index < uniqueSites.length; index += 8) {
        const batch = uniqueSites.slice(index, index + 8)
        const batchRows = await Promise.all(
          batch.map(async (site) => {
            if (typeof site?.id !== 'string')
              return {
                ...site,
                driveQuota: null,
                externalSharing: null,
                guestsCount: null,
              }
            const driveResponse = await fetch(
              `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(site.id)}/drive?$select=id,quota`,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: 'application/json',
                },
                signal: AbortSignal.timeout(20_000),
              }
            )
            const drive = driveResponse.ok
              ? ((await driveResponse.json()) as any)
              : null
            const access = sharePointAccessToken
              ? await this.collectSharePointSiteAccess(
                  site.webUrl,
                  sharePointAccessToken,
                  sharePointHost
                )
              : {
                  externalSharing: null,
                  guestsCount: null,
                  sharingCapability: null,
                  collectionError: 'SharePoint access token unavailable.',
                }
            if (access.collectionError) {
              this.logger.warn(
                `SharePoint access metadata incomplete for tenant ${tenant.id}, site ${String(site.id)}: ${access.collectionError}`
              )
            }
            return {
              ...site,
              driveQuota: drive?.quota ?? null,
              ...access,
            }
          })
        )
        enrichedSites.push(...batchRows)
      }

      await this.prisma.tenantEntraSnapshot.upsert({
        where: {
          customerTenantId_resourceType: {
            customerTenantId: tenant.id,
            resourceType: 'SHAREPOINT_SITES',
          },
        },
        create: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          resourceType: 'SHAREPOINT_SITES',
          payload: enrichedSites as never,
          observedAt: new Date(),
        },
        update: {
          payload: enrichedSites as never,
          observedAt: new Date(),
        },
      })
    })
  }

  private getSharePointSiteUrl(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) return null
    try {
      const url = new URL(value)
      if (
        url.protocol !== 'https:' ||
        !/^[a-z0-9.-]+\.sharepoint\.com$/i.test(url.hostname) ||
        url.hostname.includes('..')
      ) {
        return null
      }
      url.search = ''
      url.hash = ''
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
      return url
    } catch {
      return null
    }
  }

  private async collectSharePointSiteAccess(
    webUrl: unknown,
    accessToken: string,
    expectedHost?: string
  ) {
    const siteUrl = this.getSharePointSiteUrl(webUrl)
    if (!siteUrl || (expectedHost && siteUrl.hostname !== expectedHost)) {
      return {
        externalSharing: null,
        guestsCount: null,
        sharingCapability: null,
        collectionError: 'Invalid SharePoint site URL.',
      }
    }

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json;odata=nometadata',
    }
    let externalSharing: boolean | null = null
    let sharingCapability: string | number | null = null
    let guestsCount: number | null = null
    const errors: string[] = []

    try {
      let nextUrl = new URL(
        '_api/web/siteusers?$select=Id,LoginName,Email,Title,PrincipalType,IsShareByEmailGuestUser&$top=5000',
        siteUrl
      ).toString()
      const guestIds = new Set<string>()
      while (nextUrl) {
        const pageUrl = new URL(nextUrl, siteUrl)
        if (pageUrl.origin !== siteUrl.origin) {
          throw new Error('SharePoint returned an invalid site-users link.')
        }
        const response = await fetch(pageUrl, {
          headers,
          signal: AbortSignal.timeout(20_000),
        })
        if (!response.ok) {
          throw new Error(`site users returned ${response.status}`)
        }
        const body = (await response.json()) as any
        const users = Array.isArray(body?.value)
          ? body.value
          : Array.isArray(body?.d?.results)
            ? body.d.results
            : []
        for (const user of users) {
          const loginName = String(user?.LoginName ?? '')
          const normalizedLogin = loginName.toLowerCase()
          const isGuest =
            user?.IsShareByEmailGuestUser === true ||
            normalizedLogin.includes('#ext#') ||
            normalizedLogin.includes('urn:spo:guest')
          if (!isGuest) continue
          guestIds.add(String(user?.Id ?? loginName).toLowerCase())
        }
        nextUrl =
          body?.['@odata.nextLink'] ?? body?.['odata.nextLink'] ?? body?.d?.__next ?? ''
      }
      guestsCount = guestIds.size
      // This value describes observed external access on the site. The
      // tenant-admin SharingCapability setting is not exposed by `_api/site`.
      externalSharing = guestsCount > 0
      sharingCapability = externalSharing
        ? 'External principals present'
        : 'No external principals present'
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'site users failed')
    }

    return {
      externalSharing,
      guestsCount,
      sharingCapability,
      collectionError: errors.length > 0 ? errors.join('; ') : null,
    }
  }

  private async syncSharePointSettings(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'SHAREPOINT_SETTINGS', async () => {
      const response = await fetch(
        'https://graph.microsoft.com/v1.0/admin/sharepoint/settings',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(30_000),
        }
      )
      if (!response.ok) {
        const graphRequestId = response.headers.get('request-id')
        throw new Error(
          `Microsoft SharePoint settings synchronization returned ${response.status}${
            graphRequestId ? ` (request ${graphRequestId})` : ''
          }.`
        )
      }
      const body = (await response.json()) as any
      // Microsoft documentation has shown both the resource directly and a
      // single resource under `value`; normalize either response shape.
      const settings = Array.isArray(body?.value)
        ? body.value[0]
        : body?.value && typeof body.value === 'object'
          ? body.value
          : body

      if (!settings || typeof settings !== 'object') {
        throw new Error(
          'Microsoft SharePoint settings synchronization returned an empty response.'
        )
      }

      await this.prisma.tenantEntraSnapshot.upsert({
        where: {
          customerTenantId_resourceType: {
            customerTenantId: tenant.id,
            resourceType: 'SHAREPOINT_SETTINGS',
          },
        },
        create: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          resourceType: 'SHAREPOINT_SETTINGS',
          payload: [settings] as never,
          observedAt: new Date(),
        },
        update: {
          payload: [settings] as never,
          observedAt: new Date(),
        },
      })
    })
  }

  private async syncSharePointUsage(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'SHAREPOINT_USAGE', async () => {
      const downloadReport = async (reportUrl: string, label: string) => {
        const reportResponse = await fetch(reportUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'text/csv',
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        })
        if (reportResponse.ok) return reportResponse.text()
        if (reportResponse.status !== 302) {
          const graphRequestId = reportResponse.headers.get('request-id')
          throw new Error(
            `Microsoft ${label} usage synchronization returned ${reportResponse.status}${
              graphRequestId ? ` (request ${graphRequestId})` : ''
            }.`
          )
        }
        const downloadUrl = reportResponse.headers.get('location')
        if (!downloadUrl?.startsWith('https://')) {
          throw new Error(`Microsoft returned an invalid ${label} report link.`)
        }
        const downloadResponse = await fetch(downloadUrl, {
          headers: { Accept: 'text/csv,application/octet-stream' },
          signal: AbortSignal.timeout(30_000),
        })
        if (!downloadResponse.ok) {
          throw new Error(
            `Microsoft ${label} report download returned ${downloadResponse.status}.`
          )
        }
        return downloadResponse.text()
      }

      const [sharePointReport, oneDriveReport] = await Promise.all([
        downloadReport(
          "https://graph.microsoft.com/v1.0/reports/getSharePointSiteUsageDetail(period='D180')",
          'SharePoint'
        ),
        downloadReport(
          "https://graph.microsoft.com/v1.0/reports/getOneDriveUsageAccountDetail(period='D30')",
          'OneDrive'
        ),
      ])
      const payload = [
        {
          hawkviewDataset: 'microsoft-usage-reports-v1',
          sharePointSites: parseCsvRows(sharePointReport),
          oneDriveAccounts: parseCsvRows(oneDriveReport),
        },
      ]
      await this.prisma.tenantEntraSnapshot.upsert({
        where: {
          customerTenantId_resourceType: {
            customerTenantId: tenant.id,
            resourceType: 'SHAREPOINT_USAGE',
          },
        },
        create: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          resourceType: 'SHAREPOINT_USAGE',
          payload: payload as never,
          observedAt: new Date(),
        },
        update: {
          payload: payload as never,
          observedAt: new Date(),
        },
      })
    })
  }

  private async synchronizeUsers(
    tenant: {
      id: string
      organizationId: string
    },
    accessToken: string,
    deltaLink: string | null
  ) {
    let nextUrl =
      deltaLink ??
      `https://graph.microsoft.com/v1.0/users/delta?$select=${USER_SELECT}`
    let finalDeltaLink: string | null = null

    while (nextUrl) {
      if (!nextUrl.startsWith('https://graph.microsoft.com/')) {
        throw new Error('Microsoft returned an invalid synchronization link.')
      }
      const response = await fetch(nextUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) {
        throw new Error(
          `Microsoft users synchronization returned ${response.status}.`
        )
      }
      const page = (await response.json()) as GraphUsersPage
      const observedAt = new Date()
      const operations = (page.value ?? [])
        .filter((user) => typeof user.id === 'string')
        .map((user) => {
          const microsoftUserId = user.id as string
          if (user['@removed']) {
            return this.prisma.directoryUser.updateMany({
              where: {
                customerTenantId: tenant.id,
                microsoftUserId,
              },
              data: { deletedAt: observedAt, lastSeenAt: observedAt },
            })
          }
          const userPrincipalName = user.userPrincipalName?.trim() ?? ''
          const assignedLicenseSkuIds = [
            ...new Set(
              (user.assignedLicenses ?? [])
                .map((license) => license.skuId?.trim().toLowerCase())
                .filter((skuId): skuId is string => Boolean(skuId))
            ),
          ].sort()
          return this.prisma.directoryUser.upsert({
            where: {
              customerTenantId_microsoftUserId: {
                customerTenantId: tenant.id,
                microsoftUserId,
              },
            },
            create: {
              organizationId: tenant.organizationId,
              customerTenantId: tenant.id,
              microsoftUserId,
              displayName: user.displayName?.trim() || userPrincipalName,
              userPrincipalName,
              mail: user.mail?.trim() || null,
              accountEnabled: user.accountEnabled !== false,
              userType: user.userType?.trim() || null,
              assignedLicenseSkuIds,
              lastSeenAt: observedAt,
            },
            update: {
              displayName: user.displayName?.trim() || userPrincipalName,
              userPrincipalName,
              mail: user.mail?.trim() || null,
              accountEnabled: user.accountEnabled !== false,
              userType: user.userType?.trim() || null,
              assignedLicenseSkuIds,
              lastSeenAt: observedAt,
              deletedAt: null,
            },
          })
        })
      if (operations.length > 0) {
        await this.prisma.$transaction(operations)
      }

      nextUrl = page['@odata.nextLink'] ?? ''
      finalDeltaLink = page['@odata.deltaLink'] ?? finalDeltaLink
    }

    if (!finalDeltaLink) {
      throw new Error('Microsoft did not return a users delta checkpoint.')
    }
    return { deltaLink: finalDeltaLink }
  }

  private async buildBundle(tenant: {
    id: string
    organizationId: string
    microsoftTenantId: string
    displayName: string | null
    primaryDomain: string | null
    status: string
    connection: {
      lastVerifiedAt: Date | null
    } | null
  }) {
    const [
      users,
      directoryGroups,
      licenses,
      domains,
      syncStates,
      entraSnapshots,
      signIns,
      auditLogs,
    ] = await Promise.all([
      this.prisma.directoryUser.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          deletedAt: null,
        },
        orderBy: [{ displayName: 'asc' }, { userPrincipalName: 'asc' }],
        include: {
          groupMemberships: {
            select: {
              directoryGroup: {
                select: { displayName: true },
              },
            },
          },
        },
      }),
      this.prisma.directoryGroup.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        orderBy: { displayName: 'asc' },
        include: { memberships: { select: { id: true } } },
      }),
      this.prisma.tenantLicense.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        orderBy: { skuPartNumber: 'asc' },
      }),
      this.prisma.tenantDomain.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
      this.prisma.syncState.findMany({
        where: { customerTenantId: tenant.id },
      }),
      this.prisma.tenantEntraSnapshot.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
      }),
      this.prisma.signInLog.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        orderBy: { eventDateTime: 'desc' },
        take: 5000,
      }),
      this.prisma.directoryAuditLog.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
        },
        orderBy: { eventDateTime: 'desc' },
        take: 5000,
      }),
    ])
    const snapshotByResource = new Map(
      entraSnapshots.map((snapshot) => [
        snapshot.resourceType,
        Array.isArray(snapshot.payload) ? (snapshot.payload as any[]) : [],
      ])
    )
    const servicePrincipalNameByAppId = new Map<string, string>(
      (snapshotByResource.get('SERVICE_PRINCIPALS') ?? [])
        .filter(
          (principal) =>
            typeof principal?.appId === 'string' &&
            typeof principal?.displayName === 'string'
        )
        .map((principal) => [
          principal.appId.toLowerCase(),
          principal.displayName.trim(),
        ])
    )
    const servicePrincipals = snapshotByResource.get('SERVICE_PRINCIPALS') ?? []
    const applications = snapshotByResource.get('APPLICATIONS') ?? []
    const resourceApiByAppId = new Map<
      string,
      {
        displayName: string
        permissionsById: Map<string, string>
      }
    >()
    for (const principal of servicePrincipals) {
      if (typeof principal?.appId !== 'string') continue
      const permissionsById = new Map<string, string>()
      for (const permission of [
        ...(Array.isArray(principal.appRoles) ? principal.appRoles : []),
        ...(Array.isArray(principal.oauth2PermissionScopes)
          ? principal.oauth2PermissionScopes
          : []),
      ]) {
        if (typeof permission?.id !== 'string') continue
        permissionsById.set(
          permission.id.toLowerCase(),
          permission.value ??
            permission.displayName ??
            permission.adminConsentDisplayName ??
            permission.id
        )
      }
      resourceApiByAppId.set(principal.appId.toLowerCase(), {
        displayName: principal.displayName ?? principal.appId,
        permissionsById,
      })
    }
    const securityDefaults = (snapshotByResource.get('SECURITY_DEFAULTS') ??
      [])[0]
    const conditionalAccessTargetNames: Record<string, string> = {
      All: 'All cloud apps',
      Office365: 'Office 365',
      MicrosoftAdminPortals: 'Microsoft Admin Portals',
    }
    const resolveApplicationTarget = (target: unknown) => {
      if (typeof target !== 'string') return String(target ?? '')
      return (
        conditionalAccessTargetNames[target] ??
        servicePrincipalNameByAppId.get(target.toLowerCase()) ??
        target
      )
    }
    const sharePointSites = (
      snapshotByResource.get('SHAREPOINT_SITES') ?? []
    ).filter(isCustomerFacingSharePointSite)
    const sharePointSettings = (snapshotByResource.get('SHAREPOINT_SETTINGS') ??
      [])[0]
    const sharePointUsageSnapshot =
      snapshotByResource.get('SHAREPOINT_USAGE') ?? []
    const combinedUsage =
      sharePointUsageSnapshot.length === 1 &&
      sharePointUsageSnapshot[0]?.hawkviewDataset ===
        'microsoft-usage-reports-v1'
        ? sharePointUsageSnapshot[0]
        : null
    const sharePointUsage = combinedUsage?.sharePointSites ?? sharePointUsageSnapshot
    const oneDriveUsage = combinedUsage?.oneDriveAccounts ?? []
    const exchangeMailboxes = snapshotByResource.get('EXCHANGE_MAILBOXES') ?? []
    const exchangeMailboxConfiguration =
      snapshotByResource.get('EXCHANGE_MAILBOX_CONFIGURATION') ?? []
    const exchangeMailboxUsage =
      snapshotByResource.get('EXCHANGE_MAILBOX_USAGE') ?? []
    const exchangeAcceptedDomains =
      snapshotByResource.get('EXCHANGE_ACCEPTED_DOMAINS') ?? []
    const exchangeMailboxRules =
      snapshotByResource.get('EXCHANGE_MAILBOX_RULES') ?? []
    const domainDnsHealth = snapshotByResource.get('DOMAIN_DNS_HEALTH') ?? []
    const exchangeUsageByUpn = new Map<string, Record<string, string>>()
    for (const row of exchangeMailboxUsage as Array<Record<string, string>>) {
      for (const field of [
        'User Principal Name',
        'User Principal Name (UPN)',
        'Owner Principal Name',
        'Email Address',
      ]) {
        const identity = row?.[field]
        if (typeof identity === 'string' && identity.trim()) {
          exchangeUsageByUpn.set(identity.trim().toLowerCase(), row)
        }
      }
    }
    const exchangeConfigurationByIdentity = new Map<string, any>()
    for (const mailbox of exchangeMailboxConfiguration as any[]) {
      for (const identity of [
        mailbox?.ExternalDirectoryObjectId,
        mailbox?.UserPrincipalName,
        mailbox?.PrimarySmtpAddress,
        mailbox?.WindowsEmailAddress,
        mailbox?.Guid,
      ]) {
        if (identity != null && String(identity).trim()) {
          exchangeConfigurationByIdentity.set(
            String(identity).trim().toLowerCase(),
            mailbox
          )
        }
      }
    }
    const oneDriveUsageByUpn = new Map<string, Record<string, string>>(
      oneDriveUsage
        .filter((row: any) => typeof row?.['Owner Principal Name'] === 'string')
        .map((row: any) => [
          String(row['Owner Principal Name']).toLowerCase(),
          row,
        ])
    )
    const groupSnapshotById = new Map(
      (snapshotByResource.get('GROUPS') ?? [])
        .filter((group: any) => typeof group?.id === 'string')
        .map((group: any) => [group.id, group])
    )
    // The mailbox usage report can anonymize user identities in Microsoft 365.
    // It is enrichment data, not the source of truth for mailbox existence, so
    // never remove Graph directory mailboxes merely because their UPN cannot be
    // joined to a usage row.
    const exchangeMailboxInventory = exchangeMailboxes
    const sharePointUsageByUrl = new Map<string, Record<string, string>>(
      sharePointUsage
        .filter((row: Record<string, string>) =>
          normalizeSharePointUrl(row?.['Site URL'])
        )
        .map((row: Record<string, string>) => [
          normalizeSharePointUrl(row['Site URL']),
          row,
        ])
    )
    const sharePointUsageBySiteId = new Map<string, Record<string, string>>(
      sharePointUsage
        .filter(
          (row: Record<string, string>) =>
            typeof row?.['Site Id'] === 'string' && row['Site Id'].trim()
        )
        .map((row: Record<string, string>) => [
          normalizeSharePointSiteId(row['Site Id']),
          row,
        ])
    )
    const parseReportBytes = (value: unknown) => {
      if (typeof value !== 'string' || !value.trim()) return null
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : null
    }
    const reportBoolean = (value: unknown) =>
      ['true', 'yes', '1'].includes(
        String(value ?? '')
          .trim()
          .toLowerCase()
      )
    const deletedSharePointUsage = sharePointUsage.filter(
      (row: Record<string, string>) => reportBoolean(row?.['Is Deleted'])
    )
    const reportedSharePointAllocationBytes = sharePointUsage.reduce(
      (total: number, row: Record<string, string>) =>
        total + (parseReportBytes(row?.['Storage Allocated (Byte)']) ?? 0),
      0
    )
    const getSharePointUsage = (site: any) => {
      const byUrl = sharePointUsageByUrl.get(
        normalizeSharePointUrl(site?.webUrl)
      )
      if (byUrl) return byUrl
      if (typeof site?.id !== 'string') return undefined
      const siteIds = site.id
        .split(',')
        .map(normalizeSharePointSiteId)
      return siteIds
        .map((siteId: string) => sharePointUsageBySiteId.get(siteId))
        .find(Boolean)
    }
    const sharePointUsageRowsWithActivity = sharePointUsage.filter(
      (row: Record<string, string>) =>
        typeof row?.['Last Activity Date'] === 'string' &&
        Boolean(row['Last Activity Date'].trim())
    )
    const matchedSharePointUsageRows = new Set(
      sharePointSites.map(getSharePointUsage).filter(Boolean)
    )
    // Microsoft 365 conceals site URLs and IDs in usage reports by default in
    // some tenants. The activity dates are still present, but there is no safe
    // way to associate those anonymous rows with a Graph site. Never guess.
    const sharePointUsageIdentifiersConcealed =
      sharePointUsageRowsWithActivity.length > 0 &&
      matchedSharePointUsageRows.size === 0
    const getSharePointSiteType = (site: any, usage: any) => {
      const template = String(usage?.['Root Web Template'] ?? '').toUpperCase()
      const url = normalizeSharePointUrl(site?.webUrl)
      if (url.includes('-my.sharepoint.com/personal/')) return 'OneDrive'
      if (template.includes('SITEPAGEPUBLISHING')) return 'Communication site'
      if (template.includes('GROUP')) return 'Microsoft 365 group site'
      return 'SharePoint site'
    }
    const bytesToGb = (value: unknown) =>
      typeof value === 'number'
        ? Math.round((value / 1024 ** 3) * 100) / 100
        : null
    const bytesToUsageLabel = (value: unknown) => {
      const bytes = parseReportBytes(value)
      if (bytes === null) return 'No usage reported'
      const gigabytes = Math.round((bytes / 1024 ** 3) * 100) / 100
      return `${gigabytes} GB`
    }
    const authRegistrations = snapshotByResource.get('AUTH_REGISTRATIONS') ?? []
    const authRegistrationByUserId = new Map(
      authRegistrations
        .filter((registration) => typeof registration?.id === 'string')
        .map((registration) => [registration.id, registration])
    )
    const roleAssignments = snapshotByResource.get('DIRECTORY_ROLES') ?? []
    const roleNamesByUserId = new Map<string, string[]>()
    for (const assignment of roleAssignments) {
      if (typeof assignment?.principalId !== 'string') continue
      const roleName = assignment?.roleDefinition?.displayName
      if (typeof roleName !== 'string' || !roleName.trim()) continue
      const current = roleNamesByUserId.get(assignment.principalId) ?? []
      current.push(roleName.trim())
      roleNamesByUserId.set(
        assignment.principalId,
        [...new Set(current)].sort()
      )
    }
    const devices = snapshotByResource.get('DEVICES') ?? []
    const devicesByUserId = new Map<
      string,
      Array<{ name: string; os: string; lastSync: string; status: string }>
    >()
    for (const device of devices) {
      const label =
        typeof device?.displayName === 'string' && device.displayName.trim()
          ? device.displayName.trim()
          : typeof device?.deviceId === 'string'
            ? device.deviceId
            : 'Registered device'
      const operatingSystem = [
        typeof device?.operatingSystem === 'string'
          ? device.operatingSystem.trim()
          : '',
        typeof device?.operatingSystemVersion === 'string'
          ? device.operatingSystemVersion.trim()
          : '',
      ]
        .filter(Boolean)
        .join(' ')
      const deviceDetails = {
        name: label,
        os: operatingSystem || 'Unknown',
        lastSync:
          typeof device?.approximateLastSignInDateTime === 'string'
            ? device.approximateLastSignInDateTime
            : 'No activity reported',
        status:
          typeof device?.isCompliant === 'boolean'
            ? device.isCompliant
              ? 'Compliant'
              : 'Non-compliant'
            : 'Unknown',
      }
      for (const owner of Array.isArray(device?.registeredOwners)
        ? device.registeredOwners
        : []) {
        if (typeof owner?.id !== 'string') continue
        const current = devicesByUserId.get(owner.id) ?? []
        if (
          !current.some((registeredDevice) => registeredDevice.name === label)
        ) {
          current.push(deviceDetails)
        }
        devicesByUserId.set(
          owner.id,
          current.sort((left, right) => left.name.localeCompare(right.name))
        )
      }
    }
    const latestSignInByUserId = new Map<string, any>()
    for (const signIn of signIns) {
      if (typeof signIn?.userId !== 'string') continue
      const current = latestSignInByUserId.get(signIn.userId)
      if (
        !current ||
        signIn.eventDateTime.getTime() > current.eventDateTime.getTime()
      ) {
        latestSignInByUserId.set(signIn.userId, signIn)
      }
    }
    const directoryUserNameByIdentity = new Map<string, string>()
    for (const user of users) {
      for (const identity of [
        user.microsoftUserId,
        user.userPrincipalName,
        user.mail,
      ]) {
        if (typeof identity === 'string' && identity.trim()) {
          directoryUserNameByIdentity.set(
            identity.trim().toLowerCase(),
            user.displayName
          )
        }
      }
    }
    const syncStateByResource = new Map(
      syncStates.map((state) => [state.resourceType, state])
    )
    const userSyncState = syncStateByResource.get('USERS')
    const licenseSyncState = syncStateByResource.get('LICENSES')
    const domainSyncState = syncStateByResource.get('DOMAINS')
    const groupSyncState = syncStateByResource.get('GROUPS')
    const signInSyncState = syncStateByResource.get('SIGN_INS')
    const auditLogSyncState = syncStateByResource.get('AUDIT_LOGS')
    const sharePointSitesSyncState = syncStateByResource.get('SHAREPOINT_SITES')
    const sharePointSettingsSyncState = syncStateByResource.get(
      'SHAREPOINT_SETTINGS'
    )
    const sharePointUsageSyncState = syncStateByResource.get('SHAREPOINT_USAGE')
    const exchangeSync = (resource: EntraSnapshotResource) => {
      const state = syncStateByResource.get(resource)
      return {
        status: state?.status.toLowerCase() ?? 'never-synced',
        lastSuccessfulAt: state?.lastSuccessfulAt?.toISOString() ?? null,
        lastError: state?.lastErrorMessage ?? null,
      }
    }
    const sharePointSettingsSynchronized =
      sharePointSettingsSyncState?.status === 'SUCCEEDED' &&
      Boolean(sharePointSettings)
    const sharePointUsageSynchronized =
      sharePointUsageSyncState?.status === 'SUCCEEDED'
    const sharePointActivityAsOf = new Date()
    const getSharePointActivity = (site: any) => {
      const usage = getSharePointUsage(site)
      if (!usage) {
        return {
          lastActivityAt: null,
          activityAgeDays: null,
          activitySource: 'unmatched',
        }
      }

      const value = usage['Last Activity Date']
      if (typeof value !== 'string' || !value.trim()) {
        // A site present in Microsoft's D180 report with no activity date had
        // no reported activity during the observation window. This is useful
        // inactivity evidence, not missing data.
        return {
          lastActivityAt: null,
          activityAgeDays: 180,
          activitySource: 'microsoft-d180-no-activity',
        }
      }

      const parsed = new Date(`${value.trim()}T00:00:00.000Z`)
      if (Number.isNaN(parsed.getTime())) {
        return {
          lastActivityAt: null,
          activityAgeDays: null,
          activitySource: 'invalid-report-date',
        }
      }

      return {
        lastActivityAt: value.trim(),
        activityAgeDays: Math.max(
          0,
          Math.floor(
            (sharePointActivityAsOf.getTime() - parsed.getTime()) /
              (24 * 60 * 60 * 1000)
          )
        ),
        activitySource: 'microsoft-d180-report',
      }
    }
    const sharePointActivity = sharePointSites.map(getSharePointActivity)
    const inactiveSharePointSites90Days = sharePointActivity.filter(
      ({ activityAgeDays }) =>
        typeof activityAgeDays === 'number' && activityAgeDays >= 90
    ).length
    const inactiveSharePointSites180Days = sharePointActivity.filter(
      ({ activityAgeDays }) =>
        typeof activityAgeDays === 'number' && activityAgeDays >= 180
    ).length
    const sharePointSitesWithoutActivity = sharePointActivity.filter(
      ({ activityAgeDays }) => activityAgeDays === null
    ).length
    const licenseNameBySkuId = new Map(
      licenses.map((license) => [
        license.microsoftSkuId.toLowerCase(),
        getMicrosoftSkuName(license.skuPartNumber),
      ])
    )
    // Connector verification only proves that credentials work. It is not a
    // data synchronization and must never be displayed as one.
    const successfulDates = syncStates
      .map((state) => state.lastSuccessfulAt)
      .filter((date): date is Date => Boolean(date))
    const lastSync =
      successfulDates.length > 0
        ? new Date(Math.max(...successfulDates.map((date) => date.getTime())))
        : null

    return {
      bundle: {
        tenant: {
          id: tenant.id,
          name:
            tenant.displayName ??
            `Microsoft tenant ${tenant.microsoftTenantId.slice(0, 8)}`,
          domain:
            domains.find((domain) => domain.isDefault)?.name ??
            tenant.primaryDomain ??
            '',
          domains: domains.map((domain) => domain.name),
          provider: 'microsoft',
          status: tenant.status === 'ACTIVE' ? 'healthy' : 'warning',
          secureScore: 0,
          licenseCount: licenses.reduce(
            (total, license) => total + license.enabledUnits,
            0
          ),
          lastSync: lastSync?.toISOString() ?? null,
        },
        dns: (() => {
          const selectedDomain =
            domains.find((domain) => domain.isDefault)?.name ??
            tenant.primaryDomain ??
            ''
          const byDomain = Object.fromEntries(
            domainDnsHealth
              .filter((result) => typeof result?.domain === 'string')
              .map((result) => [result.domain.toLowerCase(), result])
          )
          return {
            ...(byDomain[selectedDomain.toLowerCase()] ?? {}),
            byDomain,
          }
        })(),
        users: users.map((user) => {
          const registration = authRegistrationByUserId.get(
            user.microsoftUserId
          )
          const roleNames = roleNamesByUserId.get(user.microsoftUserId) ?? []
          const lastSignIn = latestSignInByUserId.get(user.microsoftUserId)
          const normalizedUpn = user.userPrincipalName.toLowerCase()
          const oneDrive = oneDriveUsageByUpn.get(normalizedUpn)
          const mailboxUsage = exchangeUsageByUpn.get(normalizedUpn)
          return {
            id: user.microsoftUserId,
            name: user.displayName,
            email: user.userPrincipalName || user.mail || '',
            type: user.userType === 'Guest' ? 'Guest' : 'Member',
            role: roleNames.length > 0 ? roleNames.join(', ') : 'User',
            status: user.accountEnabled ? 'Enabled' : 'Disabled',
            // MFA requires a separate Graph dataset. Never turn missing data into
            // a security finding by reporting it as disabled.
            mfa:
              typeof registration?.isMfaRegistered === 'boolean'
                ? registration.isMfaRegistered
                  ? 'Enabled'
                  : 'Disabled'
                : 'Unknown',
            lastLogin:
              lastSignIn?.eventDateTime instanceof Date
                ? lastSignIn.eventDateTime.toISOString()
                : 'No sign-in recorded',
            driveUsage: oneDrive
              ? bytesToUsageLabel(oneDrive['Storage Used (Byte)'])
              : 'No usage reported',
            mailUsage: mailboxUsage
              ? bytesToUsageLabel(mailboxUsage['Storage Used (Byte)'])
              : 'No usage reported',
            authMethods: Array.isArray(registration?.methodsRegistered)
              ? registration.methodsRegistered
              : [],
            licenses: user.assignedLicenseSkuIds.map(
              (skuId) => licenseNameBySkuId.get(skuId.toLowerCase()) ?? skuId
            ),
            assignedLicenseSkuIds: user.assignedLicenseSkuIds,
            groups: user.groupMemberships
              .map((membership) => membership.directoryGroup.displayName)
              .sort((left, right) => left.localeCompare(right)),
            devices: devicesByUserId.get(user.microsoftUserId) ?? [],
          }
        }),
        signIns: signIns.map((signIn) => ({
          id: signIn.microsoftSignInId,
          userId: signIn.userId,
          userDisplayName:
            signIn.userDisplayName ??
            (typeof signIn.userId === 'string'
              ? directoryUserNameByIdentity.get(signIn.userId.toLowerCase())
              : undefined) ??
            (typeof signIn.userPrincipalName === 'string'
              ? directoryUserNameByIdentity.get(
                  signIn.userPrincipalName.toLowerCase()
                )
              : undefined) ??
            signIn.userPrincipalName ??
            'Unknown user',
          userPrincipalName: signIn.userPrincipalName ?? '',
          createdAt: signIn.eventDateTime.toISOString(),
          ipAddress: signIn.ipAddress ?? '',
          result:
            Number(signIn.statusErrorCode ?? 1) === 0 ? 'Success' : 'Failure',
          appDisplayName: signIn.appDisplayName ?? 'Unknown application',
          clientAppUsed: signIn.clientAppUsed ?? 'Unknown',
          conditionalAccess: signIn.conditionalAccessStatus,
          country:
            (signIn.location as any)?.countryOrRegion ??
            ((signIn.raw as any)?.hawkviewLimited
              ? 'Not provided by Microsoft'
              : 'Unknown'),
          city: (signIn.location as any)?.city ?? undefined,
          state: (signIn.location as any)?.state ?? undefined,
          latitude: Number(
            (signIn.location as any)?.geoCoordinates?.latitude ?? 0
          ),
          longitude: Number(
            (signIn.location as any)?.geoCoordinates?.longitude ?? 0
          ),
          device: (signIn.deviceDetail as any)?.displayName ?? undefined,
          os: (signIn.deviceDetail as any)?.operatingSystem ?? undefined,
          riskLevel: signIn.riskLevel,
          failureReason: signIn.failureReason,
          dataSource:
            (signIn.raw as any)?.hawkviewSource === MANAGEMENT_ACTIVITY_SOURCE
              ? 'microsoft-365-management-activity'
              : 'entra-sign-in-logs',
          isLimited: Boolean((signIn.raw as any)?.hawkviewLimited),
        })),
        auditLogs: auditLogs.map((audit) => ({
          id: audit.microsoftAuditId,
          createdAt: audit.eventDateTime.toISOString(),
          activity: audit.activityDisplayName,
          category: audit.category,
          operationType: audit.operationType,
          result: audit.result,
          resultReason: audit.resultReason,
          correlationId: audit.correlationId,
          service: audit.loggedByService,
          initiatedBy: audit.initiatedBy,
          targetResources: audit.targetResources,
          additionalDetails: audit.additionalDetails,
        })),
        logRetention: {
          months: LOG_RETENTION_MONTHS,
          displayedRecordLimit: 5000,
        },
        exchange: {
          sync: {
            mailboxes: exchangeSync('EXCHANGE_MAILBOXES'),
            mailboxConfiguration: exchangeSync(
              'EXCHANGE_MAILBOX_CONFIGURATION'
            ),
            mailboxUsage: exchangeSync('EXCHANGE_MAILBOX_USAGE'),
            acceptedDomains: exchangeSync('EXCHANGE_ACCEPTED_DOMAINS'),
            inboxRules: exchangeSync('EXCHANGE_MAILBOX_RULES'),
          },
          mailboxes: exchangeMailboxInventory.map((mailbox: any) => {
            const directoryUpn = String(
              mailbox.UserPrincipalName ??
                mailbox.userPrincipalName ??
                mailbox.PrimarySmtpAddress ??
                mailbox.mail ??
                mailbox.WindowsEmailAddress ??
                ''
            )
            const configuration =
              exchangeConfigurationByIdentity.get(
                String(mailbox.id ?? '').toLowerCase()
              ) ??
              exchangeConfigurationByIdentity.get(directoryUpn.toLowerCase()) ??
              {}
            const enrichedMailbox = { ...mailbox, ...configuration }
            const upn = String(
              enrichedMailbox.UserPrincipalName ??
                enrichedMailbox.userPrincipalName ??
                enrichedMailbox.PrimarySmtpAddress ??
                enrichedMailbox.mail ??
                enrichedMailbox.WindowsEmailAddress ??
                directoryUpn
            )
            const usage = exchangeUsageByUpn.get(upn.toLowerCase())
            const storageBytes = Number(usage?.['Storage Used (Byte)'])
            const recipientType = String(
              enrichedMailbox.RecipientTypeDetails ??
                enrichedMailbox.RecipientType ??
                'UserMailbox'
            )
            const mailboxType = recipientType.includes('Shared')
              ? 'Shared'
              : recipientType.includes('Room')
                ? 'Room'
                : recipientType.includes('Equipment')
                  ? 'Equipment'
                  : 'User'
            const emailAddresses = Array.isArray(enrichedMailbox.EmailAddresses)
              ? enrichedMailbox.EmailAddresses
              : []
            return {
              id: String(
                enrichedMailbox.ExternalDirectoryObjectId ??
                  mailbox.id ??
                  enrichedMailbox.Guid ??
                  enrichedMailbox.Identity ??
                  upn
              ),
              displayName: String(
                enrichedMailbox.DisplayName ??
                  mailbox.displayName ??
                  enrichedMailbox.Name ??
                  upn
              ),
              userPrincipalName: upn,
              aliases: (emailAddresses.length > 0
                ? emailAddresses
                : Array.isArray(mailbox.proxyAddresses)
                  ? mailbox.proxyAddresses
                  : []
              )
                .map((address: unknown) => String(address))
                .filter((address: string) =>
                  address.toLowerCase().startsWith('smtp:')
                )
                .map((address: string) => address.slice(5)),
              mailboxType,
              sizeGB: Number.isFinite(storageBytes)
                ? Math.round((storageBytes / 1024 ** 3) * 100) / 100
                : null,
              itemCount: Number(usage?.['Item Count']) || null,
              archiveEnabled:
                String(enrichedMailbox.ArchiveStatus ?? '').toLowerCase() ===
                  'active' ||
                Boolean(
                  enrichedMailbox.ArchiveGuid &&
                  !String(enrichedMailbox.ArchiveGuid).startsWith('00000000')
                ),
              retentionLabel:
                enrichedMailbox.RetentionPolicy ??
                enrichedMailbox.RetentionHoldEnabled ??
                null,
              delegation: {
                fullAccess: [],
                sendAs: [],
                sendOnBehalf: Array.isArray(
                  enrichedMailbox.GrantSendOnBehalfToWithDisplayNames
                )
                  ? enrichedMailbox.GrantSendOnBehalfToWithDisplayNames
                  : [],
              },
              lastLogon: usage?.['Last Activity Date'] || null,
            }
          }),
          rules: exchangeMailboxRules.map((rule: any) => ({
            id: String(
              rule.id ??
                `${rule.mailboxUserId}-${rule.sequence ?? rule.displayName}`
            ),
            name: String(rule.displayName ?? 'Unnamed inbox rule'),
            mailboxUpn: String(rule.mailboxUpn ?? ''),
            enabled: rule.isEnabled !== false,
            priority: Number(rule.sequence ?? 0),
            description: String(rule.displayName ?? 'Inbox rule'),
            actions: Object.entries(rule.actions ?? {})
              .filter(
                ([, value]) =>
                  value !== null &&
                  value !== false &&
                  (!Array.isArray(value) || value.length > 0)
              )
              .map(([name]) => name),
            conditions: Object.entries(rule.conditions ?? {})
              .filter(
                ([, value]) =>
                  value !== null &&
                  value !== false &&
                  (!Array.isArray(value) || value.length > 0)
              )
              .map(([name]) => name),
          })),
          acceptedDomains: exchangeAcceptedDomains.map((domain: any) => ({
            id: String(
              domain.Guid ??
                domain.id ??
                domain.Identity ??
                domain.DomainName ??
                domain.Name ??
                domain.domain
            ),
            domain: String(
              domain.DomainName ??
                domain.domain ??
                domain.Name ??
                domain.Identity ??
                domain.id ??
                ''
            ),
            type: String(domain.DomainType ?? domain.type ?? 'Authoritative'),
            isDefault: Boolean(
              domain.Default ?? domain.IsDefault ?? domain.isDefault
            ),
          })),
          groups: directoryGroups
            .filter((group) => group.mailEnabled)
            .map((group) => {
              const graphGroup = groupSnapshotById.get(group.microsoftGroupId)
              return {
                id: group.microsoftGroupId,
                name: group.displayName,
                type: group.groupTypes.includes('Unified')
                  ? 'Microsoft365'
                  : group.securityEnabled
                    ? 'MailEnabledSecurity'
                    : 'DistributionList',
                email: group.mail ?? '',
                membersCount: group.memberships.length,
                owners: Array.isArray(graphGroup?.owners)
                  ? graphGroup.owners.map(
                      (owner: any) =>
                        owner.displayName ?? owner.userPrincipalName ?? owner.id
                    )
                  : [],
                description: group.description ?? undefined,
              }
            }),
        },
        sharepoint: {
          sync: {
            sites: {
              status:
                sharePointSitesSyncState?.status.toLowerCase() ??
                'never-synced',
              lastSuccessfulAt:
                sharePointSitesSyncState?.lastSuccessfulAt?.toISOString() ??
                null,
              lastError: sharePointSitesSyncState?.lastErrorMessage ?? null,
            },
            settings: {
              status:
                sharePointSettingsSyncState?.status.toLowerCase() ??
                'never-synced',
              lastSuccessfulAt:
                sharePointSettingsSyncState?.lastSuccessfulAt?.toISOString() ??
                null,
              lastError: sharePointSettingsSyncState?.lastErrorMessage ?? null,
            },
            usage: {
              status:
                sharePointUsageSyncState?.status.toLowerCase() ??
                'never-synced',
              lastSuccessfulAt:
                sharePointUsageSyncState?.lastSuccessfulAt?.toISOString() ??
                null,
              lastError: sharePointUsageSyncState?.lastErrorMessage ?? null,
            },
          },
          capabilities: {
            tenantSettings: sharePointSettingsSynchronized,
            usageReport: sharePointUsageSynchronized,
            // The usage report provides one reported owner, not a complete
            // owners collection. It can still identify sites for which
            // Microsoft reports no owner at all.
            siteOwnerPresence: sharePointUsageSynchronized,
            deletedSites: sharePointUsageSynchronized,
          },
          overview: {
            totalSites: sharePointSites.length,
            // Microsoft Graph does not expose the licensed tenant storage
            // pool. Its usage report does provide each reported site's
            // allocation, so expose that useful aggregate with an explicit
            // capability label instead of presenting it as licensed quota.
            totalStorageQuotaGB:
              sharePointUsageSynchronized &&
              reportedSharePointAllocationBytes > 0
                ? bytesToGb(reportedSharePointAllocationBytes)
                : null,
            storageQuotaSource:
              sharePointUsageSynchronized &&
              reportedSharePointAllocationBytes > 0
                ? 'reported-site-allocation'
                : 'unavailable',
            oneDriveStorageLimitGB:
              typeof sharePointSettings?.personalSiteDefaultStorageLimitInMB ===
              'number'
                ? Math.round(
                    (sharePointSettings.personalSiteDefaultStorageLimitInMB /
                      1024) *
                      100
                  ) / 100
                : null,
            siteStorageLimitsMode:
              typeof sharePointSettings?.isSitesStorageLimitAutomatic ===
              'boolean'
                ? sharePointSettings.isSitesStorageLimitAutomatic
                  ? 'Automatic'
                  : 'Manual'
                : 'Unavailable from Microsoft Graph',
            sitesMissingReportedOwner: sharePointUsageSynchronized
              ? sharePointSites.filter((site) => {
                  const usage = getSharePointUsage(site)
                  return ![
                    usage?.['Owner Principal Name'],
                    usage?.['Owner Display Name'],
                  ].some(
                    (owner) =>
                      typeof owner === 'string' && Boolean(owner.trim())
                  )
                }).length
              : null,
            activityAsOf: sharePointActivityAsOf.toISOString(),
            activityObservationWindowDays: 180,
            inactiveSites90Days: sharePointUsageSynchronized
              ? inactiveSharePointSites90Days
              : null,
            inactiveSites180Days: sharePointUsageSynchronized
              ? inactiveSharePointSites180Days
              : null,
            sitesWithActivityData: sharePointUsageSynchronized
              ? sharePointSites.length - sharePointSitesWithoutActivity
              : null,
            sitesWithoutActivityData: sharePointUsageSynchronized
              ? sharePointSitesWithoutActivity
              : null,
            activityDataStatus: sharePointUsageIdentifiersConcealed
              ? 'identifiers-concealed'
              : sharePointUsageSynchronized
                ? sharePointSitesWithoutActivity === 0
                  ? 'available'
                  : 'partial'
                : 'unavailable',
            activityReportRows: sharePointUsageRowsWithActivity.length,
            matchedActivitySites: matchedSharePointUsageRows.size,
            activityDataMessage: sharePointUsageIdentifiersConcealed
              ? 'Microsoft returned SharePoint activity dates with concealed site identifiers. Turn off concealed names in Microsoft 365 Admin Center > Settings > Org settings > Services > Reports, then synchronize again.'
              : null,
            // Graph exposes one tenant sharing capability for the combined
            // SharePoint and OneDrive settings resource. Until Microsoft
            // exposes separate values, show the same authoritative tenant
            // policy in both cards rather than pretending OneDrive failed.
            sharingSharePoint: sharePointSettingsSynchronized
              ? (sharePointSettings?.sharingCapability ?? null)
              : null,
            sharingOneDrive: sharePointSettingsSynchronized
              ? (sharePointSettings?.sharingCapability ?? null)
              : null,
          },
          sites: sharePointSites.map((site) => {
            const usage = getSharePointUsage(site)
            const activity = getSharePointActivity(site)
            const reportStorageUsed = parseReportBytes(
              usage?.['Storage Used (Byte)']
            )
            const reportStorageAllocated = parseReportBytes(
              usage?.['Storage Allocated (Byte)']
            )
            return {
              id: site.id,
              name: site.displayName || site.name || 'Unnamed SharePoint site',
              url: site.webUrl || '',
              type: getSharePointSiteType(site, usage),
              externalSharing:
                typeof site.externalSharing === 'boolean'
                  ? site.externalSharing
                  : null,
              guestsCount:
                typeof site.guestsCount === 'number'
                  ? site.guestsCount
                  : null,
              owners: null,
              hasReportedOwner: [
                usage?.['Owner Principal Name'],
                usage?.['Owner Display Name'],
              ].some(
                (owner) => typeof owner === 'string' && Boolean(owner.trim())
              ),
              ownerDisplayName:
                typeof usage?.['Owner Display Name'] === 'string' &&
                usage['Owner Display Name'].trim()
                  ? usage['Owner Display Name'].trim()
                  : null,
              storageUsedGB: bytesToGb(
                reportStorageUsed ?? site?.driveQuota?.used
              ),
              storageQuotaGB: bytesToGb(
                reportStorageAllocated ?? site?.driveQuota?.total
              ),
              lastActivity:
                activity.activitySource === 'microsoft-d180-no-activity'
                  ? 'No activity in the last 180 days'
                  : activity.activitySource === 'unmatched'
                    ? 'Activity unavailable for this site'
                    : activity.lastActivityAt || 'Activity date unavailable',
              lastActivityAt: activity.lastActivityAt,
              activityAgeDays: activity.activityAgeDays,
              activitySource: activity.activitySource,
              activityStatus:
                activity.activityAgeDays === null
                  ? 'unknown'
                  : activity.activityAgeDays >= 90
                    ? 'inactive'
                    : 'active',
            }
          }),
          // This is the deleted-site signal in Microsoft's D180 usage report.
          // It is not the SharePoint recycle bin and must not be presented as
          // a complete list of recoverable sites.
          deletedSites: deletedSharePointUsage.map(
            (row: Record<string, string>, index: number) => ({
              id: row['Site Id'] || row['Site URL'] || `deleted-site-${index}`,
              name:
                row['Site Name'] ||
                row['Site URL'] ||
                'Deleted SharePoint site',
              url: row['Site URL'] || '',
              ownerDisplayName: row['Owner Display Name'] || null,
              ownerPrincipalName: row['Owner Principal Name'] || null,
              lastActivity: row['Last Activity Date'] || null,
              reportPeriod: 'D30',
              source: 'microsoft-usage-report',
            })
          ),
          deletedSitesSynchronized: sharePointUsageSynchronized,
          unsupported: {
            siteOwnerCount:
              'Microsoft Graph site inventory and usage reports do not provide a reliable owner count.',
            deletedSitesRecycleBin:
              'Microsoft Graph does not provide the complete SharePoint recycle-bin inventory; HawkView shows deleted sites reported by Microsoft usage data for the last 30 days.',
          },
        },
        teams: {},
        licenses: {
          rows: licenses.map((license) => ({
            skuId: license.microsoftSkuId,
            skuPartNumber: license.skuPartNumber,
            name: getMicrosoftSkuName(license.skuPartNumber),
            used: license.consumedUnits,
            total: license.enabledUnits,
            warning: license.warningUnits,
            suspended: license.suspendedUnits,
            lockedOut: license.lockedOutUnits,
            capabilityStatus: license.capabilityStatus,
          })),
        },
        entra: {
          securityDefaults:
            typeof securityDefaults?.isEnabled === 'boolean'
              ? {
                  enabled: securityDefaults.isEnabled,
                  state: securityDefaults.isEnabled ? 'ENABLED' : 'DISABLED',
                }
              : null,
          groups: directoryGroups.map((group) => {
            const graphGroup = groupSnapshotById.get(group.microsoftGroupId)
            const isUnified = group.groupTypes.includes('Unified')
            const isDynamic = group.groupTypes.includes('DynamicMembership')
            const type = isUnified
              ? isDynamic
                ? 'Dynamic Microsoft 365'
                : 'Microsoft 365'
              : group.mailEnabled && group.securityEnabled
                ? 'Mail-enabled security'
                : group.mailEnabled
                  ? 'Distribution list'
                  : isDynamic
                    ? 'Dynamic security'
                    : 'Security'
            return {
              id: group.microsoftGroupId,
              objectId: group.microsoftGroupId,
              displayName: group.displayName,
              description: group.description,
              mail: group.mail,
              type,
              groupType: type,
              membershipType: isDynamic ? 'Dynamic' : 'Assigned',
              visibility: group.visibility,
              membersCount: group.memberships.length,
              owners: Array.isArray(graphGroup?.owners)
                ? graphGroup.owners.map(
                    (owner: any) =>
                      owner.displayName ?? owner.userPrincipalName ?? owner.id
                  )
                : [],
              onPremisesSyncEnabled:
                typeof graphGroup?.onPremisesSyncEnabled === 'boolean'
                  ? graphGroup.onPremisesSyncEnabled
                  : false,
            }
          }),
          enterpriseApplications: servicePrincipals.map((principal) => ({
            id: principal.id,
            objectId: principal.id,
            appId: principal.appId,
            displayName: principal.displayName,
            description: principal.description,
            publisher:
              principal.verifiedPublisher?.displayName ??
              principal.publisherName ??
              'Publisher not verified',
            verifiedPublisher: Boolean(
              principal.verifiedPublisher?.verifiedPublisherId
            ),
            servicePrincipalType: principal.servicePrincipalType,
            accountEnabled: principal.accountEnabled,
            appRoleAssignmentRequired: principal.appRoleAssignmentRequired,
            createdDateTime: principal.createdDateTime,
            homepageUrl: principal.homepage,
            loginUrl: principal.loginUrl,
            preferredSingleSignOnMode: principal.preferredSingleSignOnMode,
            assignedUsers: Array.isArray(principal.appRoleAssignedTo)
              ? principal.appRoleAssignedTo
                  .filter(
                    (assignment: any) => assignment.principalType === 'User'
                  )
                  .map(
                    (assignment: any) =>
                      assignment.principalDisplayName ?? assignment.principalId
                  )
              : [],
            assignedGroups: Array.isArray(principal.appRoleAssignedTo)
              ? principal.appRoleAssignedTo
                  .filter(
                    (assignment: any) => assignment.principalType === 'Group'
                  )
                  .map(
                    (assignment: any) =>
                      assignment.principalDisplayName ?? assignment.principalId
                  )
              : [],
            assignedServicePrincipals: Array.isArray(
              principal.appRoleAssignedTo
            )
              ? principal.appRoleAssignedTo
                  .filter(
                    (assignment: any) =>
                      assignment.principalType === 'ServicePrincipal'
                  )
                  .map(
                    (assignment: any) =>
                      assignment.principalDisplayName ?? assignment.principalId
                  )
              : [],
            delegatedGrants: [],
            applicationPermissions: [],
          })),
          appRegistrations: applications.map((application) => {
            const now = Date.now()
            const credentials = [
              ...(Array.isArray(application.passwordCredentials)
                ? application.passwordCredentials.map((credential: any) => ({
                    type: 'Secret',
                    name: credential.displayName ?? 'Client secret',
                    startDate: credential.startDateTime,
                    endDate: credential.endDateTime,
                  }))
                : []),
              ...(Array.isArray(application.keyCredentials)
                ? application.keyCredentials.map((credential: any) => ({
                    type: 'Certificate',
                    name: credential.displayName ?? 'Certificate',
                    startDate: credential.startDateTime,
                    endDate: credential.endDateTime,
                  }))
                : []),
            ].map((credential: any) => {
              const expiration = Date.parse(credential.endDate ?? '')
              const daysRemaining = Number.isFinite(expiration)
                ? (expiration - now) / 86_400_000
                : null
              return {
                ...credential,
                status:
                  daysRemaining === null
                    ? 'Unknown'
                    : daysRemaining < 0
                      ? 'Expired'
                      : daysRemaining <= 30
                        ? 'Expiring'
                        : 'Active',
              }
            })
            const apiPermissions = Array.isArray(
              application.requiredResourceAccess
            )
              ? application.requiredResourceAccess.flatMap((resource: any) =>
                  Array.isArray(resource.resourceAccess)
                    ? resource.resourceAccess.map((permission: any) => {
                        const resourceApi = resourceApiByAppId.get(
                          String(resource.resourceAppId ?? '').toLowerCase()
                        )
                        const permissionName =
                          resourceApi?.permissionsById.get(
                            String(permission.id ?? '').toLowerCase()
                          ) ?? permission.id
                        return {
                          name: permissionName,
                          resourceApi:
                            resourceApi?.displayName ?? resource.resourceAppId,
                          type:
                            permission.type === 'Role'
                              ? 'Application'
                              : 'Delegated',
                          scopeOrRole: permissionName,
                        }
                      })
                    : []
                )
              : []
            return {
              id: application.id,
              objectId: application.id,
              appId: application.appId,
              displayName: application.displayName,
              description: application.description,
              createdDateTime: application.createdDateTime,
              publisherDomain: application.publisherDomain,
              signInAudience: application.signInAudience,
              homepageUrl: application.web?.homePageUrl,
              identifierUris: application.identifierUris ?? [],
              owners: Array.isArray(application.owners)
                ? application.owners.map(
                    (owner: any) =>
                      owner.displayName ?? owner.userPrincipalName ?? owner.id
                  )
                : [],
              credentials,
              apiPermissions,
            }
          }),
          caPolicies: (snapshotByResource.get('CONDITIONAL_ACCESS') ?? []).map(
            (policy) => {
              const includeUsers = policy?.conditions?.users?.includeUsers ?? []
              const includeGroups =
                policy?.conditions?.users?.includeGroups ?? []
              const includeRoles = policy?.conditions?.users?.includeRoles ?? []
              const grants = policy?.grantControls?.builtInControls ?? []
              const state =
                policy?.state === 'enabled'
                  ? 'ON'
                  : policy?.state === 'enabledForReportingButNotEnforced'
                    ? 'REPORT_ONLY'
                    : 'OFF'
              return {
                id: policy.id,
                name: policy.displayName ?? 'Unnamed policy',
                state,
                origin: policy.templateId ? 'MICROSOFT_TEMPLATE' : 'CUSTOM',
                targetSummary: includeUsers.includes('All')
                  ? 'All Users'
                  : `${includeUsers.length + includeGroups.length + includeRoles.length} targets`,
                grantSummary:
                  grants.length > 0
                    ? grants
                        .map((grant: string) =>
                          grant === 'mfa'
                            ? 'Require multifactor authentication'
                            : grant === 'block'
                              ? 'Block access'
                              : grant
                        )
                        .join(', ')
                    : 'No grant controls',
                assignments: {
                  usersAndGroups: {
                    include: [
                      ...includeUsers,
                      ...includeGroups,
                      ...includeRoles,
                    ],
                    exclude: [
                      ...(policy?.conditions?.users?.excludeUsers ?? []),
                      ...(policy?.conditions?.users?.excludeGroups ?? []),
                      ...(policy?.conditions?.users?.excludeRoles ?? []),
                    ],
                  },
                  cloudApps: {
                    include: (
                      policy?.conditions?.applications?.includeApplications ??
                      []
                    ).map(resolveApplicationTarget),
                    exclude: (
                      policy?.conditions?.applications?.excludeApplications ??
                      []
                    ).map(resolveApplicationTarget),
                  },
                },
                conditions: {
                  platforms:
                    policy?.conditions?.platforms?.includePlatforms ?? [],
                },
                accessControls: {
                  grant: grants.map((grant: string) =>
                    grant === 'mfa'
                      ? 'Require multifactor authentication'
                      : grant === 'block'
                        ? 'Block access'
                        : grant
                  ),
                },
              }
            }
          ),
          authMethods: (
            snapshotByResource.get('AUTH_METHOD_POLICIES') ?? []
          ).map((method) => ({
            id: method.id,
            name: formatAuthenticationMethodName(method.id),
            target: summarizeAuthenticationMethodTargets(method),
            status: method.state === 'enabled' ? 'ENABLED' : 'DISABLED',
          })),
          namedLocations: (snapshotByResource.get('NAMED_LOCATIONS') ?? []).map(
            (location) => ({
              id: location.id,
              name: location.displayName ?? 'Unnamed location',
              type: location.isTrusted === true ? 'TRUSTED' : 'OTHER',
              addresses: Array.isArray(location.ipRanges)
                ? location.ipRanges
                    .map((range: any) => range.cidrAddress)
                    .filter(Boolean)
                : (location.countriesAndRegions ?? []),
            })
          ),
        },
        syncedAt: lastSync?.toISOString() ?? null,
        sync: {
          users: {
            status: userSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt:
              userSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: userSyncState?.lastErrorMessage ?? null,
          },
          licenses: {
            status: licenseSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt:
              licenseSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: licenseSyncState?.lastErrorMessage ?? null,
          },
          domains: {
            status: domainSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt:
              domainSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: domainSyncState?.lastErrorMessage ?? null,
          },
          groups: {
            status: groupSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt:
              groupSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: groupSyncState?.lastErrorMessage ?? null,
          },
          signIns: {
            status: signInSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt:
              signInSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: signInSyncState?.lastErrorMessage ?? null,
          },
          auditLogs: {
            status: auditLogSyncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt:
              auditLogSyncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: auditLogSyncState?.lastErrorMessage ?? null,
          },
          applications: exchangeSync('APPLICATIONS'),
          servicePrincipals: exchangeSync('SERVICE_PRINCIPALS'),
          securityDefaults: exchangeSync('SECURITY_DEFAULTS'),
        },
      },
    }
  }
}
