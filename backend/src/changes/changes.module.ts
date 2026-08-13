import { Module } from '@nestjs/common'
import { ChangesController } from './changes.controller.js'
import { ChangesService } from './changes.service.js'
import { ChangeEvidenceService } from './change-evidence.service.js'

@Module({
  controllers: [ChangesController],
  providers: [ChangesService, ChangeEvidenceService],
  exports: [ChangeEvidenceService],
})
export class ChangesModule {}
