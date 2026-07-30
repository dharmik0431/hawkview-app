import { Module } from '@nestjs/common'
import { MicrosoftConsentService } from './microsoft-consent.service.js'

@Module({
  providers: [MicrosoftConsentService],
  exports: [MicrosoftConsentService],
})
export class MicrosoftModule {}
