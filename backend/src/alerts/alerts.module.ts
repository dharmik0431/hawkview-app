import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module.js'
import { AlertsController } from './alerts.controller.js'
import { AlertDispositionsService } from './alert-dispositions.service.js'
import { DeliveryOutcomeStore } from './delivery-outcome.store.js'
import { DeliveryWebhookController } from './delivery-webhook.controller.js'
import { ResendSignatureVerifier } from './resend-signature-verifier.service.js'

/** The alert settings surface. Deliberately small: the intake pipeline is wired through
 * `AlertIntakeService` from the scheduled-sync path and is not exported here. */
@Module({
  imports: [PrismaModule],
  controllers: [AlertsController, DeliveryWebhookController],
  providers: [AlertDispositionsService, DeliveryOutcomeStore, ResendSignatureVerifier],
  exports: [AlertDispositionsService],
})
export class AlertsModule {}
