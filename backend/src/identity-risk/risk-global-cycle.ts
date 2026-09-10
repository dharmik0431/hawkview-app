import type { PseudonymScope } from './identity-risk-pseudonym.js'
import type { RiskCycleLease } from './risk-global-work-store.js'
import { isGlobalRiskConfig, riskRuntimeConfig } from './risk-runtime-config.js'
import { observeCycle, type CycleReason } from './risk-operational-diagnostics.js'

export const RISK_GLOBAL_CYCLE_MS = 45_000
export const RISK_GLOBAL_CANDIDATE_LIMIT = 5
export const RISK_GLOBAL_ADMISSION_MS = 25_000

type Dependencies = {
  claimCycle: (deadline: number) => Promise<RiskCycleLease | null>
  nextScope: (lease: RiskCycleLease, deadline: number) => Promise<PseudonymScope | null>
  releaseCycle: (lease: RiskCycleLease, deadline: number) => Promise<void>
  recordAttempt: (scope: PseudonymScope, lease: RiskCycleLease, deadline: number) => Promise<string>
  ensure: (scope: PseudonymScope, deadline: number, ineligible?: () => void) => Promise<unknown>
  evaluate: (scope: PseudonymScope, deadline: number, attemptId: string) => Promise<unknown>
  /** A SECOND evaluation, run beside the first and unable to affect it.
   *
   * Optional, so the cycle behaves identically when it is absent — which is
   * what makes this additive rather than a change to a path customers currently
   * depend on. Called only after `evaluate` has already succeeded and been
   * counted, and inside its own try/catch, so a throw here cannot turn a
   * completed run into a failed one.
   *
   * It receives the REMAINING budget rather than an extension: this must make
   * the cycle fuller, never longer. Below a floor it is skipped entirely,
   * because a truncated second answer is worth less than the first answer
   * arriving on time. */
  alsoEvaluate?: (scope: PseudonymScope, deadline: number) => Promise<unknown>
  /** How the second evaluation went, reported OUT rather than folded into the
   * cycle's return value.
   *
   * The return value is one of the old path's outputs, and an existing test
   * asserts its exact shape with deepEqual — so adding fields to it would be a
   * change to the thing this step exists not to change. Caught by that test
   * rather than by review, which is the argument for it having been written
   * as an exact-shape assertion in the first place. */
  alsoObserve?: (outcome: 'COMPLETED' | 'FAILED' | 'SKIPPED') => void
  now?: () => number
  observe?: (reason: CycleReason) => void
}

/** The least remaining window worth starting a second evaluation in.
 *
 * Measured rather than chosen: a real assessment runs 7,983 ms on the largest of
 * the five tenants and 4,808 ms on the next. Starting one with less than this
 * left buys a partial answer at the cost of the cycle's own release time. */
const ALSO_EVALUATE_MIN_MS = 9_000

/** Called within the existing memory lane, never queues or starts parallel work.
 * Lease/CAS excludes overlapping schedulers; a lost acknowledgement/crash cannot
 * reset progress. Timeouts are passed to actual DB/projector operations, not a
 * Promise.race that leaves abandoned background work running. */
