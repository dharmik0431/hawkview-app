import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PIM_SUMMARY_RESPONSE_VERSION,
  parsePimPlaneSummary,
} from './pim-schedule-summary-view.ts'

// Sentinel values for the three fields the view model must never carry.
const ATTEMPT_ID = 'attempt-SENTINEL-8f21'
const SCOPE_VERSION = 'scope-SENTINEL-v97'
const CONTENT_DIGEST = 'digest-SENTINEL-abc123'

function observation(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: ATTEMPT_ID,
    scopeVersion: SCOPE_VERSION,
    committedAt: '2026-10-04T11:22:33.000Z',
    contentChangedAt: '2026-10-02T08:00:00.000Z',
    contentDigest: CONTENT_DIGEST,
    observedRecordCount: 4,
    ageMs: 172_800_000,
    traversalOutcome: 'EXHAUSTED',
    assurance: 'UNKNOWN',
    coverage: 'NOT_ESTABLISHED',
    ...overrides,
  }
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    responseVersion: PIM_SUMMARY_RESPONSE_VERSION,
    plane: 'ACTIVE',
    status: 'observed',
    lastCommitted: observation(),
    ...overrides,
  }
}

test('the factory baseline parses, so every refusal below is a change from a passing case', () => {
  const parsed = parsePimPlaneSummary('ACTIVE', payload())
  assert.ok(parsed, 'baseline payload must parse or the refusal cases prove nothing')
  assert.equal(parsed.status, 'observed')
  assert.equal(parsed.plane, 'ACTIVE')
  assert.equal(parsed.showingOlderObservation, false)
  assert.equal(parsed.lastObservation?.observedRecordCount, 4)
  assert.equal(parsed.lastObservation?.ageMs, 172_800_000)
  assert.ok(parsed.lastObservation?.collectedAt instanceof Date)
  assert.ok(parsed.lastObservation?.contentChangedAt instanceof Date)
  assert.equal(parsed.lastObservation?.collectedAt.toISOString(), '2026-10-04T11:22:33.000Z')
  assert.equal(parsed.lastObservation?.contentChangedAt.toISOString(), '2026-10-02T08:00:00.000Z')
  assert.equal(parsed.lastObservation?.coverageVerified, false)
})

test('internal identifiers are structurally absent from the view model', () => {
  const parsed = parsePimPlaneSummary('ACTIVE', payload())
  assert.ok(parsed)
  const keys = Object.keys(parsed.lastObservation ?? {})
  for (const forbidden of ['attemptId', 'scopeVersion', 'contentDigest']) {
    assert.equal(keys.includes(forbidden), false, `${forbidden} must not be a view-model field`)
  }
  const serialised = JSON.stringify(parsed)
  for (const value of [ATTEMPT_ID, SCOPE_VERSION, CONTENT_DIGEST]) {
    assert.equal(serialised.includes(value), false, `${value} reached the view model`)
  }
})

test('both planes parse independently and a plane mismatch is refused, not reinterpreted', () => {
  const active = parsePimPlaneSummary('ACTIVE', payload({ plane: 'ACTIVE' }))
  const eligible = parsePimPlaneSummary('ELIGIBLE', payload({ plane: 'ELIGIBLE' }))
  assert.equal(active?.plane, 'ACTIVE')
  assert.equal(eligible?.plane, 'ELIGIBLE')
  assert.equal(parsePimPlaneSummary('ACTIVE', payload({ plane: 'ELIGIBLE' })), null)
  assert.equal(parsePimPlaneSummary('ELIGIBLE', payload({ plane: 'ACTIVE' })), null)
  assert.equal(parsePimPlaneSummary('ACTIVE', payload({ plane: 'GROUPS' })), null)
  assert.equal(parsePimPlaneSummary('ACTIVE', payload({ plane: undefined })), null)
})

