import assert from 'node:assert/strict'
import test from 'node:test'
import {
  emptyMeansQuiet,
  notificationFeedState,
  type NotificationFeedState,
} from './feed-state.ts'
import { requestNotifications } from './normalize-response.ts'

const quiet = { error: () => {}, warn: () => {} }

test('a failed read is not an empty inbox', async () => {
  // The defect this replaces. requestNotifications returns
  // { items: [], shouldReplace: false } for a throw AND for a response this
  // build cannot read; the provider keeps its previous list; and on a first
  // load that list is empty -- so the panel said "You're all caught up" about
  // a request that never succeeded.
  const threw = await requestNotifications(() => {
    throw new Error('network')
  }, quiet)
  assert.deepEqual(threw, { items: [], shouldReplace: false })

  const unreadable = await requestNotifications(
    async () => ({ unexpected: 'shape' }),
    quiet
  )
  assert.deepEqual(unreadable, { items: [], shouldReplace: false })

  // Both produce the same empty array, which is precisely why the array cannot
  // carry the distinction and it has to be tracked beside the list.
  assert.equal(notificationFeedState(false, true), 'UNAVAILABLE')
  assert.notEqual(
    notificationFeedState(false, true),
    notificationFeedState(true, false)
  )
})

test('the four states are four different answers', () => {
  const states: NotificationFeedState[] = [
    notificationFeedState(false, false),
    notificationFeedState(true, false),
    notificationFeedState(false, true),
    notificationFeedState(true, true),
  ]
  assert.deepEqual(states, ['LOADING', 'LOADED', 'UNAVAILABLE', 'STALE'])
  assert.equal(new Set(states).size, 4, 'two feed states collapsed into one')
})

test('only a successful read lets the inbox claim the tenant is quiet', () => {
  // Exactly one state may reassure. Asserted over every member rather than the
  // one case, so a new state added later is caught rather than defaulting into
  // the reassuring branch.
  assert.equal(emptyMeansQuiet('LOADED'), true)
  for (const state of ['LOADING', 'UNAVAILABLE', 'STALE'] as const) {
    assert.equal(
      emptyMeansQuiet(state),
      false,
      state + ' was treated as evidence the tenant is quiet'
    )
  }
})

test('a later failure does not erase that a read once succeeded', () => {
  // STALE and UNAVAILABLE are both "the last read failed", and they are not the
  // same sentence: one has a list that was true at a known point, the other has
  // never had one. Collapsing them discards the only inbox we ever got.
  assert.equal(notificationFeedState(true, true), 'STALE')
  assert.equal(notificationFeedState(false, true), 'UNAVAILABLE')
  assert.notEqual(
    notificationFeedState(true, true),
    notificationFeedState(false, true)
  )
})
