import { Controller, Get, Param, Req } from '@nestjs/common'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { IdentityRiskService } from './identity-risk.service.js'

@Controller('api/tenants/:tenantId')
export class IdentityRiskController {
  constructor(private readonly service: IdentityRiskService) {}
  @Get('identity-signals/summary') summary(@Req() req: AuthenticatedRequest, @Param('tenantId') id: string) { return this.service.summary(req.auth, id) }
  @Get('identity-signals/findings') findings(@Req() req: AuthenticatedRequest, @Param('tenantId') id: string) { return this.service.findings(req.auth, id) }
  @Get('microsoft-entra-risky-users') riskyUsers(@Req() req: AuthenticatedRequest, @Param('tenantId') id: string) { return this.service.microsoftRiskyUsers(req.auth, id) }
}
