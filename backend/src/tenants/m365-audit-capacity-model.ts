/**
 * HAW-75 three-tenant capacity model — PURE ARITHMETIC, INTENTIONALLY UNUSED.
 *
 * Nothing in production imports this file, and nothing should until the writer
 * integration below is designed, reviewed and proved. It exists so the reviewed
 * admission contract has a testable boundary; it is NOT an admission writer.
 *
 * What it does: given a caller-supplied snapshot of eligibility, all recorded
 * usage, the exact effective ceilings and a per-axis increment, it reports what
 * the reviewed contract WOULD decide, and why.
 *
 * What it deliberately does not do: read any environment variable, clock,
 * network, file, Prisma client, database, provider, scheduler or credential; it
 * has no imports at all. A snapshot handed to this function is only as good as
 * the caller's own read — it is NOT evidence of a serialized or trustworthy
 * production snapshot, and this model cannot make it one.
 *
 * Unresolved before any activation (each needs its own review and registered
 * physical proof):
 *   - an authoritative cohort snapshot and the transaction/ordering rule that
 *     the tenant/connection status writers participate in. Today those writers
 *     take no budget lock (`tenants.service.ts:1243-1257`), byte reservations
 *     open their own transaction with no owner/lease locks
 *     (`m365-management-activity.service.ts:1088-1096`), the accepted-record
 *     charge holds owner locks only when an owner is supplied (`:1456-1457`),
 *     and refunds are standalone guarded decrements (`:1214-1229`).
 *   - fair treatment of unfunded residual capacity in UNPROMISED mode;
 *   - cap-legal but share-exceeding indivisible blobs (800 records vs a 666
 *     share) and hard-cap-infeasible blobs (1,500 records vs a 1,000 cap);
 *   - cohorts larger than this model's supported domain.
 *
 * This model establishes no fair admission, scheduling progress, fleet size,
 * 20-minute freshness, cost saving or Baseline completion.
 *
 * Arithmetic is `bigint` throughout so byte counts beyond
 * Number.MAX_SAFE_INTEGER are exact. Record counts are `bigint` too, for one
 * uniform rule; callers convert.
 */

/**
 * The eight existing comparisons, in the exact refusal precedence the released
 * collector uses (`sync-outcome-projection.ts:49-58`): monthly before daily,
 * and within each period tenant-bytes, deployment-bytes, tenant-records,
 * deployment-records. Iterating this frozen list — never object keys — is what
 * keeps monthly-over-daily precedence independent of property order.
 */
export const M365_CAPACITY_CONSTRAINTS = Object.freeze([
  'monthly_tenant_bytes',
  'monthly_deployment_bytes',
  'monthly_tenant_records',
  'monthly_deployment_records',
  'daily_tenant_bytes',
  'daily_deployment_bytes',
  'daily_tenant_records',
  'daily_deployment_records',
] as const)
export type M365CapacityConstraint = (typeof M365_CAPACITY_CONSTRAINTS)[number]

/** One consumed axis: a period crossed with a quantity. Same order as above. */
export const M365_CAPACITY_AXES = Object.freeze([
  'monthly_bytes',
  'monthly_records',
  'daily_bytes',
  'daily_records',
] as const)
export type M365CapacityAxis = (typeof M365_CAPACITY_AXES)[number]

/** Which monthly axis bounds each daily axis, for the day <= month invariant. */
const ENCLOSING_MONTH_AXIS = Object.freeze({
  daily_bytes: 'monthly_bytes',
  daily_records: 'monthly_records',
} as const)

const CONSTRAINT_OF = Object.freeze({
  monthly_bytes: { tenant: 'monthly_tenant_bytes', deployment: 'monthly_deployment_bytes' },
  monthly_records: { tenant: 'monthly_tenant_records', deployment: 'monthly_deployment_records' },
  daily_bytes: { tenant: 'daily_tenant_bytes', deployment: 'daily_deployment_bytes' },
  daily_records: { tenant: 'daily_tenant_records', deployment: 'daily_deployment_records' },
} as const)

