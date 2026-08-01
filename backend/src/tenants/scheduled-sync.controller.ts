import { Controller, Inject, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { Public } from '../auth/public.decorator.js'
import { SchedulerTokenVerifier } from './scheduler-token-verifier.service.js'
import { TenantSyncService } from './tenant-sync.service.js'

@Controller('api/internal/sync')
export class ScheduledSyncController {
  constructor(
    @Inject(SchedulerTokenVerifier)
    private readonly schedulerTokenVerifier: SchedulerTokenVerifier,
    @Inject(TenantSyncService)
    private readonly tenantSyncService: TenantSyncService
  ) {}

  @Public()
  @Post('due-tenants')
  async syncDueTenants(@Req() request: Request) {
    await this.schedulerTokenVerifier.verify(request.headers.authorization)
    return this.tenantSyncService.syncDueTenants()
  }
}
