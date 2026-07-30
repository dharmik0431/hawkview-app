import { Module } from '@nestjs/common'
import { MicrosoftConsentService } from './microsoft-consent.service.js'
import { SecretsModule } from '../secrets/secrets.module.js'
import { MicrosoftConnectorController } from './microsoft-connector.controller.js'

@Module({
  imports: [SecretsModule],
  controllers: [MicrosoftConnectorController],
  providers: [MicrosoftConsentService],
  exports: [MicrosoftConsentService],
})
export class MicrosoftModule {}
