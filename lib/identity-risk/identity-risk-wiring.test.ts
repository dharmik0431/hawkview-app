import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const root = process.cwd()
const layout = readFileSync(`${root}/app/layout.tsx`, 'utf8')
const tenantPage = readFileSync(
  `${root}/app/(protected)/tenants/[id]/page.tsx`,
  'utf8'
)
const section = readFileSync(
  `${root}/components/identity-risk/identity-risk-section.tsx`,
  'utf8'
)
const hook = readFileSync(`${root}/lib/api/identity-risk-hooks.ts`, 'utf8')
const presentation = readFileSync(`${root}/lib/identity-risk/presentation.ts`, 'utf8')
const flagProvider = readFileSync(`${root}/components/providers/feature-flag-provider.tsx`, 'utf8')
const flagPolicy = readFileSync(`${root}/lib/features/feature-flags.ts`, 'utf8')

test('identity-risk UI uses one global server exposure policy with an emergency hide', () => {
  assert.match(layout, /process\.env\.HAWKVIEW_IDENTITY_RISK_UI_ENABLED/)
  assert.doesNotMatch(layout, /NEXT_PUBLIC_.*IDENTITY_RISK/)
  assert.match(layout, /resolveServerFeatureFlags\(/)
  assert.match(layout, /<FeatureFlagProvider flags=\{featureFlags\}>/)
  assert.match(flagProvider, /React\.createContext<HawkViewFeatureFlags>\(\s*DEFAULT_HAWKVIEW_FEATURE_FLAGS/)
  assert.doesNotMatch(flagPolicy, /tenantId|organizationId|subscription|premium|localStorage|sessionStorage/)
  assert.doesNotMatch(flagProvider, /process\.env|localStorage|sessionStorage/)
  assert.match(tenantPage, /identityRiskUi\s*\?\s*\[\{ id: 'identity-risk'/)
  assert.match(tenantPage, /identityRiskUi && securityView === 'identity-risk'/)
  assert.match(hook, /enabled: enabled && Boolean\(tenantId\)/g)
})

test('the UI keeps HawkView and Microsoft evidence visibly separate', () => {
  assert.match(section, /HawkView identity risk indicators/)
  assert.match(section, /HawkView Identity Signals/)
  assert.match(section, /Microsoft Entra Risky Users/)
  assert.match(section, /not\s+Microsoft Identity Protection determinations/)
  assert.match(section, /never merged into one score/)
})

test('the UI states its investigation-only and no-safe-verdict boundaries', () => {
  assert.match(section, /Recommended human investigation/)
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
  assert.match(section, /must not be treated as a complete result set/)
})

test('summary counts retain investigation and evaluation semantics', () => {
  assert.match(section, /Identities needing review/)
  assert.match(section, /Open findings/)
  assert.match(section, /Rule evaluation outcomes/)
  assert.match(section, /not\s+compromised or safe identities/)
  assert.match(section, /At least/)
})

test('the UI distinguishes evaluated time and does not claim restricted detail support', () => {
  assert.match(section, /Channel evaluated/)
  assert.match(section, /Evidence observed/)
  assert.match(section, /Engine version/)
  assert.match(section, /Catalog version/)
  assert.doesNotMatch(section, />Contract version</)
  assert.match(section, /count\.capped && count\.value > 0/)
  assert.doesNotMatch(hook, /identity-signals\/findings\/\$\{/)
})
