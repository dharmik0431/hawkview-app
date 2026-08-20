import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { WorkspaceService } from './workspace.service.js'

@Controller('api/workspace')
export class WorkspaceController {
  constructor(
    @Inject(WorkspaceService)
    private readonly workspaceService: WorkspaceService,
  ) {}

  @Post('onboarding')
  completeOrganizationOnboarding(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.workspaceService.completeOrganizationOnboarding(request.auth, body)
  }

  @Patch('organization')
  updateOrganization(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.workspaceService.updateOrganization(request.auth, body)
  }

  @Get('members')
  listMembers(
    @Req() request: AuthenticatedRequest,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.workspaceService.listMembers(request.auth, organizationId)
  }

  @Get('audit-logs')
  listAuditLogs(
    @Req() request: AuthenticatedRequest,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.workspaceService.listAuditLogs(request.auth, organizationId)
  }

  @Post('members/invite')
  inviteMember(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.workspaceService.inviteMember(request.auth, body)
  }

  @Patch('members/:membershipId')
  updateMember(
    @Req() request: AuthenticatedRequest,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
  ) {
    return this.workspaceService.updateMember(request.auth, membershipId, body)
  }

  @Delete('members/:membershipId')
  removeMember(
    @Req() request: AuthenticatedRequest,
    @Param('membershipId') membershipId: string,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.workspaceService.removeMember(
      request.auth,
      membershipId,
      organizationId,
    )
  }

  @Post('members/:membershipId/password-reset')
  sendPasswordReset(
    @Req() request: AuthenticatedRequest,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
  ) {
    return this.workspaceService.sendPasswordReset(
      request.auth,
      membershipId,
      body,
    )
  }

  @Post('members/:membershipId/mfa-reset')
  resetMfa(
    @Req() request: AuthenticatedRequest,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
  ) {
    return this.workspaceService.resetHawkViewMfa(
      request.auth,
      membershipId,
      body,
    )
  }
}
