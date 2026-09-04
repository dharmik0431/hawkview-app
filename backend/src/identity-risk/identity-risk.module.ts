import { Module } from '@nestjs/common'
import { IdentityRiskController } from './identity-risk.controller.js'
import { IdentityRiskService } from './identity-risk.service.js'
import {
  IdentityRiskEvaluationScheduler,
  IdentityRiskEvaluatorService,
  IdentityRiskPlatformClock,
} from './identity-risk-evaluator.service.js'
import { IdentityRiskSafetyService } from './identity-risk-safety.service.js'
import { IdentityRiskMaintenanceService } from './identity-risk-maintenance.service.js'
import { IdentityRiskPseudonymProvider } from './identity-risk-pseudonym.js'
import { MailboxRiskProjector } from './mailbox-risk-projector.service.js'

@Module({
  controllers: [IdentityRiskController],
  providers: [
    IdentityRiskPseudonymProvider,
    MailboxRiskProjector,
    IdentityRiskService,
    IdentityRiskSafetyService,
    IdentityRiskPlatformClock,
    IdentityRiskEvaluatorService,
    IdentityRiskEvaluationScheduler,
    IdentityRiskMaintenanceService,
  ],
  exports: [
    MailboxRiskProjector,
    IdentityRiskEvaluationScheduler,
    IdentityRiskSafetyService,
    IdentityRiskMaintenanceService,
  ],
})
export class IdentityRiskModule {}
