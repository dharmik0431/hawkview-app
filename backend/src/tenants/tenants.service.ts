import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import { MembershipRole } from '../generated/prisma/enums.js'
import { MicrosoftConsentService } from '../microsoft/microsoft-consent.service.js'
import { PrismaService } from '../prisma/prisma.service.js'

const ORGANIZATION_WIDE_TENANT_ROLES = [
  MembershipRole.MSP_OWNER,
  MembershipRole.MSP_ADMIN,
] as const

const MICROSOFT_TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

@Injectable()
export class TenantsService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(MicrosoftConsentService)
    private readonly microsoftConsent: MicrosoftConsentService
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

  private async getManagedOrganizationIds(identity: AuthenticatedIdentity) {
    const user = await this.prisma.user.findUnique({
      where: { identityPlatformUserId: identity.subject },
      select: {
        disabledAt: true,
        memberships: {
          where: {
            status: 'ACTIVE',
            role: { in: [...ORGANIZATION_WIDE_TENANT_ROLES] },
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

  private mapTenant(tenant: {
    id: string
    microsoftTenantId: string
    displayName: string | null
    primaryDomain: string | null
    status: string
    organization: { name: string; slug: string }
    connection: {
      status: string
      consentedPermissions: string[]
      lastVerifiedAt: Date | null
      lastErrorCode: string | null
    } | null
  }) {
    const requiredPermissions = this.microsoftConsent.getRequiredPermissions()
    const consentedPermissions = tenant.connection?.consentedPermissions ?? []

    return {
      id: tenant.id,
      name:
        tenant.displayName ??
        `Microsoft tenant ${tenant.microsoftTenantId.slice(0, 8)}`,
      microsoftTenantId: tenant.microsoftTenantId,
      provider: 'microsoft' as const,
      domain: tenant.primaryDomain,
      status: tenant.status.toLowerCase(),
      connectionStatus:
        tenant.connection?.status.toLowerCase().replaceAll('_', '-') ?? null,
      lastSync: tenant.connection?.lastVerifiedAt?.toISOString() ?? null,
      requiredPermissions,
      consentedPermissions,
      missingPermissions: requiredPermissions
        .map((permission) => permission.name)
        .filter((permission) => !consentedPermissions.includes(permission)),
      connectionErrorCode: tenant.connection?.lastErrorCode ?? null,
      secureScore: null,
      licenseCount: null,
      organization: tenant.organization,
    }
  }

  private tenantSelect() {
    return {
      id: true,
      microsoftTenantId: true,
      displayName: true,
      primaryDomain: true,
      status: true,
      organization: { select: { name: true, slug: true } },
      connection: {
        select: {
          status: true,
          consentedPermissions: true,
          lastVerifiedAt: true,
          lastErrorCode: true,
        },
      },
    } as const
  }

  async listForIdentity(identity: AuthenticatedIdentity) {
    const organizationIds = await this.getManagedOrganizationIds(identity)
    if (organizationIds.length === 0) return { tenants: [] }

    const tenants = await this.prisma.customerTenant.findMany({
      where: { organizationId: { in: organizationIds } },
      orderBy: [{ displayName: 'asc' }, { microsoftTenantId: 'asc' }],
      select: this.tenantSelect(),
    })

    return { tenants: tenants.map((tenant) => this.mapTenant(tenant)) }
  }

  async createForIdentity(identity: AuthenticatedIdentity, body: unknown) {
    const microsoftTenantId = this.parseMicrosoftTenantId(body)
    const organizationIds = await this.getManagedOrganizationIds(identity)

    if (organizationIds.length === 0) {
      throw new ForbiddenException(
        'Only an MSP Owner or Admin can onboard a tenant.'
      )
    }
    if (organizationIds.length > 1) {
      throw new BadRequestException(
        'Choose an MSP workspace before onboarding a tenant.'
      )
    }

    const existing = await this.prisma.customerTenant.findUnique({
      where: { microsoftTenantId },
      select: { id: true },
    })
    if (existing) {
      throw new ConflictException(
        'This Microsoft tenant is already connected to HawkView.'
      )
    }

    const tenant = await this.prisma.customerTenant.create({
      data: {
        organizationId: organizationIds[0],
        microsoftTenantId,
        displayName: null,
        connection: { create: {} },
      },
      select: this.tenantSelect(),
    })

    return { tenant: this.mapTenant(tenant) }
  }

  async createConsentUrlForIdentity(
    identity: AuthenticatedIdentity,
    customerTenantId: string
  ) {
    const organizationIds = await this.getManagedOrganizationIds(identity)
    const tenant = await this.prisma.customerTenant.findFirst({
      where: {
        id: customerTenantId,
        organizationId: { in: organizationIds },
      },
      select: {
        id: true,
        organizationId: true,
        microsoftTenantId: true,
      },
    })

    if (!tenant) {
      throw new NotFoundException('Customer tenant was not found.')
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

  async completeMicrosoftConsent(query: Record<string, unknown>) {
    const stateToken = typeof query.state === 'string' ? query.state : ''
    if (!stateToken) {
      return this.buildFrontendConsentRedirect('error', 'missing-state')
    }

    let state: {
      customerTenantId: string
      organizationId: string
      nonce: string
    }
    try {
      state = await this.microsoftConsent.verifyConsentState(stateToken)
    } catch {
      return this.buildFrontendConsentRedirect('error', 'invalid-state')
    }

    const tenant = await this.prisma.customerTenant.findFirst({
      where: {
        id: state.customerTenantId,
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
      const verification = await this.microsoftConsent.verifyTenant(
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
