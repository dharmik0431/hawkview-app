import assert from 'node:assert/strict'
import test from 'node:test'
import {
  M365_CAPACITY_AXES,
  M365_CAPACITY_CONSTRAINTS,
  M365_CAPACITY_MAX_COHORT,
  decideM365Capacity,
  m365CapacityShare,
  type M365CapacityAxis,
  type M365CapacitySnapshot,
} from './m365-audit-capacity-model.js'

/**
 * Focused tests for the INTENTIONALLY UNUSED capacity model. These are pure
 * arithmetic over caller-supplied snapshots: no database, provider, clock,
 * environment or filesystem access, and nothing in production imports the
 * module under test. Passing says the reviewed contract's arithmetic is encoded
 * as reviewed; it says nothing about writer integration, scheduling progress,
 * freshness or cost.
 */

const MiB = 1024n * 1024n
const BLOB = 10n * MiB                     // 10,485,760 -- MAX_CONTENT_RESPONSE_BYTES
const DEFAULTS = {
  daily_bytes: { tenantCeiling: 50n * MiB, deploymentCeiling: 100n * MiB },
  daily_records: { tenantCeiling: 1_000n, deploymentCeiling: 2_000n },
  monthly_bytes: { tenantCeiling: 1_000n * MiB, deploymentCeiling: 2_000n * MiB },
  monthly_records: { tenantCeiling: 20_000n, deploymentCeiling: 40_000n },
} as const

type UsageMap = Readonly<Record<string, bigint>>
type Build = {
  eligible: readonly string[]
  actor: string
  dailyBytes: UsageMap
  monthlyBytes?: UsageMap
  dailyRecords?: UsageMap
  monthlyRecords?: UsageMap
  outside?: Partial<Record<M365CapacityAxis, bigint>>
  increment?: Partial<Record<M365CapacityAxis, bigint>>
  ceilings?: Partial<typeof DEFAULTS>
  /** Override the authoritative total, to exercise AGGREGATE_MISMATCH. */
  totalOverride?: Partial<Record<M365CapacityAxis, bigint>>
}

/** Builds a snapshot whose totals are consistent by construction, so a fixture
 *  cannot accidentally omit outside spend. Monthly usage defaults to the daily
 *  figures, which keeps every fixture inside the day <= month invariant. */
function build(spec: Build): M365CapacitySnapshot {
  const zeros = Object.fromEntries(spec.eligible.map((id) => [id, 0n]))
  const usage: Record<M365CapacityAxis, UsageMap> = {
    daily_bytes: spec.dailyBytes,
    monthly_bytes: spec.monthlyBytes ?? spec.dailyBytes,
    daily_records: spec.dailyRecords ?? zeros,
    monthly_records: spec.monthlyRecords ?? spec.dailyRecords ?? zeros,
  }
  const outside = {
    daily_bytes: spec.outside?.daily_bytes ?? 0n,
    monthly_bytes: spec.outside?.monthly_bytes ?? spec.outside?.daily_bytes ?? 0n,
    daily_records: spec.outside?.daily_records ?? 0n,
    monthly_records: spec.outside?.monthly_records ?? spec.outside?.daily_records ?? 0n,
  }
  const totals = {} as Record<M365CapacityAxis, bigint>
  for (const axis of M365_CAPACITY_AXES) {
    const sum = spec.eligible.reduce((acc, id) => acc + usage[axis][id]!, 0n)
    totals[axis] = spec.totalOverride?.[axis] ?? sum + outside[axis]
  }
  return {
    eligible: spec.eligible,
    actor: spec.actor,
    ceilings: { ...DEFAULTS, ...spec.ceilings },
    eligibleUsage: usage,
    outsideUsage: outside,
    recordedDeploymentTotal: totals,
    increment: {
      daily_bytes: spec.increment?.daily_bytes ?? 0n,
      monthly_bytes: spec.increment?.monthly_bytes ?? spec.increment?.daily_bytes ?? 0n,
      daily_records: spec.increment?.daily_records ?? 0n,
      monthly_records: spec.increment?.monthly_records ?? spec.increment?.daily_records ?? 0n,
    },
  }
}

