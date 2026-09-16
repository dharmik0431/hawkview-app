import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as microsoftRiskSummary from '../identity-risk/microsoft-risk-summary.ts'
import * as tenantNavigation from '../tenants/navigation.ts'
import * as hawkViewRiskSummary from './hawkview-risk-summary.ts'

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

function compileMatrix(helpers: ReturnType<typeof compileHelpers>) {
  const exports: Record<string, unknown> = {}
  const source = readFileSync(
    new URL('../../components/dashboard/tenant-risk-matrix.tsx', import.meta.url),
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
      react: require('react'),
      'next/navigation': { useRouter: () => ({ push: () => undefined }) },
      'lucide-react': icons,
      '@/components/ui/button': { Button: () => null },
      '@/components/ui/badge': { Badge: () => null },
      '@/components/ui/tooltip': {
        Tooltip: () => null,
        TooltipContent: () => null,
        TooltipProvider: () => null,
        TooltipTrigger: () => null,
      },
      '@/lib/utils': { cn: (...values: unknown[]) => values.filter(Boolean).join(' ') },
      '@/lib/dashboard/hawkview-risk-summary': hawkViewRiskSummary,
      '@/lib/tenants/navigation': tenantNavigation,
      './tenant-risk-matrix-helpers': helpers,
      './tenant-risk-matrix-drawer': { TenantRiskMatrixDrawer: () => null },
    }[name] ?? require(name)),
    exports,
  )
  return exports as {
    compareTenantRiskSummaries: (
      a: Record<string, unknown>,
      b: Record<string, unknown>,
      direction: 'asc' | 'desc',
    ) => number
    sortTenantRiskMatrixTenants: (
      tenants: Record<string, unknown>[],
      sortColumn: 'users_at_risk',
      direction: 'asc' | 'desc',
      nativeRiskByTenant?: ReadonlyMap<string, hawkViewRiskSummary.NativeTenantRiskSummary>,
    ) => Record<string, unknown>[]
  }
}

const helpers = compileHelpers()
const matrix = compileMatrix(helpers)
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

test('Users at Risk sorting follows visible HawkView-native counts and never Microsoft or legacy scalars', () => {
  const exactZero = {
    ...baseTenant,
    name: 'Exact zero',
    microsoftRiskSummary: {
      source: 'MICROSOFT_IDENTITY_PROTECTION',
      availability: 'AVAILABLE',
      completeness: 'COMPLETE',
      rawRecordCount: 1,
      observedActiveDistinctUserCount: 0,
      activeDistinctUserCount: 0,
      ...clocks,
      reasonCode: null,
    },
  }
  const observedTwo = {
    ...baseTenant,
    name: 'Observed two',
    microsoftRiskSummary: {
      source: 'MICROSOFT_IDENTITY_PROTECTION',
      availability: 'PARTIAL',
      completeness: 'PARTIAL',
      rawRecordCount: 2,
      observedActiveDistinctUserCount: 2,
      activeDistinctUserCount: null,
      ...clocks,
      reasonCode: 'PARTIAL_RECORDS',
    },
  }
  const partialZero = {
    ...baseTenant,
    name: 'Partial zero',
    microsoftRiskSummary: {
      ...observedTwo.microsoftRiskSummary,
      observedActiveDistinctUserCount: 0,
    },
  }
  const missing = { ...baseTenant, name: 'Missing summary' }
  const invalid = {
    ...baseTenant,
    name: 'Invalid summary',
    microsoftRiskSummary: {
      ...exactZero.microsoftRiskSummary,
      rawRecordCount: 1,
      observedActiveDistinctUserCount: 9,
      activeDistinctUserCount: 9,
    },
  }

  const nativeRiskByTenant = new Map([
    [exactZero.id, {
      tenantId: exactZero.id,
      availability: 'AVAILABLE' as const,
      accuracy: 'EXACT' as const,
      distinctUserCount: 0,
      evaluatedAt: clocks.collectionSucceededAt,
      windowStart: null,
      windowEnd: null,
      complete: true,
      limitations: [],
    }],
    [observedTwo.id + '-observed', {
      tenantId: observedTwo.id + '-observed',
      availability: 'PARTIAL' as const,
      accuracy: 'AT_LEAST' as const,
      distinctUserCount: 2,
      evaluatedAt: clocks.collectionSucceededAt,
      windowStart: null,
      windowEnd: null,
      complete: false,
      limitations: ['PARTIAL_ASSESSMENT'],
    }],
  ])
  const nativeTenants = [
    exactZero,
    { ...observedTwo, id: observedTwo.id + '-observed' },
    { ...partialZero, id: partialZero.id + '-partial' },
    { ...missing, id: missing.id + '-missing' },
    { ...invalid, id: invalid.id + '-invalid' },
  ]

  const descending = matrix.sortTenantRiskMatrixTenants(
    nativeTenants,
    'users_at_risk',
    'desc',
    nativeRiskByTenant,
  )
  assert.deepEqual(
    descending.map((tenant) => tenant.name),
    ['Observed two', 'Exact zero', 'Invalid summary', 'Missing summary', 'Partial zero'],
  )

  const ascending = matrix.sortTenantRiskMatrixTenants(
    nativeTenants,
    'users_at_risk',
    'asc',
    nativeRiskByTenant,
  )
  assert.deepEqual(
    ascending.map((tenant) => tenant.name),
    ['Exact zero', 'Observed two', 'Invalid summary', 'Missing summary', 'Partial zero'],
  )
})
