import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertTenantVisitLifecycleActive, runTenantVisitLifecycle,
  TENANT_VISIT_DURATION_MS, tenantVisitLifecycleEnabled,
  type TenantVisitLifecycleClock, type TenantVisitLifecycleStore,
} from './tenant-visit-lifecycle.js'
import {
  tenantVisitLeaseLossAt, tenantVisitLeaseLossDiagnostic,
} from './tenant-visit-lease-diagnostics.js'
import { TenantVisitLeaseLostError, tenantVisitLeaseLoss } from './tenant-visit-lease-error.js'
import { assertTenantVisitLeaseOwner } from './tenant-visit-lease-store.js'

const scope = { organizationId: 'organization', customerTenantId: 'tenant' }
const owner = { ...scope, token: 'token', generation: 7n, expiresAt: new Date('2030-01-01') }
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
function fixture(visitOwner: typeof owner = owner) {
  const events: string[] = []
  let now = 0
  let timer: (() => void) | undefined
  const timing: TenantVisitLifecycleClock = {
    now: () => now,
    schedule: work => { assert.equal(timer, undefined); timer = work; return work },
    cancel: handle => { assert.equal(handle, timer); timer = undefined; events.push('cancel') },
  }
  const store: TenantVisitLifecycleStore = {
    acquire: async (actualScope, duration) => {
      assert.deepEqual(actualScope, scope); assert.equal(duration, TENANT_VISIT_DURATION_MS)
      events.push('acquire'); return visitOwner
    },
    renew: async actual => { assert.equal(actual, visitOwner); events.push('renew'); return { ...visitOwner } },
    release: async actual => { assert.equal(actual, visitOwner); events.push('release'); return true },
  }
  return { events, timing, store, advance: (amount: number) => { now += amount },
    fire: () => { const work = timer; assert.ok(work); timer = undefined; work() },
    hasTimer: () => Boolean(timer) }
}

test('tenant visit rollout is OFF unless the exact internal value is enabled', () => {
  for (const value of [undefined, '', 'true', '1', 'ENABLED']) {
    assert.equal(tenantVisitLifecycleEnabled({ HAWKVIEW_TENANT_VISIT_FENCING: value }), false)
  }
  assert.equal(tenantVisitLifecycleEnabled({ HAWKVIEW_TENANT_VISIT_FENCING: 'enabled' }), true)
})

test('busy admission performs no work, renewal or release', async () => {
  const f = fixture()
  f.store.acquire = async () => null
  assert.deepEqual(await runTenantVisitLifecycle(f.store, scope, async () => assert.fail('work'), f.timing), { status: 'busy' })
  assert.deepEqual(f.events, [])
  assert.equal(f.hasTimer(), false)
})

test('normal visit holds exact owner until all work completes and cancels renewal', async () => {
  const f = fixture(), finish = deferred()
  const running = runTenantVisitLifecycle(f.store, scope, async actual => {
    assert.equal(actual, owner); f.events.push('work'); await finish.promise
    f.events.push('work-settled'); return 42
  }, f.timing)
  await flush()
  assert.deepEqual(f.events, ['acquire', 'work'])
  finish.resolve()
  assert.deepEqual(await running, { status: 'completed', value: 42 })
  assert.deepEqual(f.events, ['acquire', 'work', 'work-settled', 'cancel', 'release'])
  assert.equal(f.hasTimer(), false)
})

test('renewal is serial and cleanup drains an in-flight renewal before release', async () => {
  const f = fixture(), renewed = deferred<typeof owner | null>(), finish = deferred()
  let renewals = 0
  f.store.renew = async actual => { assert.equal(actual, owner); renewals++; return renewed.promise }
  const running = runTenantVisitLifecycle(f.store, scope, async () => finish.promise, f.timing)
  await flush(); f.fire(); await flush()
  assert.equal(renewals, 1)
  assert.equal(f.hasTimer(), false, 'no concurrent renewal can be queued')
  finish.resolve(); await flush()
  assert.equal(f.events.includes('release'), false)
  renewed.resolve(owner)
  await running
  assert.equal(renewals, 1)
  assert.equal(f.hasTimer(), false)
  assert.equal(f.events.at(-1), 'release')
})

