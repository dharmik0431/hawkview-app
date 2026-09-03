import { Controller, Inject, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { Public } from '../auth/public.decorator.js'
import { SchedulerTokenVerifier } from './scheduler-token-verifier.service.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { IdentityRiskMaintenanceService } from '../identity-risk/identity-risk-maintenance.service.js'

@Controller('api/internal/sync')
export class ScheduledSyncController {
  constructor(
    @Inject(SchedulerTokenVerifier)
    private readonly schedulerTokenVerifier: SchedulerTokenVerifier,
    @Inject(TenantSyncService)
    private readonly tenantSyncService: TenantSyncService,
    @Inject(IdentityRiskMaintenanceService)
    private readonly identityRiskMaintenance: IdentityRiskMaintenanceService,
  ) {}

  @Public()
  @Post('due-tenants')
  async syncDueTenants(@Req() request: Request) {
    await this.schedulerTokenVerifier.verify(request.headers.authorization)
    await this.identityRiskMaintenance.runAuthorizedScheduledMaintenance()
    return this.tenantSyncService.syncDueTenants()
  }
}
