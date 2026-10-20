import { Body, Controller, Get, Inject, Param, Patch, Post, Put, Req } from '@nestjs/common'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { SecurityRequirementsService } from './security-requirements.service.js'

@Controller('api/tenants/:id/security-requirements')
export class SecurityRequirementsController {
  constructor(@Inject(SecurityRequirementsService) private readonly service: SecurityRequirementsService) {}

  @Get()
  get(@Req() request: AuthenticatedRequest, @Param('id') tenantId: string) {
    return this.service.get(request.auth, tenantId)
  }

  @Post('baselines')
  create(@Req() request: AuthenticatedRequest, @Param('id') tenantId: string, @Body() body: unknown) {
    return this.service.create(request.auth, tenantId, body)
  }

  @Patch('baselines/:baselineId')
  update(@Req() request: AuthenticatedRequest, @Param('id') tenantId: string, @Param('baselineId') baselineId: string, @Body() body: unknown) {
    return this.service.update(request.auth, tenantId, baselineId, body)
  }

  @Put('assignment')
  assign(@Req() request: AuthenticatedRequest, @Param('id') tenantId: string, @Body() body: unknown) {
    return this.service.assign(request.auth, tenantId, body)
  }
}
