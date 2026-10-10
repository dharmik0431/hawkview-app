import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common'
import type { Response } from 'express'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { ChangesService } from './changes.service.js'
import { assertNoExportExtras } from './directory-audit-export.js'

@Controller('api/changes')
export class ChangesController {
  constructor(@Inject(ChangesService) private readonly changes: ChangesService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    return this.changes.list(request.auth, query)
  }

  /** Declared BEFORE `:id`: Nest matches in declaration order, so the parameter
   *  route would otherwise capture the literal `export`. */
  @Get('export')
  async exportDirectoryAudit(
    @Req() request: AuthenticatedRequest,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    assertNoExportExtras(request, query)
    const { envelope, filename } = await this.changes.exportDirectoryAudit(
      request.auth,
      query.tenantId,
      query.since,
      query.until,
    )
    // Headers are set only after every guard has passed, so a refusal never
    // announces an attachment.
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return envelope
  }

  @Get(':id')
  detail(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('tenantId') tenantId: string | undefined,
  ) {
    return this.changes.detail(request.auth, id, tenantId)
  }
}
