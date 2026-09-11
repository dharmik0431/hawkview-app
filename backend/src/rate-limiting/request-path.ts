import type { Request } from 'express'

/** The path the CALLER asked for, which is not always the path Express reports.
 *
 * THIS MODULE EXISTS BECAUSE THE OBVIOUS FIELD IS WRONG HERE, and getting it
 * wrong caused exactly the failure this component was added to avoid.
 *
 * Express strips a middleware's mount path from `request.url`, and `request.path`
 * is derived from `request.url`. A middleware registered with `forRoutes('*')` is
 * mounted on the wildcard, so the whole path is stripped and `request.path` is
 * `"/"` for every request — measured, in the assembled app:
 *
 *   GET  /health                       -> path="/"  originalUrl="/health"
 *   POST /api/internal/sync/due-tenants -> path="/"  originalUrl="/api/internal/sync/due-tenants"
 *
 * Keyed on that, no exemption can ever match: the scheduler heartbeat and the
 * health probes were both metered as ordinary traffic, every route shared one
 * bucket, and the heartbeat was refused after 120 requests. Every unit test
 * passed throughout, because a hand-written fixture sets `path` to the real path
 * — the fixture described the request we imagined rather than the one Express
 * delivers.
 *
 * `originalUrl` is assigned once, when the request enters the application, and is
 * never rewritten by mounting. It is the only field here that means what it says
 * at every layer, so both enforcement points read the path through this function
 * rather than reaching for `request.path` themselves.
 */
export function requestPath(request: Pick<Request, 'path' | 'url' | 'originalUrl'>): string {
  // In order of trustworthiness. `path` last, and only so that a caller passing a
  // bare object in a test still gets something sensible rather than an empty
  // string — never because it is a reliable source inside middleware.
  return request.originalUrl || request.url || request.path || '/'
}
