import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { NotificationsService } from './notifications.service.js'

@Controller('api/notifications')
export class NotificationsController {
  constructor(
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.notifications.list(request.auth)
  }

  @Post()
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.notifications.create(request.auth, body)
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
}
