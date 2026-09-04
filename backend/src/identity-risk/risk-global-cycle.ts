import type { PseudonymScope } from './identity-risk-pseudonym.js'
import type { RiskCycleLease } from './risk-global-work-store.js'
import { isGlobalRiskConfig, riskRuntimeConfig } from './risk-runtime-config.js'

export const RISK_GLOBAL_CYCLE_MS = 45_000
export const RISK_GLOBAL_CANDIDATE_LIMIT = 5
export const RISK_GLOBAL_ADMISSION_MS = 25_000

type Dependencies = {
  claimCycle: (deadline: number) => Promise<RiskCycleLease | null>
  nextScope: (lease: RiskCycleLease, deadline: number) => Promise<PseudonymScope | null>
  releaseCycle: (lease: RiskCycleLease, deadline: number) => Promise<void>
  recordAttempt: (scope: PseudonymScope, lease: RiskCycleLease, deadline: number) => Promise<void>
  ensure: (scope: PseudonymScope, deadline: number) => Promise<unknown>
  evaluate: (scope: PseudonymScope, deadline: number) => Promise<unknown>
  now?: () => number
}

/** Called within the existing memory lane, never queues or starts parallel work.
 * Lease/CAS excludes overlapping schedulers; a lost acknowledgement/crash cannot
 * reset progress. Timeouts are passed to actual DB/projector operations, not a
 * Promise.race that leaves abandoned background work running. */
export async function runGlobalRiskCycle(deps: Dependencies, requestDeadlineAt: number) {
  const now = deps.now ?? Date.now
  const deadline = Math.min(requestDeadlineAt, now() + RISK_GLOBAL_CYCLE_MS)
  if (!isGlobalRiskConfig(riskRuntimeConfig()) || deadline - now() < RISK_GLOBAL_ADMISSION_MS)
    return { status: 'DEFERRED' as const, attempted: 0, completed: 0, failed: 0 }
  const lease = await deps.claimCycle(Math.min(deadline, now() + 2_000))
  if (!lease) return { status: 'BUSY' as const, attempted: 0, completed: 0, failed: 0 }
  let attempted = 0; let completed = 0; let failed = 0
  try {
    while (attempted < RISK_GLOBAL_CANDIDATE_LIMIT && deadline - now() >= RISK_GLOBAL_ADMISSION_MS &&
      isGlobalRiskConfig(riskRuntimeConfig())) {
      const scope = await deps.nextScope(lease, Math.min(deadline, now() + 2_000))
      if (!scope) break
      attempted++
      try {
        await deps.recordAttempt(scope, lease, Math.min(deadline, now() + 2_000))
        await deps.ensure(scope, Math.min(deadline, now() + 4_000))
        // Reserve transaction/cleanup time after bounded source materialization.
        if (deadline - now() < 15_000) break
        await deps.evaluate(scope, deadline - 2_000)
        completed++
      } catch { failed++ }
    }
  } finally {
    // A failed release expires automatically; never hold the collector hostage.
    if (deadline - now() >= 100) {
      try { await deps.releaseCycle(lease, Math.min(deadline, now() + 1_000)) } catch { /* leased recovery */ }
    }
  }
  return { status: 'COMPLETED' as const, attempted, completed, failed }
}
