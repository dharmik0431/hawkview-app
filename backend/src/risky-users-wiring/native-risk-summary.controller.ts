import { Controller, ForbiddenException, Get, Header, Inject, Req, ServiceUnavailableException } from '@nestjs/common'
import { IdentityRiskService } from '../identity-risk/identity-risk.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { readNativeRiskSummary } from './native-risk-summary.js'

@Controller('api/risky-users')
export class NativeRiskSummaryController {
  constructor(
    @Inject(IdentityRiskService) private readonly identityRisk: IdentityRiskService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Get('summary')
  @Header('Cache-Control', 'no-store')
  async summary(@Req() request: AuthenticatedRequest) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const now = new Date()
        const scope = await this.identityRisk.authorizeRiskyUsersFleetRead(request.auth, transaction)
        return readNativeRiskSummary(transaction, scope, now)
      }, { isolationLevel: 'RepeatableRead', timeout: 10_000 })
    } catch (error) {
      if (error instanceof ForbiddenException) throw error
      // Never return a cached all-clear or driver/provider details on a failed read.
      throw new ServiceUnavailableException('Native risk summary is temporarily unavailable')
    }
  }
}
