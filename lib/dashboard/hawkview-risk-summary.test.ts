import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNativeRiskSummary } from '../api/native-risk-summary-parser.ts'
import {
  presentHawkViewTenantRisk,
  summarizeHawkViewPortfolioRisk,
  formatNativeRiskClock,
  type NativeRiskSummaryResponse,
} from './hawkview-risk-summary.ts'

function response(): NativeRiskSummaryResponse {
  return {
    contractVersion: 'hawkview-native-risk-summary/v1',
    source: 'HAWKVIEW_NATIVE_ASSESSMENT',
    countUnit: 'TENANT_USER_IDENTITIES',
    generatedAt: '2026-09-15T12:00:00.000Z',
    fleet: {
      availability: 'AVAILABLE',
      accuracy: 'EXACT',
      distinctUserCount: 5,
      assessedTenants: 3,
      totalTenants: 3,
      enumeratedTenants: 3,
      scopeComplete: true,
      limitations: [],
    },
    tenants: [0, 1, 2].map((index) => (
      {
        tenantId: `synthetic-${index}`,
        availability: 'AVAILABLE',
        accuracy: 'EXACT',
        distinctUserCount: index === 0 ? 4 : index === 1 ? 1 : 0,
        evaluatedAt: '2026-09-15T11:00:00.000Z',
        windowStart: '2026-09-08T11:00:00.000Z',
        windowEnd: '2026-09-15T11:00:00.000Z',
        complete: true,
        limitations: [],
      }
    )),
  }
}

test('strictly accepts the source-owned exact fleet and tenant summaries', () => {
  const parsed = parseNativeRiskSummary(response())
  assert.ok(parsed)
  assert.equal(
    summarizeHawkViewPortfolioRisk(parsed.fleet, 'SUCCESS').display,
    '5',
  )
  assert.equal(presentHawkViewTenantRisk(parsed.tenants[0]).display, '4')
})

test('partial positive counts remain visibly qualified', () => {
  const value = response()
  value.fleet = {
    ...value.fleet,
    availability: 'PARTIAL',
    accuracy: 'AT_LEAST',
    distinctUserCount: 2,
    assessedTenants: 1,
    scopeComplete: true,
    limitations: ['NO_CURRENT_RUN', 'PARTIAL_ASSESSMENT'],
  }
  value.tenants[0] = {
    ...value.tenants[0],
    availability: 'PARTIAL',
    accuracy: 'AT_LEAST',
    distinctUserCount: 2,
    complete: false,
    limitations: ['PARTIAL_ASSESSMENT'],
  }
  for (const index of [1, 2]) Object.assign(value.tenants[index], { availability: 'UNAVAILABLE', accuracy: 'NOT_AVAILABLE', distinctUserCount: null, complete: false, evaluatedAt: null, windowStart: null, windowEnd: null, limitations: ['NO_CURRENT_RUN'] })

  const parsed = parseNativeRiskSummary(value)
  assert.ok(parsed)
  assert.equal(
    summarizeHawkViewPortfolioRisk(parsed.fleet, 'SUCCESS').display,
    '≥2',
  )
  assert.equal(presentHawkViewTenantRisk(parsed.tenants[0]).display, '≥2')
})

test('partial zero, duplicate tenants, unknown fields, and invalid exact scope fail closed', () => {
  const partialZero = response() as unknown as Record<string, any>
  partialZero.fleet.availability = 'PARTIAL'
  partialZero.fleet.accuracy = 'AT_LEAST'
  partialZero.fleet.distinctUserCount = 0
  partialZero.fleet.scopeComplete = false
  assert.equal(parseNativeRiskSummary(partialZero), null)

  const duplicate = response()
  duplicate.tenants.push({ ...duplicate.tenants[0] })
  assert.equal(parseNativeRiskSummary(duplicate), null)

  const hostile = { ...response(), unexpected: 'do not render me' }
  assert.equal(parseNativeRiskSummary(hostile), null)

  const invalidExact = response()
  invalidExact.fleet.assessedTenants = 2
  assert.equal(parseNativeRiskSummary(invalidExact), null)
})

test('request failures and unknown tenant entries never become zero', () => {
  const fleet = summarizeHawkViewPortfolioRisk(undefined, 'ERROR')
  const tenant = presentHawkViewTenantRisk(undefined, 'ERROR')
  assert.equal(fleet.count, null)
  assert.equal(fleet.state, 'failed')
  assert.equal(tenant.count, null)
  assert.equal(tenant.state, 'failed')
})

