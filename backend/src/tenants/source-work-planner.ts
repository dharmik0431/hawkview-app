/** Pure planning seam. No collector, persistence, lease, registry or fairness policy.
 * Times are integer Unix milliseconds. Callers supply complete candidate scope,
 * deadlines, costs and committed completion evidence, including empty checks.
 * Selection is advice, not a lease; dependencies must already be verified.
 */
export interface CompleteSourceCheck {
  /** Completion/commit time of the last successful check, never its start time. */
  checkedAt: number
  generation: string
  scope: string
}

export interface SourceAttempt {
  /** Start time of the latest attempt (existing lastAttemptAt semantics). */
  startedAt: number
  outcome: 'complete' | 'failed' | 'partial' | 'skipped' | 'running'
}

export interface SourceDependency {
  source: string
  scope: string
  requiredGeneration: string
  maxAgeMs: number
}

export interface SourceWorkInput {
  tenantId: string
  source: string
  scope: string
  lastComplete: CompleteSourceCheck | null
  lastAttempt: SourceAttempt | null
  retryNotBefore: number | null
  deadline: number
  maxAgeMs: number
  estimatedCost: number
  dependencies: readonly SourceDependency[]
}

export type WorkReason =
  | 'invalid_input' | 'duplicate_source' | 'missing_dependency'
  | 'dependency_invalid' | 'dependency_unverified' | 'dependency_stale'
  | 'dependency_scope_mismatch' | 'dependency_generation_mismatch' | 'dependency_cycle'
  | 'no_complete_check' | 'deadline_due' | 'failed' | 'partial' | 'skipped'
  | 'fresh' | 'running' | 'retry_not_before' | 'budget'

export interface WorkDecision {
  inputIndex: number
  tenantId: string
  source: string
  disposition: 'selected' | 'deferred' | 'blocked'
  reasons: WorkReason[]
  /** null means malformed input; never means a verified deadline. */
  dueAt: number | null
}

