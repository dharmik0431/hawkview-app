import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8')
}

test('standard Exchange onboarding remains Graph-only and optional enrichment is not a gate', () => {
  const tenants = source('app/(protected)/tenants/page.tsx')
  const settings = source('app/(protected)/tenants/[id]/settings/page.tsx')
  const consent = source('backend/src/microsoft/microsoft-consent.service.ts')
  const collector = source('backend/src/tenants/tenant-sync.service.ts')

  assert.match(tenants, /optional Exchange enrichment requires/i)
  assert.match(tenants, /optional step\s+can be safely deferred and resumed later/)
  assert.match(settings, /ExchangeReadonlySetup/)
  assert.match(consent, /state\.flow === 'exchange-readonly'/)
  assert.match(consent, /'https:\/\/graph\.microsoft\.com\/\.default'/)
  assert.match(collector, /connection\?\.exchangeReadOnlyEnabledAt/)
  assert.match(collector, /CmdletName: 'Get-Mailbox'/)
  assert.doesNotMatch(tenants, /Global Reader|Exchange Administrator/)
})

test('Exchange customer UI does not fabricate retention or accepted-domain facts', () => {
  const component = source('app/(protected)/tenants/[id]/components/sections/exchange-section.tsx')
  assert.doesNotMatch(component, /No retention label/)
  assert.doesNotMatch(component, /Accepted Domains/)
  assert.doesNotMatch(component, /d\.type \|\| 'Authoritative'/)
  assert.match(component, /Mailbox retention-policy assignment/)
  assert.match(component, /Not available from this API/)
  assert.match(component, /Optional Exchange Get-Mailbox enrichment is not enabled/)
  assert.match(component, /Tenant-associated Microsoft 365 domains/)
})
