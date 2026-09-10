import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const root = process.cwd()
const layout = readFileSync(`${root}/app/layout.tsx`, 'utf8')
const tenantPage = readFileSync(
  `${root}/app/(protected)/tenants/[id]/page.tsx`,
  'utf8'
)
const sectionSource =
  readFileSync(
    `${root}/components/identity-risk/identity-risk-section.tsx`,
    'utf8'
  ) +
  readFileSync(
    `${root}/components/identity-risk/risk-assessment-card.tsx`,
    'utf8'
  ) +
  readFileSync(
    `${root}/components/identity-risk/risk-assessment-drawer.tsx`,
    'utf8'
  )
const section = sectionSource.replace(/\s+/g, ' ')
const hook = readFileSync(`${root}/lib/api/identity-risk-hooks.ts`, 'utf8')
const navigation = readFileSync(`${root}/lib/tenants/navigation.ts`, 'utf8')
const blade = readFileSync(
  `${root}/app/(protected)/tenants/[id]/components/tenant-blade.tsx`,
  'utf8'
)
const presentation = readFileSync(
  `${root}/lib/identity-risk/presentation.ts`,
  'utf8'
)
const flagProvider = readFileSync(
  `${root}/components/providers/feature-flag-provider.tsx`,
  'utf8'
)
const flagPolicy = readFileSync(`${root}/lib/features/feature-flags.ts`, 'utf8')

test('identity-risk UI uses one global server exposure policy with an emergency hide', () => {
  assert.match(layout, /process\.env\.HAWKVIEW_IDENTITY_RISK_UI_ENABLED/)
  assert.doesNotMatch(layout, /NEXT_PUBLIC_.*IDENTITY_RISK/)
  assert.match(layout, /resolveServerFeatureFlags\(/)
  assert.match(layout, /<FeatureFlagProvider flags=\{featureFlags\}>/)
  assert.match(
    flagProvider,
    /React\.createContext<HawkViewFeatureFlags>\(\s*DEFAULT_HAWKVIEW_FEATURE_FLAGS/
  )
  assert.doesNotMatch(
    flagPolicy,
    /tenantId|organizationId|subscription|premium|localStorage|sessionStorage/
  )
  assert.doesNotMatch(flagProvider, /process\.env|localStorage|sessionStorage/)
  assert.match(hook, /enabled: enabled && Boolean\(tenantId\)/g)

  // Risky Users now sits at tenant top level rather than four levels down
  // inside Microsoft Entra. The same server flag is still the single switch
  // that exposes or hides it.
  assert.ok(navigation.includes("'risky-users'"))
  assert.ok(tenantPage.includes("section === 'risky-users'"))
  assert.ok(
    tenantPage.includes('<RiskyUsersSection tenantId={resolvedTenantId} />')
  )
  assert.ok(
    tenantPage.includes(
      "routeState.section === 'risky-users' && !identityRiskUi"
    )
  )
  assert.ok(
    tenantPage.includes(
      "hiddenSections={identityRiskUi ? undefined : ['risky-users']}"
    )
  )
  assert.ok(blade.includes("key: 'risky-users', label: 'Risky Users'"))

  // It is no longer framed as a Microsoft Entra feature, and the address it
  // used to live at redirects instead of dying.
  assert.ok(!tenantPage.includes("securityView === 'identity-risk'"))
  assert.ok(navigation.includes('legacyRiskyUsersRedirect'))
  assert.ok(
    tenantPage.includes('legacyRiskyUsersRedirect(pathname, resolvedTenantId)')
  )
})

test('the UI keeps HawkView and Microsoft evidence visibly separate', () => {
  assert.match(section, /HawkView identity risk indicators/)
  assert.match(section, /HawkView Risky Users/)
  assert.match(section, /Microsoft Entra Risky Users/)
  assert.match(section, /not\s+Microsoft Identity Protection determinations/)
  assert.match(section, /never merged into one score/)
})

test('the UI states its investigation-only and no-safe-verdict boundaries', () => {
  assert.match(section, /Suggested MSP actions/)
  assert.match(section, /does not take autonomous remediation actions/)
  assert.match(presentation, /does not establish that any identity is safe/)
  assert.match(section, /an empty snapshot is not a safe verdict/)
  assert.doesNotMatch(section, /compromise probability/i)
})

test('the Security tabs implement complete keyboard tab semantics', () => {
  assert.match(tenantPage, /tabIndex=\{isActive \? 0 : -1\}/)
  assert.match(tenantPage, /event\.key === 'ArrowRight'/)
  assert.match(tenantPage, /event\.key === 'ArrowLeft'/)
  assert.match(tenantPage, /event\.key === 'Home'/)
  assert.match(tenantPage, /event\.key === 'End'/)
})

test('bounded pages disclose when more records exist', () => {
  assert.match(section, /More HawkView findings are available/)
  assert.match(section, /More Microsoft risky-user records are available/)
  assert.match(section, /incomplete result set/)
})

test('summary counts retain investigation and evaluation semantics', () => {
  assert.match(presentation, /Risky users identified/)
  assert.match(presentation, /Risky user count unavailable/)
  assert.match(presentation, /Multiple findings for one user count once/)
  assert.match(section, /headline count comes from the tenant summary/)
  assert.match(section, /investigation priority/)
  assert.match(section, /Counts capped; scope incomplete/)
  assert.match(section, /Technical details/)
  assert.doesNotMatch(section, /Findings in this page/)
})

test('the UI distinguishes evaluated time and does not claim restricted detail support', () => {
  assert.match(section, /Channel evaluated/)
  assert.match(section, /Evidence observed/)
  assert.match(section, /Engine version/)
  assert.match(section, /Catalog version/)
  assert.doesNotMatch(section, />Contract version</)
  assert.match(section, /rule\.countsCapped/)
  assert.doesNotMatch(hook, /identity-signals\/findings\/\$\{/)
})
