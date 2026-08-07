import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { NotificationsService } from './notifications.service.js'

@Controller('api/notifications')
export class NotificationsController {
  constructor(
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Query() query: Record<string, string | undefined>) {
    return this.notifications.list(request.auth, query)
  }

  @Get('unread-count')
  unreadCount(@Req() request: AuthenticatedRequest) {
    return this.notifications.unreadCount(request.auth)
  }

  @Patch(':id/read')
  markRead(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.notifications.markRead(request.auth, id)
  }

  @Post('read-all')
  markAllRead(@Req() request: AuthenticatedRequest) {
    return this.notifications.markAllRead(request.auth)
  }

  @Delete('read')
  clearRead(@Req() request: AuthenticatedRequest) {
    return this.notifications.clearRead(request.auth)
  }

  @Patch(':id/dismiss')
  dismiss(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.notifications.dismiss(request.auth, id)
  }

  @Get('preferences')
  preferences(@Req() request: AuthenticatedRequest, @Query('organizationId') organizationId?: string) {
    return this.notifications.preferences(request.auth, organizationId)
  }

  @Patch('preferences')
  updatePreferences(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.notifications.updatePreferences(request.auth, body)
  }

}
