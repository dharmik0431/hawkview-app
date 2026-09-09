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
import { createPilotPseudonymProvider, IDENTITY_RISK_MANAGED_MAC_TRANSPORT } from './pilot-pseudonym-provider.js'
import { MailboxInvestigationResolver } from './mailbox-investigation-resolver.js'
import { RiskAssessmentProjector } from './risk-assessment-projector.service.js'
import { RiskAssessmentReader } from './risk-assessment-reader.service.js'

@Module({
  controllers: [IdentityRiskController],
  providers: [
    { provide: IDENTITY_RISK_MANAGED_MAC_TRANSPORT, useValue: null },
    { provide: IdentityRiskPseudonymProvider, useFactory: createPilotPseudonymProvider, inject: [IDENTITY_RISK_MANAGED_MAC_TRANSPORT] },
    MailboxInvestigationResolver,
    MailboxRiskProjector,
    RiskAssessmentProjector,
    RiskAssessmentReader,
    IdentityRiskService,
    IdentityRiskSafetyService,
    IdentityRiskPlatformClock,
    IdentityRiskEvaluatorService,
    IdentityRiskEvaluationScheduler,
    IdentityRiskMaintenanceService,
  ],
  exports: [
    MailboxRiskProjector,
    RiskAssessmentProjector,
    IdentityRiskEvaluationScheduler,
    IdentityRiskSafetyService,
    IdentityRiskMaintenanceService,
  ],
})
export class IdentityRiskModule {}
