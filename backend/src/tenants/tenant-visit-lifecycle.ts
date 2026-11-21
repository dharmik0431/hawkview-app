import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import { TenantVisitLeaseLostError, tenantVisitLeaseLoss } from './tenant-visit-lease-error.js'
import type { TenantVisitLeaseOwner, TenantVisitLeaseScope } from './tenant-visit-lease-store.js'

export const TENANT_VISIT_DURATION_MS = 15 * 60_000
export const TENANT_VISIT_RENEW_AFTER_MS = 60_000

/** Deliberately absent from deployment configuration. Partial fencing is OFF. */
export function tenantVisitLifecycleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HAWKVIEW_TENANT_VISIT_FENCING === 'enabled'
}

export interface TenantVisitLifecycleStore {
  acquire(scope: TenantVisitLeaseScope, durationMs: number): Promise<TenantVisitLeaseOwner | null>
  renew(owner: TenantVisitLeaseOwner, durationMs: number): Promise<TenantVisitLeaseOwner | null>
  release(owner: TenantVisitLeaseOwner): Promise<boolean>
}

export interface TenantVisitLifecycleClock {
  now(): number
  schedule(work: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

const clock: TenantVisitLifecycleClock = {
  now: () => performance.now(),
  schedule: (work, delayMs) => setTimeout(work, delayMs),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

interface VisitContext {
  owner: TenantVisitLeaseOwner
  deadline: number
  clock: TenantVisitLifecycleClock
  lost: TenantVisitLeaseLostError | null
  closed: boolean
}
const visits = new AsyncLocalStorage<VisitContext>()

/** Credential reads can have opportunistic writes. Preserve the admitted owner
 * through nested helpers that do not otherwise accept a collector argument. */
export function currentTenantVisitOwner(): TenantVisitLeaseOwner | undefined {
  assertTenantVisitLifecycleActive()
  const owner = visits.getStore()?.owner
  return owner ? { ...owner } : undefined
}

function sameOwner(left: TenantVisitLeaseOwner, right: TenantVisitLeaseOwner) {
  return left.organizationId === right.organizationId && left.customerTenantId === right.customerTenantId &&
    left.token === right.token && left.generation === right.generation
}

/** Local renewal uncertainty is terminal even before the database lease expires. */
export function assertTenantVisitLifecycleActive(owner?: TenantVisitLeaseOwner): void {
  const visit = visits.getStore()
  if (!visit) return
  if (visit.closed || visit.clock.now() >= visit.deadline || (owner && !sameOwner(visit.owner, owner))) {
    visit.lost ??= new TenantVisitLeaseLostError()
  }
  if (visit.lost) throw visit.lost
}

/** A peer's exact ownership failure stops further collector admission. */
export function recordTenantVisitLifecycleFailure(error: unknown): void {
  const lost = tenantVisitLeaseLoss(error)
  const visit = visits.getStore()
  if (lost && visit) visit.lost ??= lost
}

/** Work must await its peers. Cleanup then drains the one possible renewal before
 * exact-owner release; it never releases a lease while an owned collector runs. */
export async function runTenantVisitLifecycle<T>(
  store: TenantVisitLifecycleStore,
  scope: TenantVisitLeaseScope,
  work: (owner: TenantVisitLeaseOwner) => Promise<T>,
  timing: TenantVisitLifecycleClock = clock,
): Promise<{ status: 'busy' } | { status: 'completed'; value: T }> {
  if (visits.getStore()) throw new Error('TENANT_VISIT_NESTED_ADMISSION')
  const startedAt = timing.now()
  const owner = await store.acquire(scope, TENANT_VISIT_DURATION_MS)
  if (!owner) return { status: 'busy' }
  const visit: VisitContext = {
    owner, deadline: startedAt + TENANT_VISIT_DURATION_MS, clock: timing,
    lost: owner.organizationId === scope.organizationId && owner.customerTenantId === scope.customerTenantId
      ? null : new TenantVisitLeaseLostError(), closed: false,
  }
  let timer: unknown
  let renewing: Promise<void> | undefined
  let closing = false
  const schedule = () => {
    if (!closing && !visit.lost) timer = timing.schedule(renew, TENANT_VISIT_RENEW_AFTER_MS)
  }
  const renew = () => {
    timer = undefined
    if (closing || renewing || visit.lost) return
    const renewalStartedAt = timing.now()
    if (renewalStartedAt >= visit.deadline) {
      visit.lost = new TenantVisitLeaseLostError()
      return
    }
    renewing = Promise.resolve().then(() => store.renew(owner, TENANT_VISIT_DURATION_MS)).then(next => {
      if (!next || !sameOwner(owner, next) || timing.now() >= renewalStartedAt + TENANT_VISIT_DURATION_MS) {
        visit.lost ??= new TenantVisitLeaseLostError()
        return
      }
      visit.deadline = renewalStartedAt + TENANT_VISIT_DURATION_MS
    }, () => { visit.lost ??= new TenantVisitLeaseLostError() }).finally(() => {
      renewing = undefined
      schedule()
    })
  }

  let value: T | undefined
  let failure: unknown
  let failed = false
  try {
    await visits.run(visit, async () => {
      assertTenantVisitLifecycleActive(owner)
      schedule()
      value = await work(owner)
      assertTenantVisitLifecycleActive(owner)
    })
  } catch (error) {
    failed = true
    failure = error
  } finally {
    closing = true
    if (timer !== undefined) timing.cancel(timer)
    if (renewing) await renewing
    visit.closed = true
    // Release failure/uncertainty must not become a successful sync response.
    try {
      if (!await store.release(owner)) visit.lost ??= new TenantVisitLeaseLostError()
    } catch {
      visit.lost ??= new TenantVisitLeaseLostError()
    }
  }
  if (visit.lost) throw visit.lost
  if (failed) throw failure
  return { status: 'completed', value: value as T }
}