test('renewal rejection immediately blocks materialization before lease expiry and still drains work', async () => {
  const f = fixture(), afterLoss = deferred(), finish = deferred()
  f.store.renew = async () => { throw new Error('closed synthetic connection') }
  const running = runTenantVisitLifecycle(f.store, scope, async () => {
    await afterLoss.promise
    await assert.rejects(() => assertTenantVisitLeaseOwner({
      $queryRawUnsafe: async () => assert.fail('must not start SQL after renewal uncertainty'),
    }, owner), TenantVisitLeaseLostError)
    f.events.push('rejected-write')
    await finish.promise
  }, f.timing)
  const rejected = assert.rejects(running, TenantVisitLeaseLostError)
  await flush(); f.fire(); await flush(); afterLoss.resolve(); await flush()
  assert.equal(f.events.includes('rejected-write'), true)
  assert.equal(f.events.includes('release'), false)
  finish.resolve(); await rejected
  assert.equal(f.events.at(-1), 'release')
})

test('renewal cannot revive a null or foreign-generation owner', async () => {
  for (const next of [null, { ...owner, generation: 8n }, { ...owner, token: 'successor' }]) {
    const f = fixture(), finish = deferred()
    f.store.renew = async () => next
    const running = runTenantVisitLifecycle(f.store, scope, async () => finish.promise, f.timing)
    const rejected = assert.rejects(running, TenantVisitLeaseLostError)
    await flush(); f.fire(); await flush(); finish.resolve(); await rejected
    assert.equal(f.hasTimer(), false)
    assert.equal(f.events.at(-1), 'release')
  }
})

test('successful renewal extends the local deadline without replacing the exact owner', async () => {
  const f = fixture(), finish = deferred()
  const running = runTenantVisitLifecycle(f.store, scope, async actual => {
    await finish.promise
    assert.equal(actual, owner)
    assertTenantVisitLifecycleActive(actual)
    return 'complete'
  }, f.timing)
  await flush(); f.advance(TENANT_VISIT_DURATION_MS - 1000); f.fire(); await flush()
  assert.equal(f.hasTimer(), true)
  f.advance(2000); finish.resolve()
  assert.deepEqual(await running, { status: 'completed', value: 'complete' })
})

test('a mismatched acquired scope is released without any work', async () => {
  const f = fixture()
  const foreign = { ...owner, customerTenantId: 'foreign' }
  f.store.acquire = async () => foreign
  f.store.release = async actual => { assert.equal(actual, foreign); f.events.push('release'); return true }
  await assert.rejects(runTenantVisitLifecycle(f.store, scope, async () => assert.fail('work'), f.timing), TenantVisitLeaseLostError)
  assert.deepEqual(f.events, ['release'])
})

test('late timer and elapsed acquisition cannot manufacture a live owner', async () => {
  const f = fixture()
  const acquire = f.store.acquire
  f.store.acquire = async (...args) => { const acquired = await acquire(...args); f.advance(TENANT_VISIT_DURATION_MS); return acquired }
  await assert.rejects(runTenantVisitLifecycle(f.store, scope, async () => assert.fail('work'), f.timing), TenantVisitLeaseLostError)
  assert.deepEqual(f.events, ['acquire', 'release'])

  const g = fixture(), finish = deferred()
  const running = runTenantVisitLifecycle(g.store, scope, async () => finish.promise, g.timing)
  const rejected = assert.rejects(running, TenantVisitLeaseLostError)
  await flush(); g.advance(TENANT_VISIT_DURATION_MS); g.fire(); finish.resolve(); await rejected
  assert.equal(g.events.includes('renew'), false)
})

