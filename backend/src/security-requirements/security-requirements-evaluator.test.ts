import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHECKS, evaluateCheck, HAWKVIEW_STARTER } from './security-requirements-evaluator.js'

const now = new Date('2026-10-16T05:00:00.000Z')
const collected = {
  status: 'SUCCEEDED',
  lastAttemptAt: new Date('2026-10-16T04:01:17.437Z'),
  observedAt: new Date('2026-10-16T04:01:17.644Z'),
  lastSuccessfulAt: new Date('2026-10-16T04:01:17.647Z'),
  payload: [{
    sharingCapability: 'existingExternalUserSharingOnly',
    isLegacyAuthProtocolsEnabled: false,
    isResharingByExternalUsersEnabled: true,
    isRequireAcceptingUserToMatchInvitedUserEnabled: true,
    idleSessionSignOut: { isEnabled: false },
    isUnmanagedSyncAppForTenantRestricted: true,
    allowedDomainGuidsForSyncApp: ['11111111-1111-4111-8111-111111111111'],
  }],
}

test('starter does not silently include security defaults', () => {
  assert.equal(HAWKVIEW_STARTER.checkIds.length, 3)
  assert.ok(!HAWKVIEW_STARTER.checkIds.includes('security-defaults-enabled'))
})

test('observed MSFT SharePoint values produce distinct outcomes', () => {
  const evidence = { SHAREPOINT_SETTINGS: collected }
  const sharing = evaluateCheck('sharepoint-anonymous-links-disabled', evidence, now)
  assert.equal(sharing.outcome, 'MET')
  assert.equal(sharing.observed, 'Sharing with existing signed-in guests only')
  assert.equal(evaluateCheck('sharepoint-legacy-auth-disabled', evidence, now).outcome, 'MET')
  assert.equal(evaluateCheck('sharepoint-guest-resharing-disabled', evidence, now).outcome, 'NEEDS_ACTION')
})

test('security defaults are an opt-in exact check, not a proxy for Conditional Access', () => {
  const evidence = { SECURITY_DEFAULTS: { ...collected, payload: [{ isEnabled: false }] } }
  assert.equal(evaluateCheck('security-defaults-enabled', evidence, now).outcome, 'NEEDS_ACTION')
})

test('additional stored SharePoint and OneDrive predicates are exact and opt-in', () => {
  const evidence = { SHAREPOINT_SETTINGS: collected }
  assert.equal(evaluateCheck('sharepoint-new-guest-sharing-disabled', evidence, now).outcome, 'MET')
  assert.equal(evaluateCheck('sharepoint-invitation-account-match-enabled', evidence, now).outcome, 'MET')
  assert.equal(evaluateCheck('sharepoint-idle-session-signout-enabled', evidence, now).outcome, 'NEEDS_ACTION')
  const sync = evaluateCheck('onedrive-sync-approved-domains-configured-v1', evidence, now)
  assert.equal(sync.outcome, 'MET')
  assert.equal(sync.service, 'OneDrive')
  assert.equal(sync.observed, 'Restriction enabled; 1 approved domain')
})

test('strict sharing level does not treat new guest access as a pass', () => {
  const newGuests = { SHAREPOINT_SETTINGS: { ...collected, payload: [{ sharingCapability: 'externalUserSharingOnly' }] } }
  assert.equal(evaluateCheck('sharepoint-anonymous-links-disabled', newGuests, now).outcome, 'MET')
  assert.equal(evaluateCheck('sharepoint-new-guest-sharing-disabled', newGuests, now).outcome, 'NEEDS_ACTION')
  assert.equal(evaluateCheck('sharepoint-external-sharing-disabled', newGuests, now).outcome, 'NEEDS_ACTION')
  const internal = { SHAREPOINT_SETTINGS: { ...collected, payload: [{ sharingCapability: 'disabled' }] } }
  assert.equal(evaluateCheck('sharepoint-external-sharing-disabled', internal, now).outcome, 'MET')
  assert.equal(evaluateCheck('sharepoint-sharing-domains-allowlisted-v1', internal, now).outcome, 'MET')
  const absent = { SHAREPOINT_SETTINGS: { ...collected, payload: [{ idleSessionSignOut: {}, isUnmanagedSyncAppForTenantRestricted: null }] } }
  assert.equal(evaluateCheck('sharepoint-idle-session-signout-enabled', absent, now).outcome, 'UNABLE_TO_ASSESS')
  assert.equal(evaluateCheck('onedrive-sync-approved-domains-configured-v1', absent, now).outcome, 'UNABLE_TO_ASSESS')
})

