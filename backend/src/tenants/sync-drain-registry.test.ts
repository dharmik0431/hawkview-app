import assert from 'node:assert/strict'
import test from 'node:test'
import { ServiceUnavailableException } from '@nestjs/common'
import { SyncDrainRegistry } from './sync-drain-registry.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('shutdown waits for an admitted outer request, including nested work started after closure', async () => {
  const registry = new SyncDrainRegistry()
  const entered = deferred(), resume = deferred(), nested = deferred()
  const events: string[] = []
  const request = registry.run(async () => {
    events.push('entered')
    entered.resolve()
    await resume.promise
    return registry.run(async () => { events.push('nested'); await nested.promise; return 'complete' })
  })
  await entered.promise
  const drained = registry.closeAdmissionsAndDrain().then(() => { events.push('drained') })
  assert.deepEqual(registry.snapshot(), { accepting: false, active: 1, completed: 0 })
  await assert.rejects(registry.run(async () => 'new'), ServiceUnavailableException)
  resume.resolve()
  await Promise.resolve()
  assert.deepEqual(events, ['entered', 'nested'])
  nested.resolve()
  assert.equal(await request, 'complete')
  await drained
  assert.deepEqual(events, ['entered', 'nested', 'drained'])
  assert.deepEqual(registry.snapshot(), { accepting: false, active: 0, completed: 1 })
})

test('queued and rejected work both settle the drain without granting late admission', async () => {
  const registry = new SyncDrainRegistry()
  const entered = deferred(), release = deferred()
  const failed = registry.run(async () => { entered.resolve(); await release.promise; throw Error('collector failed') })
  await entered.promise
  const draining = registry.closeAdmissionsAndDrain()
  assert.equal(registry.closeAdmissionsAndDrain(), draining)
  release.resolve()
  await assert.rejects(failed, /collector failed/)
  await draining
  assert.equal(registry.snapshot().completed, 1)
  await assert.rejects(registry.run(async () => undefined), ServiceUnavailableException)
})

test('an inherited ticket cannot start detached work after its parent has settled', async () => {
  const registry = new SyncDrainRegistry()
  const callLater = deferred()
  let late!: Promise<unknown>
  await registry.run(async () => {
    void callLater.promise.then(() => { late = registry.run(async () => 'untracked') })
  })
  callLater.resolve()
  await Promise.resolve()
  await assert.rejects(late, ServiceUnavailableException)
  assert.deepEqual(registry.snapshot(), { accepting: true, active: 0, completed: 1 })
})
