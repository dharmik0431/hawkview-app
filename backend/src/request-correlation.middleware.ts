import { randomUUID } from 'node:crypto'
import { Injectable, type NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'

export const REQUEST_ID_HEADER = 'X-Request-ID'

export interface CorrelatedRequest extends Request {
  requestId: string
}

@Injectable()
export class RequestCorrelationMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction) {
    // Always generate this value server-side. A caller-controlled identifier
    // must never be able to forge or collide with HawkView audit evidence.
    const requestId = randomUUID()
    ;(request as CorrelatedRequest).requestId = requestId
    response.setHeader(REQUEST_ID_HEADER, requestId)
    next()
  }
}
