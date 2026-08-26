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

    return true
  }
}
