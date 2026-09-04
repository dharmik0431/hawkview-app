import { Controller, Get, Header, Param, Query, Req } from '@nestjs/common'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { IdentityRiskService } from './identity-risk.service.js'

@Controller('api/tenants/:tenantId')
export class IdentityRiskController {
  constructor(private readonly service: IdentityRiskService) {}
  @Get('identity-signals/summary') summary(@Req() req: AuthenticatedRequest, @Param('tenantId') id: string) { return this.service.summary(req.auth, id) }
  @Get('identity-signals/findings')
  findings(
    @Req() req: AuthenticatedRequest,
    @Param('tenantId') id: string,
    @Query('limit') limit: string | undefined,
    @Query('cursor') cursor: string | undefined,
  ) {
    return this.service.findings(req.auth, id, { limit, cursor })
  }
  @Get('identity-signals/findings/:findingId')
  findingDetail(
    @Req() req: AuthenticatedRequest,
    @Param('tenantId') id: string,
    @Param('findingId') findingId: string,
  ) {
    return this.service.findingDetail(req.auth, id, findingId)
  }
  @Get('microsoft-entra-risky-users')
  riskyUsers(
    @Req() req: AuthenticatedRequest,
    @Param('tenantId') id: string,
    @Query('limit') limit: string | undefined,
    @Query('cursor') cursor: string | undefined,
  ) {
    return this.service.microsoftRiskyUsers(req.auth, id, { limit, cursor })
  }
  @Get('identity-signals/investigation-access')
  @Header('Cache-Control', 'no-store')
  investigationAccess(@Req() req: AuthenticatedRequest, @Param('tenantId') id: string) {
    return this.service.investigationAccess(req.auth, id)
  }
  @Get('identity-signals/findings/:findingId/mailbox-investigation')
  @Header('Cache-Control', 'no-store')
  mailboxInvestigation(@Req() req: AuthenticatedRequest, @Param('tenantId') id: string, @Param('findingId') findingId: string) {
    return this.service.mailboxInvestigation(req.auth, id, findingId)
  }
}
