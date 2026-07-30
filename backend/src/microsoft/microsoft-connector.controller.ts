import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Post,
  Req,
} from '@nestjs/common'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { MicrosoftConsentService } from './microsoft-consent.service.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

@Controller('api/platform/microsoft-connector')
export class MicrosoftConnectorController {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(MicrosoftConsentService)
    private readonly microsoftConsent: MicrosoftConsentService
  ) {}

  private async requirePlatformAdmin(request: AuthenticatedRequest) {
    const user = await this.prisma.user.findUnique({
      where: { identityPlatformUserId: request.auth.subject },
      select: { platformRole: true, disabledAt: true },
    })
    if (
      !user ||
      user.disabledAt ||
      !['PLATFORM_ADMIN'].includes(user.platformRole)
    ) {
      throw new ForbiddenException(
        'Only a HawkView Platform Admin can configure the shared connector.'
      )
    }
  }

  @Get()
  async status(@Req() request: AuthenticatedRequest) {
    await this.requirePlatformAdmin(request)
    const connector =
      await this.prisma.platformMicrosoftConnector.findUnique({
        where: { id: 'default' },
        select: {
          clientId: true,
          homeTenantId: true,
          credentialExpiresAt: true,
          configuredAt: true,
        },
      })
    return {
      configured: Boolean(connector),
      connector: connector
        ? {
            ...connector,
            credentialExpiresAt:
              connector.credentialExpiresAt?.toISOString() ?? null,
            configuredAt: connector.configuredAt.toISOString(),
          }
        : null,
    }
  }

  @Post()
  async configure(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown
  ) {
    await this.requirePlatformAdmin(request)
    const candidate =
      body && typeof body === 'object'
        ? (body as Record<string, unknown>)
        : {}
    const clientId =
      typeof candidate.clientId === 'string'
        ? candidate.clientId.trim().toLowerCase()
        : ''
    const homeTenantId =
      typeof candidate.homeTenantId === 'string'
        ? candidate.homeTenantId.trim().toLowerCase()
        : ''
    const clientSecret =
      typeof candidate.clientSecret === 'string'
        ? candidate.clientSecret.trim()
        : ''
    const credentialExpiresAt =
      typeof candidate.credentialExpiresAt === 'string' &&
      candidate.credentialExpiresAt
        ? new Date(candidate.credentialExpiresAt)
        : null

    if (!UUID_PATTERN.test(clientId) || !UUID_PATTERN.test(homeTenantId)) {
      throw new BadRequestException(
        'Enter valid Microsoft application and home tenant IDs.'
      )
    }
    if (clientSecret.length < 16 || clientSecret.length > 2048) {
      throw new BadRequestException('Enter a valid Microsoft client secret.')
    }
    if (
      credentialExpiresAt &&
      Number.isNaN(credentialExpiresAt.getTime())
    ) {
      throw new BadRequestException('Enter a valid secret expiration date.')
    }

    return this.microsoftConsent.configureManagedConnector({
      clientId,
      homeTenantId,
      clientSecret,
      credentialExpiresAt,
    })
  }
}
