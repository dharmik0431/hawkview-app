import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import type { AuthenticatedRequest } from './auth.types.js'
import { IdentityTokenVerifier } from './identity-token-verifier.service.js'
import { PUBLIC_ROUTE_KEY } from './public.decorator.js'
import { ConsoleSessionService } from './console-session.service.js'
import { CONSOLE_SESSION_OPERATION, assertNoSessionOverrides, type ConsoleSessionOperation } from './console-session.controller.js'

export function hasRequiredAssurance(
  assuranceLevel: 'aal1' | 'aal2' | undefined,
  subject: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (assuranceLevel === 'aal2') return true
  if (environment.HAWKVIEW_CANARY_ENABLED?.trim().toLowerCase() !== 'true') {
    return false
  }
  return ['HAWKVIEW_CANARY_A_AUTH_USER_ID', 'HAWKVIEW_CANARY_B_AUTH_USER_ID']
    .map((key) => environment[key]?.trim().toLowerCase())
    .filter(Boolean)
    .includes(subject.toLowerCase())
}

@Injectable()
export class IdentityAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(IdentityTokenVerifier)
    private readonly verifier: IdentityTokenVerifier,
    @Inject(ConsoleSessionService)
    private readonly sessions: ConsoleSessionService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      PUBLIC_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    )

    if (isPublic) {
      return true
    }

    const request = context.switchToHttp().getRequest<Request>()
    const authorization = request.headers.authorization
    const match = authorization?.match(/^Bearer ([^\s]+)$/)

    if (!match) {
      throw new UnauthorizedException('A bearer token is required.')
    }

    const identity = await this.verifier.verify(match[1])
    ;(request as AuthenticatedRequest).auth = identity

    if (!hasRequiredAssurance(identity.assuranceLevel, identity.subject)) {
      throw new ForbiddenException(
        'Multi-factor authentication verification is required.',
      )
    }

    const operation = this.reflector.getAllAndOverride<ConsoleSessionOperation>(CONSOLE_SESSION_OPERATION,
      [context.getHandler(), context.getClass()])
    if (operation) assertNoSessionOverrides(request.body, request.query)
    if (operation === 'end') {
      // Still requires a valid verified JWT and the existing MFA policy. Only
      // this fixed endpoint may revoke an expired session instead of rejecting it.
      await this.sessions.end(identity)
    } else {
      ;(request as AuthenticatedRequest).consoleSession = operation === 'activity'
        ? await this.sessions.activity(identity) : await this.sessions.check(identity)
    }

    return true
  }
}
