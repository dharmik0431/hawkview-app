import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const source = (path: string) => readFileSync(join(root, path), 'utf8')

test('tenant security views consume the server-owned Conditional Access and Security Defaults evidence', () => {
  const page = source('app/(protected)/tenants/[id]/page.tsx')
  const conditionalAccess = source('app/(protected)/tenants/[id]/components/sections/entra-section.tsx')
  const licenses = source('app/(protected)/tenants/[id]/components/sections/licenses-section.tsx')
  const overview = source('app/(protected)/tenants/[id]/components/sections/entra-overview-section.tsx')

  assert.match(page, /collectionReadiness\?\.evidence\.conditionalAccess\.availability === 'READY'/)
  assert.match(page, /evidence=\{collectionReadiness\?\.evidence \?\? null\}/)
  assert.match(conditionalAccess, /No Conditional Access policies found/)
  assert.match(conditionalAccess, /Conditional Access is not licensed for this tenant/)
  assert.match(conditionalAccess, /Security Defaults is on/)
  assert.match(conditionalAccess, /does not prove Conditional Access policy coverage or universal MFA enforcement/)
  assert.match(licenses, /securityDefaultsEvidence\?\.availability !== 'READY'/)
  assert.match(page, /conditionalAccessEvidence=\{collectionReadiness\?\.evidence\.conditionalAccess \?\? null\}/)
  assert.match(overview, /conditionalAccessOverviewState\(conditionalAccessEvidence, caPolicies\)/)
  assert.match(overview, /if \(caOverview\.status === 'neutral'\) \{\s*return 'Incomplete data'/)
  assert.doesNotMatch(overview, /caPoliciesSynchronized && enabledCaPoliciesCount === 0/)
})

test('permission and risk presentation retain bounded evidence instead of inventing status', () => {
  const settings = source('app/(protected)/tenants/[id]/settings/page.tsx')
  const tenants = source('backend/src/tenants/tenants.service.ts')
  const dashboard = source('app/(protected)/dashboard/page.tsx')

  assert.match(settings, /Applicable permissions confirmed/)
  assert.match(settings, /accessCatalog \? microsoftAccessDatasetView\(rawDataset, accessCatalog\) : rawDataset/)
  assert.match(settings, /Verified tenant permission and readiness evidence remains visible below/)
  assert.doesNotMatch(tenants, /riskyUsersByTenant/)
  assert.match(tenants, /collectionReadiness\.evidence\.riskyIdentities\.count/)
  assert.match(dashboard, /evidenceCount\(kpis\.riskyIdentities, kpis\.riskPartial, 'Unavailable'\)/)
})

test('limited sign-in fallback is modeled as current partial evidence, not a failed collector', () => {
  const readiness = source('backend/src/tenants/collection-readiness.ts')
  const health = source('backend/src/tenants/tenant-health.ts')

  assert.match(readiness, /availability: fallbackCurrent \? 'CURRENT_LIMITED' : fallbackRunning \? 'STALE'/)
  assert.match(readiness, /selectedSource: fallbackSelected \|\| signInEntitlement === 'NON_PREMIUM' \? 'OFFICE_365_ACTIVITY_FEED'/)
  assert.match(health, /classification: 'PARTIAL'/)
  assert.match(health, /Limited sign-in evidence is active/)
  assert.match(health, /pendingJobs = operationalStates\.filter\(\(s\) => s\.status === 'RUNNING' && !isSignInFallback\(s\)\)/)
})