test('release uncertainty rejects success and exact provider errors survive successful cleanup', async () => {
  for (const throws of [false, true]) {
    const f = fixture()
    f.store.release = async () => { if (throws) throw new Error('unknown commit'); return false }
    await assert.rejects(runTenantVisitLifecycle(f.store, scope, async () => 42, f.timing), TenantVisitLeaseLostError)
  }
  const f = fixture(), provider = new Error('synthetic provider error')
  await assert.rejects(runTenantVisitLifecycle(f.store, scope, async () => { throw provider }, f.timing), error => error === provider)
  assert.equal(f.events.at(-1), 'release')
})

test('a completed asynchronous context cannot start delayed owned work', async () => {
  const f = fixture(), delayed = deferred(), done = deferred()
  await runTenantVisitLifecycle(f.store, scope, async () => {
    void delayed.promise.then(() => {
      assert.throws(() => assertTenantVisitLifecycleActive(owner), TenantVisitLeaseLostError)
      done.resolve()
    })
  }, f.timing)
  delayed.resolve(); await done.promise
})

/* ---------------- bounded ownership-loss diagnosis ---------------- */

const UNSPECIFIED = { phase: 'unspecified', reason: 'unspecified' }
/** Read the pair from whatever the lifecycle actually threw. */
const pairOf = (error: unknown) => tenantVisitLeaseLossDiagnostic(error)

/**
 * The pair of a GENUINE classified ownership loss. The failure assertions sit
 * OUTSIDE the catch on purpose: asserting inside it would let this helper
 * catch its own AssertionError and return `unspecified`, so a visit that
 * resolved successfully would silently satisfy every `unspecified` expectation.
 */
async function pairFromRejection(running: Promise<unknown>) {
  let caught: unknown
  let resolved = false
  try { await running; resolved = true } catch (error) { caught = error }
  assert.equal(resolved, false, 'the visit must reject, not resolve')
  const lost = tenantVisitLeaseLoss(caught)
  assert.ok(lost, 'the rejection must be a recognized ownership loss')
  return tenantVisitLeaseLossDiagnostic(lost)
}

test('the loss-pair helper itself refuses a resolved visit and an ordinary rejection', async () => {
  const resolving = fixture()
  await assert.rejects(
    pairFromRejection(runTenantVisitLifecycle(resolving.store, scope, async () => 'fine', resolving.timing)),
    /must reject, not resolve/, 'a successful visit must fail the helper, never read as unspecified',
  )
  const ordinary = fixture()
  await assert.rejects(
    pairFromRejection(runTenantVisitLifecycle(ordinary.store, scope, async () => {
      throw new Error('synthetic provider error')
    }, ordinary.timing)),
    /recognized ownership loss/, 'an unclassified rejection must fail the helper',
  )
})

test('a hostile cause accessor cannot change what the lifecycle rethrows', async () => {
  // Diagnosis reads `.cause`. If that read threw inside the work catch it
  // would propagate past cleanup in place of the original error, and would
  // also skip the cleanup-loss precedence after the try/finally.
  const hostile = () => {
    const error = new Error('synthetic outer')
    Object.defineProperty(error, 'cause', {
      get() { throw new Error('synthetic-secret cause accessor') },
    })
    return error
  }

  const succeeding = fixture(), original = hostile()
  await assert.rejects(
    runTenantVisitLifecycle(succeeding.store, scope, async () => { throw original }, succeeding.timing),
    error => {
      assert.equal(error, original, 'the exact original work error must be rethrown')
      assert.equal((error as Error).message, 'synthetic outer')
      return true
    },
  )
  assert.equal(succeeding.events.at(-1), 'release')

  // With release uncertainty the visit must still become the expected
  // ownership loss, carrying cleanup's own reason.
  const uncertain = fixture()
  uncertain.store.release = async () => false
  assert.deepEqual(
    await pairFromRejection(
      runTenantVisitLifecycle(uncertain.store, scope, async () => { throw hostile() }, uncertain.timing)),
    { phase: 'release', reason: 'no_matching_owner' },
  )
})

