import assert from 'node:assert/strict'
import test from 'node:test'
import { COLLECTION_READINESS_STATES, UNMEASURED_RUNNING_RELABEL } from './collection-readiness.js'
import type { CollectionReadinessState } from './collection-readiness.js'

/**
 * HAW-77 v3: the relabel policy itself, kept separate from
 * `fallback-access-precedence.test.ts` on purpose.
 *
 * `UNMEASURED_RUNNING_RELABEL` does not exist on the base commit, so asserting
 * it in the behavioural suite would make that suite fail to IMPORT when the
 * source is reverted for a negative control - an aggregate failure that
 * demonstrates nothing. The behaviour lives there; the policy lives here.
 *
 * The compiler already refuses a thirteenth readiness state that nobody has
 * classified, because the Record's key type is the state union. These
 * assertions add what the compiler cannot say: which single state the relabel
 * may take, and that every authoritative verdict is excluded by name, so a
 * later widening has to delete an assertion rather than quietly pass.
 */

// ---------------------------------------------------------------------------
test('policy: exactly one dataset state may be relabelled, and every authoritative one may not', () => {
  assert.equal(COLLECTION_READINESS_STATES.length, 12,
    'a new readiness state must be classified in UNMEASURED_RUNNING_RELABEL, not ignored')
  assert.deepEqual(Object.keys(UNMEASURED_RUNNING_RELABEL).sort(),
    [...COLLECTION_READINESS_STATES].sort(),
    'the policy is exhaustive over the state union')
  assert.deepEqual(Object.entries(UNMEASURED_RUNNING_RELABEL)
    .filter(([, allowed]) => allowed).map(([state]) => state), ['PARTIAL'])
  for (const state of ['BLOCKED_PERMISSION', 'BLOCKED_TENANT_CONFIGURATION', 'NOT_LICENSED',
    'UNSUPPORTED', 'UNVERIFIED', 'BACKLOGGED', 'READY', 'STALE', 'FAILED_TRANSIENT',
    'NEVER_SUCCEEDED', 'INITIALIZING'] as CollectionReadinessState[]) {
    assert.equal(UNMEASURED_RUNNING_RELABEL[state], false, state)
  }
})
