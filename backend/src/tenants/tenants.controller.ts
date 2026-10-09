import {
  Body,
  ConflictException,
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
import {
  DIRECTORY_ROLE_EXPORT_FILENAME,
  assertNoExportInputs,
  buildDirectoryRoleExport,
} from './directory-role-export.js'

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

  @Get('microsoft/access-contract')
  getMicrosoftAccessContract() {
    return this.tenantsService.getMicrosoftAccessContract()
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

  @Get(':id/exchange/rules/related-audit')
  getRelatedExchangeRuleAudit(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string,
    @Query('mailboxUpn') mailboxUpn: string | undefined,
    @Query('ruleName') ruleName: string | undefined,
  ) {
    return this.tenantSyncService.getRelatedExchangeRuleAuditForIdentity(
      request.auth,
      customerTenantId,
      mailboxUpn,
      ruleName,
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

  @Get(':id/collection/directory-roles/control')
  getDirectoryRoleControl(@Req() request: AuthenticatedRequest, @Param('id') customerTenantId: string) {
    return this.tenantsService.getDirectoryRoleControlForIdentity(request.auth, customerTenantId)
  }

  @Post(':id/collection/directory-roles/control')
  setDirectoryRoleControl(@Req() request: AuthenticatedRequest, @Param('id') customerTenantId: string, @Body() body: unknown) {
    return this.tenantsService.setDirectoryRoleControlForIdentity(request.auth, customerTenantId, body)
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

  @Post(':id/exchange-readonly/consent')
  createExchangeReadOnlyConsentUrl(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string,
  ) {
    return this.tenantsService.createExchangeReadOnlyConsentUrlForIdentity(
      request.auth,
      customerTenantId,
    )
  }

  @Get(':id/exchange-readonly/setup')
  getExchangeReadOnlySetup(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string,
  ) {
    return this.tenantsService.getExchangeReadOnlySetupForIdentity(
      request.auth,
      customerTenantId,
    )
  }

  @Get(':id/onboarding')
  getTenantOnboarding(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string,
  ) {
    return this.tenantsService.getTenantOnboardingForIdentity(
      request.auth,
      customerTenantId,
    )
  }

  @Post(':id/onboarding/exchange-readonly/defer')
  deferExchangeReadOnly(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string,
  ) {
    return this.tenantsService.skipExchangeReadOnlyForIdentity(
      request.auth,
      customerTenantId,
    )
  }

  @Post(':id/onboarding/report-visibility/verify')
  verifyReportVisibility(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string,
  ) {
    return this.tenantsService.verifyReportVisibilityForIdentity(
      request.auth,
      customerTenantId,
    )
  }

  @Post(':id/onboarding/report-visibility/defer')
  deferReportVisibility(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string,
  ) {
    return this.tenantsService.deferReportVisibilityForIdentity(
      request.auth,
      customerTenantId,
    )
  }

  @Post(':id/onboarding/complete')
  completeTenantOnboarding(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string,
  ) {
    return this.tenantsService.completeTenantOnboardingForIdentity(
      request.auth,
      customerTenantId,
    )
  }

  @Post(':id/exchange-readonly/verify')
  async verifyExchangeReadOnly(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string,
  ) {
    await this.tenantsService.assertCanConfigureExchangeReadOnly(
      request.auth,
      customerTenantId,
    )
    return this.tenantSyncService.verifyExchangeReadOnlyForIdentity(
      request.auth,
      customerTenantId,
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

  @Get(':id/pim/schedules/:plane/summary')
  getPimScheduleSummary(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string,
    @Param('plane') plane: string,
    @Res({ passthrough: true }) response: Response
  ) {
    response.setHeader('Cache-Control', 'no-store')
    return this.tenantsService.getPimScheduleSummaryForIdentity(
      request.auth,
      customerTenantId,
      plane
    )
  }

  @Get(':id/directory-roles/results')
  getDirectoryRoleResults(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string,
    @Res({ passthrough: true }) response: Response
  ) {
    response.setHeader('Cache-Control', 'no-store')
    return this.tenantsService.getDirectoryRoleResultsForIdentity(
      request.auth,
      customerTenantId
    )
  }

  /** Derived export of the already-admitted projection. The tenant read
   *  entitlement is exactly the results route's: the same service call, which
   *  completes accessible-organisation and nondisclosing tenant authorization
   *  before any payload is read. No admin-only policy and no broader access. */
  @Get(':id/directory-roles/export')
  async exportDirectoryRoles(
    @Req() request: AuthenticatedRequest,
    @Param('id') customerTenantId: string,
    @Res({ passthrough: true }) response: Response
  ) {
    assertNoExportInputs(request.body, request.query)
    const results = await this.tenantsService.getDirectoryRoleResultsForIdentity(
      request.auth,
      customerTenantId
    )
    const outcome = buildDirectoryRoleExport({
      results,
      customerTenantId,
      generatedAt: new Date(),
    })
    if (!outcome.ok) {
      // A refusal is returned as a refusal: finite code, no attachment headers
      // and no downloadable error file to be mistaken for data.
      throw new ConflictException({ statusCode: 409, code: outcome.code, refusal: outcome.refusal })
    }
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${DIRECTORY_ROLE_EXPORT_FILENAME}"`
    )
    return outcome.envelope
  }
}
