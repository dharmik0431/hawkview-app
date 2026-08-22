import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ExchangeReadOnlySetupSchema,
  ExchangeReadOnlyVerificationSchema,
} from '../../types/api.ts'

const validSetup = {
  contractVersion: 2,
  applicationId: '11111111-2222-4333-8444-555555555555',
  permission: 'Exchange.ManageAsAppV2',
  access: 'READ_ONLY',
  roleGroupName: 'HawkView Exchange Read Only',
  managementRoleName: 'HawkView Get-Mailbox Read Only',
  parentRoleName: 'View-Only Recipients',
  allowedCmdlets: ['Get-Mailbox'],
  collectedFields: ['Send on behalf delegates', 'Maximum send size'],
  unavailableFields: ['Full Access delegates', 'Send As delegates'],
  setupScript: '# setup',
  docsUrl: 'https://learn.microsoft.com/en-us/exchange/reference/admin-api-authentication',
  consentGranted: false,
  enabledAt: null,
}

test('accepts only the closed Get-Mailbox-only setup and verification contracts', () => {
  assert.equal(ExchangeReadOnlySetupSchema.parse(validSetup).allowedCmdlets[0], 'Get-Mailbox')
  assert.throws(() => ExchangeReadOnlySetupSchema.parse({
    ...validSetup,
    allowedCmdlets: ['Get-Mailbox', 'Set-Mailbox'],
  }))
  assert.throws(() => ExchangeReadOnlySetupSchema.parse({
    ...validSetup,
    access: 'WRITE',
  }))
  assert.deepEqual(ExchangeReadOnlyVerificationSchema.parse({
    enabled: true,
    enabledAt: '2026-08-21T12:00:00.000Z',
    collectedMailboxes: 5,
    allowedCmdlets: ['Get-Mailbox'],
  }).allowedCmdlets, ['Get-Mailbox'])
})

test('settings setup is optional, staged, and verifies before enabling', () => {
  const source = readFileSync(
    new URL('../../components/tenants/exchange-readonly-setup.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /Standard Graph collection continues normally if you skip this/)
  assert.match(source, /exchange-readonly\/consent/)
  assert.match(source, /exchange-readonly\/setup/)
  assert.match(source, /exchange-readonly\/verify/)
  assert.match(source, /Target authorization: exactly one Exchange cmdlet/)
  assert.match(source, /refuses a broader Microsoft Entra directory role/)
  assert.match(source, /Microsoft labels this API as Preview and says it is not yet available in every organization/)
  assert.match(source, /exchange-readonly-consented/)
  assert.match(source, /verification probe before collection is enabled/)
  assert.doesNotMatch(source, /Global Reader|Exchange Administrator|Recipient Management/)
})

test('optional consent returns to Administration and does not masquerade as collection verification', () => {
  const backend = readFileSync(
    new URL('../../backend/src/tenants/tenants.service.ts', import.meta.url),
    'utf8',
  )
  const settings = readFileSync(
    new URL('../../app/(protected)/tenants/[id]/settings/page.tsx', import.meta.url),
    'utf8',
  )
  assert.match(backend, /if \(tenantSettings\) url\.searchParams\.set\('tab', 'administration'\)/)
  assert.match(settings, /consentResult=\{microsoftConsentResult\}/)
  assert.doesNotMatch(settings, /searchParams\.get\('error'\)[\s\S]{0,200}ExchangeReadonlySetup/)
})

test('mailbox drawer distinguishes collected facts from unavailable permissions', () => {
  const source = readFileSync(
    new URL('../../app/(protected)/tenants/[id]/components/sections/exchange-section.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /exchangeReadOnly\?\.maxSendSize/)
  assert.match(source, /exchangeReadOnly\?\.sendOnBehalfTo/)
  assert.match(source, /Full Access[\s\S]{0,300}Not available from this API/)
  assert.match(source, /Send As[\s\S]{0,300}Not available from this API/)
  assert.doesNotMatch(source, /retentionLabel\s*\?\?\s*['"]No policy['"]/)
})