export interface SourceWorkPlan {
  selected: WorkDecision[]
  /** Exactly one decision per input, in original input order. */
  decisions: WorkDecision[]
  estimatedCost: number
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const positive = (value: unknown): value is number => time(value) && value > 0
const key = (tenant: string, source: string) => JSON.stringify([tenant, source])
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

function valid(work: SourceWorkInput, now: number): boolean {
  if (!text(work.tenantId) || !text(work.source) || !text(work.scope) ||
      !time(work.deadline) || !positive(work.maxAgeMs) || !positive(work.estimatedCost) ||
      (work.retryNotBefore !== null && !time(work.retryNotBefore))) return false
  const check = work.lastComplete
  if (check !== null && (!time(check.checkedAt) || check.checkedAt > now ||
      !text(check.generation) || check.scope !== work.scope ||
      !Number.isSafeInteger(check.checkedAt + work.maxAgeMs))) return false
  // Complete: startedAt <= checkedAt <= now. Other outcomes retain a prior
  // completion and must start at/after it; overlapping/out-of-order evidence blocks.
  // No terminal failure time is inferred from an attempt start.
  const attempt = work.lastAttempt
  if (attempt !== null && (!time(attempt.startedAt) || attempt.startedAt > now ||
      !['complete', 'failed', 'partial', 'skipped', 'running'].includes(attempt.outcome) ||
      (attempt.outcome === 'complete'
        ? (!check || attempt.startedAt > check.checkedAt)
        : (check !== null && attempt.startedAt < check.checkedAt)))) return false
  const seen = new Set<string>()
  for (const dependency of work.dependencies) {
    if (!text(dependency.source) || dependency.source === work.source ||
        !text(dependency.scope) || !text(dependency.requiredGeneration) ||
        !positive(dependency.maxAgeMs) || seen.has(dependency.source)) return false
    seen.add(dependency.source)
  }
  return true
}

/** A failed/partial/skipped/running attempt never substitutes for a complete check. */
function verified(work: SourceWorkInput): boolean {
  return work.lastComplete !== null &&
    (work.lastAttempt === null || work.lastAttempt.outcome === 'complete')
}

export function planSourceWork(
  work: readonly SourceWorkInput[],
  now: number,
  budget: { maxItems: number; maxEstimatedCost: number },
): SourceWorkPlan {
  if (!time(now) || !time(budget.maxItems) || !time(budget.maxEstimatedCost)) {
    throw new RangeError('Planning time and budgets must be nonnegative safe integers')
  }
  const byKey = new Map<string, number[]>()
  const validInputs = work.map(item => valid(item, now))
  work.forEach((item, index) => {
    const id = key(item.tenantId, item.source)
    const entries = byKey.get(id) ?? []
    entries.push(index)
    byKey.set(id, entries)
  })
  // Resolve the whole declared dependency graph, without recursive stack growth.
  // A cyclic prerequisite (including its dependents) cannot be certified here.
  const dependencyIssues: WorkReason[][] = work.map(() => [])
  const remaining = work.map(() => 0)
  const dependents: number[][] = work.map(() => [])
  work.forEach((item, index) => {
    if (!validInputs[index]) return
    for (const dependency of item.dependencies) {
      const indexes = byKey.get(key(item.tenantId, dependency.source))
      const issues = dependencyIssues[index]
      if (!indexes) { issues.push('missing_dependency'); continue }
      if (indexes.length !== 1 || !validInputs[indexes[0]]) {
        issues.push('dependency_invalid'); continue
      }
      const prerequisiteIndex = indexes[0]
      remaining[index]++
      dependents[prerequisiteIndex].push(index)
      const prerequisite = work[prerequisiteIndex]
      if (!verified(prerequisite)) { issues.push('dependency_unverified'); continue }
      const check = prerequisite.lastComplete!
      if (check.scope !== dependency.scope) issues.push('dependency_scope_mismatch')
      if (check.generation !== dependency.requiredGeneration) issues.push('dependency_generation_mismatch')
      if (now - check.checkedAt >= Math.min(dependency.maxAgeMs, prerequisite.maxAgeMs)) {
        issues.push('dependency_stale')
      }
    }
  })
  const ready = remaining.flatMap((count, index) => count === 0 ? [index] : [])
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const index = ready[cursor]
    for (const dependent of dependents[index]) {
      if (dependencyIssues[index].length) dependencyIssues[dependent].push('dependency_unverified')
      if (--remaining[dependent] === 0) ready.push(dependent)
    }
  }
  remaining.forEach((count, index) => { if (count > 0) dependencyIssues[index].push('dependency_cycle') })
  const eligible: WorkDecision[] = []
  const decisions = work.map((item, inputIndex): WorkDecision => {
    const decision: WorkDecision = {
      inputIndex, tenantId: item.tenantId, source: item.source,
      disposition: 'blocked', reasons: [], dueAt: null,
    }
    if (!validInputs[inputIndex]) {
      decision.reasons = ['invalid_input']
      return decision
    }
    if (byKey.get(key(item.tenantId, item.source))!.length !== 1) {
      decision.reasons = ['duplicate_source']
      return decision
    }
    decision.dueAt = item.lastComplete === null ? item.deadline :
      Math.min(item.deadline, item.lastComplete.checkedAt + item.maxAgeMs)
    if (item.lastAttempt?.outcome === 'running') {
      decision.disposition = 'deferred'
      decision.reasons = ['running']
      return decision
    }
    if (item.lastComplete === null) decision.reasons.push('no_complete_check')
    const outcome = item.lastAttempt?.outcome
    if (outcome === 'failed' || outcome === 'partial' || outcome === 'skipped') decision.reasons.push(outcome)
    if (decision.dueAt <= now) decision.reasons.push('deadline_due')
    const blockers = dependencyIssues[inputIndex]
    if (blockers.length) {
      decision.reasons.push(...new Set(blockers))
      return decision
    }
    if (decision.reasons.length === 0) {
      decision.disposition = 'deferred'
      decision.reasons = ['fresh']
      return decision
    }
    decision.disposition = 'deferred'
    if (item.retryNotBefore !== null && now < item.retryNotBefore) {
      decision.reasons.push('retry_not_before')
      return decision
    }
    eligible.push(decision)
    return decision
  })
  // Earliest deadline within supplied candidates; no starvation guarantee across calls.
  eligible.sort((a, b) => a.dueAt! - b.dueAt! || lexical(a.tenantId, b.tenantId) || lexical(a.source, b.source))
  const selected: WorkDecision[] = []
  let estimatedCost = 0
  for (const decision of eligible) {
    const cost = work[decision.inputIndex].estimatedCost
    if (selected.length >= budget.maxItems || cost > budget.maxEstimatedCost - estimatedCost) {
      decision.reasons.push('budget')
      continue
    }
    decision.disposition = 'selected'
    selected.push(decision)
    estimatedCost += cost
  }
  return { selected, decisions, estimatedCost }
}
