import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Logger, ServiceUnavailableException } from '@nestjs/common'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantsController } from './tenants.controller.js'
import { assertSyncAdmissionOpen, syncAdmissionPaused } from './sync-admission-pause.js'

function env(t: TestContext, value: string | undefined) {
  const previous = process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED
  if (value === undefined) delete process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED
  else process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED = value
  t.after(() => {
    if (previous === undefined) delete process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED
    else process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED = previous
  })
}

function service() {
  return new TenantSyncService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any)
}

function paused(error: unknown): boolean {
  assert.ok(error instanceof ServiceUnavailableException)
  assert.equal(error.getStatus(), 503)
  assert.deepEqual(error.getResponse(), {
    code: 'TENANT_SYNC_ADMISSION_PAUSED',
    message: 'Tenant synchronization is temporarily unavailable.',
  })
  return true
}

test('admission flag defaults OFF and only exact true pauses', () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1', 'enabled']) {
    assert.equal(syncAdmissionPaused({ HAWKVIEW_SYNC_ADMISSION_PAUSED: value }), false)
    assert.doesNotThrow(() => assertSyncAdmissionOpen({ HAWKVIEW_SYNC_ADMISSION_PAUSED: value }))
  }
  assert.equal(syncAdmissionPaused({ HAWKVIEW_SYNC_ADMISSION_PAUSED: 'true' }), true)
  assert.throws(() => assertSyncAdmissionOpen({ HAWKVIEW_SYNC_ADMISSION_PAUSED: 'true' }), paused)
})

test('paused admission rejects all three production service entries before DB, provider, token or visit work', async t => {
  env(t, 'true')
  const calls: string[] = []
  const sync = service()
  ;(sync as any).getReadableTenant = async () => { calls.push('tenant-db'); throw Error('unreachable') }
  ;(sync as any).readScheduledCandidateWindow = async () => { calls.push('scheduler-db'); throw Error('unreachable') }
  ;(sync as any).verifyExchangeReadOnlyWithinMemoryLane = async () => { calls.push('verify'); throw Error('unreachable') }
  ;(sync as any).syncConnectedTenant = async () => { calls.push('collector'); throw Error('unreachable') }
  for (const fencing of [undefined, 'enabled']) {
    const previous = process.env.HAWKVIEW_TENANT_VISIT_FENCING
    if (fencing === undefined) delete process.env.HAWKVIEW_TENANT_VISIT_FENCING
    else process.env.HAWKVIEW_TENANT_VISIT_FENCING = fencing
    try {
      await assert.rejects(sync.syncUsersForIdentity({} as any, 'tenant'), paused)
      await assert.rejects(sync.verifyExchangeReadOnlyForIdentity({} as any, 'tenant'), paused)
      await assert.rejects(sync.syncDueTenants(Date.now() - 1), paused)
    } finally {
      if (previous === undefined) delete process.env.HAWKVIEW_TENANT_VISIT_FENCING
      else process.env.HAWKVIEW_TENANT_VISIT_FENCING = previous
    }
  }
  assert.deepEqual(calls, [])
})

test('paused Exchange verification rejects before the controller database preflight', async t => {
  env(t, 'true')
  const calls: string[] = []
  const controller = new TenantsController({ assertCanConfigureExchangeReadOnly: async () => {
    calls.push('controller-db')
  } } as any, { verifyExchangeReadOnlyForIdentity: async () => { calls.push('collector') } } as any)
  await assert.rejects(controller.verifyExchangeReadOnly({ auth: {} } as any, 'tenant'), paused)
  assert.deepEqual(calls, [])
})

test('unpaused production entries retain manual, verification and scheduled admission', async t => {
  env(t, 'false')
  const calls: string[] = []
  const sync = service()
  ;(sync as any).getReadableTenant = async () => { calls.push('tenant-db'); return { id: 'tenant' } }
  ;(sync as any).syncConnectedTenant = async () => { calls.push('collector'); return { bundle: { ok: true } } }
  ;(sync as any).verifyExchangeReadOnlyWithinMemoryLane = async () => { calls.push('verify'); return { ok: true } }
  ;(sync as any).readScheduledCandidateWindow = async () => {
    calls.push('scheduler-db'); return { candidateTenants: [], firstSegmentLength: 0 }
  }
  ;(sync as any).logger = { log: () => {} }
  assert.deepEqual(await sync.syncUsersForIdentity({} as any, 'tenant'), { ok: true })
  assert.deepEqual(await sync.verifyExchangeReadOnlyForIdentity({} as any, 'tenant'), { ok: true })
  assert.equal((await sync.syncDueTenants()).due, 0)
  assert.deepEqual(calls, ['tenant-db', 'collector', 'verify', 'scheduler-db'])
})

function deferred() {
  let finish!: () => void
  const promise = new Promise<void>(resolve => { finish = resolve })
  return { promise, finish }
}