function decided(snapshot: M365CapacitySnapshot) {
  const result = decideM365Capacity(snapshot)
  // Never JSON.stringify a result here: it carries bigint fields, which
  // JSON.stringify throws on, and the thrown TypeError would mask the real
  // assertion.
  const described = result.kind === 'DECIDED'
    ? 'DECIDED'
    : `${result.kind}/${result.reason}: ${result.detail}`
  assert.equal(result.kind, 'DECIDED', `expected a decision, got ${described}`)
  if (result.kind !== 'DECIDED') throw new Error('unreachable')
  return result
}

const THREE = ['N1', 'N2', 'Q'] as const
const bytesOnly = (increment: bigint) => ({ daily_bytes: increment, monthly_bytes: increment })

// ==========================================================================
// Shares, and the integer remainders the reviewed design quotes
// ==========================================================================

test('shares and remainders at n=3 match the reviewed figures', () => {
  assert.deepEqual(m365CapacityShare(DEFAULTS.daily_bytes, 3), { share: 34_952_533n, remainder: 1n })
  assert.deepEqual(m365CapacityShare(DEFAULTS.daily_records, 3), { share: 666n, remainder: 2n })
  assert.deepEqual(m365CapacityShare(DEFAULTS.monthly_bytes, 3), { share: 699_050_666n, remainder: 2n })
  assert.deepEqual(m365CapacityShare(DEFAULTS.monthly_records, 3), { share: 13_333n, remainder: 1n })
})

test('the share clamps to the tenant ceiling for small cohorts', () => {
  // At n<=2 the equal split exceeds the tenant ceiling, so the tenant ceiling wins.
  assert.deepEqual(m365CapacityShare(DEFAULTS.daily_bytes, 1),
    { share: 52_428_800n, remainder: 52_428_800n })
  assert.deepEqual(m365CapacityShare(DEFAULTS.daily_bytes, 2),
    { share: 52_428_800n, remainder: 0n })
  assert.equal(m365CapacityShare(DEFAULTS.daily_bytes, 0), null)
  assert.equal(m365CapacityShare(DEFAULTS.daily_bytes, 1.5), null)
})

test('byte arithmetic stays exact past Number.MAX_SAFE_INTEGER', () => {
  const huge = 9_007_199_254_740_993n            // 2^53 + 1, not representable as a double
  const result = decided(build({
    eligible: ['A'], actor: 'A',
    dailyBytes: { A: huge },
    ceilings: {
      daily_bytes: { tenantCeiling: huge * 4n, deploymentCeiling: huge * 8n },
      monthly_bytes: { tenantCeiling: huge * 8n, deploymentCeiling: huge * 16n },
    },
    increment: bytesOnly(1n),
  }))
  const day = result.axes.daily_bytes
  assert.equal(day.recordedTotal, huge)
  assert.equal(day.share, huge * 4n, 'the tenant ceiling clamps the single-member share')
  assert.equal(day.fairnessAdmissible, huge * 8n - huge, 'no rounding through a double')
  assert.equal(result.admitted, true)
})

// ==========================================================================
// Correction 1 — hard caps are evaluated BEFORE the zero-increment bypass
// ==========================================================================

test('a zero increment under the caps is admitted, fairness not applied', () => {
  const result = decided(build({
    eligible: THREE, actor: 'Q', dailyBytes: { N1: 30n * MiB, N2: 5n * MiB, Q: 0n },
    increment: bytesOnly(0n),
  }))
  const day = result.axes.daily_bytes
  assert.equal(day.admitted, true)
  assert.equal(day.basis, 'zero increment: fairness not applied')
  assert.equal(day.fairnessApplied, false)
  assert.equal(result.admitted, true)
})

test('a zero increment exactly at the cap is admitted', () => {
  // usage + 0 == ceiling, and the released comparison is strict `>`.
  const result = decided(build({
    eligible: ['A'], actor: 'A', dailyBytes: { A: 40n * MiB },
    ceilings: { daily_bytes: { tenantCeiling: 40n * MiB, deploymentCeiling: 100n * MiB } },
    increment: bytesOnly(0n),
  }))
  assert.equal(result.axes.daily_bytes.tenantHardCapOk, true)
  assert.equal(result.admitted, true)
})