test('external sharing domain restriction requires a usable allow list', () => {
  const evaluate = (settings: Record<string, unknown>) => evaluateCheck('sharepoint-sharing-domains-allowlisted-v1', {
    SHAREPOINT_SETTINGS: { ...collected, payload: [{ sharingCapability: 'externalUserSharingOnly', ...settings }] },
  }, now)
  assert.equal(evaluate({ sharingDomainRestrictionMode: 'allowList', sharingAllowedDomainList: ['example.org'] }).outcome, 'MET')
  assert.equal(evaluate({ sharingDomainRestrictionMode: 'allowList', sharingAllowedDomainList: [] }).outcome, 'NEEDS_ACTION')
  assert.equal(evaluate({ sharingDomainRestrictionMode: 'blockList' }).outcome, 'NEEDS_ACTION')
  assert.equal(evaluate({ sharingDomainRestrictionMode: 'allowList' }).outcome, 'UNABLE_TO_ASSESS')
  assert.equal(evaluate({ sharingDomainRestrictionMode: 'allowList', sharingAllowedDomainList: [''] }).outcome, 'UNABLE_TO_ASSESS')
})

test('OneDrive sync needs a valid nonempty domain list before it can pass', () => {
  const evaluate = (settings: Record<string, unknown>) => evaluateCheck('onedrive-sync-approved-domains-configured-v1', {
    SHAREPOINT_SETTINGS: { ...collected, payload: [settings] },
  }, now)
  assert.equal(evaluate({ isUnmanagedSyncAppForTenantRestricted: false }).outcome, 'NEEDS_ACTION')
  assert.equal(evaluate({ isUnmanagedSyncAppForTenantRestricted: true, allowedDomainGuidsForSyncApp: [] }).outcome, 'NEEDS_ACTION')
  assert.equal(evaluate({ isUnmanagedSyncAppForTenantRestricted: true }).outcome, 'UNABLE_TO_ASSESS')
  assert.equal(evaluate({ isUnmanagedSyncAppForTenantRestricted: true, allowedDomainGuidsForSyncApp: ['not-a-guid'] }).outcome, 'UNABLE_TO_ASSESS')
  assert.equal(new Set<string>(CHECKS.map((check) => check.id)).has('onedrive-sync-restricted-to-specified-domains'), false)
})

test('MSP partner-domain choice rejects an extra tenant domain and never passes missing evidence', () => {
  const settings = { 'sharepoint-approved-partner-domains-v1': { approvedDomains: ['partner.example'] } }
  const evaluate = (record: Record<string, unknown>) => evaluateCheck('sharepoint-approved-partner-domains-v1', {
    SHAREPOINT_SETTINGS: { ...collected, payload: [record] },
  }, now, settings)
  assert.equal(evaluate({ sharingCapability: 'externalUserSharingOnly', sharingDomainRestrictionMode: 'allowList', sharingAllowedDomainList: ['partner.example'] }).outcome, 'MET')
  assert.equal(evaluate({ sharingCapability: 'externalUserSharingOnly', sharingDomainRestrictionMode: 'allowList', sharingAllowedDomainList: ['partner.example', 'unapproved.example'] }).outcome, 'NEEDS_ACTION')
  assert.equal(evaluate({ sharingCapability: 'externalUserSharingOnly', sharingDomainRestrictionMode: 'blockList', sharingAllowedDomainList: ['partner.example'] }).outcome, 'NEEDS_ACTION')
  assert.equal(evaluate({ sharingCapability: 'externalUserSharingOnly', sharingDomainRestrictionMode: 'allowList' }).outcome, 'UNABLE_TO_ASSESS')
  assert.equal(evaluate({ sharingCapability: 'disabled' }).outcome, 'MET')
  assert.equal(evaluateCheck('sharepoint-approved-partner-domains-v1', { SHAREPOINT_SETTINGS: { ...collected, status: 'FAILED' } }, now, settings).outcome, 'UNABLE_TO_ASSESS')
})

test('MSP sync GUID and retention choices compare only their exact tenant settings', () => {
  const guid = '11111111-1111-4111-8111-111111111111'
  const settings = {
    'onedrive-sync-approved-domain-guids-v1': { approvedDomainGuids: [guid] },
    'onedrive-deleted-user-retention-minimum-v1': { minimumDays: 180 },
  }
  const evidence = { SHAREPOINT_SETTINGS: { ...collected, payload: [{
    isUnmanagedSyncAppForTenantRestricted: true,
    allowedDomainGuidsForSyncApp: [guid],
    deletedUserPersonalSiteRetentionPeriodInDays: 93,
  }] } }
  assert.equal(evaluateCheck('onedrive-sync-approved-domain-guids-v1', evidence, now, settings).outcome, 'MET')
  assert.equal(evaluateCheck('onedrive-deleted-user-retention-minimum-v1', evidence, now, settings).outcome, 'NEEDS_ACTION')
  const expanded = { SHAREPOINT_SETTINGS: { ...collected, payload: [{
    isUnmanagedSyncAppForTenantRestricted: true,
    allowedDomainGuidsForSyncApp: [guid, '22222222-2222-4222-8222-222222222222'],
    deletedUserPersonalSiteRetentionPeriodInDays: 180,
  }] } }
  assert.equal(evaluateCheck('onedrive-sync-approved-domain-guids-v1', expanded, now, settings).outcome, 'NEEDS_ACTION')
  assert.equal(evaluateCheck('onedrive-deleted-user-retention-minimum-v1', expanded, now, settings).outcome, 'MET')
  assert.equal(evaluateCheck('onedrive-deleted-user-retention-minimum-v1', evidence, now).outcome, 'UNABLE_TO_ASSESS')
})

