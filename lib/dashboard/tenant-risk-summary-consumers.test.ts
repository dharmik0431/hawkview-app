import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as microsoftRiskSummary from '../identity-risk/microsoft-risk-summary.ts'
import * as tenantNavigation from '../tenants/navigation.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')

function compileHelpers() {
  const exports: Record<string, unknown> = {}
  const source = readFileSync(
    new URL('../../components/dashboard/tenant-risk-matrix-helpers.ts', import.meta.url),
    'utf8',
  )
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const icons = new Proxy({}, { get: () => () => null })
  new Function('require', 'exports', compiled)(
    (name: string) => ({
      'lucide-react': icons,
      '@/lib/attention/computeTenantAttention': {
        computeTenantAttention: (tenant: { attention?: unknown }) =>
          Array.isArray(tenant.attention) ? tenant.attention : [],
      },
      '@/lib/identity-risk/microsoft-risk-summary': microsoftRiskSummary,
      '@/lib/tenants/navigation': tenantNavigation,
    }[name] ?? require(name)),
    exports,
  )
  return exports as {
    getTenantRiskyUsersInfo: (tenant: Record<string, unknown>) => {
      count: number | null
      isExact?: boolean
      label: string
    }
    getTenantIdentityInfo: (tenant: Record<string, unknown>) => {
      riskyCount: number | null
      riskyText: string
    }
    getTenantRecommendedAction: (tenant: Record<string, unknown>) => {
      destinationUrl: string
    }
  }
}

const helpers = compileHelpers()
const tenantId = '11111111-1111-4111-8111-111111111111'
const baseTenant = {
  id: tenantId,
  status: 'active',
  connectionStatus: 'connected',
  riskyIdentityCount: 10,
  missingPermissions: [],
  attention: [],
  secureScore: 90,
  mfaCoverage: 100,
}
const clocks = {
  snapshotObservedAt: '2026-09-14T10:00:00.000Z',
  collectionSucceededAt: '2026-09-14T10:01:00.000Z',
}

test('missing or invalid summaries never revive the legacy tenant count or action', () => {
  const invalid = {
    source: 'MICROSOFT_IDENTITY_PROTECTION',
    availability: 'AVAILABLE',
    completeness: 'COMPLETE',
    rawRecordCount: 1,
    observedActiveDistinctUserCount: 9,
    activeDistinctUserCount: 9,
    ...clocks,
    reasonCode: null,
  }

  for (const tenant of [baseTenant, { ...baseTenant, microsoftRiskSummary: invalid }]) {
    const risk = helpers.getTenantRiskyUsersInfo(tenant)
    const identity = helpers.getTenantIdentityInfo(tenant)
    const action = helpers.getTenantRecommendedAction(tenant)
    assert.equal(risk.count, null)
    assert.equal(risk.isExact, false)
    assert.equal(identity.riskyCount, null)
    assert.doesNotMatch(identity.riskyText, /10|active Microsoft risk/i)
    assert.notEqual(action.destinationUrl, tenantNavigation.tenantRiskyUsersPath(tenantId))
  }
})

test('partial observed zero stays incomplete even when the legacy scalar is positive', () => {
  const risk = helpers.getTenantRiskyUsersInfo({
    ...baseTenant,
    microsoftRiskSummary: {
      source: 'MICROSOFT_IDENTITY_PROTECTION',
      availability: 'PARTIAL',
      completeness: 'PARTIAL',
      rawRecordCount: 10,
      observedActiveDistinctUserCount: 0,
      activeDistinctUserCount: null,
      ...clocks,
      reasonCode: 'PARTIAL_RECORDS',
    },
  })
  assert.equal(risk.count, null)
  assert.equal(risk.isExact, false)
  assert.match(risk.label, /incomplete/i)
})

test('valid summaries win over the legacy scalar without treating partial evidence as exact', () => {
  const exact = helpers.getTenantRiskyUsersInfo({
    ...baseTenant,
    microsoftRiskSummary: {
      source: 'MICROSOFT_IDENTITY_PROTECTION',
      availability: 'AVAILABLE',
      completeness: 'COMPLETE',
      rawRecordCount: 1,
      observedActiveDistinctUserCount: 1,
      activeDistinctUserCount: 1,
      ...clocks,
      reasonCode: null,
    },
  })
  assert.equal(exact.count, 1)
  assert.equal(exact.isExact, true)

  const tenant = {
    ...baseTenant,
    microsoftRiskSummary: {
      source: 'MICROSOFT_IDENTITY_PROTECTION',
      availability: 'PARTIAL',
      completeness: 'CONFLICTING',
      rawRecordCount: 5,
      observedActiveDistinctUserCount: 2,
      activeDistinctUserCount: null,
      ...clocks,
      reasonCode: 'CONFLICTING_RECORDS',
    },
  }
  const partial = helpers.getTenantRiskyUsersInfo(tenant)
  assert.equal(partial.count, 2)
  assert.equal(partial.isExact, false)
  assert.match(partial.label, /evidence requiring review/i)
  assert.equal(
    helpers.getTenantRecommendedAction(tenant).destinationUrl,
    tenantNavigation.tenantRiskyUsersPath(tenantId),
  )
})