test('a zero increment OVER an effective cap still refuses on the hard cap', () => {
  // The review's example: 45 MiB already recorded under a now-40 MiB effective
  // tenant ceiling. usage + 0 > ceiling, so the existing comparison refuses.
  const result = decided(build({
    eligible: ['A'], actor: 'A', dailyBytes: { A: 45n * MiB },
    ceilings: { daily_bytes: { tenantCeiling: 40n * MiB, deploymentCeiling: 100n * MiB } },
    increment: bytesOnly(0n),
  }))
  const day = result.axes.daily_bytes
  assert.equal(day.tenantHardCapOk, false)
  assert.equal(day.admitted, false)
  assert.equal(day.basis, 'hard cap exceeded')
  assert.equal(day.fairnessApplied, false, 'fairness is not even reached')
  assert.equal(result.admitted, false)
  assert.deepEqual(result.refusal, {
    kind: 'HARD_CAP', constraint: 'daily_tenant_bytes', axis: 'daily_bytes',
  })
})

test('a positive charge is refused when a different zero-increment axis is already over cap', () => {
  const result = decided(build({
    eligible: ['A'], actor: 'A',
    dailyBytes: { A: 1n * MiB }, monthlyBytes: { A: 1n * MiB },
    dailyRecords: { A: 1_500n }, monthlyRecords: { A: 1_500n },
    ceilings: { daily_records: { tenantCeiling: 1_000n, deploymentCeiling: 2_000n } },
    increment: { daily_bytes: BLOB, monthly_bytes: BLOB, daily_records: 0n, monthly_records: 0n },
  }))
  assert.equal(result.axes.daily_bytes.admitted, true, 'the byte axis itself is fine')
  assert.equal(result.axes.daily_records.admitted, false)
  assert.equal(result.axes.daily_records.basis, 'hard cap exceeded')
  assert.equal(result.admitted, false, 'the overall decision is the AND over axes')
  assert.deepEqual(result.refusal, {
    kind: 'HARD_CAP', constraint: 'daily_tenant_records', axis: 'daily_records',
  })
})

// ==========================================================================
// The corrected one-byte outside-spend control (C2)
// ==========================================================================

test('C2: one byte of outside spend flips the decision, with both hard caps passing', () => {
  const fixture = (outsideByte: bigint) => build({
    eligible: THREE, actor: 'Q',
    dailyBytes: { N1: 0n, N2: 0n, Q: 24_466_774n },
    outside: { daily_bytes: outsideByte, monthly_bytes: outsideByte },
    increment: bytesOnly(BLOB),
  })

  const correct = decided(fixture(1n)).axes.daily_bytes
  assert.equal(correct.recordedTotal, 24_466_775n)
  assert.equal(correct.fundability, 104_857_600n, 'F sits exactly on the deployment ceiling')
  assert.equal(correct.mode, 'PROTECTED')
  assert.equal(correct.fairnessAdmissible, 10_485_759n)
  assert.equal(correct.admitted, false)
  assert.equal(correct.basis, 'fairness remainder exceeded')
  assert.equal(correct.tenantHardCapOk, true, 'the real tenant hard cap passes')
  assert.equal(correct.deploymentHardCapOk, true, 'and so does the real deployment hard cap')
  assert.equal(BLOB - correct.fairnessAdmissible, 1n, 'refused by exactly one byte')

  // Omitting that single outside byte is the whole mutation.
  const wrong = decided(fixture(0n)).axes.daily_bytes
  assert.equal(wrong.mode, 'PROTECTED', 'the mode is unchanged, so nothing else explains the flip')
  assert.equal(wrong.hardCapsOk, true)
  assert.equal(wrong.fairnessAdmissible, 10_485_760n)
  assert.equal(wrong.admitted, true)
  assert.notEqual(correct.admitted, wrong.admitted,
    'omitting outside spend from the model WOULD make this test fail')
})

// ==========================================================================
// A5 alternatives, and the nine/tenth blob trace
// ==========================================================================

test('A5: the three alternatives from one pre-state', () => {
  const usage = { N1: 30n * MiB, N2: 5n * MiB, Q: 0n }
  const expected = [
    ['N1', 64_662_186n, 3_495_254n, false],
    ['N2', 38_447_786n, 29_709_654n, true],
    ['Q', 33_204_906n, 34_952_534n, true],
  ] as const
  for (const [actor, otherOwed, admissible, admitted] of expected) {
    const day = decided(build({
      eligible: THREE, actor, dailyBytes: usage, increment: bytesOnly(BLOB),
    })).axes.daily_bytes
    assert.equal(day.fundability, 104_857_599n, `${actor}: F`)
    assert.equal(day.mode, 'PROTECTED', `${actor}: mode`)
    assert.equal(day.otherOwed, otherOwed, `${actor}: other owed`)
    assert.equal(day.fairnessAdmissible, admissible, `${actor}: admissible`)
    assert.equal(day.hardCapsOk, true, `${actor}: hard caps pass either way`)
    assert.equal(day.admitted, admitted, `${actor}: decision`)
  }
})