test('each renewal refusal records its own bounded reason', async () => {
  // The renewal matched no row for this exact owner. That alone does not
  // distinguish replacement, expiry, or a missing/invisible row.
  for (const [next, reason] of [
    [null, 'no_matching_owner'],
    [{ ...owner, generation: 8n }, 'owner_mismatch'],
    [{ ...owner, token: 'successor' }, 'owner_mismatch'],
  ] as const) {
    const f = fixture(), finish = deferred()
    f.store.renew = async () => next
    const running = runTenantVisitLifecycle(f.store, scope, async () => finish.promise, f.timing)
    await flush(); f.fire(); await flush(); finish.resolve()
    assert.deepEqual(await pairFromRejection(running), { phase: 'renewal', reason }, String(reason))
  }

  // The store rejected the renewal. Any transaction failure lands here; the
  // reason is not retained and ownership may still be held.
  const rejecting = fixture(), rejected = deferred()
  rejecting.store.renew = async () => { throw new Error('synthetic lock_timeout') }
  const running = runTenantVisitLifecycle(rejecting.store, scope, async () => rejected.promise, rejecting.timing)
  await flush(); rejecting.fire(); await flush(); rejected.resolve()
  assert.deepEqual(await pairFromRejection(running),
    { phase: 'renewal', reason: 'store_rejected' })
})

test('a renewal that returns the exact owner too late is recorded as a late response', async () => {
  const f = fixture(), renewed = deferred<typeof owner>(), finish = deferred()
  f.store.renew = async () => renewed.promise
  const running = runTenantVisitLifecycle(f.store, scope, async () => finish.promise, f.timing)
  await flush(); f.fire(); await flush()
  // The store answers with the same owner, but only after the whole window.
  f.advance(TENANT_VISIT_DURATION_MS)
  renewed.resolve({ ...owner }); await flush(); finish.resolve()
  assert.deepEqual(await pairFromRejection(running), { phase: 'renewal', reason: 'response_late' })
})

test('a renewal timer that fires at or after the deadline never reaches the store', async () => {
  const f = fixture(), finish = deferred()
  f.store.renew = async () => assert.fail('an elapsed deadline must not start a renewal')
  const running = runTenantVisitLifecycle(f.store, scope, async () => finish.promise, f.timing)
  await flush(); f.advance(TENANT_VISIT_DURATION_MS); f.fire(); finish.resolve()
  assert.deepEqual(await pairFromRejection(running), { phase: 'renewal', reason: 'deadline_elapsed' })
  assert.equal(f.events.includes('renew'), false)
})

test('local guards record which guard refused, without consulting the store', async () => {
  const elapsed = fixture()
  const running = runTenantVisitLifecycle(elapsed.store, scope, async () => {
    elapsed.advance(TENANT_VISIT_DURATION_MS)
  }, elapsed.timing)
  assert.deepEqual(await pairFromRejection(running), { phase: 'local_guard', reason: 'deadline_elapsed' })
  assert.equal(elapsed.events.includes('renew'), false)

  const mismatch = fixture()
  const other = { ...owner, token: 'someone-else' }
  const mismatching = runTenantVisitLifecycle(mismatch.store, scope, async () => {
    assert.throws(() => assertTenantVisitLifecycleActive(other), TenantVisitLeaseLostError)
  }, mismatch.timing)
  assert.deepEqual(await pairFromRejection(mismatching), { phase: 'local_guard', reason: 'owner_mismatch' })

  const closed = fixture(), delayed = deferred(), done = deferred<unknown>()
  await runTenantVisitLifecycle(closed.store, scope, async () => {
    void delayed.promise.then(() => {
      try { assertTenantVisitLifecycleActive(owner); done.resolve(undefined) }
      catch (error) { done.resolve(error) }
    })
  }, closed.timing)
  delayed.resolve()
  assert.deepEqual(pairOf(await done.promise), { phase: 'local_guard', reason: 'context_closed' })
})

