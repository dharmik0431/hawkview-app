import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { SecurityRequirementsService } from './security-requirements.service.js'

@Controller('api/policies/workspaces/:organizationId/baselines')
export class BaselineLibraryController {
  constructor(
    @Inject(SecurityRequirementsService)
    private readonly service: SecurityRequirementsService
  ) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Query('page') page: string | undefined,
    @Query('search') search: string | undefined
  ) {
    return this.service.listLibrary(request.auth, organizationId, page, search)
  }

  @Get('tenant-choices')
  choices(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Query('page') page: string | undefined,
    @Query('search') search: string | undefined
  ) {
    return this.service.tenantChoices(
      request.auth,
      organizationId,
      page,
      search
    )
  }

  @Get(':baselineId')
  detail(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Param('baselineId') baselineId: string,
    @Query('page') page: string | undefined,
    @Query('search') search: string | undefined
  ) {
    return this.service.getLibraryDetail(
      request.auth,
      organizationId,
      baselineId,
      page,
      search
    )
  }

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown
  ) {
    return this.service.createInWorkspace(request.auth, organizationId, body)
  }

  @Patch(':baselineId')
  update(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Param('baselineId') baselineId: string,
    @Body() body: unknown
  ) {
    return this.service.updateInWorkspace(
      request.auth,
      organizationId,
      baselineId,
      body
    )
  }

  @Put(':baselineId/assignments/:tenantId')
  assign(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Param('baselineId') baselineId: string,
    @Param('tenantId') tenantId: string
  ) {
    return this.service.assignFromLibrary(
      request.auth,
      organizationId,
      baselineId,
      tenantId
    )
  }
}