/**
 * The largest cohort this model answers for. The reviewed design only supports
 * equal shares while the share can still hold one maximum-size blob, which the
 * default daily byte ceilings stop doing at eleven tenants. Beyond this the
 * answer is UNSUPPORTED rather than a number nobody reviewed.
 */
export const M365_CAPACITY_MAX_COHORT = 10

export type M365CapacityCeilings = {
  readonly tenantCeiling: bigint
  readonly deploymentCeiling: bigint
}

export type M365CapacitySnapshot = {
  /** The declared eligible cohort. Membership is never inferred from spend, so
   *  an enrolled but idle tenant must appear here with zero usage. */
  readonly eligible: readonly string[]
  /** Who is asking. Must be a declared member. */
  readonly actor: string
  /** Exact effective ceilings per axis. The caller resolves overrides. */
  readonly ceilings: Readonly<Record<M365CapacityAxis, M365CapacityCeilings>>
  /** Recorded usage for each eligible tenant, per axis. */
  readonly eligibleUsage: Readonly<Record<M365CapacityAxis, Readonly<Record<string, bigint>>>>
  /** All other recorded usage on that axis: tenants outside the cohort, and
   *  reservations still in flight. */
  readonly outsideUsage: Readonly<Record<M365CapacityAxis, bigint>>
  /** The caller's authoritative global figure, matching the released unfiltered
   *  aggregates. It must equal the eligible sum plus outside usage; a mismatch
   *  is rejected rather than reconciled, which is how double counting and
   *  omission are caught instead of inventing capacity. */
  readonly recordedDeploymentTotal: Readonly<Record<M365CapacityAxis, bigint>>
  /** The indivisible increment under consideration. Zero is meaningful. */
  readonly increment: Readonly<Record<M365CapacityAxis, bigint>>
}

export type M365CapacityMode = 'PROTECTED' | 'UNPROMISED'

export type M365CapacityAxisOutcome = {
  readonly axis: M365CapacityAxis
  readonly cohortSize: number
  readonly share: bigint
  readonly actorUsage: bigint
  readonly actorOwed: bigint
  readonly otherOwed: bigint
  readonly totalOwed: bigint
  /** All recorded usage on this axis (the authoritative global figure). */
  readonly recordedTotal: bigint
  /** Fundability of the whole promise: recordedTotal + totalOwed. */
  readonly fundability: bigint
  readonly mode: M365CapacityMode
  readonly tenantHardCapOk: boolean
  readonly deploymentHardCapOk: boolean
  readonly hardCapsOk: boolean
  /** Raw fairness arithmetic. May be negative; it is not itself a decision. */
  readonly fairnessAdmissible: bigint
  readonly fairnessApplied: boolean
  readonly fairnessOk: boolean
  readonly admitted: boolean
  readonly basis:
    | 'hard cap exceeded'
    | 'zero increment: fairness not applied'
    | 'hard caps only: axis is UNPROMISED'
    | 'fairness remainder exceeded'
    | 'hard caps and fairness remainder'
}

export type M365CapacityRefusal =
  | { readonly kind: 'HARD_CAP'; readonly constraint: M365CapacityConstraint; readonly axis: M365CapacityAxis }
  | { readonly kind: 'FAIRNESS'; readonly axis: M365CapacityAxis }

export type M365CapacityRejection =
  | 'EMPTY_COHORT'
  | 'COHORT_TOO_LARGE'
  | 'DUPLICATE_MEMBER'
  | 'BLANK_MEMBER'
  | 'ACTOR_OUTSIDE_COHORT'
  | 'MISSING_AXIS'
  | 'MISSING_TENANT_USAGE'
  | 'UNKNOWN_USAGE_TENANT'
  | 'NON_INTEGER_VALUE'
  | 'NEGATIVE_VALUE'
  | 'NON_POSITIVE_CEILING'
  | 'AGGREGATE_MISMATCH'
  | 'PERIOD_USAGE_INVERTED'

