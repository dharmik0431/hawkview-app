import { Controller, Get, Inject, Req } from '@nestjs/common'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { TenantsService } from './tenants.service.js'

@Controller('api/tenants')
export class TenantsController {
  constructor(
    @Inject(TenantsService)
    private readonly tenantsService: TenantsService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.tenantsService.listForIdentity(request.auth)
  }
}
