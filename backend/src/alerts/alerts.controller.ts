import { Body, Controller, Get, Inject, Param, Patch, Query, Req } from '@nestjs/common'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { AlertDispositionsService } from './alert-dispositions.service.js'

/** The MSP-facing alert settings.
 *
 * NOT `@Public()`. Everything here is scoped to an organisation the caller is a member of, and
 * the service refuses one they are not — the same check `NotificationsService` makes, written the
 * same way so the two cannot drift into one of them not checking.
 *
 * NOTHING HERE SENDS ANYTHING. It reads and writes a preference; whether a preference is
 * consulted is `mapped`, and it is derived rather than claimed. */
@Controller('api/alerts')
export class AlertsController {
  constructor(
    @Inject(AlertDispositionsService)
    private readonly dispositions: AlertDispositionsService,
  ) {}

  @Get('dispositions')
  list(
    @Req() request: AuthenticatedRequest,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.dispositions.list(request.auth, organizationId)
  }

  @Patch('dispositions/:alertTypeId')
  set(
    @Req() request: AuthenticatedRequest,
    @Param('alertTypeId') alertTypeId: string,
    @Body() body: unknown,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.dispositions.set(request.auth, alertTypeId, body, organizationId)
  }
}