test('observed zero is a real observation and stays distinct from never-collected', () => {
  const zero = parsePimPlaneSummary('ACTIVE', payload({ lastCommitted: observation({ observedRecordCount: 0 }) }))
  assert.equal(zero?.status, 'observed')
  assert.equal(zero?.lastObservation?.observedRecordCount, 0)
  assert.ok(zero?.lastObservation?.collectedAt instanceof Date, 'observed zero keeps its stored collection time')

  const never = parsePimPlaneSummary('ACTIVE', payload({ status: 'never-collected', lastCommitted: null }))
  assert.equal(never?.status, 'never-collected')
  assert.equal(never?.lastObservation, null)
  assert.equal(never?.showingOlderObservation, false)
  // The two states must not be confusable by a consumer.
  assert.notEqual(zero?.status, never?.status)
})

test('never-collected carrying an observation contradicts itself and is refused', () => {
  assert.equal(parsePimPlaneSummary('ACTIVE', payload({ status: 'never-collected' })), null)
  assert.equal(
    parsePimPlaneSummary('ACTIVE', payload({ status: 'never-collected', lastCommitted: observation() })),
    null
  )
  // An explicit null is the only accepted form of "no observation".
  assert.ok(parsePimPlaneSummary('ACTIVE', payload({ status: 'never-collected', lastCommitted: null })))
})

/** The API sends `lastCommitted` as an explicit nullable property. An answer that omits it is
 *  malformed, and turning it into "no observations collected yet" would state something the server
 *  never said. */
test('an omitted lastCommitted is malformed for every status, never an absent observation', () => {
  const omitted = (status: string) => {
    const body: Record<string, unknown> = payload({ status })
    delete body.lastCommitted
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'lastCommitted'), false, 'fixture must omit the field')
    return body
  }
  for (const status of ['never-collected', 'last-attempt-failed', 'observed']) {
    assert.equal(parsePimPlaneSummary('ACTIVE', omitted(status)), null, `omitted for ${status}`)
  }
  // An own property whose value is undefined is the same malformed answer over the wire.
  for (const status of ['never-collected', 'last-attempt-failed']) {
    assert.equal(parsePimPlaneSummary('ACTIVE', payload({ status, lastCommitted: undefined })), null, `undefined for ${status}`)
  }
  // Explicit null and a valid older observation both keep working.
  assert.equal(parsePimPlaneSummary('ACTIVE', payload({ status: 'never-collected', lastCommitted: null }))?.status, 'never-collected')
  const failedWithNull = parsePimPlaneSummary('ACTIVE', payload({ status: 'last-attempt-failed', lastCommitted: null }))
  assert.equal(failedWithNull?.lastObservation, null)
  assert.equal(failedWithNull?.showingOlderObservation, false)
  const failedWithOlder = parsePimPlaneSummary('ACTIVE', payload({ status: 'last-attempt-failed', lastCommitted: observation() }))
  assert.equal(failedWithOlder?.showingOlderObservation, true)
  assert.equal(failedWithOlder?.lastObservation?.observedRecordCount, 4)
})

test('a failed latest attempt preserves the older observation and flags that it is older', () => {
  const older = observation({
    committedAt: '2026-09-28T06:00:00.000Z',
    contentChangedAt: '2026-09-27T06:00:00.000Z',
    observedRecordCount: 9,
    ageMs: 600_000,
  })
  const withOlder = parsePimPlaneSummary('ACTIVE', payload({ status: 'last-attempt-failed', lastCommitted: older }))
  assert.equal(withOlder?.status, 'last-attempt-failed')
  assert.equal(withOlder?.showingOlderObservation, true)
  assert.equal(withOlder?.lastObservation?.observedRecordCount, 9)
  // Timestamps and age come through unchanged — nothing is restamped as fresh.
  assert.equal(withOlder?.lastObservation?.collectedAt.toISOString(), '2026-09-28T06:00:00.000Z')
  assert.equal(withOlder?.lastObservation?.contentChangedAt.toISOString(), '2026-09-27T06:00:00.000Z')
  assert.equal(withOlder?.lastObservation?.ageMs, 600_000)

  const withoutOlder = parsePimPlaneSummary('ACTIVE', payload({ status: 'last-attempt-failed', lastCommitted: null }))
  assert.equal(withoutOlder?.status, 'last-attempt-failed')
  assert.equal(withoutOlder?.lastObservation, null)
  assert.equal(withoutOlder?.showingOlderObservation, false)
})