test('nine whole blobs are admitted and leave F invariant, and the tenth is refused', () => {
  const usage: Record<string, bigint> = { N1: 0n, N2: 0n, Q: 0n }
  const records: Record<string, bigint> = { N1: 0n, N2: 0n, Q: 0n }
  const seenFundability = new Set<bigint>()
  for (let step = 0; step < 9; step += 1) {
    const actor = THREE[step % 3]!
    const result = decided(build({
      eligible: THREE, actor,
      dailyBytes: { ...usage }, monthlyBytes: { ...usage },
      dailyRecords: { ...records }, monthlyRecords: { ...records },
      increment: { daily_bytes: BLOB, monthly_bytes: BLOB, daily_records: 200n, monthly_records: 200n },
    }))
    assert.equal(result.admitted, true, `step ${step + 1}`)
    assert.equal(result.axes.daily_bytes.mode, 'PROTECTED')
    seenFundability.add(result.axes.daily_bytes.fundability)
    usage[actor] = usage[actor]! + BLOB
    records[actor] = records[actor]! + 200n
  }
  assert.deepEqual([...seenFundability], [104_857_599n],
    'each admitted byte raises the total and lowers that tenant owed amount by one')
  assert.equal(usage.N1, 31_457_280n)
  assert.equal(Object.values(usage).reduce((a, b) => a + b, 0n), 94_371_840n)

  const tenth = decided(build({
    eligible: THREE, actor: 'N1',
    dailyBytes: { ...usage }, monthlyBytes: { ...usage },
    dailyRecords: { ...records }, monthlyRecords: { ...records },
    increment: { daily_bytes: BLOB, monthly_bytes: BLOB, daily_records: 200n, monthly_records: 200n },
  }))
  assert.equal(tenth.admitted, false)
  assert.equal(tenth.axes.daily_bytes.fairnessAdmissible, 3_495_254n)
  assert.equal(tenth.axes.daily_records.fairnessAdmissible, 68n)
  // The deployment hard cap is met EXACTLY and the released comparison is `>`,
  // so the hard caps alone would admit. Only fairness refuses.
  assert.equal(tenth.axes.daily_bytes.recordedTotal + BLOB, 104_857_600n)
  for (const axis of M365_CAPACITY_AXES) {
    assert.equal(tenth.axes[axis].hardCapsOk, true, `${axis} hard caps still pass`)
  }
  // Only the DAILY axes refuse here: at 31,457,280 bytes and 600 records each,
  // the monthly shares are nowhere near exhausted, so both monthly axes admit.
  assert.deepEqual(
    M365_CAPACITY_AXES.filter((axis) => !tenth.axes[axis].admitted),
    ['daily_bytes', 'daily_records'],
  )
  assert.equal(tenth.axes.monthly_bytes.admitted, true)
  assert.equal(tenth.axes.monthly_records.admitted, true)
  // Reported in axis order, so the first refusing axis is the daily byte one.
  assert.deepEqual(tenth.refusal, { kind: 'FAIRNESS', axis: 'daily_bytes' })
})

// ==========================================================================
// Correction 2 — coherent mixed-axis fixtures, one in each direction
// ==========================================================================

test('mixed modes: an UNPROMISED day does not disable month protection', () => {
  const snapshot = build({
    eligible: THREE, actor: 'Q',
    dailyBytes: { N1: 45n * MiB, N2: 45n * MiB, Q: 0n },
    monthlyBytes: { N1: 600n * MiB, N2: 600n * MiB, Q: 660n * MiB },
    increment: bytesOnly(BLOB),
  })
  // The day <= month invariant holds for every tenant and globally.
  for (const id of THREE) {
    assert.ok(snapshot.eligibleUsage.daily_bytes[id]! <= snapshot.eligibleUsage.monthly_bytes[id]!,
      `${id}: day <= month`)
  }
  assert.ok(snapshot.recordedDeploymentTotal.daily_bytes
    <= snapshot.recordedDeploymentTotal.monthly_bytes, 'global day <= month')

  const result = decided(snapshot)
  const day = result.axes.daily_bytes
  assert.equal(day.recordedTotal, 94_371_840n)
  assert.equal(day.fundability, 129_324_373n)
  assert.equal(day.mode, 'UNPROMISED')
  assert.equal(day.hardCapsOk, true)
  assert.equal(day.admitted, true)
  assert.equal(day.basis, 'hard caps only: axis is UNPROMISED')

  const month = result.axes.monthly_bytes
  assert.equal(month.recordedTotal, 1_950_351_360n)
  assert.equal(month.fundability, 2_097_151_998n)
  assert.equal(month.mode, 'PROTECTED')
  assert.equal(month.fairnessAdmissible, 6_990_508n)
  assert.equal(month.hardCapsOk, true, 'the month refuses on fairness, not a hard cap')
  assert.equal(month.admitted, false)

  assert.equal(result.admitted, false)
  assert.deepEqual(result.refusal, { kind: 'FAIRNESS', axis: 'monthly_bytes' })
})

