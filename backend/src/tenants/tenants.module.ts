import { Module } from '@nestjs/common'
import { MicrosoftModule } from '../microsoft/microsoft.module.js'
import { TenantsController } from './tenants.controller.js'
import { TenantsService } from './tenants.service.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { ScheduledSyncController } from './scheduled-sync.controller.js'
import { SchedulerTokenVerifier } from './scheduler-token-verifier.service.js'
import { IpGeolocationService } from './ip-geolocation.service.js'
import { NotificationsModule } from '../notifications/notifications.module.js'
import { ChangesModule } from '../changes/changes.module.js'
import { M365ManagementActivityService } from './m365-management-activity.service.js'

@Module({
  imports: [MicrosoftModule, NotificationsModule, ChangesModule],
  controllers: [TenantsController, ScheduledSyncController],
  providers: [
    TenantsService,
    TenantSyncService,
    SchedulerTokenVerifier,
    IpGeolocationService,
    M365ManagementActivityService,
  ],
})
export class TenantsModule {}
