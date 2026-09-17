import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NotificationScopedRequestGuard,
  notificationRequestScope,
  type NotificationRequestScope,
  type NotificationRequestTicket,
} from './scoped-request-guard.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

type View = {
  value: string | null
  error: string | null
  loading: boolean
  saving: boolean
  notices: string[]
}

async function settle(
  guard: NotificationScopedRequestGuard,
  ticket: NotificationRequestTicket,
  current: () => NotificationRequestScope | null,
  request: Promise<string>,
  view: View,
  mode: 'load' | 'save'
) {
  try {
    const value = await request
    if (!guard.isCurrent(ticket, current())) return
    view.value = value
    if (mode === 'save') view.notices.push(`saved:${value}`)
  } catch {
    if (!guard.isCurrent(ticket, current())) return
    view.error = 'bounded error'
  } finally {
    if (!guard.isCurrent(ticket, current())) return
    if (mode === 'load') view.loading = false
    else view.saving = false
  }
}

const scope = (subject: string, organizationId: string) =>
  notificationRequestScope(subject, organizationId)!

test('a delayed workspace A load cannot replace newer workspace B or clear its loading state', async () => {
  const guard = new NotificationScopedRequestGuard()
  const a = scope('user-1', 'org-a')
  const b = scope('user-1', 'org-b')
  let current: NotificationRequestScope | null = a
  const view: View = { value: null, error: null, loading: true, saving: false, notices: [] }
  const aDeferred = deferred<string>()
  const aTicket = guard.begin(a, 'load')
  const aRun = settle(guard, aTicket, () => current, aDeferred.promise, view, 'load')

  current = b
  guard.setScope(b)
  const bDeferred = deferred<string>()
  const bTicket = guard.begin(b, 'load')
  const bRun = settle(guard, bTicket, () => current, bDeferred.promise, view, 'load')
  bDeferred.resolve('workspace-b')
  await bRun
  assert.deepEqual(view, { value: 'workspace-b', error: null, loading: false, saving: false, notices: [] })

  view.loading = true
  aDeferred.resolve('workspace-a')
  await aRun
  assert.equal(view.value, 'workspace-b')
  assert.equal(view.loading, true, 'stale finally must not clear the current spinner')
})

test('same-workspace overlapping retry ignores the older success, error, and finally', async () => {
  const guard = new NotificationScopedRequestGuard()
  const active = scope('user-1', 'org-a')
  let current: NotificationRequestScope | null = active
  const view: View = { value: null, error: null, loading: true, saving: false, notices: [] }
  const first = deferred<string>()
  const firstRun = settle(guard, guard.begin(active, 'load'), () => current, first.promise, view, 'load')
  const retry = deferred<string>()
  const retryRun = settle(guard, guard.begin(active, 'load'), () => current, retry.promise, view, 'load')

  retry.resolve('retry-result')
  await retryRun
  view.loading = true
  first.reject(new Error('stale raw error'))
  await firstRun
  assert.equal(view.value, 'retry-result')
  assert.equal(view.error, null)
  assert.equal(view.loading, true)
})

test('workspace change fences stale save success, error, finally, and toast', async () => {
  for (const outcome of ['success', 'error'] as const) {
    const guard = new NotificationScopedRequestGuard()
    const a = scope('user-1', 'org-a')
    const b = scope('user-1', 'org-b')
    let current: NotificationRequestScope | null = a
    const view: View = { value: 'workspace-b', error: null, loading: false, saving: true, notices: [] }
    const pending = deferred<string>()
    const run = settle(guard, guard.begin(a, 'save'), () => current, pending.promise, view, 'save')
    current = b
    guard.setScope(b)
    if (outcome === 'success') pending.resolve('workspace-a-saved')
    else pending.reject(new Error('stale raw failure'))
    await run
    assert.equal(view.value, 'workspace-b')
    assert.equal(view.error, null)
    assert.equal(view.saving, true)
    assert.deepEqual(view.notices, [])
  }
})

test('logout and same-workspace user replacement invalidate prior authority', async () => {
  for (const next of [null, scope('user-2', 'org-a')]) {
    const guard = new NotificationScopedRequestGuard()
    const firstUser = scope('user-1', 'org-a')
    let current: NotificationRequestScope | null = firstUser
    const view: View = { value: null, error: null, loading: true, saving: false, notices: [] }
    const pending = deferred<string>()
    const run = settle(guard, guard.begin(firstUser, 'load'), () => current, pending.promise, view, 'load')
    current = next
    guard.setScope(next)
    pending.resolve('old-user-data')
    await run
    assert.equal(view.value, null)
    assert.equal(view.loading, true)
  }
})

test('independent row lanes do not cancel each other inside the same scope', () => {
  const guard = new NotificationScopedRequestGuard()
  const active = scope('user-1', 'org-a')
  const first = guard.begin(active, 'save:alert-a')
  const second = guard.begin(active, 'save:alert-b')
  assert.equal(guard.isCurrent(first, active), true)
  assert.equal(guard.isCurrent(second, active), true)
})

test('A to B to A never revives an old ticket', () => {
  const guard = new NotificationScopedRequestGuard()
  const a = scope('user-1', 'org-a')
  const b = scope('user-1', 'org-b')
  const oldA = guard.begin(a, 'load')
  guard.begin(b, 'load')
  const newA = guard.begin(a, 'load')
  assert.equal(guard.isCurrent(oldA, a), false)
  assert.equal(guard.isCurrent(newA, a), true)
})

test('logout and return to the same user and workspace never revives an old save', () => {
  const guard = new NotificationScopedRequestGuard()
  const active = scope('user-1', 'org-a')
  const beforeLogout = guard.begin(active, 'save')
  guard.setScope(null)
  const afterReturn = guard.begin(active, 'save')
  assert.equal(guard.isCurrent(beforeLogout, active), false)
  assert.equal(guard.isCurrent(afterReturn, active), true)
})

test('a save boundary invalidates an older load without cancelling other save lanes', () => {
  const guard = new NotificationScopedRequestGuard()
  const active = scope('user-1', 'org-a')
  const oldLoad = guard.begin(active, 'load')
  const otherRow = guard.begin(active, 'save:alert-a')
  guard.invalidateLane('load')
  const currentSave = guard.begin(active, 'save:alert-b')
  assert.equal(guard.isCurrent(oldLoad, active), false)
  assert.equal(guard.isCurrent(otherRow, active), true)
  assert.equal(guard.isCurrent(currentSave, active), true)
})

test('negative control demonstrates the stale overwrite that the guard prevents', async () => {
  const oldRequest = deferred<string>()
  const newerRequest = deferred<string>()
  let unguardedValue: string | null = null
  const oldRun = oldRequest.promise.then((value) => { unguardedValue = value })
  const newerRun = newerRequest.promise.then((value) => { unguardedValue = value })
  newerRequest.resolve('new-current-value')
  await newerRun
  oldRequest.resolve('old-stale-value')
  await oldRun
  assert.equal(unguardedValue, 'old-stale-value')
})