test('cached counts are withheld during loading and after failed refresh', () => {
  const value = response()
  for (const state of ['ERROR', 'LOADING'] as const) {
    assert.equal(presentHawkViewTenantRisk(value.tenants[0], state).count, null)
    assert.equal(summarizeHawkViewPortfolioRisk(value.fleet, state).count, null)
  }
  assert.equal(presentHawkViewTenantRisk(value.tenants[0], 'ERROR').state, 'failed')
})

test('rejects contradictory aggregate, incomplete clocks, unsafe shapes and impossible scope', () => {
  const mutations: Array<(value: NativeRiskSummaryResponse) => void> = [
    (value) => { value.tenants.pop() },
    (value) => { value.fleet.distinctUserCount = 50 },
    (value) => { value.fleet.enumeratedTenants = 2 },
    (value) => { value.tenants[0].distinctUserCount = Number.MAX_SAFE_INTEGER + 1 },
    (value) => { value.tenants[0].evaluatedAt = null },
    (value) => { value.tenants[0].evaluatedAt = '2026-09-16T12:00:00.000Z' },
    (value) => { value.tenants[0].windowStart = '2026-09-15T11:00:00.001Z' },
    (value) => { value.generatedAt = 'not-a-clock' },
    (value) => { value.tenants[0].windowEnd = '2026-02-30T11:00:00.000Z' },
    (value) => { value.tenants[0].complete = false },
    (value) => { value.tenants[0].availability = 'UNAVAILABLE' },
    (value) => { value.tenants[0].limitations = ['UNSUPPORTED'] },
    (value) => { Object.assign(value, { raw: { private: 'must-not-render' } }) },
  ]
  for (const mutate of mutations) {
    const value = response()
    mutate(value)
    assert.equal(parseNativeRiskSummary(value), null)
  }
  assert.equal(parseNativeRiskSummary(Object.create(response())), null)
  assert.equal(parseNativeRiskSummary(JSON.parse('{"__proto__":{}}')), null)
})

test('zero is exact only for complete assessed scope; an empty organization remains unknown', () => {
  const zero = response()
  zero.tenants.forEach((tenant) => { tenant.distinctUserCount = 0 })
  zero.fleet.distinctUserCount = 0
  assert.ok(parseNativeRiskSummary(zero))
  assert.equal(summarizeHawkViewPortfolioRisk(zero.fleet, 'SUCCESS').display, '0')
  const empty = response()
  empty.tenants = []
  Object.assign(empty.fleet, { availability: 'UNAVAILABLE', accuracy: 'NOT_AVAILABLE', distinctUserCount: null, totalTenants: 0, enumeratedTenants: 0, assessedTenants: 0, limitations: ['NO_TENANTS'] })
  assert.ok(parseNativeRiskSummary(empty))
  assert.equal(summarizeHawkViewPortfolioRisk(empty.fleet, 'SUCCESS').count, null)
})

test('scope cap is qualified and has a visible explanation, never a page-row total', () => {
  const value = response()
  value.tenants = Array.from({ length: 100 }, (_, index) => ({ ...value.tenants[0], tenantId: `synthetic-${index}`, distinctUserCount: 1 }))
  Object.assign(value.fleet, { availability: 'PARTIAL', accuracy: 'AT_LEAST', distinctUserCount: 100, totalTenants: 101, enumeratedTenants: 100, assessedTenants: 100, scopeComplete: false, limitations: ['SCOPE_CAPPED'] })
  assert.ok(parseNativeRiskSummary(value))
  const presented = summarizeHawkViewPortfolioRisk(value.fleet, 'SUCCESS')
  assert.equal(presented.display, '≥100')
  assert.match(presented.detail, /limited to 100 tenants/)
  assert.match(presented.detail, /counted separately/)
})

test('native values are dynamic and saved-withheld is not described as never assessed', () => {
  const value = response()
  value.tenants[0].distinctUserCount = 9
  value.fleet.distinctUserCount = 10
  assert.ok(parseNativeRiskSummary(value))
  assert.equal(summarizeHawkViewPortfolioRisk(value.fleet, 'SUCCESS').display, '10')
  const withheld = { ...value.tenants[0], availability: 'UNAVAILABLE' as const, accuracy: 'NOT_AVAILABLE' as const, distinctUserCount: null, complete: false, limitations: ['COUNT_WITHHELD'] }
  assert.match(presentHawkViewTenantRisk(withheld).detail, /saved assessment does not support/)
  assert.match(formatNativeRiskClock(withheld.evaluatedAt), /UTC/)
  assert.equal(formatNativeRiskClock(null), 'Not reported')
})
