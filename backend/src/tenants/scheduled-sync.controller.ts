import { Controller, Inject, Logger, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { Public } from '../auth/public.decorator.js'
import { SchedulerTokenVerifier } from './scheduler-token-verifier.service.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { IdentityRiskMaintenanceService } from '../identity-risk/identity-risk-maintenance.service.js'
import { logProcessMemoryPhase } from './runtime-telemetry.js'

@Controller('api/internal/sync')
export class ScheduledSyncController {
  private readonly logger = new Logger(ScheduledSyncController.name)
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
    const startedAt = Date.now()
    logProcessMemoryPhase(this.logger, 'scheduled_sync', 'STARTED', startedAt)
    try {
      await this.identityRiskMaintenance.runAuthorizedScheduledMaintenance()
      logProcessMemoryPhase(this.logger, 'scheduled_sync_maintenance', 'COMPLETED', startedAt)
      const result = await this.tenantSyncService.syncDueTenants()
      logProcessMemoryPhase(this.logger, 'scheduled_sync', 'COMPLETED', startedAt)
      return result
    } catch (error) {
      logProcessMemoryPhase(this.logger, 'scheduled_sync', 'FAILED', startedAt)
      throw error
    }
  }
}
