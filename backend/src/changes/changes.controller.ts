import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { ChangesService } from './changes.service.js'

@Controller('api/changes')
export class ChangesController {
  constructor(@Inject(ChangesService) private readonly changes: ChangesService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    return this.changes.list(request.auth, query)
  }

  @Get(':id')
  detail(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.changes.detail(request.auth, id)
  }
}
