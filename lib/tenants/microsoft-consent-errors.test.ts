import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { microsoftConsentErrorMessage } from './microsoft-consent-errors.ts'

test('explains when a Microsoft tenant belongs to another HawkView organization', () => {
  assert.equal(
    microsoftConsentErrorMessage('tenant-already-connected'),
    'This Microsoft 365 tenant is already connected to another HawkView organization. Ask an administrator of that organization to remove the tenant before adding it here.',
  )
})

test('does not expose unknown Microsoft consent errors', () => {
  const expected =
    'Microsoft administrator consent could not be verified. Review the tenant connection and try again.'

  assert.equal(microsoftConsentErrorMessage('unexpected-provider-detail'), expected)
  assert.equal(microsoftConsentErrorMessage(null), expected)
})

test('keeps callback errors on the recovery path and opens setup only after success', () => {
  const tenantPage = readFileSync(
    new URL('../../app/(protected)/tenants/page.tsx', import.meta.url),
    'utf8',
  )
  const fallbackPage = readFileSync(
    new URL('../../app/(protected)/tenants/[id]/onboarding/page.tsx', import.meta.url),
    'utf8',
  )

  assert.match(
    tenantPage,
    /else if \(message\?\.result === 'error'\) \{\s+setShowOnboarding\(true\)\s+setOnboardingStep\('select'\)\s+setOnboardingError\(microsoftConsentErrorMessage\(message\.error\)\)/,
  )
  assert.match(tenantPage, /consentResultCanOpenSetup\(message\)/)
  assert.match(fallbackPage, /window\.opener\.location\.assign\(currentUrl\.href\)/)
  assert.match(fallbackPage, /microsoftConsentErrorMessage\(consentError\)/)
  assert.match(tenantPage, /role="alert"\s+aria-live="assertive"/)
})
