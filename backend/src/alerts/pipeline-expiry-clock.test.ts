import assert from 'node:assert/strict'
import test from 'node:test'
import { runIntake } from './finding-pipeline.js'
import { pipelineStore, type SqlRunner } from './pipeline-store.js'

function recordingStore() {
  const reads: Array<{ sql: string; params: readonly unknown[] }> = []
  const runner: SqlRunner = {
    query: async <T>(sql: string, params: readonly unknown[]): Promise<readonly T[]> => {
      reads.push({ sql, params })
      return []
    },
    execute: async () => { throw new Error('An empty intake must not write') },
    transaction: async () => { throw new Error('An empty intake must not transact') },
  }
  return { store: pipelineStore(runner), reads }
}

test('intake expiry uses the explicit tick clock and preserves the read watermark', async () => {
  const { store, reads } = recordingStore()
  const since = '2040-02-01T00:00:00.000Z'
  const tick = '2040-02-02T00:00:00.000Z'
  const outcome = await runIntake(store, {
    sendNothingObservedBeforeIso: since,
    because: 'synthetic cutover',
  }, tick, 1, since, () => 0)

  assert.equal(outcome.kind, 'RAN')
  assert.equal(reads.length, 1)
  assert.deepEqual(reads[0]!.params, [since, tick])
  assert.match(reads[0]!.sql, /state = 'OPEN' AND observed_at >= \$1::timestamptz/)
  assert.match(reads[0]!.sql, /expires_at > \$2::timestamptz/,
    'expiry at the tick itself must be excluded, not admitted with >=')
})

test('a direct store read without an explicit tick uses its read clock', async () => {
  const { store, reads } = recordingStore()
  const since = '2040-02-01T00:00:00.000Z'
  const before = Date.now()
  await store.findOpenFindings(since)
  const after = Date.now()
  assert.equal(reads.length, 1)
  assert.equal(reads[0]!.params[0], since)
  const activeAt = Date.parse(String(reads[0]!.params[1]))
  assert.ok(activeAt >= before && activeAt <= after)
})