test('an unsupported response version is refused rather than read as this contract', () => {
  assert.equal(PIM_SUMMARY_RESPONSE_VERSION, 'pim-schedule-summary/v1')
  for (const version of ['pim-schedule-summary/v2', 'pim-schedule-summary', '', undefined, null, 1]) {
    assert.equal(parsePimPlaneSummary('ACTIVE', payload({ responseVersion: version })), null, `version ${String(version)}`)
  }
})

test('an unknown or missing status is refused, never degraded to an empty summary', () => {
  for (const status of ['collecting', 'OBSERVED', '', undefined, null, 0]) {
    assert.equal(parsePimPlaneSummary('ACTIVE', payload({ status })), null, `status ${String(status)}`)
  }
})

test('observed without a readable observation is a refusal, not zero observations', () => {
  for (const raw of [null, undefined, {}, 'observation', 42, []]) {
    const parsed = parsePimPlaneSummary('ACTIVE', payload({ lastCommitted: raw }))
    assert.equal(parsed, null, `lastCommitted ${JSON.stringify(raw) ?? 'undefined'}`)
  }
})

test('counts and ages must be finite and nonnegative', () => {
  for (const field of ['observedRecordCount', 'ageMs']) {
    for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, -1, -0.5, '4', null, undefined, {}]) {
      const parsed = parsePimPlaneSummary('ACTIVE', payload({ lastCommitted: observation({ [field]: value }) }))
      assert.equal(parsed, null, `${field} = ${String(value)} must be refused`)
    }
    // Zero remains acceptable for both fields.
    assert.ok(parsePimPlaneSummary('ACTIVE', payload({ lastCommitted: observation({ [field]: 0 }) })))
  }
})

test('stored timestamps must be parseable date strings', () => {
  for (const field of ['committedAt', 'contentChangedAt']) {
    for (const value of ['', 'not-a-date', '2026-13-45T99:99:99Z', 1759000000000, null, undefined, {}]) {
      const parsed = parsePimPlaneSummary('ACTIVE', payload({ lastCommitted: observation({ [field]: value }) }))
      assert.equal(parsed, null, `${field} = ${String(value)} must be refused`)
    }
  }
})

test('assurance and coverage are taken verbatim and never silently upgraded', () => {
  for (const assurance of ['VERIFIED', 'unknown', '', undefined, null]) {
    assert.equal(parsePimPlaneSummary('ACTIVE', payload({ lastCommitted: observation({ assurance }) })), null, `assurance ${String(assurance)}`)
  }
  for (const coverage of ['ESTABLISHED', 'COMPLETE', 'not_established', '', undefined, null]) {
    assert.equal(parsePimPlaneSummary('ACTIVE', payload({ lastCommitted: observation({ coverage }) })), null, `coverage ${String(coverage)}`)
  }
  // And the accepted pair is exactly the one the API promised.
  const parsed = parsePimPlaneSummary('ACTIVE', payload())
  assert.equal(parsed?.lastObservation?.coverageVerified, false)
})

test('a missing content digest is refused even though the digest never reaches the view', () => {
  for (const contentDigest of ['', undefined, null, 123, {}]) {
    assert.equal(parsePimPlaneSummary('ACTIVE', payload({ lastCommitted: observation({ contentDigest }) })), null, `digest ${String(contentDigest)}`)
  }
})

test('non-record envelopes are refused', () => {
  for (const value of [null, undefined, 'ok', 7, true, [], [payload()]]) {
    assert.equal(parsePimPlaneSummary('ACTIVE', value), null, `envelope ${JSON.stringify(value) ?? 'undefined'}`)
  }
})
