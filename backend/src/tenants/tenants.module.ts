import { Module } from '@nestjs/common'
import { MicrosoftModule } from '../microsoft/microsoft.module.js'
import { TenantsController } from './tenants.controller.js'
import { TenantsService } from './tenants.service.js'
import { TenantSyncService } from './tenant-sync.service.js'

@Module({
  imports: [MicrosoftModule],
  controllers: [TenantsController],
  providers: [TenantsService, TenantSyncService],
})
export class TenantsModule {}
