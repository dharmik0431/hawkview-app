import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8')
}

test('tenant onboarding keeps the consent result open for least-privilege Exchange setup', () => {
  const tenants = source('app/(protected)/tenants/page.tsx')
  assert.match(tenants, /'select' \| 'hawkview' \| 'manual' \| 'exchange'/)
  assert.match(tenants, /setExchangeSetupTenantId\(message\.tenantId\)/)
  assert.match(tenants, /setOnboardingStep\('exchange'\)/)
  assert.match(tenants, /<ExchangeRbacSetup/)
  assert.match(tenants, /tenantId=\{exchangeSetupTenantId\}/)
})

test('Exchange setup is transparent about its exact read-only role and forbidden broad roles', () => {
  const component = source('components/tenants/exchange-rbac-setup.tsx')
  assert.match(component, /Get-Mailbox only/)
  assert.match(component, /Write access/)
  assert.match(component, />None</)
  assert.match(component, /Do not assign Recipient Management, Exchange Administrator, or Global Administrator/)
  assert.match(component, /Copy setup script/)
  assert.match(component, /No permission was changed/)
  assert.doesNotMatch(component, /we assigned|role was added automatically/i)
})
