import { ForbiddenException, Inject, Injectable } from '@nestjs/common'
import { MembershipRole } from '../generated/prisma/enums.js'
import { PrismaService } from '../prisma/prisma.service.js'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'

const ORGANIZATION_WIDE_TENANT_ROLES = [
  MembershipRole.MSP_OWNER,
  MembershipRole.MSP_ADMIN,
] as const

@Injectable()
export class TenantsService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  async listForIdentity(identity: AuthenticatedIdentity) {
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

    const organizationIds = user.memberships.map(
      (membership) => membership.organizationId,
    )

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
}
