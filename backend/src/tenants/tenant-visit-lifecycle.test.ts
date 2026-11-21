import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertTenantVisitLifecycleActive, runTenantVisitLifecycle,
  TENANT_VISIT_DURATION_MS, tenantVisitLifecycleEnabled,
  type TenantVisitLifecycleClock, type TenantVisitLifecycleStore,
} from './tenant-visit-lifecycle.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'
import { assertTenantVisitLeaseOwner } from './tenant-visit-lease-store.js'

const scope = { organizationId: 'organization', customerTenantId: 'tenant' }
const owner = { ...scope, token: 'token', generation: 7n, expiresAt: new Date('2030-01-01') }
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
function fixture() {
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
      events.push('acquire'); return owner
    },
    renew: async actual => { assert.equal(actual, owner); events.push('renew'); return { ...owner } },
    release: async actual => { assert.equal(actual, owner); events.push('release'); return true },
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
