import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dialog = readFileSync(
  new URL('../../components/tenants/tenant-onboarding-dialog.tsx', import.meta.url),
  'utf8',
)
const directory = readFileSync(
  new URL('../../app/(protected)/tenants/page.tsx', import.meta.url),
  'utf8',
)
const fallback = readFileSync(
  new URL('../../app/(protected)/tenants/[id]/onboarding/page.tsx', import.meta.url),
  'utf8',
)

test('successful callbacks trigger a modal that refetches server truth', () => {
  assert.match(directory, /consentResultCanOpenSetup\(message\)/)
  assert.match(directory, /openTenantSetup\(message\.tenantId, true\)/)
  assert.match(dialog, /apiClient\.get<unknown>\([\s\S]*?\/onboarding/)
  assert.match(dialog, /TenantOnboardingSchema\.parse\(raw\)/)
  assert.match(dialog, /steps\.microsoftAccess\.status !== 'VERIFIED'/)
  assert.doesNotMatch(directory, /Microsoft 365 consent is verified\. HawkView will begin/)
})

test('the primary wizard has exactly three textual steps and one active panel', () => {
  assert.match(dialog, /1: 'Microsoft app installed'/)
  assert.match(dialog, /2: 'Set up Exchange access'/)
  assert.match(dialog, /3: 'Show names in Microsoft 365 reports'/)
  assert.match(dialog, /aria-label="Tenant setup progress"/)
  assert.match(dialog, /aria-current=\{current \? 'step'/)
  assert.match(dialog, /<section[\s\S]*?aria-labelledby=\{`tenant-setup-step-\$\{activeStep\}`\}/)
})

test('Exchange consent, RBAC verification, and skip remain distinct', () => {
  assert.match(dialog, /exchangeStatus === 'CONSENT_REQUIRED'/)
  assert.match(dialog, /exchangeStatus === 'RBAC_REQUIRED'/)
  assert.match(dialog, /\/exchange-readonly\/consent/)
  assert.match(dialog, /\/exchange-readonly\/setup/)
  assert.match(dialog, /\/exchange-readonly\/verify/)
  assert.match(dialog, /\/onboarding\/exchange-readonly\/defer/)
  assert.match(dialog, /Get-Mailbox only/)
  assert.match(dialog, /Skip for now/)
  assert.match(dialog, /ExchangeReadOnlyVerificationSchema\.parse\(raw\)[\s\S]*?loadState\(false\)/)
})

test('report verification reuses safe feedback and has no primary report skip', () => {
  assert.match(dialog, /executeReportVisibilityVerification/)
  assert.match(dialog, /ReportVisibilityVerificationSchema\.parse\(raw\)/)
  assert.match(dialog, /Re-consent Microsoft access/)
  assert.match(dialog, /Checking Microsoft…/)
  assert.match(dialog, /Last checked with Microsoft/)
  assert.match(dialog, /UNCHECK/)
  assert.doesNotMatch(dialog, /report-visibility\/defer/)
})

test('final completion is gated by a fresh DTO and verified report state', () => {
  const refresh = dialog.indexOf('const rawCurrent = await apiClient.get<unknown>')
  const gate = dialog.indexOf('if (!modalOnboardingCanComplete(current))')
  const completion = dialog.indexOf('/onboarding/complete')
  assert.ok(refresh >= 0 && gate > refresh && completion > gate)
  assert.match(dialog, /if \(!completed\.completedAt\)/)
})

test('close is session-bounded while visible resume controls remain', () => {
  assert.match(directory, /sessionStorage\.setItem\([\s\S]*?tenantSetupDismissedKey/)
  assert.match(directory, /tenantSetupCanAutoOpen\(message, dismissed\)/)
  assert.equal((directory.match(/onClick=\{\(\) => openTenantSetup\(String\(tenant\.id\)\)\}/g) ?? []).length, 2)
  assert.match(dialog, />Finish later</)
  assert.match(dialog, /Open full setup and recovery page/)
  assert.match(directory, /handledConsentMessagesRef\.current\.delete\(messageKey\)/)
})

test('dialog provides keyboard, focus, live-region, zoom, and motion safety', () => {
  assert.match(dialog, /role="dialog"/)
  assert.match(dialog, /aria-modal="true"/)
  assert.match(dialog, /aria-labelledby="tenant-setup-title"/)
  assert.match(dialog, /event\.key === 'Escape'/)
  assert.match(dialog, /event\.key !== 'Tab'/)
  assert.match(dialog, /priorFocusRef\.current\?\.focus\(\)/)
  assert.match(dialog, /aria-live="polite"/)
  assert.match(dialog, /max-h-\[calc\(100dvh-1rem\)\]/)
  assert.match(dialog, /motion-reduce:transition-none/)
})

test('successful callbacks resume the modal while failures retain the fallback route', () => {
  assert.match(fallback, /consentResultCanOpenSetup\(consentMessage\)/)
  assert.match(fallback, /window\.opener\.postMessage\(consentMessage, window\.location\.origin\)/)
  assert.match(fallback, /window\.opener\.location\.assign\(currentUrl\.href\)/)
  assert.match(fallback, /window\.location\.replace\(returnPath\)/)
  assert.match(fallback, /microsoftConsentErrorMessage\(consentError\)/)
})
