import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MICROSOFT_CONSENT_MESSAGE,
  consentMessageFromSearch,
  consentResultCanOpenSetup,
  modalOnboardingCanComplete,
  modalOnboardingStep,
  modalStepStatus,
  normalizeMicrosoftConsentMessage,
  tenantSetupCanAutoOpen,
  tenantSetupDismissedKey,
  tenantSetupReturnPath,
} from './modal-tenant-onboarding.ts'
import type { TenantOnboarding } from './tenant-onboarding.ts'

const tenantId = '11111111-1111-4111-8111-111111111111'

const state = (
  microsoftAccess: TenantOnboarding['steps']['microsoftAccess']['status'],
  exchangeReadOnly: TenantOnboarding['steps']['exchangeReadOnly']['status'],
  reportVisibility: TenantOnboarding['steps']['reportVisibility']['status'],
  canFinish = false,
): TenantOnboarding => ({
  version: 1,
  tenant: {
    id: tenantId,
    name: 'Contoso',
    primaryDomain: 'contoso.example',
    microsoftTenantId: '22222222-2222-4222-8222-222222222222',
  },
  completedAt: null,
  canFinish,
  steps: {
    microsoftAccess: {
      required: true,
      status: microsoftAccess,
      errorCode: null,
      errorMessage: null,
    },
    exchangeReadOnly: {
      required: false,
      status: exchangeReadOnly,
      enabledAt: exchangeReadOnly === 'VERIFIED' ? '2026-08-30T00:00:00.000Z' : null,
      deferredAt: exchangeReadOnly === 'DEFERRED' ? '2026-08-30T00:00:00.000Z' : null,
      permission: 'Exchange.ManageAsAppV2',
      capability: 'Get-Mailbox only',
      disclaimer: 'Optional and read-only.',
    },
    reportVisibility: {
      required: false,
      status: reportVisibility,
      identifiersVisible: reportVisibility === 'VERIFIED' ? true : null,
      lastCheckedAt: null,
      deferredAt: reportVisibility === 'DEFERRED' ? '2026-08-30T00:00:00.000Z' : null,
      permission: 'ReportSettings.Read.All',
      adminCenterUrl: 'https://admin.microsoft.com/#/Settings/Services',
      settingPath: ['Settings', 'Org settings', 'Services', 'Reports'],
      settingLabel: 'Conceal user, group, and site names in all reports',
      disclaimer: 'Read-only verification.',
    },
  },
})

test('only a valid successful callback with a tenant UUID can trigger setup', () => {
  const success = consentMessageFromSearch(
    `?microsoftConsent=success&tenantId=${tenantId}`,
  )
  assert.equal(consentResultCanOpenSetup(success), true)
  assert.equal(tenantSetupCanAutoOpen(success, false), true)
  assert.equal(tenantSetupCanAutoOpen(success, true), false)
  assert.equal(tenantSetupReturnPath(success!), `/tenants?microsoftConsent=success&tenantId=${tenantId}`)

  const exchangeConsent = consentMessageFromSearch(
    `?microsoftConsent=exchange-readonly-consented&tenantId=${tenantId}`,
  )
  assert.equal(consentResultCanOpenSetup(exchangeConsent), true)
  assert.equal(
    tenantSetupReturnPath(exchangeConsent!),
    `/tenants?microsoftConsent=exchange-readonly-consented&tenantId=${tenantId}`,
  )

  for (const query of [
    '?microsoftConsent=success',
    '?microsoftConsent=success&tenantId=foreign',
    `?microsoftConsent=missing-permissions&tenantId=${tenantId}`,
    `?microsoftConsent=error&tenantId=${tenantId}`,
    `?microsoftConsent=exchange-readonly-error&tenantId=${tenantId}`,
  ]) {
    assert.equal(consentResultCanOpenSetup(consentMessageFromSearch(query)), false)
  }
})

test('popup messages fail closed for hostile, inherited, and future values', () => {
  assert.equal(normalizeMicrosoftConsentMessage(null), null)
  assert.equal(normalizeMicrosoftConsentMessage({}), null)
  assert.equal(normalizeMicrosoftConsentMessage({
    type: MICROSOFT_CONSENT_MESSAGE,
    result: 'future-success',
    tenantId,
  }), null)
  assert.equal(normalizeMicrosoftConsentMessage(Object.create({
    type: MICROSOFT_CONSENT_MESSAGE,
    result: 'success',
    tenantId,
  })), null)
})

test('server-confirmed truth selects the first incomplete actionable step', () => {
  assert.equal(modalOnboardingStep(state('CONSENT_REQUIRED', 'CONSENT_REQUIRED', 'CHECK_REQUIRED')), 1)
  assert.equal(modalOnboardingStep(state('ERROR', 'CONSENT_REQUIRED', 'CHECK_REQUIRED')), 1)
  assert.equal(modalOnboardingStep(state('VERIFIED', 'CONSENT_REQUIRED', 'CHECK_REQUIRED')), 2)
  assert.equal(modalOnboardingStep(state('VERIFIED', 'RBAC_REQUIRED', 'CHECK_REQUIRED')), 2)
  assert.equal(modalOnboardingStep(state('VERIFIED', 'VERIFIED', 'CHECK_REQUIRED')), 3)
  assert.equal(modalOnboardingStep(state('VERIFIED', 'DEFERRED', 'CHECK_REQUIRED')), 3)
  assert.equal(modalOnboardingStep(state('VERIFIED', 'DEFERRED', 'DEFERRED', true)), 3)
})

test('progress distinguishes Exchange verification from consent and skip', () => {
  assert.equal(modalStepStatus(state('VERIFIED', 'CONSENT_REQUIRED', 'CHECK_REQUIRED'), 2), 'Current')
  assert.equal(modalStepStatus(state('VERIFIED', 'RBAC_REQUIRED', 'CHECK_REQUIRED'), 2), 'Current')
  assert.equal(modalStepStatus(state('VERIFIED', 'VERIFIED', 'CHECK_REQUIRED'), 2), 'Complete')
  assert.equal(modalStepStatus(state('VERIFIED', 'DEFERRED', 'CHECK_REQUIRED'), 2), 'Skipped')
})

test('completion requires refreshed canFinish plus verified report names', () => {
  assert.equal(modalOnboardingCanComplete(state('VERIFIED', 'VERIFIED', 'VERIFIED', true)), true)
  assert.equal(modalOnboardingCanComplete(state('VERIFIED', 'DEFERRED', 'VERIFIED', true)), true)
  assert.equal(modalOnboardingCanComplete(state('VERIFIED', 'RBAC_REQUIRED', 'VERIFIED', true)), false)
  assert.equal(modalOnboardingCanComplete(state('VERIFIED', 'DEFERRED', 'DEFERRED', true)), false)
  assert.equal(modalOnboardingCanComplete(state('VERIFIED', 'DEFERRED', 'VERIFIED', false)), false)
})

test('session dismissal is scoped to the exact tenant', () => {
  assert.equal(
    tenantSetupDismissedKey(tenantId),
    `hawkview:tenant-setup-dismissed:${tenantId}`,
  )
})
