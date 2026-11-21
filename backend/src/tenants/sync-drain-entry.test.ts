import assert from 'node:assert/strict'
import test from 'node:test'
import { ServiceUnavailableException } from '@nestjs/common'
import { ScheduledSyncController } from './scheduled-sync.controller.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantsController } from './tenants.controller.js'
import { syncDrainRegistry } from './sync-drain-registry.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('all three SYNC routes drain their complete admitted operation and reject a new one', async t => {
  const previous = process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED
  process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED = 'false'
  t.after(() => {
    if (previous === undefined) delete process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED
    else process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED = previous
  })
  const manualEntered = deferred(), manualRelease = deferred()
  const verifyEntered = deferred(), verifyRelease = deferred()
  const intakeEntered = deferred(), intakeRelease = deferred()
  const calls: string[] = []
  const sync = new TenantSyncService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any)
  ;(sync as any).getReadableTenant = async () => {
    manualEntered.resolve(); await manualRelease.promise; return { id: 'tenant' }
  }
  ;(sync as any).syncConnectedTenant = async () => ({ bundle: 'manual' })
  ;(sync as any).verifyExchangeReadOnlyWithinMemoryLane = async () => {
    calls.push('verify-nested-after-close'); return 'verified'
  }
  ;(sync as any).readScheduledCandidateWindow = async () => {
    calls.push('scheduled-nested-after-close'); return { candidateTenants: [], firstSegmentLength: 0 }
  }
  ;(sync as any).runScheduledGlobalRiskCycle = async () => undefined
  ;(sync as any).logger = { log: () => undefined }
  const manual = sync.syncUsersForIdentity({} as any, 'tenant')

  const tenantController = new TenantsController({ assertCanConfigureExchangeReadOnly: async () => {
    verifyEntered.resolve(); await verifyRelease.promise
  } } as any, sync)
  const verify = tenantController.verifyExchangeReadOnly({ auth: {} } as any, 'tenant')

  const scheduled = new ScheduledSyncController(
    { verify: async () => undefined } as any,
    sync,
    { runAuthorizedRiskHistoryMaintenance: async () => undefined,
      runAuthorizedScheduledMaintenance: async () => ({ hasMore: false }) } as any,
    { runOnce: async () => { intakeEntered.resolve(); await intakeRelease.promise } } as any,
  )
  const scheduledRun = scheduled.syncDueTenants({ headers: { authorization: 'synthetic' } } as any)

  await Promise.all([manualEntered.promise, verifyEntered.promise, intakeEntered.promise])
  assert.deepEqual(syncDrainRegistry.snapshot(), { accepting: true, active: 3, completed: 0 })
  const drained = syncDrainRegistry.closeAdmissionsAndDrain()
  await assert.rejects(sync.syncUsersForIdentity({} as any, 'tenant'), ServiceUnavailableException)
  manualRelease.resolve(); verifyRelease.resolve(); intakeRelease.resolve()
  assert.equal(await manual, 'manual')
  assert.equal(await verify, 'verified')
  assert.equal((await scheduledRun).due, 0)
  await drained
  assert.deepEqual(calls.sort(), ['scheduled-nested-after-close', 'verify-nested-after-close'])
  assert.deepEqual(syncDrainRegistry.snapshot(), { accepting: false, active: 0, completed: 3 })
})
