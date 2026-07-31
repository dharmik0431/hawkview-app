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
import { PrismaService } from '../prisma/prisma.service.js'

const TENANT_ADMIN_ROLES = ['MSP_OWNER', 'MSP_ADMIN'] as const
const USER_SELECT =
  'id,displayName,userPrincipalName,mail,accountEnabled,userType,assignedLicenses'

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
  | 'SIGN_INS'
  | 'DEVICES'
  | 'DIRECTORY_ROLES'
  | 'SERVICE_PRINCIPALS'
  | 'SHAREPOINT_SITES'

interface GraphCollectionPage {
  value?: unknown[]
  '@odata.nextLink'?: string
}

@Injectable()
export class TenantSyncService {
  private readonly logger = new Logger(TenantSyncService.name)

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(MicrosoftConsentService)
    private readonly microsoftConsent: MicrosoftConsentService
  ) {}

  private async getAuthorizedTenant(
    identity: AuthenticatedIdentity,
    customerTenantId: string
  ) {
    const user = await this.prisma.user.findUnique({
      where: { identityPlatformUserId: identity.subject },
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
    if (
      existingState?.status === 'RUNNING' &&
      existingState.lastAttemptAt &&
      existingState.lastAttemptAt.getTime() > Date.now() - 2 * 60 * 1000
    ) {
      throw new ConflictException('A users synchronization is already running.')
    }

    const now = new Date()
    await this.prisma.syncState.upsert({
      where: {
        customerTenantId_resourceType: {
          customerTenantId: tenant.id,
          resourceType: 'USERS',
        },
      },
      create: {
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        resourceType: 'USERS',
        status: 'RUNNING',
        lastAttemptAt: now,
      },
      update: {
        status: 'RUNNING',
        lastAttemptAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    })

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

    const snapshotAccessToken =
      await this.microsoftConsent.getTenantAccessToken({
        microsoftTenantId: tenant.microsoftTenantId,
        connectionMode:
          tenant.connection.connectionMode === 'CUSTOMER_MANAGED'
            ? 'CUSTOMER_MANAGED'
            : 'HAWKVIEW_MANAGED',
        clientId: tenant.connection.clientId,
        credentialReference: tenant.connection.credentialReference,
      })
    await Promise.all([
      this.syncLicenses(tenant, snapshotAccessToken),
      this.syncDomains(tenant, snapshotAccessToken),
    ])
    // Groups require a separate Microsoft permission. Record an isolated
    // GROUPS failure without hiding successfully refreshed users/licenses.
    await this.syncGroups(tenant, snapshotAccessToken).catch((error) => {
      const message =
        error instanceof Error ? error.message : 'Unknown groups sync error'
      this.logger.error(
        `Groups synchronization failed for tenant ${tenant.id}: ${message}`,
        error instanceof Error ? error.stack : undefined
      )
    })

    const entraModules: Array<Promise<unknown>> = [
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'AUTH_REGISTRATIONS',
        'https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails'
      ),
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'AUTH_METHOD_POLICIES',
        'https://graph.microsoft.com/v1.0/policies/authenticationMethodsPolicy/authenticationMethodConfigurations'
      ),
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
      this.syncEntraCollection(
        tenant,
        snapshotAccessToken,
        'SIGN_INS',
        `https://graph.microsoft.com/v1.0/auditLogs/signIns?$filter=createdDateTime ge ${encodeURIComponent(
          new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
        )}&$top=1000`
      ),
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
        'https://graph.microsoft.com/v1.0/servicePrincipals?$select=id,appId,displayName,servicePrincipalType'
      ),
      this.syncSharePointSites(tenant, snapshotAccessToken),
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
          'DEVICES',
          'DIRECTORY_ROLES',
          'SERVICE_PRINCIPALS',
          'SHAREPOINT_SITES',
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

    return this.buildBundle(tenant)
  }

  private async runSnapshotSync(
    tenant: { id: string; organizationId: string },
    resourceType: 'LICENSES' | 'DOMAINS' | 'GROUPS' | EntraSnapshotResource,
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
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Microsoft ${resourceType.toLowerCase()} synchronization failed.`
      await this.prisma.syncState.update({
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

  private async syncGroups(
    tenant: { id: string; organizationId: string },
    accessToken: string
  ) {
    return this.runSnapshotSync(tenant, 'GROUPS', async () => {
      const groups: GraphGroup[] = []
      let groupsUrl =
        'https://graph.microsoft.com/v1.0/groups?' +
        '$select=id,displayName,description,mail,mailNickname,mailEnabled,' +
        'securityEnabled,groupTypes,visibility&$top=999'

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

      const memberIdsByGroupId = new Map<string, string[]>()
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
            throw new Error(
              `Microsoft group membership synchronization returned ${response.status}.`
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
        memberIdsByGroupId.set(groupId, [...new Set(memberIds)])
      }

      // Keep concurrency bounded to avoid overwhelming Microsoft Graph while
      // still making the initial snapshot practical for tenants with many groups.
      for (let index = 0; index < groups.length; index += 5) {
        await Promise.all(
          groups
            .slice(index, index + 5)
            .map((group) => fetchGroupMemberIds(group.id as string))
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
          throw new Error(
            `Microsoft ${resourceType.toLowerCase()} synchronization returned ${response.status}${
              graphRequestId ? ` (request ${graphRequestId})` : ''
            }.`
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

  private async syncSharePointSites(
    tenant: { id: string; organizationId: string },
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

      let nextUrl =
        `https://graph.microsoft.com/v1.0/sites?search=*&$select=${siteFields}`
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
      const enrichedSites: any[] = []
      for (let index = 0; index < uniqueSites.length; index += 8) {
        const batch = uniqueSites.slice(index, index + 8)
        const batchRows = await Promise.all(
          batch.map(async (site) => {
            if (typeof site?.id !== 'string')
              return { ...site, driveQuota: null }
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
            if (!driveResponse.ok) return { ...site, driveQuota: null }
            const drive = (await driveResponse.json()) as any
            return { ...site, driveQuota: drive?.quota ?? null }
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
    const [users, licenses, domains, syncStates, entraSnapshots] =
      await Promise.all([
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
    const sharePointSites = snapshotByResource.get('SHAREPOINT_SITES') ?? []
    const bytesToGb = (value: unknown) =>
      typeof value === 'number'
        ? Math.round((value / 1024 ** 3) * 100) / 100
        : null
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
            : 'Not synchronized',
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
    const signIns = snapshotByResource.get('SIGN_INS') ?? []
    const latestSignInByUserId = new Map<string, any>()
    for (const signIn of signIns) {
      if (typeof signIn?.userId !== 'string') continue
      const current = latestSignInByUserId.get(signIn.userId)
      if (
        !current ||
        String(signIn.createdDateTime) > String(current.createdDateTime)
      ) {
        latestSignInByUserId.set(signIn.userId, signIn)
      }
    }
    const syncStateByResource = new Map(
      syncStates.map((state) => [state.resourceType, state])
    )
    const userSyncState = syncStateByResource.get('USERS')
    const licenseSyncState = syncStateByResource.get('LICENSES')
    const domainSyncState = syncStateByResource.get('DOMAINS')
    const groupSyncState = syncStateByResource.get('GROUPS')
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
        users: users.map((user) => {
          const registration = authRegistrationByUserId.get(
            user.microsoftUserId
          )
          const roleNames = roleNamesByUserId.get(user.microsoftUserId) ?? []
          const lastSignIn = latestSignInByUserId.get(user.microsoftUserId)
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
              typeof lastSignIn?.createdDateTime === 'string'
                ? lastSignIn.createdDateTime
                : 'Not synchronized',
            driveUsage: 'Not synchronized',
            mailUsage: 'Not synchronized',
            authMethods: Array.isArray(registration?.methodsRegistered)
              ? registration.methodsRegistered
              : [],
            licenses: user.assignedLicenseSkuIds.map(
              (skuId) => licenseNameBySkuId.get(skuId.toLowerCase()) ?? skuId
            ),
            groups: user.groupMemberships
              .map((membership) => membership.directoryGroup.displayName)
              .sort((left, right) => left.localeCompare(right)),
            devices: devicesByUserId.get(user.microsoftUserId) ?? [],
          }
        }),
        signIns: signIns.map((signIn) => ({
          id: signIn.id,
          userId: signIn.userId,
          userDisplayName: signIn.userDisplayName ?? 'Unknown user',
          userPrincipalName: signIn.userPrincipalName ?? '',
          createdAt: signIn.createdDateTime,
          ipAddress: signIn.ipAddress ?? '',
          result:
            Number(signIn?.status?.errorCode ?? 1) === 0
              ? 'SUCCESS'
              : 'FAILURE',
          appDisplayName: signIn.appDisplayName ?? 'Unknown application',
          clientAppUsed: signIn.clientAppUsed ?? 'Unknown',
          country: signIn?.location?.countryOrRegion ?? 'Unknown',
          city: signIn?.location?.city ?? undefined,
          latitude: Number(signIn?.location?.geoCoordinates?.latitude ?? 0),
          longitude: Number(signIn?.location?.geoCoordinates?.longitude ?? 0),
          riskLevel: signIn.riskLevelAggregated ?? signIn.riskLevelDuringSignIn,
        })),
        exchange: {
          mailboxes: [],
          rules: [],
          acceptedDomains: [],
          groups: [],
        },
        sharepoint: {
          overview: {
            totalSites: sharePointSites.length,
            totalStorageQuotaGB:
              Math.round(
                sharePointSites.reduce(
                  (total, site) =>
                    total + (bytesToGb(site?.driveQuota?.total) ?? 0),
                  0
                ) * 100
              ) / 100,
            oneDriveStorageLimitGB: null,
            siteStorageLimitsMode: 'Not synchronized',
            sharingSharePoint: null,
            sharingOneDrive: null,
          },
          sites: sharePointSites.map((site) => ({
            id: site.id,
            name: site.displayName || site.name || 'Unnamed SharePoint site',
            url: site.webUrl || '',
            type: 'Team site',
            externalSharing: null,
            guestsCount: null,
            owners: null,
            storageUsedGB: bytesToGb(site?.driveQuota?.used),
            storageQuotaGB: bytesToGb(site?.driveQuota?.total),
            lastActivity: site.lastModifiedDateTime || 'Not synchronized',
          })),
          deletedSites: [],
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
        },
      },
    }
  }
}