test('mixed modes: an UNPROMISED month does not disable day protection', () => {
  const snapshot = build({
    eligible: THREE, actor: 'Q',
    dailyBytes: { N1: 30n * MiB, N2: 30n * MiB, Q: 30n * MiB },
    monthlyBytes: { N1: 950n * MiB, N2: 950n * MiB, Q: 30n * MiB },
    increment: bytesOnly(BLOB),
  })
  for (const id of THREE) {
    assert.ok(snapshot.eligibleUsage.daily_bytes[id]! <= snapshot.eligibleUsage.monthly_bytes[id]!,
      `${id}: day <= month`)
  }

  const result = decided(snapshot)
  const day = result.axes.daily_bytes
  assert.equal(day.fundability, 104_857_599n)
  assert.equal(day.mode, 'PROTECTED')
  assert.equal(day.fairnessAdmissible, 3_495_254n)
  assert.equal(day.hardCapsOk, true)
  assert.equal(day.admitted, false)
  assert.equal(day.basis, 'fairness remainder exceeded')

  const month = result.axes.monthly_bytes
  assert.equal(month.recordedTotal, 2_023_751_680n)
  assert.equal(month.fundability, 2_691_345_066n)
  assert.equal(month.mode, 'UNPROMISED')
  assert.equal(month.admitted, true)
  assert.equal(month.basis, 'hard caps only: axis is UNPROMISED')

  assert.equal(result.admitted, false)
  assert.deepEqual(result.refusal, { kind: 'FAIRNESS', axis: 'daily_bytes' })
})

test('bypassing a PROTECTED axis would change the answer', () => {
  // The forward mixed fixture, judged on the day axis alone: it admits. The
  // month is what refuses, so a model that dropped the month would be wrong.
  const result = decided(build({
    eligible: THREE, actor: 'Q',
    dailyBytes: { N1: 45n * MiB, N2: 45n * MiB, Q: 0n },
    monthlyBytes: { N1: 600n * MiB, N2: 600n * MiB, Q: 660n * MiB },
    increment: { daily_bytes: BLOB, monthly_bytes: 0n },
  }))
  assert.equal(result.admitted, true,
    'with no monthly charge the same day state admits, so the monthly axis is load-bearing')
})

// ==========================================================================
// Mode recomputation: departure and refund
// ==========================================================================

test('a departure re-funds the axis, because the cohort size changes every share', () => {
  const over = { N1: 45n * MiB, N2: 45n * MiB, Q: 0n }
  const before = decided(build({
    eligible: THREE, actor: 'Q', dailyBytes: over, increment: bytesOnly(BLOB),
  })).axes.daily_bytes
  assert.equal(before.mode, 'UNPROMISED')
  assert.equal(before.fundability, 129_324_373n)

  const after = decided(build({
    eligible: ['N1', 'N2'], actor: 'N1',
    dailyBytes: { N1: 45n * MiB, N2: 45n * MiB }, increment: bytesOnly(0n),
  })).axes.daily_bytes
  assert.equal(after.cohortSize, 2)
  assert.equal(after.share, 52_428_800n)
  assert.equal(after.fundability, 104_857_600n)
  assert.equal(after.mode, 'PROTECTED', 'the same day re-funds once Q leaves')
})

