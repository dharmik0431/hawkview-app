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
import type { Prisma } from '../generated/prisma/client.js'
import { MicrosoftConsentService } from '../microsoft/microsoft-consent.service.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import {
  deriveTenantHealth,
  type TenantAuditEvent,
} from './tenant-health.js'
import { deriveCollectionReadiness } from './collection-readiness.js'
import {
  deriveTenantSyncFreshness,
  type TenantSyncFreshness,
} from './service-sync-freshness.js'
import { getMicrosoftSecureScore } from './secure-score.util.js'
import { buildExchangeReadOnlyRbacSetup } from './exchange-rbac-setup.js'
import type { MicrosoftUsageSourceProjectionEvidence } from './sharepoint-data-contract.js'

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

export function effectiveMicrosoftConnectionStatus(
  status: string | null,
  lastErrorCode: string | null,
  missingRequiredPermissions: readonly string[],
) {
  return status === 'ERROR' &&
    lastErrorCode === 'missing-permissions' &&
    missingRequiredPermissions.length === 0
    ? 'ACTIVE'
    : status
}

export const preserveOptionalExchangeConsent = (
  graphPermissions: string[],
  previouslyRecorded: string[]
) => [
  ...new Set([
    ...graphPermissions,
    ...previouslyRecorded.filter(
      (permission) => permission === 'Exchange.ManageAsAppV2'
    ),
  ]),
]

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

  getMicrosoftAccessContract() {
    return this.microsoftConsent.getAccessContract()
  }

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
    action: string,
    requireCompletedOrganizationOnboarding = false,
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
          select: {
            organizationId: true,
            organization: { select: { onboardingCompletedAt: true } },
          },
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

    const eligibleMemberships = requireCompletedOrganizationOnboarding
      ? user.memberships.filter(
          (membership) => membership.organization.onboardingCompletedAt !== null,
        )
      : user.memberships
    if (
      requireCompletedOrganizationOnboarding &&
      user.memberships.length > 0 &&
      eligibleMemberships.length === 0
    ) {
      throw new ForbiddenException(
        'Complete MSP organization setup before onboarding tenants.',
      )
    }
    return eligibleMemberships.map((membership) => membership.organizationId)
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
      'onboarding tenants',
      true,
    )
  }

  private async getTenantOnboardingActor(identity: AuthenticatedIdentity) {
    const user = await this.prisma.user.findUnique({
      where: { authProviderUserId: identity.subject },
      select: { id: true, disabledAt: true },
    })
    if (!user || user.disabledAt) {
      throw new ForbiddenException('This HawkView account cannot onboard tenants.')
    }
    return user.id
  }

  private async recordConsentAttempt(input: {
    identity: AuthenticatedIdentity
    organizationId: string
    customerTenantId?: string
    flow: 'DISCOVER_TENANT' | 'EXISTING_TENANT' | 'EXCHANGE_READ_ONLY'
    stateHash: string
    expiresAt: Date
  }) {
    const initiatedByUserId = await this.getTenantOnboardingActor(input.identity)
    await this.prisma.microsoftConsentAttempt.create({
      data: {
        organizationId: input.organizationId,
        customerTenantId: input.customerTenantId,
        initiatedByUserId,
        flow: input.flow,
        stateHash: input.stateHash,
        expiresAt: input.expiresAt,
      },
    })
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
      onboardingCompletedAt?: Date | null
    } | null
    tenantLicenses: Array<{ enabledUnits: number; servicePlans?: unknown }>
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
    collectionFieldStates?: Array<{
      fieldKey: string
      state: string
      reasonCode: string | null
    }>
    m365ActivitySubscriptions: Array<{
      contentType: string
      status: string
      lastStartRequestedAt: Date | null
      lastVerifiedAt: Date | null
      lastSuccessfulPollAt: Date | null
      lastError: string | null
    }>
  }, riskyIdentityCount = 0, auditEvents: TenantAuditEvent[] = []) {
    const requiredPermissions = this.microsoftConsent.getRequiredPermissions()
    const consentedPermissions = tenant.connection?.consentedPermissions ?? []
    const connectionStatus = tenant.connection?.status ?? null
    const missingPermissions = requiredPermissions
      .map((permission) => permission.name)
      .filter((permission) => !consentedPermissions.includes(permission))
    const accessContract = this.microsoftConsent.getAccessContract()
    const missingRequiredPermissions = accessContract.connectionRequiredPermissions
      .filter((permission) => !consentedPermissions.includes(permission))
    const missingNonConnectionPermissions = missingPermissions
      .filter((permission) => !missingRequiredPermissions.includes(permission))
    // Before the access contract, any missing one-click capability grant was
    // persisted as a connection-wide ERROR. Interpret only that legacy error
    // as active when the actual connection baseline is present; other ERROR
    // causes remain disconnected and the database is not mutated on a read.
    const effectiveConnectionStatus = effectiveMicrosoftConnectionStatus(
      connectionStatus,
      tenant.connection?.lastErrorCode ?? null,
      missingRequiredPermissions,
    )
    const legacyOptionalPermissionError =
      connectionStatus === 'ERROR' && effectiveConnectionStatus === 'ACTIVE'
    const effectiveStatus =
      effectiveConnectionStatus === 'ERROR' || effectiveConnectionStatus === 'REVOKED'
        ? 'disconnected'
        : effectiveConnectionStatus === 'PENDING_CONSENT'
          ? 'pending'
          : tenant.status.toLowerCase()
    const usageProjectionEvidence = (fieldKey: string): MicrosoftUsageSourceProjectionEvidence => {
      const field = tenant.collectionFieldStates?.find((candidate) => candidate.fieldKey === fieldKey)
      if (!field) {
        return { state: 'UNVERIFIED_LEGACY', reasonCode: 'USAGE_PROJECTION_NOT_DURABLY_VERIFIED' }
      }
      if (field.state === 'AVAILABLE' && field.reasonCode === null) {
        return { state: 'AUTHORITATIVE_COMPLETE', reasonCode: null }
      }
      if (field.reasonCode === 'USAGE_PROJECTION_NOT_DURABLY_VERIFIED') {
        return { state: 'UNVERIFIED_LEGACY', reasonCode: field.reasonCode }
      }
      if (field.reasonCode === 'USAGE_PROJECTION_EVIDENCE_INCOMPLETE') {
        return { state: 'PARTIAL', reasonCode: field.reasonCode }
      }
      return { state: 'REJECTED', reasonCode: 'USAGE_PROJECTION_EVIDENCE_INVALID' }
    }
    const collectionReadiness = deriveCollectionReadiness({
      connectionStatus: effectiveConnectionStatus,
      connectionVerifiedAt: tenant.connection?.lastVerifiedAt,
      consentedPermissions,
      syncStates: tenant.syncStates,
      subscriptions: tenant.m365ActivitySubscriptions,
      // Existing rows deliberately remain null until a successful authoritative
      // LICENSES collection writes service plans.  Do not turn that absence
      // into a deceptive authoritative empty inventory.
      licenseServicePlans: tenant.tenantLicenses.some((license) => !Array.isArray(license.servicePlans))
        ? null
        : tenant.tenantLicenses.flatMap((license) => license.servicePlans as Array<{ servicePlanId?: string; servicePlanName: string; provisioningStatus: string }>),
      sharePointUsageProjectionEvidence: usageProjectionEvidence('sharepoint.usage-projection'),
      oneDriveUsageProjectionEvidence: usageProjectionEvidence('onedrive.usage-projection'),
    })
    const notApplicableResourceTypes = collectionReadiness.workloads
      .filter((workload) => workload.state === 'NOT_LICENSED' || workload.state === 'UNSUPPORTED')
      .flatMap((workload) => workload.components?.map((component) => component.key) ?? [])
      .filter((key) => !['LICENSE_APPLICABILITY', 'PERMISSION_GRANT'].includes(key))
    const syncFreshness = deriveTenantSyncFreshness(tenant.syncStates, new Date(), notApplicableResourceTypes)
    const health = deriveTenantHealth({
      tenantId: tenant.id,
      effectiveStatus,
      connectionStatus: effectiveConnectionStatus,
      connectionLastVerifiedAt: tenant.connection?.lastVerifiedAt ?? null,
      missingPermissions: missingRequiredPermissions,
      syncStates: tenant.syncStates,
      authSnapshot: tenant.entraSnapshots.find((snapshot) => snapshot.resourceType === SyncResourceType.AUTH_REGISTRATIONS) ?? null,
      riskyIdentityCount,
      auditEvents,
      notApplicableResourceTypes,
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
        effectiveConnectionStatus?.toLowerCase().replaceAll('_', '-') ?? null,
      connectionMode:
        tenant.connection?.connectionMode === 'CUSTOMER_MANAGED'
          ? 'customer-managed'
          : 'hawkview-managed',
      onboarding: {
        complete: Boolean(tenant.connection?.onboardingCompletedAt),
        completedAt: tenant.connection?.onboardingCompletedAt?.toISOString() ?? null,
        resumeUrl: `/tenants/${tenant.id}/onboarding`,
      },
      lastSync:
        tenant.syncStates
          .map((state) => state.lastSuccessfulAt)
          .filter((date): date is Date => Boolean(date))
          .sort((a, b) => b.getTime() - a.getTime())[0]
          ?.toISOString() ?? null,
      requiredPermissions,
      consentedPermissions,
      // Compatibility: missingPermissions remains the complete set of scopes
      // offered by one-click consent. Connection/health gates use the two
      // explicit fields below and never infer global failure from this list.
      missingPermissions,
      missingRequiredPermissions,
      missingNonConnectionPermissions,
      connectionErrorCode: legacyOptionalPermissionError
        ? null
        : tenant.connection?.lastErrorCode ?? null,
      secureScore: getMicrosoftSecureScore(
        tenant.entraSnapshots.find(
          (snapshot) => snapshot.resourceType === SyncResourceType.SECURE_SCORES,
        )?.payload,
      ),
      ...health,
      // Service-level freshness is additive. The legacy lastSync remains for
      // callers that have not yet moved to the per-service contract.
      syncFreshness,
      // Readiness is deliberately derived from durable per-resource outcomes.
      // It is not an OAuth or scheduler-success proxy and makes no Microsoft
      // request while listing tenants.
      collectionReadiness,
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
            consentedPermissions: true,
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
      const connected = verification.missingRequiredPermissions.length === 0

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
            consentedPermissions: preserveOptionalExchangeConsent(
              verification.grantedPermissions,
              tenant.connection.consentedPermissions
            ),
            lastVerifiedAt: now,
            lastErrorCode: connected ? null : 'missing-permissions',
            lastErrorMessage: connected
              ? null
              : `Missing connection-required permissions: ${verification.missingRequiredPermissions.join(', ')}`,
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
      tenantLicenses: { select: { enabledUnits: true, servicePlans: true } },
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
      collectionFieldStates: {
        where: {
          fieldKey: {
            in: ['sharepoint.usage-projection', 'onedrive.usage-projection'] as string[],
          },
        },
        select: { fieldKey: true, state: true, reasonCode: true },
      },
      connection: {
        select: {
          connectionMode: true,
          status: true,
          consentedPermissions: true,
          lastVerifiedAt: true,
          lastErrorCode: true,
          onboardingCompletedAt: true,
        },
      },
      m365ActivitySubscriptions: {
        select: {
          contentType: true,
          status: true,
          lastStartRequestedAt: true,
          lastVerifiedAt: true,
          lastSuccessfulPollAt: true,
          lastError: true,
        },
      },
    } as const satisfies Prisma.CustomerTenantSelect
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
          organizationId: { in: organizationIds },
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
          organizationId: { in: organizationIds },
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
      await this.persistTenantHealthSnapshot(tenant, mapped.tenantHealth, mapped.syncFreshness)
    }))

    return { tenants: mappedTenants }
  }

  private async persistTenantHealthSnapshot(
    tenant: { id: string; microsoftTenantId: string; organization: { id: string } },
    health: ReturnType<typeof deriveTenantHealth>,
    syncFreshness: TenantSyncFreshness,
  ) {
    try {
      const previous = await this.prisma.tenantHealthSnapshot.findFirst({
        where: { organizationId: tenant.organization.id, customerTenantId: tenant.id },
        orderBy: { evaluatedAt: 'desc' },
        select: { overallStatus: true, evaluatedAt: true, payload: true },
      })
      const evaluatedAt = new Date(health.evaluatedAt)
      const currentSignature = JSON.stringify(Object.values(syncFreshness.services).map((service) => ({ service: service.service, status: service.status, freshness: service.freshnessStatus, failures: service.partialFailures.map((failure) => failure.collector) })))
      const previousPayload = previous?.payload as { syncFreshness?: TenantSyncFreshness } | null
      const previousSignature = previousPayload?.syncFreshness
        ? JSON.stringify(Object.values(previousPayload.syncFreshness.services).map((service) => ({ service: service.service, status: service.status, freshness: service.freshnessStatus, failures: service.partialFailures.map((failure) => failure.collector) })))
        : null
      // Keep evidence history without producing a row on every tenant-list poll.
      if (previous?.overallStatus === health.overallStatus && previousSignature === currentSignature && evaluatedAt.getTime() - previous.evaluatedAt.getTime() < 15 * 60 * 1000) return
      await this.prisma.tenantHealthSnapshot.create({
        // Preserve the existing health fields for snapshot consumers; freshness
        // is additive rather than wrapping the prior payload shape.
        data: { organizationId: tenant.organization.id, customerTenantId: tenant.id, healthModelVersion: health.healthModelVersion, overallStatus: health.overallStatus, payload: { ...health, syncFreshness }, evaluatedAt },
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
        serviceSyncTransitions: Object.values(syncFreshness.services).map((service) => ({
          service: service.service,
          status: service.status,
          freshnessStatus: service.freshnessStatus,
          failedCollectors: service.failedCollectors + service.permissionRequiredCollectors,
        })),
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
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    })
    await this.recordConsentAttempt({
      identity,
      organizationId: tenant.organizationId,
      customerTenantId: tenant.id,
      flow: 'EXISTING_TENANT',
      stateHash: consent.stateHash,
      expiresAt: consent.expiresAt,
    })

    return {
      consentUrl: consent.consentUrl,
      requiredPermissions: this.microsoftConsent.getRequiredPermissions(),
    }
  }

  async createExchangeReadOnlyConsentUrlForIdentity(
    identity: AuthenticatedIdentity,
    customerTenantId: string,
  ) {
    const organizationIds = await this.getTenantOnboardingOrganizationIds(identity)
    const tenant = await this.prisma.customerTenant.findFirst({
      where: { id: customerTenantId, organizationId: { in: organizationIds } },
      select: {
        id: true,
        organizationId: true,
        microsoftTenantId: true,
        connection: { select: { connectionMode: true } },
      },
    })
    if (!tenant?.connection) throw new NotFoundException('Customer tenant was not found.')
    if (tenant.connection.connectionMode !== 'HAWKVIEW_MANAGED') {
      throw new BadRequestException(
        'Customer-managed connectors must add Exchange.ManageAsAppV2 to their own app registration before configuring the read-only Exchange role.',
      )
    }
    const consent = await this.microsoftConsent.createExchangeReadOnlyConsentUrl(
      tenant.microsoftTenantId,
      { customerTenantId: tenant.id, organizationId: tenant.organizationId },
    )
    await this.prisma.tenantConnection.update({
      where: {
        customerTenantId_organizationId: {
          customerTenantId: tenant.id,
          organizationId: tenant.organizationId,
        },
      },
      data: {
        exchangeReadOnlySkippedAt: null,
      },
    })
    await this.recordConsentAttempt({
      identity,
      organizationId: tenant.organizationId,
      customerTenantId: tenant.id,
      flow: 'EXCHANGE_READ_ONLY',
      stateHash: consent.stateHash,
      expiresAt: consent.expiresAt,
    })
    return {
      consentUrl: consent.consentUrl,
      permission: 'Exchange.ManageAsAppV2',
      optional: true,
    }
  }

  async getExchangeReadOnlySetupForIdentity(
    identity: AuthenticatedIdentity,
    customerTenantId: string,
  ) {
    const organizationIds = await this.getTenantOnboardingOrganizationIds(identity)
    const tenant = await this.prisma.customerTenant.findFirst({
      where: { id: customerTenantId, organizationId: { in: organizationIds } },
      select: {
        connection: {
          select: {
            connectionMode: true,
            clientId: true,
            consentedPermissions: true,
            exchangeReadOnlyEnabledAt: true,
          },
        },
      },
    })
    if (!tenant?.connection) throw new NotFoundException('Customer tenant was not found.')
    const applicationId = tenant.connection.connectionMode === 'CUSTOMER_MANAGED'
      ? tenant.connection.clientId
      : await this.microsoftConsent.getManagedConnectorApplicationId()
    if (!applicationId) {
      throw new BadRequestException('The Microsoft application ID required for Exchange setup is unavailable.')
    }
    return {
      ...buildExchangeReadOnlyRbacSetup(applicationId),
      consentGranted: tenant.connection.consentedPermissions.includes('Exchange.ManageAsAppV2'),
      enabledAt: tenant.connection.exchangeReadOnlyEnabledAt?.toISOString() ?? null,
    }
  }

  async getTenantOnboardingForIdentity(
    identity: AuthenticatedIdentity,
    customerTenantId: string,
  ) {
    const organizationIds = await this.getTenantOnboardingOrganizationIds(identity)
    const tenant = await this.prisma.customerTenant.findFirst({
      where: { id: customerTenantId, organizationId: { in: organizationIds } },
      select: {
        id: true,
        displayName: true,
        primaryDomain: true,
        microsoftTenantId: true,
        connection: {
          select: {
            connectionMode: true,
            status: true,
            clientId: true,
            credentialReference: true,
            consentedPermissions: true,
            exchangeReadOnlyEnabledAt: true,
            exchangeReadOnlySkippedAt: true,
            reportSettingsLastCheckedAt: true,
            reportIdentifiersVisible: true,
            reportVisibilityDeferredAt: true,
            onboardingCompletedAt: true,
            lastErrorCode: true,
            lastErrorMessage: true,
          },
        },
      },
    })
    if (!tenant?.connection) throw new NotFoundException('Customer tenant was not found.')

    const coreComplete = tenant.connection.status === 'CONNECTED'
    const exchangeStatus = tenant.connection.exchangeReadOnlyEnabledAt
      ? 'VERIFIED'
      : tenant.connection.exchangeReadOnlySkippedAt
        ? 'DEFERRED'
        : tenant.connection.consentedPermissions.includes('Exchange.ManageAsAppV2')
          ? 'RBAC_REQUIRED'
          : 'CONSENT_REQUIRED'
    const reportStatus = tenant.connection.reportIdentifiersVisible === true
      ? 'VERIFIED'
      : tenant.connection.reportVisibilityDeferredAt
          ? 'DEFERRED'
          : tenant.connection.reportIdentifiersVisible === false
            ? 'ACTION_REQUIRED'
            : tenant.connection.consentedPermissions.includes('ReportSettings.Read.All')
              ? 'CHECK_REQUIRED'
              : 'PERMISSION_REQUIRED'

    return {
      version: 1 as const,
      tenant: {
        id: tenant.id,
        name: tenant.displayName ?? tenant.primaryDomain ?? 'Microsoft 365 tenant',
        primaryDomain: tenant.primaryDomain,
        microsoftTenantId: tenant.microsoftTenantId,
      },
      completedAt: tenant.connection.onboardingCompletedAt?.toISOString() ?? null,
      canFinish: coreComplete &&
        (exchangeStatus === 'VERIFIED' || exchangeStatus === 'DEFERRED') &&
        (reportStatus === 'VERIFIED' || reportStatus === 'DEFERRED'),
      steps: {
        microsoftAccess: {
          required: true,
          status: coreComplete ? 'VERIFIED' as const : tenant.connection.status === 'PENDING_CONSENT' ? 'CONSENT_REQUIRED' as const : 'ERROR' as const,
          errorCode: coreComplete ? null : tenant.connection.lastErrorCode,
          errorMessage: coreComplete ? null : tenant.connection.lastErrorMessage,
        },
        exchangeReadOnly: {
          required: false,
          status: exchangeStatus,
          enabledAt: tenant.connection.exchangeReadOnlyEnabledAt?.toISOString() ?? null,
          deferredAt: tenant.connection.exchangeReadOnlySkippedAt?.toISOString() ?? null,
          permission: 'Exchange.ManageAsAppV2' as const,
          capability: 'Get-Mailbox only' as const,
          disclaimer: 'Exchange.ManageAsAppV2 permits authentication to the Exchange Admin API. HawkView activates this option only after verifying a custom Exchange RBAC assignment that exposes Get-Mailbox and no broader Microsoft Entra directory role. HawkView does not run Set-, New-, or Remove- cmdlets.',
        },
        reportVisibility: {
          required: false,
          status: reportStatus,
          identifiersVisible: tenant.connection.reportIdentifiersVisible,
          lastCheckedAt: tenant.connection.reportSettingsLastCheckedAt?.toISOString() ?? null,
          deferredAt: tenant.connection.reportVisibilityDeferredAt?.toISOString() ?? null,
          permission: 'ReportSettings.Read.All' as const,
          adminCenterUrl: 'https://admin.microsoft.com/#/Settings/Services',
          settingPath: ['Settings', 'Org settings', 'Services', 'Reports'],
          settingLabel: 'Display concealed user, group, and site names in all reports',
          disclaimer: 'HawkView can read this privacy setting but cannot change it. A Microsoft 365 administrator must update it in the Microsoft 365 admin center.',
        },
      },
    }
  }

  async skipExchangeReadOnlyForIdentity(identity: AuthenticatedIdentity, customerTenantId: string) {
    const organizationIds = await this.getTenantOnboardingOrganizationIds(identity)
    const tenant = await this.prisma.customerTenant.findFirst({
      where: { id: customerTenantId, organizationId: { in: organizationIds } },
      select: { id: true, organizationId: true },
    })
    if (!tenant) throw new NotFoundException('Customer tenant was not found.')
    await this.prisma.tenantConnection.update({
      where: { customerTenantId_organizationId: { customerTenantId: tenant.id, organizationId: tenant.organizationId } },
      data: { exchangeReadOnlySkippedAt: new Date() },
    })
    return this.getTenantOnboardingForIdentity(identity, customerTenantId)
  }

  async deferReportVisibilityForIdentity(identity: AuthenticatedIdentity, customerTenantId: string) {
    const organizationIds = await this.getTenantOnboardingOrganizationIds(identity)
    const tenant = await this.prisma.customerTenant.findFirst({
      where: { id: customerTenantId, organizationId: { in: organizationIds } },
      select: { id: true, organizationId: true },
    })
    if (!tenant) throw new NotFoundException('Customer tenant was not found.')
    await this.prisma.tenantConnection.update({
      where: { customerTenantId_organizationId: { customerTenantId: tenant.id, organizationId: tenant.organizationId } },
      data: { reportVisibilityDeferredAt: new Date() },
    })
    return this.getTenantOnboardingForIdentity(identity, customerTenantId)
  }

  async verifyReportVisibilityForIdentity(identity: AuthenticatedIdentity, customerTenantId: string) {
    const organizationIds = await this.getTenantOnboardingOrganizationIds(identity)
    const tenant = await this.prisma.customerTenant.findFirst({
      where: { id: customerTenantId, organizationId: { in: organizationIds } },
      select: {
        id: true,
        organizationId: true,
        microsoftTenantId: true,
        connection: { select: { connectionMode: true, clientId: true, credentialReference: true } },
      },
    })
    if (!tenant?.connection) throw new NotFoundException('Customer tenant was not found.')
    const result = await this.microsoftConsent.readTenantReportPrivacySetting({
      microsoftTenantId: tenant.microsoftTenantId,
      connectionMode: tenant.connection.connectionMode === 'CUSTOMER_MANAGED' ? 'CUSTOMER_MANAGED' : 'HAWKVIEW_MANAGED',
      clientId: tenant.connection.clientId,
      credentialReference: tenant.connection.credentialReference,
    })
    const checkedAt = new Date()
    await this.prisma.tenantConnection.update({
      where: { customerTenantId_organizationId: { customerTenantId: tenant.id, organizationId: tenant.organizationId } },
      data: {
        reportSettingsLastCheckedAt: checkedAt,
        reportIdentifiersVisible: result.identifiersVisible,
        reportVisibilityDeferredAt: result.identifiersVisible ? null : undefined,
      },
    })
    return {
      verification: { ...result, checkedAt: checkedAt.toISOString() },
      onboarding: await this.getTenantOnboardingForIdentity(identity, customerTenantId),
    }
  }

  async completeTenantOnboardingForIdentity(identity: AuthenticatedIdentity, customerTenantId: string) {
    const state = await this.getTenantOnboardingForIdentity(identity, customerTenantId)
    if (state.completedAt) return state
    if (!state.canFinish) {
      throw new ConflictException('Resolve or explicitly defer each optional setup step before finishing onboarding.')
    }
    const organizationIds = await this.getTenantOnboardingOrganizationIds(identity)
    const tenant = await this.prisma.customerTenant.findFirst({
      where: { id: customerTenantId, organizationId: { in: organizationIds } },
      select: { id: true, organizationId: true },
    })
    if (!tenant) throw new NotFoundException('Customer tenant was not found.')
    await this.prisma.tenantConnection.updateMany({
      where: {
        customerTenantId: tenant.id,
        organizationId: tenant.organizationId,
        onboardingCompletedAt: null,
      },
      data: { onboardingCompletedAt: new Date() },
    })
    return this.getTenantOnboardingForIdentity(identity, customerTenantId)
  }

  async assertCanConfigureExchangeReadOnly(
    identity: AuthenticatedIdentity,
    customerTenantId: string,
  ) {
    const organizationIds = await this.getTenantOnboardingOrganizationIds(identity)
    const tenant = await this.prisma.customerTenant.findFirst({
      where: { id: customerTenantId, organizationId: { in: organizationIds } },
      select: { id: true },
    })
    if (!tenant) throw new NotFoundException('Customer tenant was not found.')
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
    await this.recordConsentAttempt({
      identity,
      organizationId: organizationIds[0],
      flow: 'DISCOVER_TENANT',
      stateHash: consent.stateHash,
      expiresAt: consent.expiresAt,
    })
    return {
      consentUrl: consent.consentUrl,
      requiredPermissions: this.microsoftConsent.getRequiredPermissions(),
    }
  }

  private async consumeConsentAttempt(state: {
    customerTenantId?: string
    organizationId: string
    nonce: string
    flow: 'existing-tenant' | 'discover-tenant' | 'exchange-readonly'
  }) {
    const stateHash = this.microsoftConsent.hashConsentNonce(state.nonce)
    const expectedFlow = state.flow === 'discover-tenant'
      ? 'DISCOVER_TENANT'
      : state.flow === 'exchange-readonly'
        ? 'EXCHANGE_READ_ONLY'
        : 'EXISTING_TENANT'
    const attempt = await this.prisma.microsoftConsentAttempt.findUnique({
      where: { stateHash },
      select: {
        id: true,
        organizationId: true,
        customerTenantId: true,
        flow: true,
        expiresAt: true,
        consumedAt: true,
      },
    })
    if (
      !attempt ||
      attempt.organizationId !== state.organizationId ||
      attempt.flow !== expectedFlow ||
      attempt.customerTenantId !== (state.customerTenantId ?? null) ||
      attempt.expiresAt.getTime() < Date.now() ||
      attempt.consumedAt
    ) {
      return null
    }
    const consumed = await this.prisma.microsoftConsentAttempt.updateMany({
      where: { id: attempt.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date(), resultCode: 'CALLBACK_RECEIVED' },
    })
    return consumed.count === 1 ? attempt.id : null
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
      flow: 'existing-tenant' | 'discover-tenant' | 'exchange-readonly'
    }
    try {
      state = await this.microsoftConsent.verifyConsentState(stateToken)
    } catch {
      return this.buildFrontendConsentRedirect('error', 'invalid-state')
    }


    const consentAttemptId = await this.consumeConsentAttempt(state)
    if (!consentAttemptId) {
      return this.buildFrontendConsentRedirect(
        'error',
        'expired-or-used-state',
        state.customerTenantId,
        Boolean(state.customerTenantId),
      )
    }

    if (state.flow === 'discover-tenant') {
      return this.completeDiscoveredMicrosoftConsent(query, state, consentAttemptId)
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
            connectionMode: true,
            clientId: true,
            credentialReference: true,
            consentedPermissions: true,
          },
        },
      },
    })
    if (!tenant) {
      return this.buildFrontendConsentRedirect('error', 'tenant-not-found')
    }
    if (!tenant.connection) {
      return this.buildFrontendConsentRedirect('error', 'connection-missing', tenant.id, true)
    }

    if (state.flow === 'exchange-readonly') {
      return this.completeExchangeReadOnlyConsent(query, tenant)
    }

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
      return this.buildFrontendConsentRedirect('error', errorCode, tenant.id, true)
    }

    try {
      const verification = await this.microsoftConsent.verifyTenantAfterConsent(
        tenant.microsoftTenantId
      )
      const connected = verification.missingRequiredPermissions.length === 0
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
            consentedPermissions: preserveOptionalExchangeConsent(
              verification.grantedPermissions,
              tenant.connection.consentedPermissions
            ),
            consentedAt: now,
            lastVerifiedAt: now,
            lastErrorCode: connected ? null : 'missing-permissions',
            lastErrorMessage: connected
              ? null
              : `Missing connection-required permissions: ${verification.missingRequiredPermissions.join(', ')}`,
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
          verification.missingRequiredPermissions
        )
      }

      return this.buildFrontendConsentRedirect(
        connected ? 'success' : 'missing-permissions',
        connected ? null : 'missing-permissions',
        tenant.id,
        true,
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
        tenant.id,
        true,
      )
    }
  }

  private async completeExchangeReadOnlyConsent(
    query: Record<string, unknown>,
    tenant: {
      id: string
      organizationId: string
      microsoftTenantId: string
      connection: {
        connectionMode: string
        clientId: string | null
        credentialReference: string | null
        consentedPermissions: string[]
      } | null
    },
  ) {
    const returnedTenantId = typeof query.tenant === 'string' ? query.tenant.toLowerCase() : ''
    const granted = query.admin_consent === 'True' || query.admin_consent === 'true'
    const microsoftError = typeof query.error === 'string' ? query.error : null
    if (microsoftError || !granted || returnedTenantId !== tenant.microsoftTenantId.toLowerCase()) {
      return this.buildFrontendConsentRedirect(
        'exchange-readonly-error',
        microsoftError ?? (granted ? 'tenant-mismatch' : 'consent-denied'),
        tenant.id,
        true,
      )
    }
    if (!tenant.connection) {
      return this.buildFrontendConsentRedirect('exchange-readonly-error', 'connection-missing', tenant.id, true)
    }
    try {
      const verification = await this.microsoftConsent.verifyTenantExchangeConsent({
        microsoftTenantId: tenant.microsoftTenantId,
        connectionMode: tenant.connection.connectionMode === 'CUSTOMER_MANAGED'
          ? 'CUSTOMER_MANAGED'
          : 'HAWKVIEW_MANAGED',
        clientId: tenant.connection.clientId,
        credentialReference: tenant.connection.credentialReference,
      })
      const now = new Date()
      await this.prisma.tenantConnection.update({
        where: {
          customerTenantId_organizationId: {
            customerTenantId: tenant.id,
            organizationId: tenant.organizationId,
          },
        },
        data: {
          consentedPermissions: [
            ...new Set([...tenant.connection.consentedPermissions, verification.permission]),
          ].sort(),
          consentedAt: now,
          lastVerifiedAt: now,
        },
      })
      return this.buildFrontendConsentRedirect('exchange-readonly-consented', null, tenant.id, true)
    } catch {
      return this.buildFrontendConsentRedirect(
        'exchange-readonly-error',
        'exchange-consent-verification-failed',
        tenant.id,
        true,
      )
    }
  }

  private async completeDiscoveredMicrosoftConsent(
    query: Record<string, unknown>,
    state: { organizationId: string; nonce: string },
    consentAttemptId: string,
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
        connection: {
          select: {
            connectionMode: true,
            consentedPermissions: true,
          },
        },
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
          select: {
            id: true,
            organizationId: true,
            connection: {
              select: { consentedPermissions: true },
            },
          },
        })

    await this.prisma.microsoftConsentAttempt.update({
      where: { id: consentAttemptId },
      data: { customerTenantId: tenant.id },
    })

    try {
      const verification =
        await this.microsoftConsent.verifyTenantAfterConsent(returnedTenantId)
      const connected = verification.missingRequiredPermissions.length === 0
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
            consentedPermissions: preserveOptionalExchangeConsent(
              verification.grantedPermissions,
              tenant.connection?.consentedPermissions ?? []
            ),
            consentedAt: now,
            lastVerifiedAt: now,
            lastErrorCode: connected ? null : 'missing-permissions',
            lastErrorMessage: connected
              ? null
              : `Missing connection-required permissions: ${verification.missingRequiredPermissions.join(', ')}`,
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
          verification.missingRequiredPermissions
        )
      }

      return this.buildFrontendConsentRedirect(
        connected ? 'success' : 'missing-permissions',
        connected ? null : 'missing-permissions',
        tenant.id,
        true,
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
        tenant.id,
        true,
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
    customerTenantId?: string,
    tenantOnboarding = false,
  ) {
    const frontendUrl = process.env.FRONTEND_APP_URL?.trim()
    if (!frontendUrl) throw new Error('FRONTEND_APP_URL is not configured.')

    const url = new URL(
      tenantOnboarding && customerTenantId
        ? `/tenants/${encodeURIComponent(customerTenantId)}/onboarding`
        : '/tenants',
      frontendUrl,
    )
    url.searchParams.set('microsoftConsent', result)
    if (error) url.searchParams.set('error', error)
    if (customerTenantId) url.searchParams.set('tenantId', customerTenantId)
    return url.toString()
  }
}
