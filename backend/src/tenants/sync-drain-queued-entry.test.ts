import assert from 'node:assert/strict'
import test from 'node:test'
import { ServiceUnavailableException } from '@nestjs/common'
import { runInSyncMemoryLane, TenantSyncService } from './tenant-sync.service.js'
import { syncDrainRegistry } from './sync-drain-registry.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('shutdown drains a real queued verification after the occupied memory lane releases', async t => {
  const previous = process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED
  process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED = 'false'
  t.after(() => {
    if (previous === undefined) delete process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED
    else process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED = previous
  })

  const laneEntered = deferred(), releaseLane = deferred()
  const verifyEntered = deferred(), releaseVerify = deferred()
  const occupied = syncDrainRegistry.run(() => runInSyncMemoryLane(async () => {
    laneEntered.resolve()
    await releaseLane.promise
    return 'first complete'
  }))
  await laneEntered.promise

  const service = new TenantSyncService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any)
  let collectionCalls = 0
  ;(service as any).verifyExchangeReadOnlyWithinMemoryLane = async () => {
    collectionCalls += 1
    verifyEntered.resolve()
    await releaseVerify.promise
    return 'verification complete'
  }
  const queued = service.verifyExchangeReadOnlyForIdentity({} as any, 'tenant')
  await Promise.resolve()
  assert.equal(collectionCalls, 0, 'the real service entry is still behind the occupied memory lane')
  assert.deepEqual(syncDrainRegistry.snapshot(), { accepting: true, active: 2, completed: 0 })

  let drainFinished = false
  const drained = syncDrainRegistry.closeAdmissionsAndDrain().then(() => { drainFinished = true })
  await assert.rejects(service.verifyExchangeReadOnlyForIdentity({} as any, 'late'), ServiceUnavailableException)
  assert.equal(collectionCalls, 0, 'new independent work cannot bypass the closed gate')
  releaseLane.resolve()
  assert.equal(await occupied, 'first complete')
  await verifyEntered.promise
  assert.equal(collectionCalls, 1)
  assert.equal(drainFinished, false, 'the queued operation is still active after the first lane holder settles')
  assert.deepEqual(syncDrainRegistry.snapshot(), { accepting: false, active: 1, completed: 1 })

  releaseVerify.resolve()
  assert.equal(await queued, 'verification complete')
  await drained
  assert.equal(drainFinished, true)
  assert.deepEqual(syncDrainRegistry.snapshot(), { accepting: false, active: 0, completed: 2 })
})