test('forward and rollback gate transitions admit no new visit until the preceding version settles', async t => {
  env(t, undefined)
  const events: string[] = []
  async function heldVisit(name: string, gate: ReturnType<typeof deferred>) {
    const sync = service()
    ;(sync as any).getReadableTenant = async () => ({ id: 'tenant' })
    ;(sync as any).syncConnectedTenant = async () => {
      events.push(`${name}:start`)
      await gate.promise
      events.push(`${name}:finish`)
      return { bundle: name }
    }
    const inFlight = sync.syncUsersForIdentity({} as any, 'tenant')
    await Promise.resolve()
    await Promise.resolve()
    assert.ok(events.includes(`${name}:start`))
    return { inFlight }
  }
  const oldGate = deferred()
  const { inFlight: oldVisit } = await heldVisit('old', oldGate)
  process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED = 'true'
  const pausedVersion = service()
  await assert.rejects(pausedVersion.syncUsersForIdentity({} as any, 'tenant'), paused)
  assert.deepEqual(events, ['old:start'])
  oldGate.finish()
  assert.equal(await oldVisit, 'old')

  // After a separately proven drain, a new active version may admit work.
  process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED = 'false'
  const activeGate = deferred()
  const { inFlight: activeVisit } = await heldVisit('active', activeGate)
  process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED = 'true'
  const rollbackPausedVersion = service()
  await assert.rejects(rollbackPausedVersion.syncUsersForIdentity({} as any, 'tenant'), paused)
  assert.deepEqual(events, ['old:start', 'old:finish', 'active:start'])
  activeGate.finish()
  assert.equal(await activeVisit, 'active')

  process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED = 'false'
  const legacy = service()
  ;(legacy as any).getReadableTenant = async () => ({ id: 'tenant' })
  ;(legacy as any).syncConnectedTenant = async () => { events.push('rollback:start'); return { bundle: 'rollback' } }
  assert.equal(await legacy.syncUsersForIdentity({} as any, 'tenant'), 'rollback')
  assert.deepEqual(events, ['old:start', 'old:finish', 'active:start', 'active:finish', 'rollback:start'])
})

/** Capture the real default witness path: the gate's own module logger, not an
 * injected seam, so a production refusal is what is actually being observed. */
function refusals(t: TestContext): string[] {
  const captured: string[] = []
  const original = Logger.prototype.log
  Logger.prototype.log = function (message: unknown) {
    if (typeof message === 'string' && message.includes('TENANT_SYNC_ADMISSION_PAUSED')) captured.push(message)
  } as typeof Logger.prototype.log
  t.after(() => { Logger.prototype.log = original })
  return captured
}

test('a refused admission emits exactly one bounded witness carrying only the reason code', t => {
  const captured = refusals(t)
  assert.throws(() => assertSyncAdmissionOpen({ HAWKVIEW_SYNC_ADMISSION_PAUSED: 'true' }), paused)
  assert.deepEqual(captured.map(entry => JSON.parse(entry)), [{
    event: 'tenant_sync_admission', outcome: 'REFUSED', reasonCode: 'TENANT_SYNC_ADMISSION_PAUSED',
  }], 'the witness carries no tenant identifier, caller detail, secret or response body')
  // An open gate stays silent, so the witness cannot be mistaken for traffic.
  assert.doesNotThrow(() => assertSyncAdmissionOpen({ HAWKVIEW_SYNC_ADMISSION_PAUSED: 'false' }))
  assert.doesNotThrow(() => assertSyncAdmissionOpen({}))
  assert.equal(captured.length, 1, 'only a refusal emits the witness')
})

test('a witness logging failure cannot admit a paused visit or change its refusal', t => {
  const original = Logger.prototype.log
  Logger.prototype.log = (() => { throw new Error('log transport unavailable') }) as typeof Logger.prototype.log
  t.after(() => { Logger.prototype.log = original })
  // `paused` pins the exact status and response, so a replaced or swallowed
  // error fails here rather than silently becoming an admission.
  assert.throws(() => assertSyncAdmissionOpen({ HAWKVIEW_SYNC_ADMISSION_PAUSED: 'true' }), paused)
})

test('a paused scheduled entry logs the refusal and does no collector or database work', async t => {
  const captured = refusals(t)
  env(t, 'true')
  const calls: string[] = []
  const sync = service()
  ;(sync as any).readScheduledCandidateWindow = async () => { calls.push('scheduler-db'); throw Error('unreachable') }
  ;(sync as any).syncConnectedTenant = async () => { calls.push('collector'); throw Error('unreachable') }
  ;(sync as any).logger = { log: () => calls.push('summary'), warn: () => calls.push('warn') }
  await assert.rejects(sync.syncDueTenants(Date.now() + 60_000), paused)
  // Compare a copy: `deepEqual` is an `asserts actual is T` guard and would
  // narrow `calls` to `never[]`, breaking the open-path arm below.
  assert.deepEqual([...calls], [], 'a refused scheduled admission performs no collector or database work')
  assert.equal(captured.length, 1, 'the refused scheduled admission emitted its witness')

  // The same entry, admitted: the scheduler runs and emits no refusal witness,
  // so a red cron run can be told apart from an open-but-idle scheduler.
  process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED = 'false'
  ;(sync as any).readScheduledCandidateWindow = async () => {
    calls.push('scheduler-db'); return { candidateTenants: [], firstSegmentLength: 0 }
  }
  assert.equal((await sync.syncDueTenants()).due, 0)
  assert.deepEqual(calls, ['scheduler-db', 'summary'], 'the open path admits and reads the scheduler window')
  assert.equal(captured.length, 1, 'the open path emits no refusal witness')
})
