import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8')
}

test('standard Exchange onboarding has no Exchange Admin API or PowerShell RBAC step', () => {
  const tenants = source('app/(protected)/tenants/page.tsx')
  const settings = source('app/(protected)/tenants/[id]/settings/page.tsx')
  const consent = source('backend/src/microsoft/microsoft-consent.service.ts')
  const collector = source('backend/src/tenants/tenant-sync.service.ts')

  for (const value of [tenants, settings, consent, collector]) {
    assert.doesNotMatch(value, /Exchange\.ManageAsAppV2/)
    assert.doesNotMatch(value, /ExchangeRbacSetup/)
    assert.doesNotMatch(value, /getTenantExchangeAccessToken/)
    assert.doesNotMatch(value, /outlook\.office365\.com\/adminapi/)
    assert.doesNotMatch(value, /Get-Mailbox/)
  }
})

test('Exchange customer UI does not fabricate retention or accepted-domain facts', () => {
  const component = source('app/(protected)/tenants/[id]/components/sections/exchange-section.tsx')
  assert.doesNotMatch(component, /No retention label/)
  assert.doesNotMatch(component, /Accepted Domains/)
  assert.doesNotMatch(component, /d\.type \|\| 'Authoritative'/)
  assert.match(component, /Mailbox retention-policy assignment/)
  assert.match(component, /Not collected in standard mode/)
  assert.match(component, /Tenant-associated Microsoft 365 domains/)
})
