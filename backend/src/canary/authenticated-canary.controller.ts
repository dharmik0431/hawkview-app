import { Body, Controller, Header, Inject, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { Public } from '../auth/public.decorator.js'
import { AuthenticatedCanaryService } from './authenticated-canary.service.js'

@Public()
@Controller('api/internal/canary')
export class AuthenticatedCanaryController {
  constructor(
    @Inject(AuthenticatedCanaryService)
    private readonly canary: AuthenticatedCanaryService,
  ) {}

  @Post('sessions')
  @Header('Cache-Control', 'private, no-store')
  issueSessions(@Req() request: Request, @Body() body: unknown) {
    return this.canary.issueSessions(request.headers.authorization, body)
  }
}