test('a refund re-funds the axis only when it removes genuine over-share spend', () => {
  const at = (n1: bigint) => decided(build({
    eligible: THREE, actor: 'Q', dailyBytes: { N1: n1, N2: 45n * MiB, Q: 0n },
    increment: bytesOnly(0n),
  })).axes.daily_bytes

  // Refunding one tenant lowers F only until it reaches its share, then stops:
  // below the share each refunded byte re-creates a byte of owed.
  assert.equal(at(45n * MiB).fundability, 129_324_373n)
  assert.equal(at(34_952_533n).fundability, 117_090_986n)
  assert.equal(at(0n).fundability, 117_090_986n, 'refunding everything does not help further')
  for (const n1 of [45n * MiB, 34_952_533n, 0n]) {
    assert.equal(at(n1).mode, 'UNPROMISED', 'no single-tenant refund re-funds this axis')
  }

  // Refunding BOTH over-share tenants down to their shares does re-fund it.
  const both = decided(build({
    eligible: THREE, actor: 'Q',
    dailyBytes: { N1: 34_952_533n, N2: 34_952_533n, Q: 0n }, increment: bytesOnly(0n),
  })).axes.daily_bytes
  assert.equal(both.fundability, 104_857_599n)
  assert.equal(both.mode, 'PROTECTED')
})

// ==========================================================================
// Refusal precedence
// ==========================================================================

test('monthly hard caps outrank daily ones regardless of property order', () => {
  const overEverywhere = {
    eligible: ['A'] as const, actor: 'A',
    dailyBytes: { A: 60n * MiB }, monthlyBytes: { A: 1_100n * MiB },
    increment: bytesOnly(BLOB),
  }
  const result = decided(build(overEverywhere))
  assert.equal(result.axes.daily_bytes.tenantHardCapOk, false, 'the daily cap is breached too')
  assert.equal(result.axes.monthly_bytes.tenantHardCapOk, false)
  assert.deepEqual(result.refusal, {
    kind: 'HARD_CAP', constraint: 'monthly_tenant_bytes', axis: 'monthly_bytes',
  }, 'monthly precedes daily, matching the released refusal order')

  // Reversing the key insertion order of every per-axis record must not matter,
  // because the model iterates its own frozen constraint and axis lists.
  const reversedAxisOrder = [...M365_CAPACITY_AXES].reverse()
  const reorder = <T>(source: Readonly<Record<M365CapacityAxis, T>>) =>
    Object.fromEntries(reversedAxisOrder.map((axis) => [axis, source[axis]])) as
      Record<M365CapacityAxis, T>
  const base = build(overEverywhere)
  const shuffled = decided({
    ...base,
    ceilings: reorder(base.ceilings),
    eligibleUsage: reorder(base.eligibleUsage),
    outsideUsage: reorder(base.outsideUsage),
    recordedDeploymentTotal: reorder(base.recordedDeploymentTotal),
    increment: reorder(base.increment),
  })
  assert.deepEqual(shuffled.refusal, result.refusal, 'property order cannot change precedence')
})

test('a hard-cap refusal outranks a fairness refusal on another axis', () => {
  const result = decided(build({
    eligible: THREE, actor: 'N1',
    dailyBytes: { N1: 30n * MiB, N2: 5n * MiB, Q: 0n },
    monthlyBytes: { N1: 1_100n * MiB, N2: 5n * MiB, Q: 0n },
    increment: bytesOnly(BLOB),
  }))
  assert.equal(result.axes.daily_bytes.admitted, false)
  assert.equal(result.axes.daily_bytes.basis, 'fairness remainder exceeded')
  assert.equal(result.axes.monthly_bytes.basis, 'hard cap exceeded')
  assert.deepEqual(result.refusal, {
    kind: 'HARD_CAP', constraint: 'monthly_tenant_bytes', axis: 'monthly_bytes',
  })
})

test('an admitted decision reports no refusal', () => {
  const result = decided(build({
    eligible: THREE, actor: 'Q', dailyBytes: { N1: 0n, N2: 0n, Q: 0n },
    increment: bytesOnly(BLOB),
  }))
  assert.equal(result.admitted, true)
  assert.equal(result.refusal, null)
})

// ==========================================================================
// Non-default effective ceilings
// ==========================================================================

