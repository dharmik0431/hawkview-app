import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common'
import { MembershipRole } from '../generated/prisma/enums.js'
import { PrismaService } from '../prisma/prisma.service.js'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'

const ORGANIZATION_WIDE_TENANT_ROLES = [
  MembershipRole.MSP_OWNER,
  MembershipRole.MSP_ADMIN,
] as const

const MICROSOFT_TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface CreateTenantInput {
  displayName: string
  microsoftTenantId: string
}

@Injectable()
export class TenantsService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  private parseCreateInput(body: unknown): CreateTenantInput {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('Tenant details are required.')
    }

    const candidate = body as Record<string, unknown>
    const displayName =
      typeof candidate.displayName === 'string'
        ? candidate.displayName.trim()
        : ''
    const microsoftTenantId =
      typeof candidate.microsoftTenantId === 'string'
        ? candidate.microsoftTenantId.trim().toLowerCase()
        : ''

    if (displayName.length < 2 || displayName.length > 200) {
      throw new BadRequestException(
        'Customer name must be between 2 and 200 characters.',
      )
    }

    if (!MICROSOFT_TENANT_ID_PATTERN.test(microsoftTenantId)) {
      throw new BadRequestException(
        'Enter a valid Microsoft tenant ID.',
      )
    }

    return { displayName, microsoftTenantId }
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
        'Complete HawkView account setup before accessing tenants.',
      )
    }

    if (user.disabledAt) {
      throw new ForbiddenException('This HawkView account is disabled.')
    }

    return user.memberships.map((membership) => membership.organizationId)
  }

  async listForIdentity(identity: AuthenticatedIdentity) {
    const organizationIds = await this.getManagedOrganizationIds(identity)

    if (organizationIds.length === 0) {
      return { tenants: [] }
    }

    const tenants = await this.prisma.customerTenant.findMany({
      where: {
        organizationId: { in: organizationIds },
      },
      orderBy: { displayName: 'asc' },
      select: {
        id: true,
        microsoftTenantId: true,
        displayName: true,
        status: true,
        organization: {
          select: {
            name: true,
            slug: true,
          },
        },
        connection: {
          select: {
            status: true,
            lastVerifiedAt: true,
          },
        },
      },
    })

    return {
      tenants: tenants.map((tenant) => ({
        id: tenant.id,
        name: tenant.displayName,
        microsoftTenantId: tenant.microsoftTenantId,
        provider: 'microsoft' as const,
        domain: null,
        status: tenant.status.toLowerCase(),
        connectionStatus:
          tenant.connection?.status.toLowerCase().replaceAll('_', '-') ?? null,
        lastSync: tenant.connection?.lastVerifiedAt?.toISOString() ?? null,
        secureScore: null,
        licenseCount: null,
        organization: tenant.organization,
      })),
    }
  }

  async createForIdentity(
    identity: AuthenticatedIdentity,
    body: unknown,
  ) {
    const input = this.parseCreateInput(body)
    const organizationIds = await this.getManagedOrganizationIds(identity)

    if (organizationIds.length === 0) {
      throw new ForbiddenException(
        'Only an MSP Owner or Admin can onboard a tenant.',
      )
    }

    if (organizationIds.length > 1) {
      throw new BadRequestException(
        'Choose an MSP workspace before onboarding a tenant.',
      )
    }

    const existing = await this.prisma.customerTenant.findUnique({
      where: { microsoftTenantId: input.microsoftTenantId },
      select: { id: true },
    })

    if (existing) {
      throw new ConflictException(
        'This Microsoft tenant is already connected to HawkView.',
      )
    }

    const tenant = await this.prisma.customerTenant.create({
      data: {
        organizationId: organizationIds[0],
        microsoftTenantId: input.microsoftTenantId,
        displayName: input.displayName,
        connection: {
          create: {},
        },
      },
      select: {
        id: true,
        microsoftTenantId: true,
        displayName: true,
        status: true,
        organization: {
          select: { name: true, slug: true },
        },
        connection: {
          select: { status: true, lastVerifiedAt: true },
        },
      },
    })

    return {
      tenant: {
        id: tenant.id,
        name: tenant.displayName,
        microsoftTenantId: tenant.microsoftTenantId,
        provider: 'microsoft' as const,
        domain: null,
        status: tenant.status.toLowerCase(),
        connectionStatus:
          tenant.connection?.status.toLowerCase().replaceAll('_', '-') ?? null,
        lastSync: tenant.connection?.lastVerifiedAt?.toISOString() ?? null,
        secureScore: null,
        licenseCount: null,
        organization: tenant.organization,
      },
    }
  }
}
