import assert from 'node:assert/strict'
import test from 'node:test'
import { conditionalAccessOverviewState } from './conditional-access-overview.ts'

const unavailableStates = [
  'UNVERIFIED',
  'BLOCKED_PERMISSION',
  'STALE',
  'NOT_APPLICABLE',
  'UNSUPPORTED',
] as const

test('does not turn unlicensed Conditional Access into a numeric compliance warning', () => {
  const result = conditionalAccessOverviewState(
    { availability: 'NOT_LICENSED', count: null },
    [],
  )
  assert.equal(result.value, 'Conditional Access is not licensed for this tenant')
  assert.equal(result.status, 'neutral')
  assert.equal(result.contributesWarning, false)
  assert.doesNotMatch(result.value, /\d+ of \d+/)
  assert.match(result.detail, /Security Defaults is reported separately/)
})

test('keeps every non-authoritative Conditional Access state neutral and non-numeric', () => {
  for (const availability of unavailableStates) {
    const result = conditionalAccessOverviewState(
      { availability, count: null },
      [],
    )
    assert.equal(result.authoritative, false, availability)
    assert.equal(result.status, 'neutral', availability)
    assert.equal(result.contributesWarning, false, availability)
    assert.doesNotMatch(result.value, /\d+ of \d+/, availability)
  }
})

test('renders an authoritative empty Conditional Access result with neutral wording', () => {
  const result = conditionalAccessOverviewState(
    { availability: 'READY', count: 0 },
    [],
  )
  assert.equal(result.authoritative, true)
  assert.equal(result.value, 'No Conditional Access policies found')
  assert.equal(result.status, 'neutral')
  assert.equal(result.contributesWarning, false)
})

test('rejects an authoritative zero count when policy details are not empty', () => {
  const result = conditionalAccessOverviewState(
    { availability: 'READY', count: 0 },
    [{ state: 'ON' }],
  )
  assert.equal(result.authoritative, false)
  assert.equal(result.value, 'Conditional Access policy details unavailable')
  assert.equal(result.status, 'neutral')
  assert.equal(result.contributesWarning, false)
  assert.doesNotMatch(result.value, /\d+ of \d+/)
})

test('rejects malformed policy states instead of converting them to disabled policies', () => {
  const result = conditionalAccessOverviewState(
    { availability: 'READY', count: 1 },
    [{ state: 'ENABLED' }],
  )
  assert.equal(result.authoritative, false)
  assert.equal(result.value, 'Conditional Access policy details unavailable')
  assert.equal(result.status, 'neutral')
  assert.equal(result.contributesWarning, false)
  assert.doesNotMatch(result.value, /\d+ of \d+/)
})

test('rejects non-plain policy objects at the runtime boundary', () => {
  const result = conditionalAccessOverviewState(
    { availability: 'READY', count: 1 },
    [Object.assign(new Date(), { state: 'ON' })],
  )
  assert.equal(result.authoritative, false)
  assert.equal(result.value, 'Conditional Access policy details unavailable')
  assert.equal(result.status, 'neutral')
})

test('fails closed when ready policy details do not match the authoritative count', () => {
  const result = conditionalAccessOverviewState(
    { availability: 'READY', count: 2 },
    [{ state: 'ON' }],
  )
  assert.equal(result.authoritative, false)
  assert.equal(result.value, 'Conditional Access policy details unavailable')
  assert.equal(result.status, 'neutral')
})

test('calculates policy posture only from a matching authoritative policy set', () => {
  const result = conditionalAccessOverviewState(
    { availability: 'READY', count: 2 },
    [{ state: 'ON' }, { state: 'OFF' }],
  )
  assert.equal(result.value, '1 of 2 Conditional Access policies enabled')
  assert.equal(result.status, 'healthy')
  assert.equal(result.contributesWarning, false)
})
