import { Controller, Get, Inject, Query, Req } from '@nestjs/common'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { ChangesService } from './changes.service.js'

@Controller('api/changes')
export class ChangesController {
  constructor(@Inject(ChangesService) private readonly changes: ChangesService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    return this.changes.list(request.auth, query)
  }
}
