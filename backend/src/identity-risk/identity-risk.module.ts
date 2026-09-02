import { Module } from '@nestjs/common'
import { IdentityRiskController } from './identity-risk.controller.js'
import { IdentityRiskService } from './identity-risk.service.js'
@Module({ controllers: [IdentityRiskController], providers: [IdentityRiskService] })
export class IdentityRiskModule {}