export type M365CapacityResult =
  | {
      readonly kind: 'DECIDED'
      readonly admitted: boolean
      /** The first refusal in released precedence: every hard cap, in the order
       *  of M365_CAPACITY_CONSTRAINTS, before any fairness refusal. */
      readonly refusal: M365CapacityRefusal | null
      readonly axes: Readonly<Record<M365CapacityAxis, M365CapacityAxisOutcome>>
    }
  | { readonly kind: 'INVALID'; readonly reason: M365CapacityRejection; readonly detail: string }
  | { readonly kind: 'UNSUPPORTED'; readonly reason: M365CapacityRejection; readonly detail: string }

function invalid(reason: M365CapacityRejection, detail: string): M365CapacityResult {
  return { kind: 'INVALID', reason, detail }
}

function isNonNegativeBigInt(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n
}

/** Every rejection the snapshot can earn, or null when it is in the domain. */
function rejectSnapshot(snapshot: M365CapacitySnapshot): M365CapacityResult | null {
  const { eligible, actor } = snapshot
  if (!Array.isArray(eligible) || eligible.length === 0) {
    return invalid('EMPTY_COHORT', 'the eligible cohort must name at least one tenant')
  }
  if (eligible.length > M365_CAPACITY_MAX_COHORT) {
    return {
      kind: 'UNSUPPORTED',
      reason: 'COHORT_TOO_LARGE',
      detail: `this model answers for at most ${M365_CAPACITY_MAX_COHORT} eligible tenants; `
        + `${eligible.length} were declared`,
    }
  }
  for (const id of eligible) {
    if (typeof id !== 'string' || id.length === 0) {
      return invalid('BLANK_MEMBER', 'every eligible tenant id must be a non-empty string')
    }
  }
  if (new Set(eligible).size !== eligible.length) {
    return invalid('DUPLICATE_MEMBER', 'the eligible cohort lists the same tenant more than once')
  }
  if (!eligible.includes(actor)) {
    return invalid('ACTOR_OUTSIDE_COHORT',
      'the acting tenant is not a declared member, so it is owed no share and cannot be decided here')
  }
  for (const axis of M365_CAPACITY_AXES) {
    const ceilings = snapshot.ceilings?.[axis]
    const usage = snapshot.eligibleUsage?.[axis]
    const outside = snapshot.outsideUsage?.[axis]
    const total = snapshot.recordedDeploymentTotal?.[axis]
    const increment = snapshot.increment?.[axis]
    if (!ceilings || !usage || outside === undefined || total === undefined || increment === undefined) {
      return invalid('MISSING_AXIS', `axis ${axis} is not fully specified; no axis may be omitted`)
    }
    for (const [label, value] of [
      ['tenantCeiling', ceilings.tenantCeiling],
      ['deploymentCeiling', ceilings.deploymentCeiling],
      ['outsideUsage', outside],
      ['recordedDeploymentTotal', total],
      ['increment', increment],
    ] as const) {
      if (typeof value !== 'bigint') {
        return invalid('NON_INTEGER_VALUE', `${axis}.${label} must be a bigint`)
      }
      if (value < 0n) {
        return invalid('NEGATIVE_VALUE', `${axis}.${label} is negative`)
      }
    }
    if (ceilings.tenantCeiling <= 0n || ceilings.deploymentCeiling <= 0n) {
      return invalid('NON_POSITIVE_CEILING', `${axis} ceilings must both be positive`)
    }
    for (const id of Object.keys(usage)) {
      if (!eligible.includes(id)) {
        return invalid('UNKNOWN_USAGE_TENANT',
          `${axis} usage names ${id}, which is not a declared member; membership is never inferred from spend`)
      }
    }
    let eligibleSum = 0n
    for (const id of eligible) {
      const used = usage[id]
      if (used === undefined) {
        return invalid('MISSING_TENANT_USAGE',
          `${axis} has no usage for declared member ${id}; an idle member must appear with zero`)
      }
      if (!isNonNegativeBigInt(used)) {
        return invalid(typeof used === 'bigint' ? 'NEGATIVE_VALUE' : 'NON_INTEGER_VALUE',
          `${axis} usage for ${id} must be a non-negative bigint`)
      }
      eligibleSum += used
    }
    if (eligibleSum + outside !== total) {
      return invalid('AGGREGATE_MISMATCH',
        `${axis} recordedDeploymentTotal ${total} does not equal eligible ${eligibleSum} plus outside `
        + `${outside}; the caller's figures disagree, so capacity would have to be invented`)
    }
  }
  // Same-period coherence: a day's usage is inside its month, so the monthly
  // aggregate can never be smaller -- per tenant, for outside spend, and
  // globally. A violated snapshot is impossible, not merely unusual.
  for (const dayAxis of ['daily_bytes', 'daily_records'] as const) {
    const monthAxis = ENCLOSING_MONTH_AXIS[dayAxis]
    for (const id of snapshot.eligible) {
      const day = snapshot.eligibleUsage[dayAxis][id]!
      const month = snapshot.eligibleUsage[monthAxis][id]!
      if (day > month) {
        return invalid('PERIOD_USAGE_INVERTED',
          `${dayAxis} usage for ${id} (${day}) exceeds its ${monthAxis} usage (${month}); `
          + 'the day lies inside the month, so this state is unreachable')
      }
    }
    if (snapshot.outsideUsage[dayAxis] > snapshot.outsideUsage[monthAxis]) {
      return invalid('PERIOD_USAGE_INVERTED',
        `${dayAxis} outside usage exceeds ${monthAxis} outside usage`)
    }
    if (snapshot.recordedDeploymentTotal[dayAxis] > snapshot.recordedDeploymentTotal[monthAxis]) {
      return invalid('PERIOD_USAGE_INVERTED',
        `${dayAxis} recorded total exceeds ${monthAxis} recorded total`)
    }
  }
  return null
}

