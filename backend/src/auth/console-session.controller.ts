import { BadRequestException, Controller, Get, Header, HttpCode, Inject, Post, Req, SetMetadata } from '@nestjs/common'
import type { AuthenticatedRequest } from './auth.types.js'
import { ConsoleSessionService } from './console-session.service.js'

export const CONSOLE_SESSION_OPERATION = 'hawkview:console-session-operation'
export type ConsoleSessionOperation = 'read' | 'activity' | 'end'
export function assertNoSessionOverrides(body: unknown, query: unknown) {
  const empty = (value: unknown) => value === undefined || value === null ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
  if (!empty(body) || !empty(query)) throw new BadRequestException('Session endpoints do not accept body or query parameters.')
}

/** The global guard verifies JWT/MFA, validates input and performs the selected
 * operation atomically. Metadata is server-owned; URL/body claims cannot select it. */
@Controller('auth/session')
export class ConsoleSessionController {
  constructor(@Inject(ConsoleSessionService) private readonly sessions: ConsoleSessionService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @SetMetadata(CONSOLE_SESSION_OPERATION, 'read')
  status(@Req() request: AuthenticatedRequest) { return request.consoleSession }

  /** Self-only recorded session history for the verified caller.
   *
   * Carries the existing `read` metadata, so the guard performs its JWT, MFA and
   * current-session checks — and rejects body or query overrides — before this
   * handler runs. The subject comes from the verified `request.auth`; there is no
   * identity parameter to supply, so there is nothing to override. */
  @Get('history')
  @Header('Cache-Control', 'no-store')
  @SetMetadata(CONSOLE_SESSION_OPERATION, 'read')
  history(@Req() request: AuthenticatedRequest) { return this.sessions.history(request.auth) }

  @Post('activity')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @SetMetadata(CONSOLE_SESSION_OPERATION, 'activity')
  activity(@Req() request: AuthenticatedRequest) { return request.consoleSession }

  @Post('end')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @SetMetadata(CONSOLE_SESSION_OPERATION, 'end')
  end() { return { ended: true } }
}