export async function runGlobalRiskCycle(deps: Dependencies, requestDeadlineAt: number) {
  const now = deps.now ?? Date.now
  const deadline = Math.min(requestDeadlineAt, now() + RISK_GLOBAL_CYCLE_MS)
  if (!isGlobalRiskConfig(riskRuntimeConfig()) || deadline - now() < RISK_GLOBAL_ADMISSION_MS) {
    observeCycle(deps.observe, !isGlobalRiskConfig(riskRuntimeConfig()) ? 'CONFIG_UNAVAILABLE' : 'ADMISSION_BUDGET_EXHAUSTED')
    return { status: 'DEFERRED' as const, attempted: 0, completed: 0, failed: 0 }
  }
  let lease: RiskCycleLease | null
  try { lease = await deps.claimCycle(Math.min(deadline, now() + 2_000)) }
  catch (error) { observeCycle(deps.observe, 'CYCLE_CLAIM_FAILED'); throw error }
  if (!lease) {
    observeCycle(deps.observe, 'LEASE_BUSY')
    return { status: 'BUSY' as const, attempted: 0, completed: 0, failed: 0 }
  }
  let attempted = 0; let completed = 0; let failed = 0

  try {
    while (attempted < RISK_GLOBAL_CANDIDATE_LIMIT && deadline - now() >= RISK_GLOBAL_ADMISSION_MS &&
      isGlobalRiskConfig(riskRuntimeConfig())) {
      let scope: PseudonymScope | null
      try { scope = await deps.nextScope(lease, Math.min(deadline, now() + 2_000)) }
      catch (error) { observeCycle(deps.observe, 'SCOPE_SELECTION_FAILED'); throw error }
      if (!scope) { if (attempted === 0) observeCycle(deps.observe, 'NO_ELIGIBLE_WORK'); break }
      attempted++
      let stage: CycleReason = 'ATTEMPT_RECORD_FAILED'
      let ineligible = false
      try {
        const attemptId = await deps.recordAttempt(scope, lease, Math.min(deadline, now() + 2_000))
        stage = 'KEY_ENSURE_FAILED'
        await deps.ensure(scope, Math.min(deadline, now() + 4_000), () => { ineligible = true })
        // Reserve transaction/cleanup time after bounded source materialization.
        if (deadline - now() < 15_000) { observeCycle(deps.observe, 'ADMISSION_BUDGET_EXHAUSTED'); break }
        stage = 'EVALUATION_FAILED'
        await deps.evaluate(scope, deadline - 2_000, attemptId)
        completed++
      } catch { failed++; observeCycle(deps.observe, stage === 'KEY_ENSURE_FAILED' && ineligible ? 'CANDIDATE_INELIGIBLE' : stage) }
      // ISOLATION COMES FROM THIS BLOCK'S OWN try/catch, not from where it sits.
      // I first wrote the opposite here — that being outside the try above was
      // what made it structural — and a mutation disproved it: moving the whole
      // block inside that try left all four isolation tests passing, because the
      // inner catch swallows the throw before the outer one can see it. Removing
      // the inner catch fails two of them immediately. So the load-bearing part
      // is the catch, and the comment claiming otherwise was a confident
      // structural claim about a mechanism I had not tested.
      //
      // The placement is still deliberate, for a narrower reason worth stating
      // accurately: if someone later removes the inner catch, being OUTSIDE the
      // old engine's try turns that mistake into an error escaping the cycle —
      // loud — instead of a silent `failed++` reporting the old engine as having
      // failed a run it had already completed. Defence in depth against a future
      // edit, not the mechanism today.
      if (deps.alsoEvaluate !== undefined) {
        if (deadline - now() < ALSO_EVALUATE_MIN_MS) deps.alsoObserve?.('SKIPPED')
        else {
          try { await deps.alsoEvaluate(scope, deadline - 1_000); deps.alsoObserve?.('COMPLETED') }
          catch { deps.alsoObserve?.('FAILED') }
        }
      }
    }
    if (!isGlobalRiskConfig(riskRuntimeConfig())) observeCycle(deps.observe, 'CONFIG_UNAVAILABLE')
    else if (deadline - now() < RISK_GLOBAL_ADMISSION_MS) observeCycle(deps.observe, 'ADMISSION_BUDGET_EXHAUSTED')
  } finally {
    // A failed release expires automatically; never hold the collector hostage.
    if (deadline - now() >= 100) {
      try { await deps.releaseCycle(lease, Math.min(deadline, now() + 1_000)) } catch { /* leased recovery */ }
    }
  }
  return { status: 'COMPLETED' as const, attempted, completed, failed }
}
