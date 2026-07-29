import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import type { AuthenticatedRequest } from './auth.types.js'
import { IdentityTokenVerifier } from './identity-token-verifier.service.js'
import { PUBLIC_ROUTE_KEY } from './public.decorator.js'

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

    return true
  }
}
