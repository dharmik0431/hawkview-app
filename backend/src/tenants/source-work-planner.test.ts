import assert from 'node:assert/strict'
import test from 'node:test'
import { planSourceWork, type SourceWorkInput, type SourceDependency } from './source-work-planner.js'

const hour = 3_600_000
const now = 10 * hour
const budget = { maxItems: 10, maxEstimatedCost: 100 }
function item(overrides: Partial<SourceWorkInput> = {}): SourceWorkInput {
  return {
    tenantId: 'a', source: 'USERS', scope: 'all-users',
    lastComplete: { checkedAt: now - 1, generation: 'g1', scope: 'all-users' },
    lastAttempt: { startedAt: now - 1, outcome: 'complete' },
    deadline: now + hour, maxAgeMs: hour, retryNotBefore: null,
    estimatedCost: 1, dependencies: [], ...overrides,
  }
}
function dependent(overrides: Partial<SourceWorkInput> = {}, dep: Partial<SourceDependency> = {}) {
  return item({ source: 'MEMBERSHIP', scope: 'declared-membership', lastComplete: null, lastAttempt: null,
    dependencies: [{ source: 'USERS', scope: 'all-users', requiredGeneration: 'g1', maxAgeMs: hour, ...dep }], ...overrides })
}
function decide(value: SourceWorkInput) { return planSourceWork([value], now, budget).decisions[0] }

