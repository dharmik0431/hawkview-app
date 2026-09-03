import { Module } from '@nestjs/common'
import { IdentityRiskController } from './identity-risk.controller.js'
import { IdentityRiskService } from './identity-risk.service.js'
import {
  IdentityRiskEvaluationScheduler,
  IdentityRiskEvaluatorService,
  IdentityRiskPlatformClock,
} from './identity-risk-evaluator.service.js'
import { IdentityRiskSafetyService } from './identity-risk-safety.service.js'

@Module({
  controllers: [IdentityRiskController],
  providers: [
    IdentityRiskService,
    IdentityRiskSafetyService,
    IdentityRiskPlatformClock,
    IdentityRiskEvaluatorService,
    IdentityRiskEvaluationScheduler,
  ],
  exports: [IdentityRiskEvaluationScheduler, IdentityRiskSafetyService],
})
export class IdentityRiskModule {}