test('Entra Fido2 availability requires an enabled all-user method with no exclusions', () => {
  const method = { id: 'Fido2', state: 'enabled', includeTargets: [{ id: 'all_users', targetType: 'group' }], excludeTargets: [] }
  const evaluate = (rows: unknown[], state = 'SUCCEEDED') => evaluateCheck('entra-fido2-method-all-users-enabled-v1', {
    AUTH_METHOD_POLICIES: { ...collected, status: state, payload: rows },
  }, now)
  assert.equal(evaluate([method]).outcome, 'MET')
  assert.equal(evaluate([{ ...method, state: 'disabled' }]).outcome, 'NEEDS_ACTION')
  assert.equal(evaluate([{ ...method, includeTargets: [{ id: 'team-id', targetType: 'group' }] }]).outcome, 'NEEDS_ACTION')
  assert.equal(evaluate([{ ...method, excludeTargets: [{ id: 'excluded-group' }] }]).outcome, 'NEEDS_ACTION')
  assert.equal(evaluate([{ ...method, excludeTargets: undefined }]).outcome, 'UNABLE_TO_ASSESS')
  assert.equal(evaluate([]).outcome, 'UNABLE_TO_ASSESS')
  assert.equal(evaluate([method], 'FAILED').outcome, 'UNABLE_TO_ASSESS')
})

test('required Microsoft verified domains are checked against only the selected tenant inventory', () => {
  const settings = { 'm365-required-verified-domains-v1': { requiredDomains: ['brand.example', 'customer.example'] } }
  const evaluate = (rows: unknown[], state = 'SUCCEEDED') => evaluateCheck('m365-required-verified-domains-v1', {
    DOMAINS: { ...collected, status: state, payload: rows },
  }, now, settings)
  assert.equal(evaluate([{ name: 'brand.example' }, { name: 'customer.example' }]).outcome, 'MET')
  assert.equal(evaluate([{ name: 'brand.example' }]).outcome, 'NEEDS_ACTION')
  assert.equal(evaluate([{ name: 'brand.example' }, { name: 'invalid domain' }]).outcome, 'UNABLE_TO_ASSESS')
  assert.equal(evaluate([]).outcome, 'UNABLE_TO_ASSESS')
  assert.equal(evaluate([{ name: 'brand.example' }], 'FAILED').outcome, 'UNABLE_TO_ASSESS')
})

test('absent, failed, stale, conflicting and malformed evidence never produce a finding', () => {
  const variants = [
    undefined,
    { ...collected, status: 'FAILED' },
    { ...collected, lastSuccessfulAt: new Date('2026-10-14T00:00:00Z') },
    { ...collected, observedAt: new Date('2026-10-16T04:02:00Z') },
    { ...collected, payload: [] },
    { ...collected, payload: [{}] },
    { ...collected, payload: [{ sharingCapability: 'unexpected' }] },
  ]
  for (const variant of variants) {
    assert.equal(evaluateCheck('sharepoint-anonymous-links-disabled', { SHAREPOINT_SETTINGS: variant }, now).outcome, 'UNABLE_TO_ASSESS')
  }
})

test('exact Microsoft permission and licensing errors explain unavailable evidence without failing a setting', () => {
  const permission = evaluateCheck('security-defaults-enabled', { SECURITY_DEFAULTS: {
    status: 'FAILED', lastErrorCode: 'MICROSOFT_PERMISSION_REQUIRED', payload: undefined,
  } }, now)
  assert.equal(permission.outcome, 'UNABLE_TO_ASSESS')
  assert.match(permission.reason ?? '', /permission required/)
  const licence = evaluateCheck('entra-fido2-method-all-users-enabled-v1', { AUTH_METHOD_POLICIES: {
    status: 'FAILED', lastErrorCode: 'MICROSOFT_LICENSE_REQUIRED', payload: undefined,
  } }, now)
  assert.equal(licence.outcome, 'UNABLE_TO_ASSESS')
  assert.match(licence.reason ?? '', /licensing restriction/)
  const generic = evaluateCheck('security-defaults-enabled', { SECURITY_DEFAULTS: {
    status: 'FAILED', lastErrorCode: 'OTHER_ERROR', payload: undefined,
  } }, now)
  assert.doesNotMatch(generic.reason ?? '', /permission|licens/i)
})
