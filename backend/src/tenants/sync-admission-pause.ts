import { ServiceUnavailableException } from '@nestjs/common'

const PAUSED_RESPONSE = {
  code: 'TENANT_SYNC_ADMISSION_PAUSED',
  message: 'Tenant synchronization is temporarily unavailable.',
} as const

export function syncAdmissionPaused(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HAWKVIEW_SYNC_ADMISSION_PAUSED === 'true'
}

/** Stops new tenant sync visits. It does not drain a visit already in progress. */
export function assertSyncAdmissionOpen(env: NodeJS.ProcessEnv = process.env): void {
  if (syncAdmissionPaused(env)) throw new ServiceUnavailableException(PAUSED_RESPONSE)
}