test('effective non-default ceilings drive the share and the boundary exactly', () => {
  // A deployment ceiling that is not divisible by the cohort size: the share
  // floors and the remainder is visible in the acting tenant admissible amount.
  const ceilings = {
    daily_bytes: { tenantCeiling: 30n * MiB, deploymentCeiling: 70n * MiB },
    monthly_bytes: { tenantCeiling: 300n * MiB, deploymentCeiling: 700n * MiB },
  } as const
  assert.deepEqual(m365CapacityShare(ceilings.daily_bytes, 3),
    { share: 24_466_773n, remainder: 1n })

  const day = decided(build({
    eligible: THREE, actor: 'Q', dailyBytes: { N1: 0n, N2: 0n, Q: 0n },
    ceilings, increment: bytesOnly(24_466_774n),
  })).axes.daily_bytes
  assert.equal(day.share, 24_466_773n)
  assert.equal(day.fairnessAdmissible, 24_466_774n, 'the share plus the integer remainder')
  assert.equal(day.admitted, true, 'exactly at the boundary')

  const over = decided(build({
    eligible: THREE, actor: 'Q', dailyBytes: { N1: 0n, N2: 0n, Q: 0n },
    ceilings, increment: bytesOnly(24_466_775n),
  })).axes.daily_bytes
  assert.equal(over.admitted, false, 'one byte past it')
  assert.equal(over.basis, 'fairness remainder exceeded')
})

// ==========================================================================
// Domain: rejected and unsupported snapshots
// ==========================================================================

test('an empty cohort is rejected rather than divided by zero', () => {
  const result = decideM365Capacity(build({
    eligible: [], actor: 'Q', dailyBytes: {}, increment: bytesOnly(BLOB),
  }))
  assert.equal(result.kind, 'INVALID')
  assert.equal(result.kind === 'INVALID' && result.reason, 'EMPTY_COHORT')
})

test('a cohort beyond the supported domain is UNSUPPORTED, not guessed', () => {
  const ids = Array.from({ length: M365_CAPACITY_MAX_COHORT + 1 }, (_unused, i) => `T${i}`)
  const zeros = Object.fromEntries(ids.map((id) => [id, 0n]))
  const result = decideM365Capacity(build({
    eligible: ids, actor: 'T0', dailyBytes: zeros, increment: bytesOnly(BLOB),
  }))
  assert.equal(result.kind, 'UNSUPPORTED')
  assert.equal(result.kind === 'UNSUPPORTED' && result.reason, 'COHORT_TOO_LARGE')
  // The supported edge still decides.
  const edgeIds = ids.slice(0, M365_CAPACITY_MAX_COHORT)
  const edge = decideM365Capacity(build({
    eligible: edgeIds, actor: 'T0',
    dailyBytes: Object.fromEntries(edgeIds.map((id) => [id, 0n])), increment: bytesOnly(BLOB),
  }))
  assert.equal(edge.kind, 'DECIDED')
})

test('duplicate membership, a blank id and an outside actor are each rejected', () => {
  const duplicate = decideM365Capacity(build({
    eligible: ['N1', 'N1', 'Q'], actor: 'N1',
    dailyBytes: { N1: 0n, Q: 0n }, increment: bytesOnly(0n),
  }))
  assert.equal(duplicate.kind === 'INVALID' && duplicate.reason, 'DUPLICATE_MEMBER')

  const blank = decideM365Capacity(build({
    eligible: ['N1', ''], actor: 'N1', dailyBytes: { N1: 0n, '': 0n }, increment: bytesOnly(0n),
  }))
  assert.equal(blank.kind === 'INVALID' && blank.reason, 'BLANK_MEMBER')

  const outsider = decideM365Capacity(build({
    eligible: THREE, actor: 'STRANGER',
    dailyBytes: { N1: 0n, N2: 0n, Q: 0n }, increment: bytesOnly(BLOB),
  }))
  assert.equal(outsider.kind === 'INVALID' && outsider.reason, 'ACTOR_OUTSIDE_COHORT')
})

test('an idle member must be present with zero, never synthesized from spend', () => {
  const snapshot = build({
    eligible: THREE, actor: 'N1', dailyBytes: { N1: 0n, N2: 0n, Q: 0n },
    increment: bytesOnly(0n),
  })
  const withoutQ = {
    ...snapshot,
    eligibleUsage: {
      ...snapshot.eligibleUsage,
      daily_bytes: { N1: 0n, N2: 0n },
    },
  }
  const result = decideM365Capacity(withoutQ)
  assert.equal(result.kind === 'INVALID' && result.reason, 'MISSING_TENANT_USAGE')

  const stranger = {
    ...snapshot,
    eligibleUsage: {
      ...snapshot.eligibleUsage,
      daily_bytes: { N1: 0n, N2: 0n, Q: 0n, OUTSIDER: 5n },
    },
  }
  assert.equal(decideM365Capacity(stranger).kind === 'INVALID'
    && (decideM365Capacity(stranger) as { reason: string }).reason, 'UNKNOWN_USAGE_TENANT')
})