// Completion, not row count or provider publication time, drives the check clock.
test('an empty complete check stays fresh; absence of completion needs work immediately', () => {
  assert.deepEqual(decide(item()).reasons, ['fresh'])
  assert.deepEqual(decide(item({ lastComplete: null, lastAttempt: null })).reasons, ['no_complete_check'])
  assert.equal(decide(item({ lastComplete: null, lastAttempt: null })).disposition, 'selected')
})
for (const [age, due] of [[hour - 1, false], [hour, true], [hour + 1, true]] as const) {
  test(`successful check age ${age} has due=${due} at exact hourly boundary`, () => {
    const result = decide(item({ lastComplete: { checkedAt: now - age, generation: 'g1', scope: 'all-users' }, lastAttempt: null }))
    assert.equal(result.disposition, due ? 'selected' : 'deferred')
    assert.ok(result.reasons.includes(due ? 'deadline_due' : 'fresh'))
  })
}
for (const outcome of ['failed', 'partial', 'skipped'] as const) {
  test(`${outcome} cannot refresh a historical complete check or satisfy dependencies`, () => {
    const prerequisite = item({ lastAttempt: { startedAt: now, outcome } })
    const result = planSourceWork([prerequisite, dependent()], now, budget)
    assert.equal(result.decisions[0].disposition, 'selected')
    assert.ok(result.decisions[0].reasons.includes(outcome))
    assert.ok(result.decisions[1].reasons.includes('dependency_unverified'))
    assert.equal(prerequisite.lastComplete!.checkedAt, now - 1)
  })
}
test('running sources are deferred and cannot satisfy a dependency', () => {
  const result = planSourceWork([item({ lastAttempt: { startedAt: now, outcome: 'running' } }), dependent()], now, budget)
  assert.deepEqual(result.decisions[0].reasons, ['running'])
  assert.ok(result.decisions[1].reasons.includes('dependency_unverified'))
  assert.equal(result.selected.length, 0)
})
for (const malformed of [NaN, Infinity, -1, 0.5, now + 1]) {
  test(`invalid/future completion ${malformed} blocks rather than becoming fresh`, () => {
    assert.deepEqual(decide(item({ lastComplete: { checkedAt: malformed, generation: 'g1', scope: 'all-users' }, lastAttempt: null })).reasons, ['invalid_input'])
  })
}
for (const field of ['deadline', 'retryNotBefore'] as const) {
  for (const invalid of [NaN, Infinity, -1, 0.5]) {
    test(`invalid ${field} ${invalid} blocks`, () => assert.deepEqual(decide(item({ [field]: invalid })).reasons, ['invalid_input']))
  }
}
test('future/invalid attempts and inconsistent completion evidence block', () => {
  for (const startedAt of [NaN, now + 1, now - 2]) {
    assert.deepEqual(decide(item({ lastAttempt: { startedAt, outcome: 'failed' } })).reasons, ['invalid_input'])
  }
  assert.deepEqual(decide(item({ lastComplete: null })).reasons, ['invalid_input'])
  assert.deepEqual(decide(item({ lastAttempt: { startedAt: now, outcome: 'complete' } })).reasons, ['invalid_input'])
  assert.deepEqual(decide(item({ lastComplete: { checkedAt: now - 1, generation: '', scope: 'all-users' } })).reasons, ['invalid_input'])
})
test('absolute deadline can bring forward work but cannot postpone maximum check age', () => {
  assert.equal(decide(item({ deadline: now })).disposition, 'selected')
  assert.equal(decide(item({ deadline: now - 1 })).disposition, 'selected')
  assert.equal(decide(item({ lastComplete: { checkedAt: now - hour, generation: 'g1', scope: 'all-users' }, lastAttempt: null, deadline: now + hour })).dueAt, now)
})
test('retry-not-before respects exact boundary and does not erase deadline misses', () => {
  for (const offset of [-1, 0, 1]) {
    const decision = decide(item({ deadline: now, retryNotBefore: now + offset }))
    assert.equal(decision.disposition, offset > 0 ? 'deferred' : 'selected')
    assert.ok(decision.reasons.includes('deadline_due'))
    assert.equal(decision.reasons.includes('retry_not_before'), offset > 0)
  }
})
test('valid complete dependency allows selection, even while prerequisite is not due', () => {
  const result = planSourceWork([dependent(), item()], now, budget)
  assert.equal(result.selected.length, 1)
  assert.equal(result.selected[0].source, 'MEMBERSHIP')
})
test('selected prerequisite is not treated as completed in this plan', () => {
  const result = planSourceWork([dependent(), item({ lastComplete: null, lastAttempt: null })], now, budget)
  assert.deepEqual(result.selected.map(value => value.source), ['USERS'])
  assert.ok(result.decisions[0].reasons.includes('dependency_unverified'))
})
test('dependencies cannot borrow evidence from another tenant', () => {
  const result = planSourceWork([dependent(), item({ tenantId: 'b' })], now, budget)
  assert.equal(result.decisions[0].disposition, 'blocked')
  assert.ok(result.decisions[0].reasons.includes('missing_dependency'))
})
test('dependency generation and declared scope must match exactly', () => {
  for (const [dep, reason] of [
    [{ requiredGeneration: 'g2' }, 'dependency_generation_mismatch'],
    [{ scope: 'direct-only-users' }, 'dependency_scope_mismatch'],
  ] as const) {
    const result = planSourceWork([item(), dependent({}, dep)], now, budget)
    assert.equal(result.decisions[1].disposition, 'blocked')
    assert.ok(result.decisions[1].reasons.includes(reason))
  }
})
test('even a recently complete dependent is blocked on incompatible dependency evidence', () => {
  const result = planSourceWork([item(), dependent({ lastComplete: { checkedAt: now - 1, generation: 'm1', scope: 'declared-membership' } }, { requiredGeneration: 'g2' })], now, budget)
  assert.equal(result.decisions[1].disposition, 'blocked')
  assert.ok(result.decisions[1].reasons.includes('dependency_generation_mismatch'))
})
test('dependency ages use the stricter caller contract at exact boundary', () => {
  for (const maxAgeMs of [1, hour]) {
    const prerequisite = item({ maxAgeMs, lastComplete: { checkedAt: now - 1, generation: 'g1', scope: 'all-users' }, lastAttempt: null })
    const result = planSourceWork([prerequisite, dependent({}, { maxAgeMs: 1 })], now, budget)
    assert.ok(result.decisions[1].reasons.includes('dependency_stale'))
  }
  const result = planSourceWork([item({ maxAgeMs: 1 }), dependent()], now, budget)
  assert.ok(result.decisions[1].reasons.includes('dependency_stale'))
})
test('duplicate tenant/source inputs block both and their dependent', () => {
  const result = planSourceWork([item(), dependent(), item()], now, budget)
  assert.deepEqual(result.decisions[0].reasons, ['duplicate_source'])
  assert.deepEqual(result.decisions[2].reasons, ['duplicate_source'])
  assert.ok(result.decisions[1].reasons.includes('dependency_invalid'))
})
test('invalid dependency records, duplicate declarations and self-dependencies block', () => {
  assert.ok(planSourceWork([item({ deadline: NaN }), dependent()], now, budget).decisions[1].reasons.includes('dependency_invalid'))
  const d = dependent().dependencies[0]
  for (const dependencies of [[d, d], [{ ...d, source: 'MEMBERSHIP' }], [{ ...d, requiredGeneration: '' }], [{ ...d, maxAgeMs: 0 }]]) {
    assert.deepEqual(decide(dependent({ dependencies })).reasons, ['invalid_input'])
  }
})
test('item and cost bounds hold and oversize work does not hide fitting work', () => {
  const input = [item({ source: 'large', deadline: now - 3, estimatedCost: 11 }), item({ source: 'b', deadline: now - 2, estimatedCost: 3 }), item({ source: 'c', deadline: now - 1, estimatedCost: 2 })]
  const result = planSourceWork(input, now, { maxItems: 1, maxEstimatedCost: 10 })
  assert.deepEqual(result.selected.map(value => value.source), ['b'])
  assert.equal(result.estimatedCost, 3)
  assert.ok(result.decisions[0].reasons.includes('budget'))
  assert.ok(result.decisions[2].reasons.includes('budget'))
  assert.equal(planSourceWork(input, now, { maxItems: 0, maxEstimatedCost: 10 }).selected.length, 0)
  assert.equal(planSourceWork(input, now, { maxItems: 10, maxEstimatedCost: 0 }).selected.length, 0)
})
test('deadline ordering is deterministic across input permutations and tenants', () => {
  const a = item({ tenantId: 'a', deadline: now })
  const b = item({ tenantId: 'b', deadline: now - 1 })
  for (const input of [[a, b], [b, a]]) {
    const result = planSourceWork(input, now, budget)
    assert.deepEqual(result.selected.map(value => value.tenantId), ['b', 'a'])
    assert.deepEqual(result.decisions.map(value => value.inputIndex), [0, 1])
  }
})
test('planning is deterministic and does not mutate caller inputs', () => {
  const input = [item({ deadline: now }), dependent()]
  const before = JSON.stringify(input)
  const first = planSourceWork(input, now, budget)
  assert.deepEqual(first, planSourceWork(input, now, budget))
  assert.equal(JSON.stringify(input), before)
})
test('invalid budgets and planning times are rejected; invalid costs block individually', () => {
  for (const invalid of [NaN, Infinity, -1, 0.5]) {
    assert.throws(() => planSourceWork([], invalid, budget), RangeError)
    assert.throws(() => planSourceWork([], now, { ...budget, maxItems: invalid }), RangeError)
    assert.throws(() => planSourceWork([], now, { ...budget, maxEstimatedCost: invalid }), RangeError)
  }
  for (const estimatedCost of [0, -1, Infinity, 0.1]) assert.deepEqual(decide(item({ estimatedCost })).reasons, ['invalid_input'])
  assert.deepEqual(planSourceWork([], now, budget), { selected: [], decisions: [], estimatedCost: 0 })
})

