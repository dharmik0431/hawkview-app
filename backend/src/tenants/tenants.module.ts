import { Module } from '@nestjs/common'
import { MicrosoftModule } from '../microsoft/microsoft.module.js'
import { TenantsController } from './tenants.controller.js'
import { TenantsService } from './tenants.service.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { ScheduledSyncController } from './scheduled-sync.controller.js'
import { AlertIntakeService } from '../alerts/alert-intake.service.js'
import { EmailAlertReleaseService } from '../alerts/email-alert-release.service.js'
import { SchedulerTokenVerifier } from './scheduler-token-verifier.service.js'
import { IpGeolocationService } from './ip-geolocation.service.js'
import { NotificationsModule } from '../notifications/notifications.module.js'
import { ChangesModule } from '../changes/changes.module.js'
import { M365ManagementActivityService } from './m365-management-activity.service.js'
import { IdentityRiskModule } from '../identity-risk/identity-risk.module.js'
import { SecurityRequirementsController } from '../security-requirements/security-requirements.controller.js'
import { SecurityRequirementsService } from '../security-requirements/security-requirements.service.js'
import { BaselineLibraryController } from '../security-requirements/baseline-library.controller.js'

@Module({
  imports: [
    MicrosoftModule,
    NotificationsModule,
    ChangesModule,
    IdentityRiskModule,
  ],
  controllers: [TenantsController, ScheduledSyncController, SecurityRequirementsController, BaselineLibraryController],
  providers: [
    AlertIntakeService,
    EmailAlertReleaseService,
    TenantsService,
    TenantSyncService,
    SchedulerTokenVerifier,
    IpGeolocationService,
    M365ManagementActivityService,
    SecurityRequirementsService,
  ],
})
export class TenantsModule {}