test('a mismatched acquired scope records the admission branch', async () => {
  const foreign = { ...owner, customerTenantId: 'foreign' }
  const f = fixture(foreign)
  assert.deepEqual(
    await pairFromRejection(runTenantVisitLifecycle(f.store, scope, async () => assert.fail('work'), f.timing)),
    { phase: 'admission', reason: 'scope_mismatch' },
  )
  assert.deepEqual(f.events, ['acquire', 'release'], 'a mismatched lease is released with no work')
})

test('cleanup records its own branch only when no earlier loss was recognized', async () => {
  for (const [release, reason] of [
    [async () => false, 'no_matching_owner'],
    [async () => { throw new Error('synthetic unknown commit') }, 'store_rejected'],
  ] as const) {
    // Work succeeded, so cleanup is genuinely the first and only loss.
    const f = fixture()
    f.store.release = release as typeof f.store.release
    assert.deepEqual(
      await pairFromRejection(runTenantVisitLifecycle(f.store, scope, async () => 42, f.timing)),
      { phase: 'release', reason }, String(reason),
    )
    // An ordinary provider error plus release uncertainty must STILL become an
    // ownership loss, and cleanup keeps its own reason because the provider
    // error is not a recognized loss.
    const g = fixture()
    g.store.release = release as typeof g.store.release
    const provider = new Error('synthetic provider error')
    assert.deepEqual(
      await pairFromRejection(runTenantVisitLifecycle(g.store, scope, async () => { throw provider }, g.timing)),
      { phase: 'release', reason }, String(reason),
    )
  }
})

test('the exact outward wrapper survives successful cleanup and is still classified by its cause', async () => {
  const f = fixture()
  const inner = new TenantVisitLeaseLostError()
  const wrapper = new Error('synthetic wrapper', { cause: inner })
  await assert.rejects(
    runTenantVisitLifecycle(f.store, scope, async () => { throw wrapper }, f.timing),
    error => {
      assert.equal(error, wrapper, 'the exact wrapper instance must be rethrown, not its inner cause')
      assert.equal((error as Error).name, 'Error')
      assert.equal((error as Error).message, 'synthetic wrapper')
      assert.equal((error as Error).cause, inner)
      assert.equal(error instanceof TenantVisitLeaseLostError, false)
      return true
    },
  )
  assert.equal(f.events.at(-1), 'release')
  assert.equal(tenantVisitLeaseLoss(wrapper), inner, 'the classifier still recognizes it through its cause')
  assert.deepEqual(pairOf(wrapper), UNSPECIFIED)
})

test('a direct work loss keeps its own identity through successful cleanup', async () => {
  const f = fixture()
  const direct = tenantVisitLeaseLossAt('local_guard', 'owner_mismatch')
  await assert.rejects(
    runTenantVisitLifecycle(f.store, scope, async () => { throw direct }, f.timing),
    error => { assert.equal(error, direct); return true },
  )
  assert.deepEqual(pairOf(direct), { phase: 'local_guard', reason: 'owner_mismatch' })
  assert.equal(f.events.at(-1), 'release')
})

test('an ordinary error survives successful cleanup with its exact identity and no pair', async () => {
  const f = fixture(), provider = new Error('synthetic provider error')
  await assert.rejects(
    runTenantVisitLifecycle(f.store, scope, async () => { throw provider }, f.timing),
    error => { assert.equal(error, provider); return true },
  )
  assert.equal(tenantVisitLeaseLoss(provider), null)
})