test('invalid evidence propagates through dependency chains', () => {
  const users = item({ lastAttempt: { startedAt: now, outcome: 'partial' } })
  const membership = dependent({ lastComplete: { checkedAt: now - 1, generation: 'm1', scope: 'declared-membership' } })
  const roles = item({ source: 'ROLES', deadline: now, dependencies: [{ source: 'MEMBERSHIP', scope: 'declared-membership', requiredGeneration: 'm1', maxAgeMs: hour }] })
  const result = planSourceWork([roles, membership, users], now, budget)
  assert.ok(result.decisions[0].reasons.includes('dependency_unverified'))
  assert.equal(result.decisions[0].disposition, 'blocked')
})
test('dependency cycles and sources depending on them are explicitly blocked', () => {
  const users = item({ dependencies: [{ source: 'MEMBERSHIP', scope: 'declared-membership', requiredGeneration: 'm1', maxAgeMs: hour }] })
  const membership = dependent({ lastComplete: { checkedAt: now - 1, generation: 'm1', scope: 'declared-membership' } })
  const roles = item({ source: 'ROLES', deadline: now, dependencies: [{ source: 'USERS', scope: 'all-users', requiredGeneration: 'g1', maxAgeMs: hour }] })
  const result = planSourceWork([roles, membership, users], now, budget)
  assert.equal(result.selected.length, 0)
  for (const decision of result.decisions) {
    assert.equal(decision.disposition, 'blocked')
    assert.ok(decision.reasons.includes('dependency_cycle'))
  }
})
test('opaque tenant/source keys cannot collide through delimiters', () => {
  const result = planSourceWork([item({ tenantId: 'a:b', source: 'c', deadline: now }), item({ tenantId: 'a', source: 'b:c', deadline: now })], now, budget)
  assert.equal(result.selected.length, 2)
})
test('exact cost budget fits without rounding and overflowed expiry blocks', () => {
  assert.equal(planSourceWork([item({ deadline: now, estimatedCost: 10 })], now, { maxItems: 1, maxEstimatedCost: 10 }).estimatedCost, 10)
  assert.deepEqual(decide(item({ maxAgeMs: Number.MAX_SAFE_INTEGER })).reasons, ['invalid_input'])
})