test('negative values, non-positive ceilings and a missing axis are rejected', () => {
  const base = build({
    eligible: ['A'], actor: 'A', dailyBytes: { A: 0n }, increment: bytesOnly(0n),
  })
  const negativeUsage = {
    ...base,
    eligibleUsage: { ...base.eligibleUsage, daily_bytes: { A: -1n } },
    recordedDeploymentTotal: { ...base.recordedDeploymentTotal, daily_bytes: -1n },
  }
  assert.equal(decideM365Capacity(negativeUsage).kind === 'INVALID'
    && (decideM365Capacity(negativeUsage) as { reason: string }).reason, 'NEGATIVE_VALUE')

  const zeroCeiling = {
    ...base,
    ceilings: { ...base.ceilings, daily_bytes: { tenantCeiling: 0n, deploymentCeiling: 100n } },
  }
  assert.equal(decideM365Capacity(zeroCeiling).kind === 'INVALID'
    && (decideM365Capacity(zeroCeiling) as { reason: string }).reason, 'NON_POSITIVE_CEILING')

  const { daily_records: _dropped, ...partial } = base.increment
  const missingAxis = { ...base, increment: partial as typeof base.increment }
  assert.equal(decideM365Capacity(missingAxis).kind === 'INVALID'
    && (decideM365Capacity(missingAxis) as { reason: string }).reason, 'MISSING_AXIS')
})

test('a total that disagrees with its parts is rejected, not reconciled', () => {
  const doubleCounted = build({
    eligible: THREE, actor: 'Q', dailyBytes: { N1: 10n * MiB, N2: 0n, Q: 0n },
    outside: { daily_bytes: 5n * MiB, monthly_bytes: 5n * MiB },
    // the caller adds the outside spend twice
    totalOverride: { daily_bytes: 10n * MiB + 5n * MiB + 5n * MiB },
    increment: bytesOnly(BLOB),
  })
  const result = decideM365Capacity(doubleCounted)
  assert.equal(result.kind === 'INVALID' && result.reason, 'AGGREGATE_MISMATCH')

  const omitted = build({
    eligible: THREE, actor: 'Q', dailyBytes: { N1: 10n * MiB, N2: 0n, Q: 0n },
    outside: { daily_bytes: 5n * MiB, monthly_bytes: 5n * MiB },
    totalOverride: { daily_bytes: 10n * MiB },       // outside spend dropped from the total
    increment: bytesOnly(BLOB),
  })
  assert.equal(decideM365Capacity(omitted).kind === 'INVALID'
    && (decideM365Capacity(omitted) as { reason: string }).reason, 'AGGREGATE_MISMATCH')
})

test('a day larger than its own month is rejected as unreachable', () => {
  const inverted = build({
    eligible: THREE, actor: 'Q',
    dailyBytes: { N1: 30n * MiB, N2: 30n * MiB, Q: 30n * MiB },
    monthlyBytes: { N1: 950n * MiB, N2: 950n * MiB, Q: 0n },   // Q's month below its day
    increment: bytesOnly(BLOB),
  })
  const result = decideM365Capacity(inverted)
  assert.equal(result.kind === 'INVALID' && result.reason, 'PERIOD_USAGE_INVERTED')
  assert.match(result.kind === 'INVALID' ? result.detail : '', /daily_bytes usage for Q/)
})

test('the exported constraint and axis lists are frozen and in released order', () => {
  assert.deepEqual([...M365_CAPACITY_CONSTRAINTS], [
    'monthly_tenant_bytes', 'monthly_deployment_bytes',
    'monthly_tenant_records', 'monthly_deployment_records',
    'daily_tenant_bytes', 'daily_deployment_bytes',
    'daily_tenant_records', 'daily_deployment_records',
  ])
  assert.deepEqual([...M365_CAPACITY_AXES],
    ['monthly_bytes', 'monthly_records', 'daily_bytes', 'daily_records'])
  assert.equal(Object.isFrozen(M365_CAPACITY_CONSTRAINTS), true)
  assert.equal(Object.isFrozen(M365_CAPACITY_AXES), true)
})
