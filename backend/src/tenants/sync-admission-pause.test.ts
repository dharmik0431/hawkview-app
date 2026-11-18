import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { ServiceUnavailableException } from '@nestjs/common'
import { TenantSyncService } from './tenant-sync.service.js'
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
