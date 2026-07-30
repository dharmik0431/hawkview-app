import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import { MicrosoftConsentService } from '../microsoft/microsoft-consent.service.js'
import { PrismaService } from '../prisma/prisma.service.js'

const TENANT_ADMIN_ROLES = ['MSP_OWNER', 'MSP_ADMIN'] as const
const USER_SELECT =
  'id,displayName,userPrincipalName,mail,accountEnabled,userType'

interface GraphUser {
  id?: string
  displayName?: string | null
  userPrincipalName?: string | null
  mail?: string | null
  accountEnabled?: boolean | null
  userType?: string | null
  '@removed'?: { reason?: string }
}

interface GraphUsersPage {
  value?: GraphUser[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
}

@Injectable()
export class TenantSyncService {
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
      throw new ForbiddenException('This HawkView account cannot access tenants.')
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

    return this.buildBundle(tenant)
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
              lastSeenAt: observedAt,
            },
            update: {
              displayName: user.displayName?.trim() || userPrincipalName,
              userPrincipalName,
              mail: user.mail?.trim() || null,
              accountEnabled: user.accountEnabled !== false,
              userType: user.userType?.trim() || null,
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
    const [users, syncState] = await Promise.all([
      this.prisma.directoryUser.findMany({
        where: {
          organizationId: tenant.organizationId,
          customerTenantId: tenant.id,
          deletedAt: null,
        },
        orderBy: [{ displayName: 'asc' }, { userPrincipalName: 'asc' }],
      }),
      this.prisma.syncState.findUnique({
        where: {
          customerTenantId_resourceType: {
            customerTenantId: tenant.id,
            resourceType: 'USERS',
          },
        },
      }),
    ])
    // Connector verification only proves that credentials work. It is not a
    // data synchronization and must never be displayed as one.
    const lastSync = syncState?.lastSuccessfulAt ?? null

    return {
      bundle: {
        tenant: {
          id: tenant.id,
          name:
            tenant.displayName ??
            `Microsoft tenant ${tenant.microsoftTenantId.slice(0, 8)}`,
          domain: tenant.primaryDomain ?? '',
          domains: tenant.primaryDomain ? [tenant.primaryDomain] : [],
          provider: 'microsoft',
          status: tenant.status === 'ACTIVE' ? 'healthy' : 'warning',
          secureScore: 0,
          licenseCount: 0,
          lastSync: lastSync?.toISOString() ?? null,
        },
        users: users.map((user) => ({
          id: user.microsoftUserId,
          name: user.displayName,
          email: user.userPrincipalName || user.mail || '',
          type: user.userType === 'Guest' ? 'Guest' : 'Member',
          role: 'User',
          status: user.accountEnabled ? 'Enabled' : 'Disabled',
          // MFA requires a separate Graph dataset. Never turn missing data into
          // a security finding by reporting it as disabled.
          mfa: 'Unknown',
          lastLogin: 'Not synchronized',
          driveUsage: 'Not synchronized',
          mailUsage: 'Not synchronized',
          authMethods: [],
          licenses: [],
          groups: [],
          devices: [],
        })),
        signIns: [],
        exchange: {
          mailboxes: [],
          rules: [],
          acceptedDomains: [],
          groups: [],
        },
        sharepoint: { sites: [], deletedSites: [] },
        teams: {},
        licenses: { rows: [] },
        entra: {
          caPolicies: [],
          authMethods: [],
          namedLocations: [],
        },
        syncedAt: lastSync?.toISOString() ?? null,
        sync: {
          users: {
            status: syncState?.status.toLowerCase() ?? 'never-synced',
            lastSuccessfulAt:
              syncState?.lastSuccessfulAt?.toISOString() ?? null,
            lastError: syncState?.lastErrorMessage ?? null,
          },
        },
      },
    }
  }
}