test('failing cleanup cannot relabel an earlier work loss it did not cause', async () => {
  // An unlabelled loss from an existing collector site: cleanup must not claim
  // it. The thrown value stays whatever the base lifecycle throws.
  for (const work of [
    () => { throw new TenantVisitLeaseLostError() },
    () => { throw new Error('synthetic wrapper', { cause: new TenantVisitLeaseLostError() }) },
  ]) {
    const f = fixture()
    f.store.release = async () => false
    assert.deepEqual(
      await pairFromRejection(runTenantVisitLifecycle(f.store, scope, async () => work(), f.timing)),
      UNSPECIFIED, 'an earlier unlabelled loss must not be reported as a release failure',
    )
  }
  // A labelled earlier loss keeps its own pair through failing cleanup.
  const f = fixture()
  f.store.release = async () => { throw new Error('synthetic unknown commit') }
  const labelled = tenantVisitLeaseLossAt('renewal', 'no_matching_owner')
  assert.deepEqual(
    await pairFromRejection(runTenantVisitLifecycle(f.store, scope, async () => { throw labelled }, f.timing)),
    { phase: 'renewal', reason: 'no_matching_owner' },
  )
})

test('the first recorded loss wins over every later one', async () => {
  const f = fixture(), finish = deferred()
  f.store.renew = async () => { throw new Error('synthetic lock_timeout') }
  f.store.release = async () => false
  const running = runTenantVisitLifecycle(f.store, scope, async () => finish.promise, f.timing)
  await flush(); f.fire(); await flush(); finish.resolve()
  assert.deepEqual(await pairFromRejection(running),
    { phase: 'renewal', reason: 'store_rejected' }, 'a later release failure cannot overwrite it')
})

test('separate visits keep separate losses and pairs', async () => {
  const losing = fixture(), healthy = fixture({ ...owner, token: 'second-visit' })
  losing.store.renew = async () => null
  const lose = deferred(), keep = deferred<string>()
  const failing = runTenantVisitLifecycle(losing.store, scope, async () => lose.promise, losing.timing)
  const succeeding = runTenantVisitLifecycle(healthy.store, scope, async () => keep.promise, healthy.timing)
  await flush(); losing.fire(); await flush()
  lose.resolve(); keep.resolve('intact')
  assert.deepEqual(await pairFromRejection(failing), { phase: 'renewal', reason: 'no_matching_owner' })
  assert.deepEqual(await succeeding, { status: 'completed', value: 'intact' })
})

test('a recorded pair cannot be forged, mutated or widened at the error', () => {
  const labelled = tenantVisitLeaseLossAt('renewal', 'store_rejected')
  Object.assign(labelled, { phase: 'admission', reason: 'synthetic-secret' })
  assert.deepEqual(pairOf(labelled), { phase: 'renewal', reason: 'store_rejected' },
    'the pair comes from private storage, never from the error own properties')
  assert.deepEqual(Object.keys(pairOf(labelled)), ['phase', 'reason'])
  assert.equal(Object.isFrozen(pairOf(labelled)), true)

  // Unlabelled, impersonating, doubly wrapped and non-error values.
  assert.deepEqual(pairOf(new TenantVisitLeaseLostError()), UNSPECIFIED)
  assert.deepEqual(pairOf(Object.assign(new Error('x'), {
    name: 'TenantVisitLeaseLostError', phase: 'renewal', reason: 'store_rejected',
  })), UNSPECIFIED)
  assert.deepEqual(pairOf(new Error('outer', {
    cause: new Error('inner', { cause: tenantVisitLeaseLossAt('renewal', 'store_rejected') }),
  })), UNSPECIFIED, 'single-cause recognition must not be widened')
  for (const value of [undefined, null, 'string', 0, {}, []]) {
    assert.deepEqual(pairOf(value), UNSPECIFIED, String(value))
  }

  // A hostile `cause` accessor must not turn diagnosis into a new throw.
  const throwingCause = new Error('synthetic outer')
  Object.defineProperty(throwingCause, 'cause', {
    get() { throw new Error('synthetic-secret cause accessor') },
  })
  assert.deepEqual(pairOf(throwingCause), UNSPECIFIED)

  // A pair outside the closed table is refused at emission, without throwing.
  for (const invalid of [
    ['renewal', 'synthetic-secret'], ['release', 'deadline_elapsed'],
    ['admission', 'store_rejected'], ['__proto__', 'unspecified'],
    ['constructor', 'unspecified'], ['toString', 'unspecified'],
    ['', ''], ['unspecified', 'scope_mismatch'],
  ] as Array<[string, string]>) {
    assert.deepEqual(
      pairOf(tenantVisitLeaseLossAt(...(invalid as unknown as ['unspecified', 'unspecified']))),
      UNSPECIFIED, invalid.join('/'),
    )
  }
})

