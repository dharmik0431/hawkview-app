import assert from 'node:assert/strict'
import test from 'node:test'
import {
  emptySectionMeaning,
  freshnessPresentation,
  serviceFreshness,
} from './service-freshness.ts'
import type { ServiceSyncFreshness } from '@/types/tenant-data'

function freshness(
  overrides: Partial<ServiceSyncFreshness> = {}
): ServiceSyncFreshness {
  return {
    service: 'ENTRA_ID',
    status: 'SUCCESS',
    freshnessStatus: 'CURRENT',
    lastAttemptStartedAt: '2026-09-11T09:00:00.000Z',
    lastAttemptCompletedAt: '2026-09-11T09:00:30.000Z',
    lastSuccessfulCollectionAt: '2026-09-11T09:00:30.000Z',
    partialFailures: [],
    ...overrides,
  } as ServiceSyncFreshness
}

test('no state renders as a blank or a bare date', () => {
  // A date with no judgement attached asks the reader to work out whether
  // seventeen days is a problem, and nobody does that while scanning. If it is
  // stale the screen says stale.
  const states: ServiceSyncFreshness[] = [
    freshness(),
    freshness({ status: 'FAILED' }),
    freshness({ status: 'STALE' }),
    freshness({ status: 'PARTIAL', partialFailures: [{} as never] }),
    freshness({ status: 'RUNNING' }),
    freshness({ status: 'PENDING' }),
    freshness({ status: 'NOT_COLLECTED', freshnessStatus: 'NEVER_SYNCED' }),
    freshness({ freshnessStatus: 'AGING' }),
  ]
  for (const state of [...states, null]) {
    const shown = freshnessPresentation(state)
    assert.ok(shown.label.trim().length > 0, 'a state rendered a blank label')
    assert.ok(shown.detail.trim().length > 0, 'a state rendered no explanation')
    // A label that is only a timestamp is the thing this replaces.
    assert.ok(
      !/^\d|^[0-9/.: ]+$/.test(shown.label),
      'a bare date was rendered as the label: ' + shown.label
    )
  }
})

test('only a verified current collection is treated as trustworthy', () => {
  // The screen may be read as a picture of the tenant in exactly one case.
  // Everything else -- failing, stale, running, pending, never collected,
  // aging, or unreported -- leaves the rows on screen unvouched for.
  assert.equal(freshnessPresentation(freshness()).trustworthy, true)

  for (const state of [
    freshness({ status: 'FAILED' }),
    freshness({ status: 'STALE' }),
    freshness({ status: 'PARTIAL', partialFailures: [] }),
    freshness({ status: 'RUNNING' }),
    freshness({ status: 'PENDING' }),
    freshness({ status: 'NOT_COLLECTED', freshnessStatus: 'NEVER_SYNCED' }),
    freshness({ freshnessStatus: 'AGING' }),
    freshness({ lastSuccessfulCollectionAt: null }),
    null,
  ]) {
    assert.equal(
      freshnessPresentation(state).trustworthy,
      false,
      'unvouched-for data was marked trustworthy: ' +
        freshnessPresentation(state).label
    )
  }
})

test('an empty section says whether anyone looked', () => {
  // The distinction the product exists for. An empty user list because the
  // collector failed is not an empty user list, and the two render identically
  // unless something says otherwise: the reader sees nothing and concludes
  // there is nothing.
  const collected = emptySectionMeaning(freshness(), true)
  assert.ok(collected)
  assert.match(collected!, /succeeded and returned nothing/)
  assert.match(collected!, /empty result rather than a missing one/)

  const failed = emptySectionMeaning(freshness({ status: 'FAILED' }), true)
  assert.ok(failed)
  assert.match(failed!, /not a finding/)
  assert.notEqual(
    failed,
    collected,
    'a failed collection and a genuine absence produced the same sentence'
  )

  const never = emptySectionMeaning(
    freshness({ status: 'NOT_COLLECTED', freshnessStatus: 'NEVER_SYNCED' }),
    true
  )
  assert.ok(never)
  assert.notEqual(never, failed, 'never-collected read as a failed collection')

  // A populated section gets no qualification: attaching it to rows that exist
  // would be noise, and noise is what gets skimmed past.
  assert.equal(
    emptySectionMeaning(freshness({ status: 'FAILED' }), false),
    null
  )
})

test('never-collected and stale are different sentences', () => {
  // Only one of them is fixed by waiting, and a tenant that was never wired up
  // is a different conversation from one whose feed stopped.
  const never = freshnessPresentation(
    freshness({ status: 'NOT_COLLECTED', freshnessStatus: 'NEVER_SYNCED' })
  )
  const stale = freshnessPresentation(freshness({ status: 'STALE' }))
  assert.notEqual(never.label, stale.label)
  assert.match(never.detail, /never successfully collected/)
  assert.match(stale.detail, /older than/)
  // Neither may read as an absence of data in the tenant.
  assert.match(never.detail, /not the same as the tenant having nothing/)
})

test('freshness is read from either place the bundle carries it', () => {
  const state = freshness()
  assert.equal(
    serviceFreshness(
      { syncFreshness: { services: { entraId: state } } } as never,
      'entraId'
    ),
    state
  )
  assert.equal(
    serviceFreshness(
      { tenant: { syncFreshness: { services: { entraId: state } } } } as never,
      'entraId'
    ),
    state
  )
  // Absent is its own answer rather than a synonym for current.
  assert.equal(serviceFreshness(null, 'entraId'), null)
  assert.equal(serviceFreshness({} as never, 'entraId'), null)
  assert.equal(
    freshnessPresentation(serviceFreshness({} as never, 'entraId')).trustworthy,
    false
  )
})
