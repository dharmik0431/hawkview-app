import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common'
import type { Response } from 'express'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { Public } from '../auth/public.decorator.js'
import { TenantsService } from './tenants.service.js'
import { TenantSyncService } from './tenant-sync.service.js'

@Controller('api/tenants')
export class TenantsController {
  constructor(
    @Inject(TenantsService)
    private readonly tenantsService: TenantsService,
    @Inject(TenantSyncService)
    private readonly tenantSyncService: TenantSyncService
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.tenantsService.listForIdentity(request.auth)
  }

  @Post()
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.tenantsService.createForIdentity(request.auth, body)
  }

  @Post('microsoft/onboarding')
  createMicrosoftOnboardingUrl(@Req() request: AuthenticatedRequest) {
    return this.tenantsService.createManagedOnboardingUrlForIdentity(
      request.auth
    )
  }

  @Get(':id')
  getTenantBundle(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string
  ) {
    return this.tenantSyncService.getBundleForIdentity(
      request.auth,
      customerTenantId
    )
  }

  @Post(':id/sync')
  syncTenantUsers(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string
  ) {
    return this.tenantSyncService.syncUsersForIdentity(
      request.auth,
      customerTenantId
    )
  }

  @Post(':id/verify-connection')
  verifyConnection(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string
  ) {
    return this.tenantsService.verifyConnectionForIdentity(
      request.auth,
      customerTenantId
    )
  }

  @Post(':id/microsoft-consent')
  createMicrosoftConsentUrl(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string
  ) {
    return this.tenantsService.createConsentUrlForIdentity(
      request.auth,
      customerTenantId
    )
  }

  @Delete(':id')
  removePendingTenant(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string,
    @Body() body: unknown
  ) {
    return this.tenantsService.removeTenantForIdentity(
      request.auth,
      customerTenantId,
      body
    )
  }

  @Public()
  @Get('microsoft/admin-consent/callback')
  async completeMicrosoftConsent(
    @Query() query: Record<string, unknown>,
    @Res() response: Response
  ) {
    const redirectUrl =
      await this.tenantsService.completeMicrosoftConsent(query)
    response.redirect(303, redirectUrl)
  }
}