function axisOutcome(
  snapshot: M365CapacitySnapshot,
  axis: M365CapacityAxis,
): M365CapacityAxisOutcome {
  const { tenantCeiling, deploymentCeiling } = snapshot.ceilings[axis]
  const usage = snapshot.eligibleUsage[axis]
  const cohortSize = snapshot.eligible.length
  const increment = snapshot.increment[axis]
  const recordedTotal = snapshot.recordedDeploymentTotal[axis]

  // floor division on positive bigints is exact, so the share carries the same
  // integer remainder the reviewed design describes.
  const share = (() => {
    const equalShare = deploymentCeiling / BigInt(cohortSize)
    return tenantCeiling < equalShare ? tenantCeiling : equalShare
  })()
  const owedOf = (used: bigint) => (share > used ? share - used : 0n)

  let totalOwed = 0n
  let otherOwed = 0n
  for (const id of snapshot.eligible) {
    const owed = owedOf(usage[id]!)
    totalOwed += owed
    if (id !== snapshot.actor) otherOwed += owed
  }
  const actorUsage = usage[snapshot.actor]!
  const fundability = recordedTotal + totalOwed
  const mode: M365CapacityMode = fundability <= deploymentCeiling ? 'PROTECTED' : 'UNPROMISED'

  const tenantHardCapOk = actorUsage + increment <= tenantCeiling
  const deploymentHardCapOk = recordedTotal + increment <= deploymentCeiling
  const hardCapsOk = tenantHardCapOk && deploymentHardCapOk

  const fairnessAdmissible = deploymentCeiling - recordedTotal - otherOwed
  const fairnessOk = increment <= fairnessAdmissible
  // Hard caps are evaluated FIRST, for every increment including zero: the
  // released comparisons are `usage + increment > ceiling`, which a pre-state
  // already above a lowered effective ceiling fails even at zero. A zero
  // increment skips only the fairness remainder.
  const fairnessApplied = hardCapsOk && increment > 0n && mode === 'PROTECTED'

  let admitted: boolean
  let basis: M365CapacityAxisOutcome['basis']
  if (!hardCapsOk) {
    admitted = false
    basis = 'hard cap exceeded'
  } else if (increment === 0n) {
    admitted = true
    basis = 'zero increment: fairness not applied'
  } else if (mode === 'UNPROMISED') {
    admitted = true
    basis = 'hard caps only: axis is UNPROMISED'
  } else if (!fairnessOk) {
    admitted = false
    basis = 'fairness remainder exceeded'
  } else {
    admitted = true
    basis = 'hard caps and fairness remainder'
  }

  return {
    axis, cohortSize, share, actorUsage, actorOwed: owedOf(actorUsage), otherOwed, totalOwed,
    recordedTotal, fundability, mode, tenantHardCapOk, deploymentHardCapOk, hardCapsOk,
    fairnessAdmissible, fairnessApplied, fairnessOk, admitted, basis,
  }
}

