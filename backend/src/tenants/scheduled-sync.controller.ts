import { Controller, Inject, Logger, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { Public } from '../auth/public.decorator.js'
import { SchedulerTokenVerifier } from './scheduler-token-verifier.service.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { IdentityRiskMaintenanceService } from '../identity-risk/identity-risk-maintenance.service.js'
import { identityRiskMaintenanceEnabled } from '../identity-risk/identity-risk-maintenance.service.js'
import { logProcessMemoryPhase } from './runtime-telemetry.js'
import { isGlobalRiskConfig, riskRuntimeConfig } from '../identity-risk/risk-runtime-config.js'
import { riskHistoryRetentionConfig } from '../identity-risk/risk-history-retention.js'

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
    const startedAt = Date.now()
    // Admission only: already-running collectors retain their existing limits.
    // Authentication, maintenance and risk all consume this same request clock.
    const admissionDeadlineAt = startedAt + 240_000
    await this.schedulerTokenVerifier.verify(request.headers.authorization)
    logProcessMemoryPhase(this.logger, 'scheduled_sync', 'STARTED', startedAt)
    try {
      // Separate opt-in physical history policy also runs with evaluation OFF.
      // It never invokes Microsoft, keys, or evaluation; backlog cannot suppress
      // ordinary collection or manufacture a successful/clean risk assessment.
      if (riskHistoryRetentionConfig() && Date.now() < startedAt + 10_000) {
        try {
          const history = await this.identityRiskMaintenance.runAuthorizedRiskHistoryMaintenance(startedAt + 10_000)
          this.logger.log(JSON.stringify({ event: 'risk_history_retention', ...history }))
        } catch {
          this.logger.warn(JSON.stringify({ event: 'risk_history_retention', status: 'UNAVAILABLE' }))
        }
      }
      // Missing the maintenance admission window is not proof the backlog is
      // drained. Defer risk (but still permit collectors) in that case too.
      let riskMaintenanceReady = !identityRiskMaintenanceEnabled()
      if (identityRiskMaintenanceEnabled() && Date.now() < startedAt + 15_000) {
        try {
          const maintenance = await this.identityRiskMaintenance.runAuthorizedScheduledMaintenance(startedAt + 15_000)
          riskMaintenanceReady = !maintenance.hasMore
          logProcessMemoryPhase(this.logger, 'scheduled_sync_maintenance', 'COMPLETED', startedAt)
        } catch {
          riskMaintenanceReady = false
          // A settled maintenance failure does not suppress ordinary collectors.
          // Only a closed diagnostic is logged; no DB/provider payloads.
          this.logger.warn('Identity-risk maintenance unavailable; collection continues.')
          logProcessMemoryPhase(this.logger, 'scheduled_sync_maintenance', 'FAILED', startedAt)
        }
      }
      if (riskMaintenanceReady && Date.now() < startedAt + 45_000 && isGlobalRiskConfig(riskRuntimeConfig())) {
        try {
          // Reserve collector admission opportunity; this is not a whole-request SLA.
          await this.tenantSyncService.runScheduledGlobalRiskCycle(startedAt + 45_000)
        } catch {
          this.logger.warn('Identity-risk cycle unavailable; collection continues.')
        }
      }
      const result = await this.tenantSyncService.syncDueTenants(admissionDeadlineAt)
      logProcessMemoryPhase(this.logger, 'scheduled_sync', 'COMPLETED', startedAt)
      return result
    } catch (error) {
      logProcessMemoryPhase(this.logger, 'scheduled_sync', 'FAILED', startedAt)
      throw error
    }
  }
}