/**
 * Work throws FIRST, while a renewal is still in flight. `finally` must drain
 * that renewal before release, the outward error must stay whatever the base
 * lifecycle throws, and the pair must come from the earlier work loss -- the
 * one ordering `carryTenantVisitLeaseLossPair` exists for, and the one neither
 * renewal-before-work nor work-before-release covers.
 */
async function lateRenewalRace(
  settleRenewal: (resolve: (value: typeof owner | null | PromiseLike<typeof owner | null>) => void) => void,
  work: () => never,
) {
  const f = fixture()
  const renewed = deferred<typeof owner | null>()
  f.store.renew = async actual => {
    assert.equal(actual, owner); f.events.push('renew'); return renewed.promise
  }
  const gate = deferred()
  let thrown: unknown
  let resolvedOk = false
  const running = runTenantVisitLifecycle(f.store, scope, async () => {
    await gate.promise
    return work()
  }, f.timing).then(() => { resolvedOk = true }, error => { thrown = error })

  await flush(); f.fire(); await flush()
  assert.deepEqual(f.events, ['acquire', 'renew'], 'the renewal is in flight before the work fails')
  gate.resolve(); await flush()
  assert.equal(f.events.includes('release'), false, 'release must await the in-flight renewal')
  assert.equal(thrown, undefined, 'the visit cannot settle while a renewal is outstanding')

  settleRenewal(renewed.resolve)
  await running
  assert.equal(resolvedOk, false, 'the visit must not report success')
  assert.equal(f.events.at(-1), 'release', 'release runs only after the renewal settled')
  assert.equal(f.hasTimer(), false, 'a settled late renewal cannot reschedule itself while closing')
  return thrown
}

test('a late renewal settles before release and cannot relabel the earlier work loss', async () => {
  // Direct labelled work loss, then a late renewal that matches no row.
  const workLoss = tenantVisitLeaseLossAt('local_guard', 'owner_mismatch')
  const afterNull = await lateRenewalRace(resolve => resolve(null), () => { throw workLoss })
  assert.equal(tenantVisitLeaseLoss(afterNull), afterNull,
    'the outward error is itself a recognized loss instance, not a wrapper')
  assert.notEqual(afterNull, workLoss,
    'base precedence throws the lifecycle-recorded loss, and that identity is unchanged')
  assert.deepEqual(pairOf(afterNull), { phase: 'local_guard', reason: 'owner_mismatch' },
    'the earlier work-loss pair is carried onto the outward error')

  // Singly wrapped labelled work loss, then a late renewal rejection.
  const innerLoss = tenantVisitLeaseLossAt('renewal', 'response_late')
  const wrapper = new Error('synthetic wrapper', { cause: innerLoss })
  const afterRejection = await lateRenewalRace(
    resolve => resolve(Promise.reject(new Error('synthetic store rejection'))),
    () => { throw wrapper })
  assert.equal(tenantVisitLeaseLoss(afterRejection), afterRejection,
    'the outward error is itself a recognized loss instance')
  assert.notEqual(afterRejection, wrapper, 'the wrapper is superseded exactly as the base lifecycle does')
  assert.deepEqual(pairOf(afterRejection), { phase: 'renewal', reason: 'response_late' },
    'a singly wrapped earlier work loss still decides the reported pair')

  // Control: with no earlier recognized loss, the late renewal keeps its own
  // pair, so the carry above is not simply overwriting everything.
  const ordinary = await lateRenewalRace(resolve => resolve(null), () => {
    throw new Error('synthetic provider error')
  })
  assert.deepEqual(pairOf(ordinary), { phase: 'renewal', reason: 'no_matching_owner' })
})