/**
 * Decide one hypothetical increment against one caller-supplied snapshot.
 *
 * Returns INVALID or UNSUPPORTED instead of a decision when the snapshot is
 * outside the supported domain. It never throws for in-domain input, never
 * defaults to admission, and never synthesizes a cohort from spend.
 */
export function decideM365Capacity(snapshot: M365CapacitySnapshot): M365CapacityResult {
  const rejected = rejectSnapshot(snapshot)
  if (rejected) return rejected

  const axes = {} as Record<M365CapacityAxis, M365CapacityAxisOutcome>
  for (const axis of M365_CAPACITY_AXES) axes[axis] = axisOutcome(snapshot, axis)

  // Released precedence: every hard-cap breach, in constraint order, before any
  // fairness refusal. Both walks use frozen arrays, so no property order can
  // change which refusal is reported.
  let refusal: M365CapacityRefusal | null = null
  for (const constraint of M365_CAPACITY_CONSTRAINTS) {
    for (const axis of M365_CAPACITY_AXES) {
      const scopes = CONSTRAINT_OF[axis]
      if (scopes.tenant === constraint && !axes[axis].tenantHardCapOk) {
        refusal = { kind: 'HARD_CAP', constraint, axis }
        break
      }
      if (scopes.deployment === constraint && !axes[axis].deploymentHardCapOk) {
        refusal = { kind: 'HARD_CAP', constraint, axis }
        break
      }
    }
    if (refusal) break
  }
  if (!refusal) {
    for (const axis of M365_CAPACITY_AXES) {
      if (!axes[axis].admitted) {
        refusal = { kind: 'FAIRNESS', axis }
        break
      }
    }
  }

  const admitted = M365_CAPACITY_AXES.every((axis) => axes[axis].admitted)
  return { kind: 'DECIDED', admitted, refusal: admitted ? null : refusal, axes }
}

/**
 * The equal share and its integer remainder for one axis, exposed because the
 * reviewed design quotes both. `cohortSize` must be positive.
 */
export function m365CapacityShare(
  ceilings: M365CapacityCeilings,
  cohortSize: number,
): { readonly share: bigint; readonly remainder: bigint } | null {
  if (!Number.isInteger(cohortSize) || cohortSize <= 0) return null
  if (ceilings.tenantCeiling <= 0n || ceilings.deploymentCeiling <= 0n) return null
  const n = BigInt(cohortSize)
  const equalShare = ceilings.deploymentCeiling / n
  const share = ceilings.tenantCeiling < equalShare ? ceilings.tenantCeiling : equalShare
  return { share, remainder: ceilings.deploymentCeiling - n * share }
}
