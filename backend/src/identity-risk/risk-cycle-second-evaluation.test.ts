import assert from 'node:assert/strict'
import test from 'node:test'
import { runGlobalRiskCycle } from './risk-global-cycle.js'

/** The second evaluation runs beside the old engine and must be unable to harm
 * it. Everything else in this change is recoverable; this property isn't,
 * because breaking the path customers depend on in order to ship its
 * replacement is the one failure that cannot be walked back after a deploy. */

const scope = {
  organizationId: '00000000-0000-0000-0000-000000000001',
  customerTenantId: '00000000-0000-0000-0000-000000000002',
  environment: 'synthetic',
}

const settings = {
  HAWKVIEW_IDENTITY_RISK_ROLLOUT: 'global', HAWKVIEW_IDENTITY_RISK_MODE: 'shadow',
  HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'wrapped-v1', HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: 'synthetic',
  HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: undefined, SECRET_ENCRYPTION_KEY: '52'.repeat(32),
  DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
} as Record<string, string | undefined>

async function configured(work: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
  try { await work() } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
}

/** One candidate, one clock that does not advance, so the budget never runs out
 * and the only variable is what the second evaluation does. */
function fixture(alsoEvaluate?: (...args: never[]) => Promise<unknown>) {
  const evaluated: string[] = []
  const outcomes: string[] = []
  let handed = 0
  const deps = {
    now: () => 1_000,
    claimCycle: async () => ({ id: 'lease' } as never),
    nextScope: async () => (handed++ === 0 ? scope as never : null),
    releaseCycle: async () => {},
    recordAttempt: async () => 'attempt-1',
    ensure: async () => {},
    evaluate: async () => { evaluated.push('old-engine-run-written') },
    ...(alsoEvaluate ? { alsoEvaluate: alsoEvaluate as never } : {}),
    alsoObserve: (outcome: string) => { outcomes.push(outcome) },
  }
  return { deps, evaluated, outcomes }
}

test('the old engine completes even when the second evaluation throws', async () => {
  await configured(async () => {
    const { deps, evaluated, outcomes } = fixture(async () => { throw new Error('second engine exploded') })

    const result = await runGlobalRiskCycle(deps as never, 100_000)

    // THE PROPERTY. The old engine's run is written and counted as completed —
    // not as failed, which is what would happen if this step sat inside the
    // try/catch that guards it.
    assert.deepEqual(evaluated, ['old-engine-run-written'])
    assert.deepEqual(result, { status: 'COMPLETED', attempted: 1, completed: 1, failed: 0 })
    assert.deepEqual(outcomes, ['FAILED'])
  })
})

test('the cycle behaves identically when the second evaluation is absent', async () => {
  await configured(async () => {
    // Additive means the old path is unchanged when nothing is wired in, so the
    // two results must be indistinguishable — including the return shape, which
    // is one of the old path's outputs. An earlier version of this change added
    // three counters to it and broke four existing tests; that is what the
    // exact-shape assertion below is for.
    const absent = fixture()
    const throwing = fixture(async () => { throw new Error('second engine exploded') })

    const withoutStep = await runGlobalRiskCycle(absent.deps as never, 100_000)
    const withFailingStep = await runGlobalRiskCycle(throwing.deps as never, 100_000)

    assert.deepEqual(withoutStep, withFailingStep)
    assert.deepEqual(absent.evaluated, throwing.evaluated)
    // POSITIVE CONTROL: the step really was absent in one and ran in the other,
    // so the equality above is about the old path being unaffected rather than
    // about neither having run.
    assert.deepEqual(absent.outcomes, [])
    assert.deepEqual(throwing.outcomes, ['FAILED'])
  })
})

test('a second evaluation that hangs to the deadline cannot fail the old engine', async () => {
  await configured(async () => {
    // Not a throw but a stall — the failure a try/catch does not cover. The
    // old engine has already completed and been counted by the time this runs,
    // so the worst a stall can cost is the cycle's own remaining time.
    const { deps, evaluated, outcomes } = fixture(async () => new Promise(resolve => setTimeout(resolve, 25)))

    const result = await runGlobalRiskCycle(deps as never, 100_000)

    assert.deepEqual(evaluated, ['old-engine-run-written'])
    assert.equal(result.completed, 1)
    assert.equal(result.failed, 0)
    assert.deepEqual(outcomes, ['COMPLETED'])
  })
})

test('the second evaluation is skipped rather than truncated when the window is short', async () => {
  await configured(async () => {
    // THE CLOCK HAS TO ADVANCE, and finding that out is worth recording. With
    // the cycle's own constants — admission needs 25s remaining, the floor here
    // is 9s — a frozen clock cannot reach the skip branch at all: anything
    // admissible is above the floor by construction. The only way the remaining
    // window drops below the floor is the OLD engine consuming it, which is
    // exactly the situation the skip exists for.
    //
    // So this models the first evaluation eating 38 of the 45 seconds. My first
    // version of this test used a frozen clock and asserted a skip that could
    // never happen; it failed, which is the only reason I know the branch needs
    // a slow first engine to be reachable at all.
    let clock = 1_000
    let started = false
    const { deps, evaluated, outcomes } = fixture(async () => { started = true })
    const slow = {
      ...deps,
      now: () => clock,
      evaluate: async () => { evaluated.push('old-engine-run-written'); clock = 39_000 },
    }

    const result = await runGlobalRiskCycle(slow as never, 100_000)

    assert.equal(started, false, 'a truncated second answer is worth less than the first one being on time')
    assert.deepEqual(outcomes, ['SKIPPED'])
    // And the old engine still ran and still counted, which is the half that
    // matters when the window is tight.
    assert.deepEqual(evaluated, ['old-engine-run-written'])
    assert.equal(result.completed, 1)
    assert.equal(result.failed, 0)
  })
})
