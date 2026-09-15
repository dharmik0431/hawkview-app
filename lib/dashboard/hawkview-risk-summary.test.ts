import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNativeRiskSummary } from '../api/native-risk-summary-parser.ts'
import {
  presentHawkViewTenantRisk,
  summarizeHawkViewPortfolioRisk,
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
    tenants: [
      {
        tenantId: 'tenant-green',
        availability: 'AVAILABLE',
        accuracy: 'EXACT',
        distinctUserCount: 4,
        evaluatedAt: '2026-09-15T11:00:00.000Z',
        windowStart: '2026-09-08T11:00:00.000Z',
        windowEnd: '2026-09-15T11:00:00.000Z',
        complete: true,
        limitations: [],
      },
    ],
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
    scopeComplete: false,
    limitations: ['NO_CURRENT_RUN'],
  }
  value.tenants[0] = {
    ...value.tenants[0],
    availability: 'PARTIAL',
    accuracy: 'AT_LEAST',
    distinctUserCount: 2,
    complete: false,
    limitations: ['PARTIAL_ASSESSMENT'],
  }

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
