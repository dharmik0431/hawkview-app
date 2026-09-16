import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const source = (path: string) => readFileSync(join(root, path), 'utf8')

test('dashboard renders explicit evidence states and has no healthy or risky fabricated defaults', () => {
  const dashboard = source('app/(protected)/dashboard/page.tsx')
  const helpers = source('components/dashboard/tenant-risk-matrix-helpers.ts')

  assert.doesNotMatch(dashboard, /healthScore\s*\?\?\s*100/)
  assert.doesNotMatch(dashboard, /Risky users:\s*1/)
  assert.doesNotMatch(dashboard, /Math\.max\(1,\s*tenant\.identityDetected\)/)
  assert.doesNotMatch(dashboard, /Number\(value\)/)
  assert.match(dashboard, /LoadingState/)
  assert.match(dashboard, /ErrorState/)
  assert.match(dashboard, /EmptyState/)
  assert.match(dashboard, /Partial dashboard evidence/)
  assert.match(dashboard, /evidenceCount/)
  assert.match(helpers, /key: 'unknown'/)
  assert.match(helpers, /Risk data not reported/)
})

test('HawkView native and Microsoft risk consumers remain source-separated', () => {
  const dashboard = source('app/(protected)/dashboard/page.tsx')
  const helpers = source('components/dashboard/tenant-risk-matrix-helpers.ts')
  const matrix = source('components/dashboard/tenant-risk-matrix.tsx')
  const workspace = source('lib/tenant-workspace-state.ts')
  const section = source('components/identity-risk/risky-users-section.tsx')

  assert.match(dashboard, /normalizeMicrosoftRiskSummary/)
  assert.match(dashboard, /useNativeRiskSummary/)
  assert.match(dashboard, /<NativeRiskSummaryCard/)
  assert.match(source('components/dashboard/native-risk-summary-card.tsx'), /HawkView Risky Users/)
  assert.match(dashboard, /identityExact/)
  assert.doesNotMatch(dashboard, /riskyIdentityCount/)
  assert.doesNotMatch(dashboard, /partial \? `≥\$\{value\}`/)
  assert.match(helpers, /tenantRiskyUsersPath\(tenant\.id\)/)
  assert.doesNotMatch(helpers, /riskyIdentityCount/)
  assert.match(matrix, /sortTenantRiskMatrixTenants\([\s\S]*?nativeRiskByTenant/)
  assert.match(matrix, /Microsoft Entra:/)
  assert.doesNotMatch(matrix, /riskyIdentityCount/)
  assert.doesNotMatch(helpers, /'0 users at risk'|'No risky users'/)
  assert.match(workspace, /if \(key\.includes\('risky'\)\) return 'risky-users'/)
  assert.match(section, /id="microsoft-risk-summary"/)
  assert.match(section, /Microsoft Identity Protection/)
  assert.doesNotMatch(section, /activeMsCount|microsoftRecordsByPolarity/)
})

test('alert details navigation is bound to the alert tenant', () => {
  const modal = source('components/dashboard/alert-details-modal.tsx')
  assert.match(
    modal,
    /investigateDestination\([\s\S]*?item\.item\.actionUrl,[\s\S]*?item\.tenantId,[\s\S]*?\)/,
  )
})

test('activity normalization never invents timestamps, identities, outcomes, or random IDs', () => {
  const activity = source('app/(protected)/activity/page.tsx')
  const normalize = source('app/(protected)/activity/data/normalize.ts')
  const drawer = source('app/(protected)/activity/components/signin-drawer.tsx')
  const csv = source('app/(protected)/activity/utils/csv-exporter.ts')

  for (const text of [activity, normalize]) {
    assert.doesNotMatch(text, /unknown@tenant\.com/)
    assert.doesNotMatch(text, /Math\.random/)
    assert.doesNotMatch(text, /new Date\(\)\.toISOString\(\)/)
  }
  assert.doesNotMatch(activity, /lastError\s*\}/)
  assert.doesNotMatch(activity, /filters\.tenantId \? signInRows\.length : 0/)
  assert.match(normalize, /Not reported/)
  assert.match(activity, /Partial log evidence/)
  assert.doesNotMatch(drawer, /Copy JSON|Raw event \(JSON\)|event\.raw/)
  assert.doesNotMatch(csv, /event\.rowKey/)
  assert.match(drawer, /event\.eventId \?\? 'Not reported'/)
  assert.match(csv, /event\.eventId \|\| 'Not reported'/)
})

test('activity tabs expose associated panel semantics and keyboard navigation', () => {
  const activity = source('app/(protected)/activity/page.tsx')

  assert.match(activity, /role="tablist"/)
  assert.match(activity, /aria-controls="activity-log-panel"/)
  assert.match(activity, /role="tabpanel"/)
  assert.match(activity, /aria-labelledby={`activity-tab-\${tab}`}/)
  assert.match(activity, /event\.key === 'ArrowRight'/)
  assert.match(activity, /event\.key === 'ArrowLeft'/)
  assert.match(activity, /event\.key === 'Home'/)
  assert.match(activity, /event\.key === 'End'/)
  assert.match(activity, /\.current\?\.focus\(\)/)
})

test('workspace security surfaces do not advertise unverified provider enablement', () => {
  const team = source('app/(protected)/settings/team/page.tsx')
  const profile = source('app/(protected)/profile/page.tsx')
  const security = source('app/(protected)/profile/security/page.tsx')

  assert.doesNotMatch(team, /Supabase Identity & Authentication Engine/)
  assert.doesNotMatch(team, />Google Sign-In</)
  assert.doesNotMatch(team, />Microsoft Sign-In</)
  assert.match(team, /Workspace authentication configuration/)
  assert.match(team, /Not reported/)
  assert.doesNotMatch(profile, /user@hawkview\.net|HawkView Organization|Supabase Auth/)
  assert.doesNotMatch(security, /user@hawkview\.net|Supabase Auth/)
})

test('shell exposes only beta-ready navigation and provides a keyboard-accessible tablet menu', () => {
  const sidebar = source('components/layout/sidebar.tsx')
  const topbar = source('components/layout/topbar.tsx')
  const mobile = source('components/layout/mobile-navigation.tsx')
  const layout = source('app/(protected)/layout.tsx')

  assert.doesNotMatch(sidebar, /href="\/(?:security|reports|help)"/)
  assert.doesNotMatch(topbar, /Changelog/)
  assert.match(topbar, /'\/what-changed': 'What Changed\?'/)
  assert.match(mobile, /aria-modal="true"/)
  assert.match(mobile, /event\.key === 'Escape'/)
  assert.match(mobile, /event\.key !== 'Tab'/)
  assert.match(mobile, /lg:hidden/)
  assert.match(layout, /Skip to main content/)
  assert.match(layout, /id="main-content"/)
})
