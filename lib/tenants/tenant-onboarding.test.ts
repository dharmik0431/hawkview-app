import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { onboardingNextStep, TenantOnboardingSchema } from './tenant-onboarding.ts'

const onboardingPage = readFileSync(
  new URL('../../app/(protected)/tenants/[id]/onboarding/page.tsx', import.meta.url),
  'utf8',
)

const base = {
  version: 1,
  tenant: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Contoso',
    primaryDomain: 'contoso.com',
    microsoftTenantId: '22222222-2222-4222-8222-222222222222',
  },
  completedAt: null,
  canFinish: false,
  steps: {
    microsoftAccess: { required: true, status: 'VERIFIED', errorCode: null, errorMessage: null },
    exchangeReadOnly: {
      required: false,
      status: 'CONSENT_REQUIRED',
      enabledAt: null,
      deferredAt: null,
      permission: 'Exchange.ManageAsAppV2',
      capability: 'Get-Mailbox only',
      disclaimer: 'Limited after verification.',
    },
    reportVisibility: {
      required: false,
      status: 'CHECK_REQUIRED',
      identifiersVisible: null,
      lastCheckedAt: null,
      deferredAt: null,
      permission: 'ReportSettings.Read.All',
      adminCenterUrl: 'https://admin.microsoft.com/#/Settings/Services',
      settingPath: ['Settings', 'Org settings', 'Services', 'Reports'],
      settingLabel: 'Conceal user, group, and site names in all reports',
      disclaimer: 'HawkView cannot change it.',
    },
  },
}

test('strict onboarding contract resumes at the first unresolved step', () => {
  const parsed = TenantOnboardingSchema.parse(base)
  assert.equal(onboardingNextStep(parsed), 'exchangeReadOnly')
  const deferred = TenantOnboardingSchema.parse({
    ...base,
    steps: {
      ...base.steps,
      exchangeReadOnly: { ...base.steps.exchangeReadOnly, status: 'DEFERRED' },
    },
  })
  assert.equal(onboardingNextStep(deferred), 'reportVisibility')
})

test('unknown fields and future contract versions fail closed', () => {
  assert.throws(() => TenantOnboardingSchema.parse({ ...base, version: 2 }))
  assert.throws(() => TenantOnboardingSchema.parse({ ...base, unexpected: true }))
})

test('report-setting verification has immediate inline feedback and correct read-only instructions', () => {
  assert.match(onboardingPage, /Checking Microsoft/)
  assert.match(onboardingPage, /aria-busy=/)
  assert.match(onboardingPage, /Last checked with Microsoft/)
  assert.match(onboardingPage, /UNCHECK/)
  assert.doesNotMatch(onboardingPage, /Enable: “/)
})
