import { Module } from '@nestjs/common'
import { MicrosoftModule } from '../microsoft/microsoft.module.js'
import { TenantsController } from './tenants.controller.js'
import { TenantsService } from './tenants.service.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { ScheduledSyncController } from './scheduled-sync.controller.js'
import { SchedulerTokenVerifier } from './scheduler-token-verifier.service.js'
import { IpGeolocationService } from './ip-geolocation.service.js'

@Module({
  imports: [MicrosoftModule],
  controllers: [TenantsController, ScheduledSyncController],
  providers: [
    TenantsService,
    TenantSyncService,
    SchedulerTokenVerifier,
    IpGeolocationService,
  ],
})
export class TenantsModule {}