test('ordinary successful start before completion is fresh and dependency-eligible', () => {
  const prerequisite = item({ lastAttempt: { startedAt: now - 1000, outcome: 'complete' } })
  const result = planSourceWork([prerequisite, dependent()], now, budget)
  assert.deepEqual(result.decisions[0].reasons, ['fresh'])
  assert.deepEqual(result.selected.map(value => value.source), ['MEMBERSHIP'])
  assert.equal(prerequisite.lastAttempt!.startedAt, now - 1000)
  assert.equal(prerequisite.lastComplete!.checkedAt, now - 1)
})
test('freshness age is measured from successful completion, never attempt start', () => {
  const prerequisite = item({ lastAttempt: { startedAt: now - 2 * hour, outcome: 'complete' } })
  assert.deepEqual(decide(prerequisite).reasons, ['fresh'])
  assert.equal(planSourceWork([prerequisite, dependent()], now, budget).decisions[1].disposition, 'selected')
})
test('backwards successful clocks and future starts/completions block dependencies', () => {
  for (const prerequisite of [
    item({ lastAttempt: { startedAt: now, outcome: 'complete' } }),
    item({ lastAttempt: { startedAt: now + 1, outcome: 'complete' } }),
    item({ lastComplete: { checkedAt: now + 1, generation: 'g1', scope: 'all-users' } }),
  ]) {
    const result = planSourceWork([prerequisite, dependent()], now, budget)
    assert.deepEqual(result.decisions[0].reasons, ['invalid_input'])
    assert.ok(result.decisions[1].reasons.includes('dependency_invalid'))
    assert.equal(result.selected.length, 0)
  }
})
for (const outcome of ['failed', 'partial'] as const) {
  test(`prior success followed by later ${outcome} preserves success clock but blocks dependency`, () => {
    const prerequisite = item({
      lastComplete: { checkedAt: now - 5000, generation: 'g1', scope: 'all-users' },
      lastAttempt: { startedAt: now - 1000, outcome },
      retryNotBefore: now + 1000,
    })
    const result = planSourceWork([prerequisite, dependent()], now, budget)
    assert.equal(result.decisions[0].disposition, 'deferred')
    assert.ok(result.decisions[0].reasons.includes(outcome))
    assert.ok(result.decisions[0].reasons.includes('retry_not_before'))
    assert.ok(result.decisions[1].reasons.includes('dependency_unverified'))
    assert.equal(prerequisite.lastComplete!.checkedAt, now - 5000)
    assert.equal(result.selected.length, 0)
  })
}
test('equal start/completion is valid but a later failure cannot precede historical success', () => {
  assert.deepEqual(decide(item()).reasons, ['fresh'])
  for (const outcome of ['failed', 'partial', 'skipped', 'running'] as const) {
    assert.deepEqual(decide(item({ lastAttempt: { startedAt: now - 2, outcome } })).reasons, ['invalid_input'])
  }
})
