import assert from 'node:assert/strict'
import test from 'node:test'
import { ServiceUnavailableException } from '@nestjs/common'
import { ScheduledSyncController } from './scheduled-sync.controller.js'

test('authenticated scheduled entry pauses before maintenance, risk, intake, collection and email', async t => {
  const previous = process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED
  process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED = 'true'
  t.after(() => {
    if (previous === undefined) delete process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED
    else process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED = previous
  })
  const calls: string[] = []
  const controller = new ScheduledSyncController(
    { verify: async () => { calls.push('auth') } } as any,
    { runScheduledGlobalRiskCycle: async () => { calls.push('risk') },
      syncDueTenants: async () => { calls.push('collect') } } as any,
    { runAuthorizedRiskHistoryMaintenance: async () => { calls.push('history') },
      runAuthorizedScheduledMaintenance: async () => { calls.push('maintenance') } } as any,
    { runOnce: async () => { calls.push('intake') } } as any,
    { runOnce: async () => { calls.push('email') } } as any,
  )
  await assert.rejects(controller.syncDueTenants({ headers: { authorization: 'synthetic' } } as any), error => {
    assert.ok(error instanceof ServiceUnavailableException)
    assert.equal(error.getStatus(), 503)
    return true
  })
  assert.deepEqual(calls, ['auth'])
})

test('invalid scheduled authentication remains authoritative while paused', async t => {
  const previous = process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED
  process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED = 'true'
  t.after(() => {
    if (previous === undefined) delete process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED
    else process.env.HAWKVIEW_SYNC_ADMISSION_PAUSED = previous
  })
  const calls: string[] = []
  const controller = new ScheduledSyncController(
    { verify: async () => { calls.push('auth'); throw Error('invalid scheduler token') } } as any,
    { syncDueTenants: async () => { calls.push('collect') } } as any,
    {} as any, {} as any,
  )
  await assert.rejects(controller.syncDueTenants({ headers: {} } as any), /invalid scheduler token/)
  assert.deepEqual(calls, ['auth'])
})
