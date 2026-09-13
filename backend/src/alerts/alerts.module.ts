import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module.js'
import { AlertsController } from './alerts.controller.js'
import { AlertDispositionsService } from './alert-dispositions.service.js'

/** The alert settings surface. Deliberately small: the intake pipeline is wired through
 * `AlertIntakeService` from the scheduled-sync path and is not exported here. */
@Module({
  imports: [PrismaModule],
  controllers: [AlertsController],
  providers: [AlertDispositionsService],
  exports: [AlertDispositionsService],
})
export class AlertsModule {}
