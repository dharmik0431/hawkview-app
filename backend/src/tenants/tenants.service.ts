import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import {
  MembershipRole,
  SyncResourceType,
} from '../generated/prisma/enums.js'
import { MicrosoftConsentService } from '../microsoft/microsoft-consent.service.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import {
  deriveTenantHealth,
  type TenantAuditEvent,
} from './tenant-health.js'
import { getMicrosoftSecureScore } from './secure-score.util.js'

const TENANT_DELETION_ROLES = [
  MembershipRole.MSP_OWNER,
  MembershipRole.MSP_ADMIN,
] as const

const TENANT_ONBOARDING_ROLES = [
  MembershipRole.MSP_OWNER,
  MembershipRole.MSP_ADMIN,
  MembershipRole.MSP_TECHNICIAN,
] as const

const MICROSOFT_TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name)
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(MicrosoftConsentService)
    private readonly microsoftConsent: MicrosoftConsentService,
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService
  ) {}

  private parseMicrosoftTenantId(body: unknown) {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('Microsoft tenant ID is required.')
    }

    const candidate = body as Record<string, unknown>
    const microsoftTenantId =
      typeof candidate.microsoftTenantId === 'string'
        ? candidate.microsoftTenantId.trim().toLowerCase()
        : ''

    if (!MICROSOFT_TENANT_ID_PATTERN.test(microsoftTenantId)) {
      throw new BadRequestException('Enter a valid Microsoft tenant ID.')
    }

    return microsoftTenantId
  }

  private parseCreateTenant(body: unknown) {
    const microsoftTenantId = this.parseMicrosoftTenantId(body)
    const candidate = body as Record<string, unknown>
    const connectionMode =
      candidate.connectionMode === 'CUSTOMER_MANAGED'
        ? 'CUSTOMER_MANAGED'
        : 'HAWKVIEW_MANAGED'
    const clientId =
      typeof candidate.clientId === 'string'
        ? candidate.clientId.trim().toLowerCase()
        : ''
    const clientSecret =
      typeof candidate.clientSecret === 'string'
        ? candidate.clientSecret.trim()
        : ''

    if (connectionMode === 'CUSTOMER_MANAGED') {
      if (!MICROSOFT_TENANT_ID_PATTERN.test(clientId)) {
        throw new BadRequestException(
          'Enter a valid customer-managed Microsoft application ID.'
        )
      }
      if (clientSecret.length < 16 || clientSecret.length > 2048) {
        throw new BadRequestException(
          'Enter a valid customer-managed Microsoft client secret.'
        )
      }
    }
    return { microsoftTenantId, connectionMode, clientId, clientSecret }
  }

  private async getAccessibleOrganizationIds(identity: AuthenticatedIdentity) {
    const user = await this.prisma.user.findUnique({
      where: { authProviderUserId: identity.subject },
      select: {
        disabledAt: true,
        memberships: {
          where: {
            status: 'ACTIVE',
            organization: { status: 'ACTIVE' },
          },
          select: { organizationId: true },
        },
      },
    })

    if (!user) {
      throw new ForbiddenException(
        'Complete HawkView account setup before accessing tenants.'
      )
    }
    if (user.disabledAt) {
      throw new ForbiddenException('This HawkView account is disabled.')
    }

    return user.memberships.map((membership) => membership.organizationId)
  }

  private async getOrganizationIdsForRoles(
    identity: AuthenticatedIdentity,
    roles: readonly MembershipRole[],
    action: string
  ) {
    const user = await this.prisma.user.findUnique({
      where: { authProviderUserId: identity.subject },
      select: {
        disabledAt: true,
        memberships: {
          where: {
            status: 'ACTIVE',
            role: { in: [...roles] },
            organization: { status: 'ACTIVE' },
          },
          select: { organizationId: true },
        },
      },
    })

    if (!user) {
      throw new ForbiddenException(
        `Complete HawkView account setup before ${action}.`
      )
    }
    if (user.disabledAt) {
      throw new ForbiddenException('This HawkView account is disabled.')
    }

    return user.memberships.map((membership) => membership.organizationId)
  }

  private getTenantDeletionOrganizationIds(identity: AuthenticatedIdentity) {
    return this.getOrganizationIdsForRoles(
      identity,
      TENANT_DELETION_ROLES,
      'removing tenants'
    )
  }

  private getTenantOnboardingOrganizationIds(identity: AuthenticatedIdentity) {
    return this.getOrganizationIdsForRoles(
      identity,
      TENANT_ONBOARDING_ROLES,
      'onboarding tenants'
    )
  }

  private mapTenant(tenant: {
    id: string
    microsoftTenantId: string
    displayName: string | null
    primaryDomain: string | null
    status: string
    organization: { id: string; name: string; slug: string }
    connection: {
      connectionMode: string
      status: string
      consentedPermissions: string[]
      lastVerifiedAt: Date | null
      lastErrorCode: string | null
    } | null
    tenantLicenses: Array<{ enabledUnits: number }>
    syncStates: Array<{
      resourceType: string
      status: string
      lastAttemptAt: Date | null
      lastSuccessfulAt: Date | null
      lastErrorCode: string | null
      lastErrorMessage: string | null
      consecutiveFailures: number
    }>
    entraSnapshots: Array<{
      resourceType: SyncResourceType
      payload: unknown
      observedAt: Date
    }>
  }, riskyIdentityCount = 0, auditEvents: TenantAuditEvent[] = []) {
    const requiredPermissions = this.microsoftConsent.getRequiredPermissions()
    const consentedPermissions = tenant.connection?.consentedPermissions ?? []
    const connectionStatus = tenant.connection?.status ?? null
    const effectiveStatus =
      connectionStatus === 'ERROR' || connectionStatus === 'REVOKED'
        ? 'disconnected'
        : connectionStatus === 'PENDING_CONSENT'
          ? 'pending'
          : tenant.status.toLowerCase()

    const missingPermissions = requiredPermissions
      .map((permission) => permission.name)
      .filter((permission) => !consentedPermissions.includes(permission))
    const health = deriveTenantHealth({
      tenantId: tenant.id,
      effectiveStatus,
      connectionStatus,
      connectionLastVerifiedAt: tenant.connection?.lastVerifiedAt ?? null,
      missingPermissions,
      syncStates: tenant.syncStates,
      authSnapshot:
        tenant.entraSnapshots.find(
          (snapshot) =>
            snapshot.resourceType === SyncResourceType.AUTH_REGISTRATIONS,
        ) ?? null,
      riskyIdentityCount,
      auditEvents,
    })

    return {
      id: tenant.id,
      name:
        tenant.displayName ??
        `Microsoft tenant ${tenant.microsoftTenantId.slice(0, 8)}`,
      microsoftTenantId: tenant.microsoftTenantId,
      provider: 'microsoft' as const,
      domain: tenant.primaryDomain,
      status: effectiveStatus,
      connectionStatus:
        tenant.connection?.status.toLowerCase().replaceAll('_', '-') ?? null,
      connectionMode:
        tenant.connection?.connectionMode === 'CUSTOMER_MANAGED'
          ? 'customer-managed'
          : 'hawkview-managed',
      lastSync:
        tenant.syncStates
          .map((state) => state.lastSuccessfulAt)
          .filter((date): date is Date => Boolean(date))
          .sort((a, b) => b.getTime() - a.getTime())[0]
          ?.toISOString() ?? null,
      requiredPermissions,
      consentedPermissions,
      missingPermissions,
      connectionErrorCode: tenant.connection?.lastErrorCode ?? null,
      secureScore: getMicrosoftSecureScore(
        tenant.entraSnapshots.find(
          (snapshot) => snapshot.resourceType === SyncResourceType.SECURE_SCORES,
        )?.payload,
      ),
      ...health,
      // The named object is the versioned API contract.  The spread above
      // intentionally preserves legacy healthScore/mfaCoverage/attention.
      tenantHealth: health,
      licenseCount:
        tenant.tenantLicenses.length > 0
          ? tenant.tenantLicenses.reduce(
              (total, license) => total + license.enabledUnits,
              0
            )
          : null,
      organization: tenant.organization,
    }
  }

  async verifyConnectionForIdentity(
    identity: AuthenticatedIdentity,
    customerTenantId: string
  ) {
    const organizationIds = await this.getAccessibleOrganizationIds(identity)
    const tenant = await this.prisma.customerTenant.findFirst({
      where: {
        id: customerTenantId,
        organizationId: { in: organizationIds },
      },
      select: {
        id: true,
        organizationId: true,
        microsoftTenantId: true,
        connection: {
          select: {
            connectionMode: true,
            clientId: true,
            credentialReference: true,
          },
        },
      },
    })

    if (!tenant?.connection) {
      throw new NotFoundException('Customer tenant connection was not found.')
    }

    const now = new Date()
    try {
      const verification = await this.microsoftConsent.verifyConnectedTenant({
        microsoftTenantId: tenant.microsoftTenantId,
        connectionMode:
          tenant.connection.connectionMode === 'CUSTOMER_MANAGED'
            ? 'CUSTOMER_MANAGED'
            : 'HAWKVIEW_MANAGED',
        clientId: tenant.connection.clientId,
        credentialReference: tenant.connection.credentialReference,
      })
      const connected = verification.missingPermissions.length === 0

      await this.prisma.$transaction([
        this.prisma.customerTenant.update({
          where: { id: tenant.id },
          data: {
            displayName: verification.displayName,
            primaryDomain: verification.primaryDomain,
            status: connected ? 'ACTIVE' : 'SUSPENDED',
          },
        }),
        this.prisma.tenantConnection.update({
          where: {
            customerTenantId_organizationId: {
              customerTenantId: tenant.id,
              organizationId: tenant.organizationId,
            },
          },
          data: {
            status: connected ? 'CONNECTED' : 'ERROR',
            consentedPermissions: verification.grantedPermissions,
            lastVerifiedAt: now,
            lastErrorCode: connected ? null : 'missing-permissions',
            lastErrorMessage: connected
              ? null
              : `Missing permissions: ${verification.missingPermissions.join(', ')}`,
          },
        }),
      ])

      const refreshed = await this.prisma.customerTenant.findUniqueOrThrow({
        where: { id: tenant.id },
        select: this.tenantSelect(),
      })
      return { tenant: this.mapTenant(refreshed), connected }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Microsoft tenant verification failed.'
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
            lastVerifiedAt: now,
            lastErrorCode: 'connection-verification-failed',
            lastErrorMessage: message.slice(0, 2000),
          },
        }),
      ])
      throw new BadGatewayException(
        'HawkView could not access this Microsoft tenant. Reauthorize the connection or remove the tenant.'
      )
    }
  }

  private tenantSelect() {
    return {
      id: true,
      microsoftTenantId: true,
      displayName: true,
      primaryDomain: true,
      status: true,
      organization: { select: { id: true, name: true, slug: true } },
      tenantLicenses: { select: { enabledUnits: true } },
      syncStates: {
        select: {
          resourceType: true,
          status: true,
          lastAttemptAt: true,
          lastSuccessfulAt: true,
          lastErrorCode: true,
          lastErrorMessage: true,
          consecutiveFailures: true,
        },
      },
      entraSnapshots: {
        where: {
          resourceType: {
            in: [
              SyncResourceType.AUTH_REGISTRATIONS,
              SyncResourceType.SECURE_SCORES,
            ] as SyncResourceType[],
          },
        },
        orderBy: { observedAt: 'desc' as const },
        select: { resourceType: true, payload: true, observedAt: true },
      },
      connection: {
        select: {
          connectionMode: true,
          status: true,
          consentedPermissions: true,
          lastVerifiedAt: true,
          lastErrorCode: true,
        },
      },
    } as const
  }

  async listForIdentity(identity: AuthenticatedIdentity) {
    const organizationIds = await this.getAccessibleOrganizationIds(identity)
    if (organizationIds.length === 0) return { tenants: [] }

    const tenants = await this.prisma.customerTenant.findMany({
      where: { organizationId: { in: organizationIds } },
      orderBy: [{ displayName: 'asc' }, { microsoftTenantId: 'asc' }],
      select: this.tenantSelect(),
    })

    const tenantIds = tenants.map((tenant) => tenant.id)
    const [riskySignIns, auditEvents] = await Promise.all([
      this.prisma.signInLog.findMany({
        where: {
          customerTenantId: { in: tenantIds },
          eventDateTime: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          },
          riskLevel: { not: null },
        },
        select: {
          customerTenantId: true,
          userId: true,
          userPrincipalName: true,
          riskLevel: true,
        },
      }),
      this.prisma.directoryAuditLog.findMany({
        where: {
          customerTenantId: { in: tenantIds },
          eventDateTime: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
        orderBy: { eventDateTime: 'desc' },
        take: 500,
        select: {
          customerTenantId: true,
          microsoftAuditId: true,
          eventDateTime: true,
          activityDisplayName: true,
          category: true,
          operationType: true,
          result: true,
          initiatedBy: true,
          targetResources: true,
        },
      }),
    ])
    const riskyUsersByTenant = new Map<string, Set<string>>()
    for (const row of riskySignIns) {
      if (!['low', 'medium', 'high'].includes(row.riskLevel?.toLowerCase() ?? '')) {
        continue
      }
      const identity =
        row.userId ?? row.userPrincipalName?.toLowerCase() ?? 'unknown'
      const users = riskyUsersByTenant.get(row.customerTenantId) ?? new Set()
      users.add(identity)
      riskyUsersByTenant.set(row.customerTenantId, users)
    }

    const auditEventsByTenant = new Map<string, TenantAuditEvent[]>()
    for (const event of auditEvents) {
      const events = auditEventsByTenant.get(event.customerTenantId) ?? []
      events.push(event)
      auditEventsByTenant.set(event.customerTenantId, events)
    }

    const mappedTenants = tenants.map((tenant) =>
        this.mapTenant(
          tenant,
          riskyUsersByTenant.get(tenant.id)?.size ?? 0,
          auditEventsByTenant.get(tenant.id) ?? []
        )
      )

    // Retain auditable health history. A persistence failure must never make a
    // tenant list unavailable, and every row is scoped to the same workspace
    // used to load the tenant above.
    await Promise.all(mappedTenants.map(async (mapped, index) => {
      const tenant = tenants[index]
      if (!tenant) return
      await this.persistTenantHealthSnapshot(tenant, mapped.tenantHealth)
    }))

    return { tenants: mappedTenants }
  }

  private async persistTenantHealthSnapshot(
    tenant: { id: string; microsoftTenantId: string; organization: { id: string } },
    health: ReturnType<typeof deriveTenantHealth>,
  ) {
    try {
      const previous = await this.prisma.tenantHealthSnapshot.findFirst({
        where: { organizationId: tenant.organization.id, customerTenantId: tenant.id },
        orderBy: { evaluatedAt: 'desc' },
        select: { overallStatus: true, evaluatedAt: true },
      })
      const evaluatedAt = new Date(health.evaluatedAt)
      // Keep evidence history without producing a row on every tenant-list poll.
      if (previous?.overallStatus === health.overallStatus && evaluatedAt.getTime() - previous.evaluatedAt.getTime() < 15 * 60 * 1000) return
      await this.prisma.tenantHealthSnapshot.create({
        data: { organizationId: tenant.organization.id, customerTenantId: tenant.id, healthModelVersion: health.healthModelVersion, overallStatus: health.overallStatus, payload: health, evaluatedAt },
      })
      this.logger.debug({
        event: 'tenant_health_evaluated',
        workspaceId: tenant.organization.id,
        customerTenantId: tenant.id,
        microsoftTenantId: tenant.microsoftTenantId,
        healthModelVersion: health.healthModelVersion,
        previousStatus: previous?.overallStatus ?? null,
        newStatus: health.overallStatus,
        triggeringEvidence: {
          connection: health.connection.status,
          data: health.data.status,
          security: health.security.status,
          operations: health.operations.status,
        },
        evaluatedAt: health.evaluatedAt,
      })
    } catch (error) {
      this.logger.warn(`Tenant health snapshot persistence failed for tenant ${tenant.id}: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }

  async createForIdentity(identity: AuthenticatedIdentity, body: unknown) {
    const input = this.parseCreateTenant(body)
    const { microsoftTenantId } = input
    const organizationIds = await this.getTenantOnboardingOrganizationIds(identity)

    if (organizationIds.length === 0) {
      throw new ForbiddenException(
        'Only an MSP Owner, Admin, or Technician can onboard a tenant.'
      )
    }
    if (organizationIds.length > 1) {
      throw new BadRequestException(
        'Choose an MSP workspace before onboarding a tenant.'
      )
    }

    const existing = await this.prisma.customerTenant.findUnique({
      where: { microsoftTenantId },
      select: {
        id: true,
        organizationId: true,
        status: true,
        connection: {
          select: {
            status: true,
          },
        },
      },
    })
    if (existing) {
      if (existing.organizationId !== organizationIds[0]) {
        throw new ConflictException(
          'This Microsoft tenant is already connected to HawkView.'
        )
      }
      if (
        existing.status === 'ACTIVE' ||
        existing.connection?.status === 'CONNECTED'
      ) {
        throw new ConflictException(
          'This Microsoft tenant is already connected to HawkView.'
        )
      }

      if (input.connectionMode === 'CUSTOMER_MANAGED') {
        const prepared =
          await this.microsoftConsent.prepareCustomerManagedConnection({
            microsoftTenantId,
            clientId: input.clientId,
            clientSecret: input.clientSecret,
            secretId: `tenant-${microsoftTenantId}-microsoft-client-secret`,
          })
        const now = new Date()
        const tenant = await this.prisma.customerTenant.update({
          where: { id: existing.id },
          data: {
            displayName: prepared.displayName,
            primaryDomain: prepared.primaryDomain,
            status: 'ACTIVE',
            connection: {
              update: {
                connectionMode: 'CUSTOMER_MANAGED',
                clientId: input.clientId,
                credentialReference: prepared.credentialReference,
                status: 'CONNECTED',
                consentedPermissions: prepared.grantedPermissions,
                consentedAt: now,
                lastVerifiedAt: now,
                consentStateHash: null,
                consentStateExpiresAt: null,
                lastErrorCode: null,
                lastErrorMessage: null,
              },
            },
          },
          select: this.tenantSelect(),
        })
        await this.markInitialSyncDue(tenant.id, organizationIds[0])
        return { tenant: this.mapTenant(tenant), requiresConsent: false }
      }

      const tenant = await this.prisma.customerTenant.findUniqueOrThrow({
        where: { id: existing.id },
        select: this.tenantSelect(),
      })
      return { tenant: this.mapTenant(tenant), requiresConsent: true }
    }

    if (input.connectionMode === 'CUSTOMER_MANAGED') {
      const prepared =
        await this.microsoftConsent.prepareCustomerManagedConnection({
          microsoftTenantId,
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          secretId: `tenant-${microsoftTenantId}-microsoft-client-secret`,
        })
      const now = new Date()
      const tenant = await this.prisma.customerTenant.create({
        data: {
          organizationId: organizationIds[0],
          microsoftTenantId,
          displayName: prepared.displayName,
          primaryDomain: prepared.primaryDomain,
          status: 'ACTIVE',
          connection: {
            create: {
              connectionMode: 'CUSTOMER_MANAGED',
              clientId: input.clientId,
              credentialReference: prepared.credentialReference,
              status: 'CONNECTED',
              consentedPermissions: prepared.grantedPermissions,
              consentedAt: now,
              lastVerifiedAt: now,
            },
          },
        },
        select: this.tenantSelect(),
      })
      await this.markInitialSyncDue(tenant.id, organizationIds[0])
      return { tenant: this.mapTenant(tenant), requiresConsent: false }
    }

    const tenant = await this.prisma.customerTenant.create({
      data: {
        organizationId: organizationIds[0],
        microsoftTenantId,
        displayName: null,
        connection: {
          create: { connectionMode: 'HAWKVIEW_MANAGED' },
        },
      },
      select: this.tenantSelect(),
    })

    return { tenant: this.mapTenant(tenant), requiresConsent: true }
  }

  async removeTenantForIdentity(
    identity: AuthenticatedIdentity,
    customerTenantId: string,
    body: unknown
  ) {
    const organizationIds = await this.getTenantDeletionOrganizationIds(identity)
    const tenant = await this.prisma.customerTenant.findFirst({
      where: {
        id: customerTenantId,
        organizationId: { in: organizationIds },
      },
      select: {
        id: true,
        organizationId: true,
        microsoftTenantId: true,
        status: true,
        connection: {
          select: {
            status: true,
            credentialReference: true,
          },
        },
      },
    })

    if (!tenant) {
      throw new NotFoundException('Customer tenant was not found.')
    }
    const isConnected =
      tenant.status === 'ACTIVE' || tenant.connection?.status === 'CONNECTED'

    if (isConnected) {
      const candidate =
        body && typeof body === 'object'
          ? (body as Record<string, unknown>)
          : {}
      const confirmation =
        typeof candidate.confirmMicrosoftTenantId === 'string'
          ? candidate.confirmMicrosoftTenantId.trim().toLowerCase()
          : ''
      if (confirmation !== tenant.microsoftTenantId.toLowerCase()) {
        throw new BadRequestException(
          'Type the Microsoft tenant ID to confirm deletion.'
        )
      }

      await this.prisma.$transaction([
        this.prisma.customerTenant.update({
          where: { id: tenant.id },
          data: { status: 'DISCONNECTED' },
        }),
        this.prisma.tenantConnection.update({
          where: {
            customerTenantId_organizationId: {
              customerTenantId: tenant.id,
              organizationId: tenant.organizationId,
            },
          },
          data: { status: 'REVOKED' },
        }),
      ])
    }

    if (tenant.connection?.credentialReference) {
      await this.microsoftConsent.deleteStoredCredential(
        tenant.connection.credentialReference
      )
    }

    await this.prisma.customerTenant.delete({
      where: { id: tenant.id },
    })

    return {
      removed: true,
      tenantId: tenant.id,
      credentialRemoved: Boolean(tenant.connection?.credentialReference),
    }
  }

  async createConsentUrlForIdentity(
    identity: AuthenticatedIdentity,
    customerTenantId: string
  ) {
    const organizationIds = await this.getAccessibleOrganizationIds(identity)
    const tenant = await this.prisma.customerTenant.findFirst({
      where: {
        id: customerTenantId,
        organizationId: { in: organizationIds },
      },
      select: {
        id: true,
        organizationId: true,
        microsoftTenantId: true,
        connection: { select: { connectionMode: true } },
      },
    })

    if (!tenant) {
      throw new NotFoundException('Customer tenant was not found.')
    }
    if (tenant.connection?.connectionMode !== 'HAWKVIEW_MANAGED') {
      throw new BadRequestException(
        'Customer-managed connections do not use HawkView admin consent.'
      )
    }

    const consent = await this.microsoftConsent.createAdminConsentUrl(
      tenant.microsoftTenantId,
      {
        customerTenantId: tenant.id,
        organizationId: tenant.organizationId,
      }
    )
    await this.prisma.tenantConnection.update({
      where: {
        customerTenantId_organizationId: {
          customerTenantId: tenant.id,
          organizationId: tenant.organizationId,
        },
      },
      data: {
        status: 'PENDING_CONSENT',
        consentStateHash: consent.stateHash,
        consentStateExpiresAt: consent.expiresAt,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    })

    return {
      consentUrl: consent.consentUrl,
      requiredPermissions: this.microsoftConsent.getRequiredPermissions(),
    }
  }

  async createManagedOnboardingUrlForIdentity(identity: AuthenticatedIdentity) {
    const organizationIds = await this.getTenantOnboardingOrganizationIds(identity)
    if (organizationIds.length === 0) {
      throw new ForbiddenException(
        'Only an MSP Owner, Admin, or Technician can onboard a tenant.'
      )
    }
    if (organizationIds.length > 1) {
      throw new BadRequestException(
        'Choose an MSP workspace before onboarding a tenant.'
      )
    }

    const consent = await this.microsoftConsent.createTenantDiscoveryConsentUrl(
      organizationIds[0]
    )
    return {
      consentUrl: consent.consentUrl,
      requiredPermissions: this.microsoftConsent.getRequiredPermissions(),
    }
  }

  async completeMicrosoftConsent(query: Record<string, unknown>) {
    const stateToken = typeof query.state === 'string' ? query.state : ''
    if (!stateToken) {
      return this.buildFrontendConsentRedirect('error', 'missing-state')
    }

    let state: {
      customerTenantId?: string
      organizationId: string
      nonce: string
      flow: 'existing-tenant' | 'discover-tenant'
    }
    try {
      state = await this.microsoftConsent.verifyConsentState(stateToken)
    } catch {
      return this.buildFrontendConsentRedirect('error', 'invalid-state')
    }

    if (state.flow === 'discover-tenant') {
      return this.completeDiscoveredMicrosoftConsent(query, state)
    }

    const tenant = await this.prisma.customerTenant.findFirst({
      where: {
        id: state.customerTenantId!,
        organizationId: state.organizationId,
      },
      select: {
        id: true,
        organizationId: true,
        microsoftTenantId: true,
        connection: {
          select: {
            consentStateHash: true,
            consentStateExpiresAt: true,
          },
        },
      },
    })
    if (!tenant) {
      return this.buildFrontendConsentRedirect('error', 'tenant-not-found')
    }

    const returnedStateHash = this.microsoftConsent.hashConsentNonce(
      state.nonce
    )
    if (
      !tenant.connection?.consentStateHash ||
      returnedStateHash !== tenant.connection.consentStateHash ||
      !tenant.connection.consentStateExpiresAt ||
      tenant.connection.consentStateExpiresAt.getTime() < Date.now()
    ) {
      return this.buildFrontendConsentRedirect(
        'error',
        'expired-or-used-state',
        tenant.id
      )
    }

    await this.prisma.tenantConnection.update({
      where: {
        customerTenantId_organizationId: {
          customerTenantId: tenant.id,
          organizationId: tenant.organizationId,
        },
      },
      data: {
        consentStateHash: null,
        consentStateExpiresAt: null,
      },
    })

    const returnedTenantId =
      typeof query.tenant === 'string' ? query.tenant.toLowerCase() : ''
    const granted =
      query.admin_consent === 'True' || query.admin_consent === 'true'
    const microsoftError = typeof query.error === 'string' ? query.error : null

    if (
      microsoftError ||
      !granted ||
      returnedTenantId !== tenant.microsoftTenantId.toLowerCase()
    ) {
      const errorCode =
        microsoftError ??
        (returnedTenantId !== tenant.microsoftTenantId.toLowerCase()
          ? 'tenant-mismatch'
          : 'consent-denied')
      await this.recordConnectionError(
        tenant,
        errorCode,
        typeof query.error_description === 'string'
          ? query.error_description
          : 'Microsoft administrator consent was not completed.'
      )
      return this.buildFrontendConsentRedirect('error', errorCode, tenant.id)
    }

    try {
      const verification = await this.microsoftConsent.verifyTenantAfterConsent(
        tenant.microsoftTenantId
      )
      const connected = verification.missingPermissions.length === 0
      const now = new Date()

      await this.prisma.$transaction([
        this.prisma.customerTenant.update({
          where: { id: tenant.id },
          data: {
            displayName: verification.displayName,
            primaryDomain: verification.primaryDomain,
            status: connected ? 'ACTIVE' : 'PENDING',
          },
        }),
        this.prisma.tenantConnection.update({
          where: {
            customerTenantId_organizationId: {
              customerTenantId: tenant.id,
              organizationId: tenant.organizationId,
            },
          },
          data: {
            status: connected ? 'CONNECTED' : 'ERROR',
            consentedPermissions: verification.grantedPermissions,
            consentedAt: now,
            lastVerifiedAt: now,
            lastErrorCode: connected ? null : 'missing-permissions',
            lastErrorMessage: connected
              ? null
              : `Missing permissions: ${verification.missingPermissions.join(', ')}`,
          },
        }),
      ])

      if (connected) {
        await this.markInitialSyncDue(tenant.id, tenant.organizationId)
        await this.notifyConnectionAuthorized(tenant.id, tenant.organizationId)
      } else {
        await this.notifyMissingPermissions(
          tenant.id,
          tenant.organizationId,
          verification.missingPermissions
        )
      }

      return this.buildFrontendConsentRedirect(
        connected ? 'success' : 'missing-permissions',
        connected ? null : 'missing-permissions',
        tenant.id
      )
    } catch (error) {
      await this.recordConnectionError(
        tenant,
        'verification-failed',
        error instanceof Error
          ? error.message
          : 'Microsoft tenant verification failed.'
      )
      return this.buildFrontendConsentRedirect(
        'error',
        'verification-failed',
        tenant.id
      )
    }
  }

  private async completeDiscoveredMicrosoftConsent(
    query: Record<string, unknown>,
    state: { organizationId: string; nonce: string }
  ) {
    const returnedTenantId =
      typeof query.tenant === 'string' ? query.tenant.toLowerCase() : ''
    const granted =
      query.admin_consent === 'True' || query.admin_consent === 'true'
    const microsoftError = typeof query.error === 'string' ? query.error : null

    if (
      microsoftError ||
      !granted ||
      !MICROSOFT_TENANT_ID_PATTERN.test(returnedTenantId)
    ) {
      return this.buildFrontendConsentRedirect(
        'error',
        microsoftError ?? (granted ? 'invalid-tenant' : 'consent-denied')
      )
    }

    const existing = await this.prisma.customerTenant.findUnique({
      where: { microsoftTenantId: returnedTenantId },
      select: {
        id: true,
        organizationId: true,
        connection: { select: { connectionMode: true } },
      },
    })
    if (existing && existing.organizationId !== state.organizationId) {
      return this.buildFrontendConsentRedirect(
        'error',
        'tenant-already-connected'
      )
    }
    if (existing?.connection?.connectionMode === 'CUSTOMER_MANAGED') {
      return this.buildFrontendConsentRedirect(
        'error',
        'customer-managed-tenant'
      )
    }

    const tenant = existing
      ? existing
      : await this.prisma.customerTenant.create({
          data: {
            organizationId: state.organizationId,
            microsoftTenantId: returnedTenantId,
            connection: {
              create: { connectionMode: 'HAWKVIEW_MANAGED' },
            },
          },
          select: { id: true, organizationId: true },
        })

    try {
      const verification =
        await this.microsoftConsent.verifyTenantAfterConsent(returnedTenantId)
      const connected = verification.missingPermissions.length === 0
      const now = new Date()

      await this.prisma.$transaction([
        this.prisma.customerTenant.update({
          where: { id: tenant.id },
          data: {
            displayName: verification.displayName,
            primaryDomain: verification.primaryDomain,
            status: connected ? 'ACTIVE' : 'PENDING',
          },
        }),
        this.prisma.tenantConnection.update({
          where: {
            customerTenantId_organizationId: {
              customerTenantId: tenant.id,
              organizationId: tenant.organizationId,
            },
          },
          data: {
            connectionMode: 'HAWKVIEW_MANAGED',
            status: connected ? 'CONNECTED' : 'ERROR',
            consentedPermissions: verification.grantedPermissions,
            consentedAt: now,
            lastVerifiedAt: now,
            consentStateHash: null,
            consentStateExpiresAt: null,
            lastErrorCode: connected ? null : 'missing-permissions',
            lastErrorMessage: connected
              ? null
              : `Missing permissions: ${verification.missingPermissions.join(', ')}`,
          },
        }),
      ])

      if (connected) {
        await this.markInitialSyncDue(tenant.id, tenant.organizationId)
        await this.notifyConnectionAuthorized(tenant.id, tenant.organizationId)
      } else {
        await this.notifyMissingPermissions(
          tenant.id,
          tenant.organizationId,
          verification.missingPermissions
        )
      }

      return this.buildFrontendConsentRedirect(
        connected ? 'success' : 'missing-permissions',
        connected ? null : 'missing-permissions',
        tenant.id
      )
    } catch (error) {
      await this.recordConnectionError(
        tenant,
        'verification-failed',
        error instanceof Error
          ? error.message
          : 'Microsoft tenant verification failed.'
      )
      return this.buildFrontendConsentRedirect(
        'error',
        'verification-failed',
        tenant.id
      )
    }
  }

  private async recordConnectionError(
    tenant: { id: string; organizationId: string },
    code: string,
    message: string
  ) {
    await this.prisma.tenantConnection.update({
      where: {
        customerTenantId_organizationId: {
          customerTenantId: tenant.id,
          organizationId: tenant.organizationId,
        },
      },
      data: {
        status: 'ERROR',
        lastVerifiedAt: new Date(),
        lastErrorCode: code.slice(0, 100),
        lastErrorMessage: message.slice(0, 2000),
      },
    })
    await this.notifications.publishIncident({
      organizationId: tenant.organizationId,
      customerTenantId: tenant.id,
      eventType: 'tenant.connection_failed',
      category: 'error',
      severity: 'high',
      title: 'Microsoft 365 authorization failed',
      description: message,
      dedupeKey: `tenant:${tenant.id}:connection`,
      source: 'microsoft-consent',
      actionUrl: `/tenants/${tenant.id}/settings`,
      actionLabel: 'Review connection',
      metadata: { errorCode: code },
    })
  }

  private async notifyConnectionAuthorized(
    customerTenantId: string,
    organizationId: string
  ) {
    await this.notifications.resolveIncident(
      organizationId,
      `tenant:${customerTenantId}:connection`
    )
    await this.notifications.publishIncident({
      organizationId,
      customerTenantId,
      eventType: 'tenant.connection_authorized',
      category: 'success',
      severity: 'info',
      title: 'Microsoft 365 connection authorized',
      description:
        'HawkView verified the tenant connection and queued the initial synchronization.',
      dedupeKey: `tenant:${customerTenantId}:onboarding-authorized`,
      source: 'microsoft-consent',
      actionUrl: `/tenants/${customerTenantId}`,
      actionLabel: 'View tenant',
    })
  }

  private async notifyMissingPermissions(
    customerTenantId: string,
    organizationId: string,
    missingPermissions: string[]
  ) {
    await this.notifications.publishIncident({
      organizationId,
      customerTenantId,
      eventType: 'tenant.connection_permissions_missing',
      category: 'warning',
      severity: 'high',
      title: 'Microsoft 365 permissions need attention',
      description: `${missingPermissions.length} required permission${missingPermissions.length === 1 ? '' : 's'} must be approved before synchronization can begin.`,
      dedupeKey: `tenant:${customerTenantId}:connection`,
      source: 'microsoft-consent',
      actionUrl: `/tenants/${customerTenantId}/settings`,
      actionLabel: 'Review permissions',
      metadata: { missingPermissions },
    })
  }

  private async markInitialSyncDue(
    customerTenantId: string,
    organizationId: string
  ) {
    await this.prisma.syncState.upsert({
      where: {
        customerTenantId_resourceType: {
          customerTenantId,
          resourceType: 'USERS',
        },
      },
      create: {
        organizationId,
        customerTenantId,
        resourceType: 'USERS',
        status: 'IDLE',
      },
      update: {},
    })
  }

  private buildFrontendConsentRedirect(
    result: string,
    error: string | null,
    customerTenantId?: string
  ) {
    const frontendUrl = process.env.FRONTEND_APP_URL?.trim()
    if (!frontendUrl) throw new Error('FRONTEND_APP_URL is not configured.')

    const url = new URL('/tenants', frontendUrl)
    url.searchParams.set('microsoftConsent', result)
    if (error) url.searchParams.set('error', error)
    if (customerTenantId) url.searchParams.set('tenantId', customerTenantId)
    return url.toString()
  }
}
