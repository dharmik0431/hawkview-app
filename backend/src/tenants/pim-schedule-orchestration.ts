import type { AuthorityDatabase } from '../microsoft/managed-connector-authority.js'
import { acquirePimSchedule, type PimTransport } from './pim-schedule-acquisition.js'
import { copyPimLimits, copyPimTenant, pimLifetime, pimPlane, pimVersion, type PimLimits } from './pim-schedule-contract.js'
import { capturePimAttempt, publishPimObservations, recordPimTerminalFailure, type PimCaptureRequest } from './pim-schedule-store.js'
import { authorizePimRead, readPimSchedulePlane, type PimReadAuthorization } from './pim-schedule-reader.js'

export interface PimCollectionRequest extends PimCaptureRequest { limits: PimLimits }
/** Integrated source entry point, deliberately not registered with any production dispatcher.
 * Requires an authenticated membership context, explicit finite policy and injected effects.
 * Retention, real grant assurance and production activation remain unresolved prerequisites. */
export async function collectAndReadPimSchedule(input: PimCollectionRequest, dependencies: {
  db: AuthorityDatabase; authorization: PimReadAuthorization; transport: PimTransport
}) {
  const snapshot = () => ({ ...copyPimTenant(input), plane: pimPlane(input.plane), scopeVersion: pimVersion(input.scopeVersion),
    attemptLifetimeMs: pimLifetime(input.attemptLifetimeMs), limits: copyPimLimits(input.limits) })
  const request = snapshot(), fingerprint = JSON.stringify(request)
  const unchanged = () => { try { return JSON.stringify(snapshot()) === fingerprint } catch { return false } }
  const { db, transport } = dependencies
  const auth = authorizePimRead(dependencies.authorization, request.customerTenantId)
  if (auth.organizationId !== request.organizationId) throw new Error('PIM_FORBIDDEN')
  const captured = await capturePimAttempt(db, request)
  if (captured.status === 'rejected') return { collection: captured, persisted: await readPimSchedulePlane(db, auth, request) }
  const { attempt, authority } = captured
  const result = await acquirePimSchedule(attempt, authority, request.limits, transport, unchanged)
  // Database failures propagate. An uncertain commit must never trigger a compensating failure write.
  const collection = result.status === 'exhausted'
    ? await publishPimObservations(db, attempt, result.prepared, request.limits)
    : await recordPimTerminalFailure(db, attempt, result.failure, request.limits)
  return { collection, persisted: await readPimSchedulePlane(db, auth, request) }
}
