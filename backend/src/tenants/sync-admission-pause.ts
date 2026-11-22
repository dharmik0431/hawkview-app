import { Logger, ServiceUnavailableException } from '@nestjs/common'

const PAUSED_RESPONSE = {
  code: 'TENANT_SYNC_ADMISSION_PAUSED',
  message: 'Tenant synchronization is temporarily unavailable.',
} as const

/** The positive API-side witness for a refused admission. The gate receives no
 * tenant, caller or request argument, so this payload is a fixed constant and
 * cannot carry an identifier, secret or response body by construction. Info
 * level: a refusal is an intended operational state, not a fault, and the
 * scheduled path already fails visibly while the pause is in force. */
const PAUSED_REFUSAL_EVENT = JSON.stringify({
  event: 'tenant_sync_admission',
  outcome: 'REFUSED',
  reasonCode: PAUSED_RESPONSE.code,
})

const logger = new Logger('SyncAdmissionPause')

export function syncAdmissionPaused(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HAWKVIEW_SYNC_ADMISSION_PAUSED === 'true'
}

/** Stops new tenant sync visits. It does not drain a visit already in progress. */
export function assertSyncAdmissionOpen(env: NodeJS.ProcessEnv = process.env): void {
  if (!syncAdmissionPaused(env)) return
  // Observability does not control admission: a logging failure must not admit
  // a paused visit, alter the response, or replace this refusal with a
  // different error.
  try { logger.log(PAUSED_REFUSAL_EVENT) } catch { /* the refusal still stands */ }
  throw new ServiceUnavailableException(PAUSED_RESPONSE)
}
