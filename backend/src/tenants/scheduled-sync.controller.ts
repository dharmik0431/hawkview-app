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
import { RiskCycleDiagnostic } from '../identity-risk/risk-operational-diagnostics.js'
import { AlertIntakeService } from '../alerts/alert-intake.service.js'

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
    @Inject(AlertIntakeService)
    private readonly alertIntake: AlertIntakeService,
  ) {}

  @Public()
  @Post('due-tenants')
  async syncDueTenants(@Req() request: Request) {
    const startedAt = Date.now()
    // Admission only: already-running collectors retain their existing limits.
    // Authentication, maintenance and risk all consume this same request clock.
    const admissionDeadlineAt = startedAt + 240_000
    await this.schedulerTokenVerifier.verify(request.headers.authorization)
    const riskDiagnostic = new RiskCycleDiagnostic()
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
          await this.tenantSyncService.runScheduledGlobalRiskCycle(startedAt + 45_000, reason => riskDiagnostic.record(reason))
        } catch {
          riskDiagnostic.record('ATTEMPT_FAILED')
          this.logger.warn('Identity-risk cycle unavailable; collection continues.')
        }
      } else riskDiagnostic.record(!isGlobalRiskConfig(riskRuntimeConfig()) ? 'CONFIG_UNAVAILABLE' :
        !riskMaintenanceReady ? 'MAINTENANCE_DEFERRED' : 'ADMISSION_BUDGET_EXHAUSTED')
      riskDiagnostic.finish()

      // ALERT INTAKE, IN ITS OWN WINDOW, AFTER RISK AND BEFORE THE COLLECTORS.
      //
      // COLLECTION OUTRANKS ALERTING, ALWAYS. This stage gets from wherever the risk cycle
      // left off until +60s and not one millisecond of the collectors’ admission budget. If
      // it cannot finish in that window it YIELDS — leaving the findings untouched and still
      // OPEN for the next tick — rather than borrowing time from what comes after it.
      //
      // The failure it would otherwise cause is the worst one this product has: a slow intake
      // eats the collectors’ budget, tenants quietly stop being collected, and that reads as
      // the tenants being quiet. Nobody would trace it to alerting.
      //
      // It never throws — see `runOnce`, which logs and returns null — so a settled intake
      // failure cannot abort the collection that follows. Same rule the maintenance stage
      // above states in its own words.
      if (Date.now() < startedAt + 60_000) {
        await this.alertIntake.runOnce(startedAt + 60_000)
      } else {
        this.logger.log(JSON.stringify({ event: 'alert_intake', status: 'WINDOW_MISSED' }))
      }

      const result = await this.tenantSyncService.syncDueTenants(admissionDeadlineAt)
      logProcessMemoryPhase(this.logger, 'scheduled_sync', 'COMPLETED', startedAt)
      return result
    } catch (error) {
      logProcessMemoryPhase(this.logger, 'scheduled_sync', 'FAILED', startedAt)
      throw error
    } finally {
      // Once per authenticated natural invocation, including exceptional exits.
      riskDiagnostic.finish()
    }
  }
}
