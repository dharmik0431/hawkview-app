import { normalizeDomain, normalizeGuid, type CheckSettings } from './security-requirements-settings.js'

export const CHECKS = [
  {
    id: 'sharepoint-anonymous-links-disabled',
    title: 'Anonymous SharePoint links are disabled',
    service: 'SharePoint',
    recommendation: 'HAWKVIEW_STARTER',
    choiceGroup: 'external-sharing-level',
    source: 'Microsoft SharePoint settings',
    resourceType: 'SHAREPOINT_SETTINGS',
    expected: 'Sharing is restricted to signed-in external users or disabled.',
    guidance: 'Review the organization sharing capability in SharePoint admin settings.',
  },
  {
    id: 'sharepoint-new-guest-sharing-disabled',
    title: 'SharePoint sharing is limited to existing guests or internal users',
    service: 'SharePoint',
    recommendation: 'STRICT_OPTION',
    choiceGroup: 'external-sharing-level',
    source: 'Microsoft SharePoint settings',
    resourceType: 'SHAREPOINT_SETTINGS',
    expected: 'The organization sharing level is Existing guests or Only people in your organization.',
    guidance: 'Review the organization sharing level and any site-specific sharing restrictions before changing it.',
  },
  {
    id: 'sharepoint-external-sharing-disabled',
    title: 'SharePoint external sharing is disabled',
    service: 'SharePoint',
    recommendation: 'STRICT_OPTION',
    choiceGroup: 'external-sharing-level',
    source: 'Microsoft SharePoint settings',
    resourceType: 'SHAREPOINT_SETTINGS',
    expected: 'The organization sharing level is Only people in your organization.',
    guidance: 'Choose this only when external collaboration is not needed; check site-specific access and Entra B2B policies separately.',
  },
  {
    id: 'sharepoint-sharing-domains-allowlisted-v1',
    title: 'External sharing is off or domain-allowlisted',
    service: 'SharePoint',
    recommendation: 'OPTIONAL',
    choiceGroup: null,
    source: 'Microsoft SharePoint settings',
    resourceType: 'SHAREPOINT_SETTINGS',
    expected: 'External sharing is disabled, or Anyone links are disabled and the tenant uses an Allow list with at least one external email domain.',
    guidance: 'Review the sharing level, actual allowed domains, and Entra B2B restrictions; a domain Allow list does not restrict Anyone links or prove every partner or site-specific access.',
  },
  {
    id: 'sharepoint-approved-partner-domains-v1',
    title: 'SharePoint sharing is limited to MSP-approved partner domains',
    service: 'SharePoint',
    recommendation: 'OPTIONAL',
    choiceGroup: null,
    parameterKind: 'approvedDomains',
    source: 'Microsoft SharePoint settings',
    resourceType: 'SHAREPOINT_SETTINGS',
    expected: 'External sharing is disabled, or Anyone links are disabled and the tenant allow list contains only the partner domains selected by the MSP.',
    guidance: 'Review the sharing level, allowed domains, and site-specific sharing rules. A domain Allow list does not restrict Anyone links or prove that invitations or site access work.',
  },
  {
    id: 'sharepoint-legacy-auth-disabled',
    title: 'SharePoint legacy authentication is disabled',
    service: 'SharePoint',
    recommendation: 'HAWKVIEW_STARTER',
    choiceGroup: null,
    source: 'Microsoft SharePoint settings',
    resourceType: 'SHAREPOINT_SETTINGS',
    expected: 'Legacy authentication protocols are disabled.',
    guidance: 'Review the legacy authentication setting in SharePoint admin settings.',
  },
  {
    id: 'sharepoint-guest-resharing-disabled',
    title: 'Guest resharing of others’ items requires Full Control',
    service: 'SharePoint',
    recommendation: 'HAWKVIEW_STARTER',
    choiceGroup: null,
    source: 'Microsoft SharePoint settings',
    resourceType: 'SHAREPOINT_SETTINGS',
    expected: 'The tenant guest-resharing setting is off. Guests with Full Control may still share items.',
    guidance: 'Review the external-user resharing setting and site permissions in SharePoint admin settings. This setting does not revoke a guest’s Full Control sharing permission.',
  },
  {
    id: 'sharepoint-direct-site-creation-disabled-v1',
    title: 'Direct SharePoint site creation by users is disabled',
    service: 'SharePoint',
    recommendation: 'OPTIONAL',
    choiceGroup: null,
    source: 'Microsoft SharePoint settings',
    resourceType: 'SHAREPOINT_SETTINGS',
    expected: 'The collected isSiteCreationEnabled setting is false for direct user site creation. Users may still create Microsoft 365 Groups or Teams and their connected SharePoint sites.',
    guidance: 'Review Settings > Site creation in the SharePoint admin center before restricting legitimate collaboration. Check satellite geos separately where applicable. This setting does not stop users from creating Microsoft 365 groups or Teams and their connected SharePoint sites; manage group creation separately if needed.',
  },
  {
    id: 'sharepoint-invitation-account-match-enabled',
    title: 'SharePoint invited-account matching is enabled',
    service: 'SharePoint',
    recommendation: 'OPTIONAL',
    choiceGroup: null,
    source: 'Microsoft SharePoint settings',
    resourceType: 'SHAREPOINT_SETTINGS',
    expected: 'The SharePoint invited-account matching setting is enabled.',
    guidance: 'Review Entra B2B integration too: it can govern the effective invitation behavior independently of this SharePoint flag.',
  },
  {
    id: 'sharepoint-idle-session-signout-enabled',
    title: 'SharePoint idle session sign-out is configured',
    service: 'SharePoint',
    recommendation: 'OPTIONAL',
    choiceGroup: null,
    source: 'Microsoft SharePoint settings',
    resourceType: 'SHAREPOINT_SETTINGS',
    expected: 'The tenant setting is enabled with a positive warning time and a later sign-out time. Microsoft Entra P1/P2 licensing and actual session enforcement are not verified.',
    guidance: 'Review the warning and sign-out times, Microsoft Entra licensing, device scope and Conditional Access. The setting does not affect existing sessions or prove a user was signed out.',
  },
  {
    id: 'onedrive-sync-approved-domains-configured-v1',
    title: 'AD-domain PC sync restriction is configured',
    service: 'OneDrive',
    recommendation: 'STRICT_OPTION',
    choiceGroup: null,
    source: 'Microsoft SharePoint and OneDrive tenant settings',
    resourceType: 'SHAREPOINT_SETTINGS',
    expected: 'The collected SharePoint setting enables AD-domain PC sync restriction and lists at least one domain GUID.',
    guidance: 'Check each geo separately. This setting does not cover Entra-only joined PCs, Mac or mobile sync by default, or files already synced.',
  },
  {
    id: 'onedrive-sync-approved-domain-guids-v1',
    title: 'Configured AD-domain PC sync GUIDs match the MSP-approved list',
    service: 'OneDrive',
    recommendation: 'OPTIONAL',
    choiceGroup: null,
    parameterKind: 'approvedDomainGuids',
    source: 'Microsoft SharePoint and OneDrive tenant settings',
    resourceType: 'SHAREPOINT_SETTINGS',
    expected: 'The collected SharePoint AD-domain PC sync setting is enabled and its configured domain GUIDs are within the MSP-approved set.',
    guidance: 'Check each geo separately. This setting does not cover Entra-only joined PCs, Mac or mobile sync by default, or files already synced.',
  },
  {
    id: 'onedrive-deleted-user-retention-minimum-v1',
    title: 'Deleted-user OneDrive tenant retention setting meets the MSP minimum',
    service: 'OneDrive',
    recommendation: 'OPTIONAL',
    choiceGroup: null,
    parameterKind: 'minimumDays',
    source: 'Microsoft SharePoint and OneDrive tenant settings',
    resourceType: 'SHAREPOINT_SETTINGS',
    expected: 'The deleted-user OneDrive retention setting is at least the MSP-selected number of days.',
    guidance: 'This setting is not a complete data-retention policy; Purview retention policies can take precedence.',
  },
  {
    id: 'security-defaults-enabled',
    title: 'Microsoft security defaults are enabled',
    service: 'Entra',
    recommendation: 'OPTIONAL',
    choiceGroup: null,
    source: 'Microsoft Entra security defaults',
    resourceType: 'SECURITY_DEFAULTS',
    expected: 'Security defaults are enabled.',
    guidance: 'Review security defaults and your Conditional Access strategy before changing either.',
  },
  {
    id: 'entra-fido2-method-all-users-enabled-v1',
    title: 'FIDO2 method policy is enabled for all users without exclusions',
    service: 'Entra',
    recommendation: 'OPTIONAL',
    choiceGroup: null,
    source: 'Microsoft Entra authentication method policy',
    resourceType: 'AUTH_METHOD_POLICIES',
    expected: 'The Fido2 method is enabled, targets all_users, and has no excluded targets.',
    guidance: 'This checks method-policy availability and targeting only. It does not prove new registrations are allowed, users enrolled, or Conditional Access requires passkeys.',
  },
  {
    id: 'entra-authenticator-push-all-users-enabled-v1',
    title: 'Microsoft Authenticator push is enabled for all users in the methods policy',
    service: 'Entra',
    recommendation: 'OPTIONAL',
    choiceGroup: null,
    source: 'Microsoft Entra authentication method policy',
    resourceType: 'AUTH_METHOD_POLICIES',
    expected: 'The Microsoft Authenticator methods policy is enabled with one all_users target in push or any mode and no excluded targets.',
    guidance: 'This checks the Authentication methods policy for sign-in. It does not prove user registration, SSPR coverage, MFA enforcement, or Conditional Access coverage. Legacy policies can also permit the method. Passwordless-only deviceBasedPush does not satisfy it.',
  },
  {
    id: 'm365-required-verified-domains-v1',
    title: 'MSP-required domains appear in the Microsoft organization inventory',
    service: 'Microsoft 365',
    recommendation: 'OPTIONAL',
    choiceGroup: null,
    parameterKind: 'requiredDomains',
    source: 'Microsoft Graph organization verifiedDomains',
    resourceType: 'DOMAINS',
    expected: 'Every domain selected by the MSP appears in the tenant-associated organization.verifiedDomains inventory.',
    guidance: 'This checks stored organization-inventory membership, not the /domains isVerified field, DNS mail authentication, Exchange accepted-domain type, or service health.',
  },
] as const

export type CheckId = typeof CHECKS[number]['id']
export type ResourceType = typeof CHECKS[number]['resourceType']
export const HAWKVIEW_STARTER = {
  id: 'hawkview-starter-v1',
  name: 'HawkView Essentials',
  description: 'A conservative starting template using three SharePoint tenant settings HawkView can assess from current stored evidence.',
  boundary: 'It does not assess Entra MFA or Conditional Access, OneDrive device policy, Exchange threat protection, or Microsoft 365 audit coverage.',
  checkIds: [
    'sharepoint-anonymous-links-disabled',
    'sharepoint-legacy-auth-disabled',
    'sharepoint-guest-resharing-disabled',
  ] as CheckId[],
} as const

export type EvidenceInput = {
  status?: string | null
  lastErrorCode?: string | null
  lastAttemptAt?: Date | null
  lastSuccessfulAt?: Date | null
  observedAt?: Date | null
  payload?: unknown
}

export type CheckResult = {
  id: CheckId
  title: string
  source: string
  expected: string
  guidance: string
  resourceType: ResourceType
  service: typeof CHECKS[number]['service']
  recommendation: typeof CHECKS[number]['recommendation']
  choiceGroup: string | null
  outcome: 'MET' | 'NEEDS_ACTION' | 'UNABLE_TO_ASSESS'
  observed: string
  observedAt: string | null
  reason: string | null
}

const MAX_EVIDENCE_AGE_MS = 26 * 60 * 60 * 1000
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function unavailableReason(evidence: EvidenceInput | undefined, fallback: string): string {
  if (evidence?.status === 'FAILED' && evidence.lastErrorCode === 'MICROSOFT_PERMISSION_REQUIRED') {
    return 'Microsoft reported that the permission required for this resource is missing or not granted.'
  }
  if (evidence?.status === 'FAILED' && evidence.lastErrorCode === 'MICROSOFT_LICENSE_REQUIRED') {
    return 'Microsoft reported a licensing restriction for this resource.'
  }
  return fallback
}

function usableRecord(evidence: EvidenceInput | undefined, now: Date):
  | { record: Record<string, unknown>; observedAt: string }
  | { reason: string } {
  if (!evidence || evidence.status !== 'SUCCEEDED') {
    return { reason: unavailableReason(evidence, 'This resource has no successful current collection.') }
  }
  const attempt = evidence.lastAttemptAt?.getTime()
  const success = evidence.lastSuccessfulAt?.getTime()
  const observed = evidence.observedAt?.getTime()
  if (attempt === undefined || success === undefined || observed === undefined ||
      !Number.isFinite(attempt) || !Number.isFinite(success) || !Number.isFinite(observed) ||
      attempt > observed || observed > success || success > now.getTime() + 60_000) {
    return { reason: 'The stored evidence and success clocks cannot be correlated.' }
  }
  if (now.getTime() - success > MAX_EVIDENCE_AGE_MS) {
    return { reason: 'The last successful collection is older than 26 hours.' }
  }
  // The state can advance independently of an older stored snapshot. Do not
  // borrow its newer success clock to make that snapshot appear current.
  if (now.getTime() - observed > MAX_EVIDENCE_AGE_MS) {
    return { reason: 'The stored configuration snapshot is older than 26 hours.' }
  }
  if (!Array.isArray(evidence.payload) || evidence.payload.length !== 1 ||
      !evidence.payload[0] || typeof evidence.payload[0] !== 'object' ||
      Array.isArray(evidence.payload[0])) {
    return { reason: 'The stored configuration record is missing or malformed.' }
  }
  return { record: evidence.payload[0] as Record<string, unknown>, observedAt: evidence.observedAt!.toISOString() }
}

function usableRows(evidence: EvidenceInput | undefined, now: Date, label: string, maximumRows: number):
  | { rows: Record<string, unknown>[]; observedAt: string }
  | { reason: string } {
  if (!evidence || evidence.status !== 'SUCCEEDED') return { reason: unavailableReason(evidence, `The ${label} has no successful current collection.`) }
  const attempt = evidence.lastAttemptAt?.getTime()
  const success = evidence.lastSuccessfulAt?.getTime()
  const observed = evidence.observedAt?.getTime()
  if (attempt === undefined || success === undefined || observed === undefined ||
      !Number.isFinite(attempt) || !Number.isFinite(success) || !Number.isFinite(observed) ||
      attempt > observed || observed > success || success > now.getTime() + 60_000) {
    return { reason: `The ${label} evidence and success clocks cannot be correlated.` }
  }
  if (now.getTime() - success > MAX_EVIDENCE_AGE_MS) return { reason: `The last successful ${label} collection is older than 26 hours.` }
  if (now.getTime() - observed > MAX_EVIDENCE_AGE_MS) return { reason: `The stored ${label} snapshot is older than 26 hours.` }
  if (!Array.isArray(evidence.payload) || evidence.payload.length > maximumRows ||
      evidence.payload.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    return { reason: `The stored ${label} collection is malformed.` }
  }
  return { rows: evidence.payload as Record<string, unknown>[], observedAt: evidence.observedAt!.toISOString() }
}

export function evaluateCheck(
  checkId: CheckId,
  evidenceByResource: Partial<Record<ResourceType, EvidenceInput>>,
  now: Date = new Date(),
  settings: CheckSettings = {},
): CheckResult {
  const check = CHECKS.find((candidate) => candidate.id === checkId)!
  const base = {
    id: check.id,
    title: check.title,
    source: check.source,
    expected: check.expected,
    guidance: check.guidance,
    resourceType: check.resourceType,
    service: check.service,
    recommendation: check.recommendation,
    choiceGroup: check.choiceGroup,
  }
  if (checkId === 'entra-fido2-method-all-users-enabled-v1' || checkId === 'entra-authenticator-push-all-users-enabled-v1') {
    const authenticator = checkId === 'entra-authenticator-push-all-users-enabled-v1'
    const methodId = authenticator ? 'MicrosoftAuthenticator' : 'Fido2'
    const usable = usableRows(evidenceByResource.AUTH_METHOD_POLICIES, now, 'authentication method policy', 100)
    if ('reason' in usable) return { ...base, outcome: 'UNABLE_TO_ASSESS', observed: 'Unavailable', observedAt: null, reason: usable.reason }
    if (usable.rows.some((row) => typeof row.id !== 'string' || !row.id.trim())) {
      return { ...base, outcome: 'UNABLE_TO_ASSESS', observed: 'Unavailable', observedAt: usable.observedAt,
        reason: 'The stored authentication method collection contains an unidentified configuration.' }
    }
    const matching = usable.rows.filter((row) => row.id === methodId)
    if (matching.length !== 1) return { ...base, outcome: 'UNABLE_TO_ASSESS', observed: 'Unavailable', observedAt: usable.observedAt,
      reason: `The ${methodId} method configuration is absent or duplicated in the stored collection.` }
    const method = matching[0]
    if (method.state !== 'enabled' && method.state !== 'disabled') return { ...base, outcome: 'UNABLE_TO_ASSESS', observed: 'Unavailable', observedAt: usable.observedAt,
      reason: `The ${methodId} method state is absent or unrecognized.` }
    if (!Array.isArray(method.includeTargets) || !Array.isArray(method.excludeTargets)) return { ...base, outcome: 'UNABLE_TO_ASSESS', observed: 'Unavailable', observedAt: usable.observedAt,
      reason: `The ${methodId} include or exclude targets are absent.` }
    // A projected malformed target becomes {}. If one target is unreadable, an
    // all_users row cannot establish the complete policy scope or exclusions.
    const validTarget = (target: unknown) => target !== null && typeof target === 'object' && !Array.isArray(target) &&
      typeof (target as Record<string, unknown>).id === 'string' && Boolean(((target as Record<string, unknown>).id as string).trim()) &&
      ['group', 'user'].includes(String((target as Record<string, unknown>).targetType))
    if (method.includeTargets.length + method.excludeTargets.length > 1_000 ||
        !method.includeTargets.every(validTarget) || !method.excludeTargets.every(validTarget)) {
      return { ...base, outcome: 'UNABLE_TO_ASSESS', observed: 'Unavailable', observedAt: usable.observedAt,
        reason: `The ${methodId} policy targets are malformed, unrecognized, or exceed the supported bound.` }
    }
    const allUsers = method.includeTargets.some((target) => target && typeof target === 'object' && !Array.isArray(target) &&
      (target as Record<string, unknown>).id === 'all_users' && (target as Record<string, unknown>).targetType === 'group')
    if (authenticator) {
      // Other included groups can carry a different authenticationMode. Avoid
      // inferring effective all-user push availability from overlapping targets.
      if (allUsers && method.includeTargets.length > 1) return { ...base, outcome: 'UNABLE_TO_ASSESS', observed: 'Unavailable', observedAt: usable.observedAt,
        reason: 'Microsoft Authenticator has overlapping include targets whose effective mode is not established.' }
      const mode = allUsers ? (method.includeTargets[0] as Record<string, unknown>).authenticationMode : undefined
      if (allUsers && mode !== 'any' && mode !== 'push' && mode !== 'deviceBasedPush') {
        return { ...base, outcome: 'UNABLE_TO_ASSESS', observed: 'Unavailable', observedAt: usable.observedAt,
          reason: 'The all-user Microsoft Authenticator mode is absent or unrecognized.' }
      }
      const met = method.state === 'enabled' && allUsers && (mode === 'any' || mode === 'push') && method.excludeTargets.length === 0
      return { ...base, outcome: met ? 'MET' : 'NEEDS_ACTION',
        observed: `${method.state}; ${allUsers ? `all users targeted in ${mode} mode` : 'all users not targeted'}; ${method.excludeTargets.length} excluded target${method.excludeTargets.length === 1 ? '' : 's'}`,
        observedAt: usable.observedAt, reason: null }
    }
    const met = method.state === 'enabled' && allUsers && method.excludeTargets.length === 0
    return { ...base, outcome: met ? 'MET' : 'NEEDS_ACTION',
      observed: `${method.state}; ${allUsers ? 'all users targeted' : 'all users not targeted'}; ${method.excludeTargets.length} excluded target${method.excludeTargets.length === 1 ? '' : 's'}`,
      observedAt: usable.observedAt, reason: null }
  }
  if (checkId === 'm365-required-verified-domains-v1') {
    const configured = settings[checkId]?.requiredDomains
    const required = Array.isArray(configured) && configured.length > 0 &&
      configured.every((domain) => normalizeDomain(domain) === domain) ? configured : undefined
    const usable = usableRows(evidenceByResource.DOMAINS, now, 'organization-domain inventory', 1000)
    const expected = required?.length ? `Microsoft organization-domain inventory includes: ${required.join(', ')}.` : base.expected
    if ('reason' in usable) return { ...base, expected, outcome: 'UNABLE_TO_ASSESS', observed: 'Unavailable', observedAt: null, reason: usable.reason }
    if (!required?.length || usable.rows.length === 0) return { ...base, expected, outcome: 'UNABLE_TO_ASSESS', observed: 'Unavailable', observedAt: usable.observedAt,
      reason: !required?.length ? 'The saved required-domain choice is missing or malformed.' : 'The organization-domain inventory is empty.' }
    const domains = usable.rows.map((row) => normalizeDomain(row.name))
    if (domains.some((domain) => !domain)) return { ...base, expected, outcome: 'UNABLE_TO_ASSESS', observed: 'Unavailable', observedAt: usable.observedAt,
      reason: 'The stored organization-domain inventory contains an invalid domain.' }
    const missing = required.filter((domain) => !domains.includes(domain))
    return { ...base, expected, outcome: missing.length ? 'NEEDS_ACTION' : 'MET',
      observed: `${domains.length} organization domain${domains.length === 1 ? '' : 's'}; ${missing.length} required domain${missing.length === 1 ? '' : 's'} absent`,
      observedAt: usable.observedAt, reason: null }
  }
  const usable = usableRecord(evidenceByResource[check.resourceType], now)
  if ('reason' in usable) {
    return { ...base, outcome: 'UNABLE_TO_ASSESS', observed: 'Unavailable', observedAt: null, reason: usable.reason }
  }

  if (checkId === 'sharepoint-idle-session-signout-enabled') {
    const idle = usable.record.idleSessionSignOut
    const setting = idle && typeof idle === 'object' && !Array.isArray(idle)
      ? idle as Record<string, unknown> : null
    if (!setting || typeof setting.isEnabled !== 'boolean') {
      return { ...base, outcome: 'UNABLE_TO_ASSESS', observed: 'Unavailable', observedAt: usable.observedAt,
        reason: 'The tenant idle session sign-out setting is absent or unrecognized.' }
    }
    if (!setting.isEnabled) {
      return { ...base, outcome: 'NEEDS_ACTION', observed: 'Disabled', observedAt: usable.observedAt, reason: null }
    }
    const warn = setting.warnAfterInSeconds
    const signOut = setting.signOutAfterInSeconds
    if (typeof warn !== 'number' || !Number.isSafeInteger(warn) || warn <= 0 ||
        typeof signOut !== 'number' || !Number.isSafeInteger(signOut) || signOut <= warn) {
      return { ...base, outcome: 'UNABLE_TO_ASSESS', observed: 'Enabled; timeouts unavailable', observedAt: usable.observedAt,
        reason: 'The required warning and sign-out times are absent, invalid, or out of order.' }
    }
    return { ...base, outcome: 'MET', observed: `Enabled; warning after ${warn} seconds; sign-out after ${signOut} seconds`,
      observedAt: usable.observedAt, reason: null }
  }

  if (checkId === 'sharepoint-approved-partner-domains-v1') {
    const configured = settings[checkId]?.approvedDomains
    const approved = Array.isArray(configured) && configured.length > 0 &&
      configured.every((domain) => normalizeDomain(domain) === domain) ? configured : undefined
    const sharing = usable.record.sharingCapability
    const mode = usable.record.sharingDomainRestrictionMode
    const rawDomains = usable.record.sharingAllowedDomainList
    const expected = approved?.length ? `External sharing disabled, or Anyone links disabled with an Allow list containing only: ${approved.join(', ')}.` : base.expected
    const outcome = (met: boolean | null, observed: string, reason: string | null = null): CheckResult => ({
      ...base, expected, observed, observedAt: usable.observedAt,
      outcome: met === null ? 'UNABLE_TO_ASSESS' : met ? 'MET' : 'NEEDS_ACTION', reason,
    })
    if (!approved?.length) return outcome(null, 'Unavailable', 'The saved approved-domain choice is missing or malformed.')
    if (sharing === 'disabled') return outcome(true, 'External sharing disabled')
    if (!['externalUserSharingOnly', 'existingExternalUserSharingOnly', 'externalUserAndGuestSharing'].includes(String(sharing))) {
      return outcome(null, 'Unavailable', 'The external sharing level is absent or unrecognized.')
    }
    if (sharing === 'externalUserAndGuestSharing') {
      return outcome(false, 'Anyone links permitted; the partner-domain Allow list does not restrict anonymous links')
    }
    if (mode === 'none' || mode === 'blockList') return outcome(false, `External sharing domain mode: ${mode}`)
    if (mode !== 'allowList' || !Array.isArray(rawDomains) || !rawDomains.length) {
      return outcome(null, 'Unavailable', 'The partner-domain Allow list is absent or malformed.')
    }
    const domains = rawDomains.map(normalizeDomain)
    if (domains.some((domain) => !domain)) return outcome(null, 'Unavailable', 'The stored partner-domain list contains an invalid domain.')
    const unexpected = (domains as string[]).filter((domain) => !approved.includes(domain))
    return outcome(unexpected.length === 0, `Allow list with ${domains.length} domain${domains.length === 1 ? '' : 's'}${unexpected.length ? `; ${unexpected.length} outside the approved set` : ''}`)
  }
  if (checkId === 'onedrive-sync-approved-domain-guids-v1') {
    const configured = settings[checkId]?.approvedDomainGuids
    const approved = Array.isArray(configured) && configured.length > 0 &&
      configured.every((guid) => normalizeGuid(guid) === guid) ? configured : undefined
    const enabled = usable.record.isUnmanagedSyncAppForTenantRestricted
    const rawGuids = usable.record.allowedDomainGuidsForSyncApp
    const expected = approved?.length ? `Collected AD-domain PC sync setting enabled; configured domain GUIDs limited to ${approved.length} MSP-approved ${approved.length === 1 ? 'identity' : 'identities'}.` : base.expected
    const outcome = (met: boolean | null, observed: string, reason: string | null = null): CheckResult => ({
      ...base, expected, observed, observedAt: usable.observedAt,
      outcome: met === null ? 'UNABLE_TO_ASSESS' : met ? 'MET' : 'NEEDS_ACTION', reason,
    })
    if (!approved?.length) return outcome(null, 'Unavailable', 'The saved approved-domain identity choice is missing or malformed.')
    if (enabled === false) return outcome(false, 'AD-domain PC sync setting disabled')
    if (enabled !== true || !Array.isArray(rawGuids)) return outcome(null, 'Unavailable', 'The sync restriction or configured domain list is absent.')
    const guids = rawGuids.map(normalizeGuid)
    if (guids.some((guid) => !guid)) return outcome(null, 'Unavailable', 'The stored sync domain list contains an invalid GUID.')
    const unexpected = (guids as string[]).filter((guid) => !approved.includes(guid))
    return outcome(guids.length > 0 && unexpected.length === 0, `AD-domain PC sync setting enabled; ${guids.length} configured domain GUID${guids.length === 1 ? '' : 's'}${unexpected.length ? `; ${unexpected.length} outside the approved set` : ''}`)
  }
  if (checkId === 'onedrive-deleted-user-retention-minimum-v1') {
    const minimumDays = settings[checkId]?.minimumDays
    const days = usable.record.deletedUserPersonalSiteRetentionPeriodInDays
    const expected = Number.isInteger(minimumDays)
      ? `At least ${minimumDays} days in the deleted-user OneDrive tenant retention setting; effective content retention is not assessed.`
      : base.expected
    if (!Number.isInteger(minimumDays) || (minimumDays as number) < 30 || (minimumDays as number) > 3650 ||
        !Number.isInteger(days) || (days as number) < 30 || (days as number) > 3650) {
      return { ...base, expected, outcome: 'UNABLE_TO_ASSESS', observed: 'Unavailable', observedAt: usable.observedAt,
        reason: 'The saved minimum or collected retention setting is absent or outside the supported range.' }
    }
    return { ...base, expected, outcome: (days as number) >= (minimumDays as number) ? 'MET' : 'NEEDS_ACTION',
      observed: `${days} days`, observedAt: usable.observedAt, reason: null }
  }

  let value: unknown
  switch (checkId) {
    case 'sharepoint-anonymous-links-disabled':
    case 'sharepoint-new-guest-sharing-disabled':
    case 'sharepoint-external-sharing-disabled':
    case 'sharepoint-sharing-domains-allowlisted-v1':
      value = usable.record.sharingCapability
      break
    case 'sharepoint-legacy-auth-disabled':
      value = usable.record.isLegacyAuthProtocolsEnabled
      break
    case 'sharepoint-guest-resharing-disabled':
      value = usable.record.isResharingByExternalUsersEnabled
      break
    case 'sharepoint-direct-site-creation-disabled-v1':
      value = usable.record.isSiteCreationEnabled
      break
    case 'sharepoint-invitation-account-match-enabled':
      value = usable.record.isRequireAcceptingUserToMatchInvitedUserEnabled
      break
    case 'onedrive-sync-approved-domains-configured-v1':
      value = usable.record.isUnmanagedSyncAppForTenantRestricted
      break
    case 'security-defaults-enabled':
      value = usable.record.isEnabled
      break
  }

  let met: boolean | null = null
  let observed: string
  if (checkId === 'sharepoint-sharing-domains-allowlisted-v1') {
    const mode = usable.record.sharingDomainRestrictionMode
    const domains = usable.record.sharingAllowedDomainList
    observed = value === 'disabled' ? 'External sharing disabled' : typeof mode === 'string' ? `External sharing domain mode: ${mode}` : 'Unavailable'
    if (value === 'disabled') met = true
    if (value === 'externalUserAndGuestSharing') {
      met = false
      observed = 'Anyone links permitted; the domain Allow list does not restrict anonymous links'
    }
    if (value === 'externalUserSharingOnly' || value === 'existingExternalUserSharingOnly') {
      if (mode === 'none' || mode === 'blockList') met = false
      if (mode === 'allowList' && Array.isArray(domains) && domains.every((domain) => normalizeDomain(domain) !== null)) {
        met = domains.length > 0
        observed = `Allow list with ${domains.length} domain${domains.length === 1 ? '' : 's'}`
      }
    }
  } else if (checkId === 'sharepoint-anonymous-links-disabled' || checkId === 'sharepoint-new-guest-sharing-disabled' || checkId === 'sharepoint-external-sharing-disabled') {
    const sharingLabels: Record<string, string> = {
      disabled: 'External sharing disabled',
      externalUserSharingOnly: 'Sharing with signed-in external users',
      existingExternalUserSharingOnly: 'Sharing with existing signed-in guests only',
      externalUserAndGuestSharing: 'Anyone links permitted',
    }
    observed = typeof value === 'string' ? sharingLabels[value] ?? 'Unrecognized sharing setting' : 'Unavailable'
    if (checkId === 'sharepoint-anonymous-links-disabled') {
      if (value === 'externalUserAndGuestSharing') met = false
      if (value === 'disabled' || value === 'externalUserSharingOnly' || value === 'existingExternalUserSharingOnly') met = true
    } else if (checkId === 'sharepoint-new-guest-sharing-disabled') {
      if (value === 'externalUserAndGuestSharing' || value === 'externalUserSharingOnly') met = false
      if (value === 'disabled' || value === 'existingExternalUserSharingOnly') met = true
    } else {
      if (value === 'disabled') met = true
      if (value === 'externalUserAndGuestSharing' || value === 'externalUserSharingOnly' || value === 'existingExternalUserSharingOnly') met = false
    }
  } else if (checkId === 'onedrive-sync-approved-domains-configured-v1') {
    const domains = usable.record.allowedDomainGuidsForSyncApp
    observed = value === true ? 'AD-domain PC sync setting enabled' : value === false ? 'AD-domain PC sync setting disabled' : 'Unavailable'
    if (value === false) met = false
    if (value === true && Array.isArray(domains) && domains.every((domain) => typeof domain === 'string' && GUID.test(domain))) {
      met = domains.length > 0
      observed = `AD-domain PC sync setting enabled; ${domains.length} configured domain GUID${domains.length === 1 ? '' : 's'}`
    }
  } else if (checkId === 'sharepoint-direct-site-creation-disabled-v1') {
    observed = value === true ? 'Direct SharePoint site creation by users enabled' :
      value === false ? 'Direct SharePoint site creation by users disabled' : 'Unavailable'
    if (typeof value === 'boolean') met = !value
  } else {
    observed = typeof value === 'boolean' ? (value ? 'Enabled' : 'Disabled') : 'Unavailable'
    if (typeof value === 'boolean') {
      met = checkId === 'sharepoint-legacy-auth-disabled' || checkId === 'sharepoint-guest-resharing-disabled' ? !value : value
    }
  }
  if (met === null) {
    return { ...base, outcome: 'UNABLE_TO_ASSESS', observed, observedAt: usable.observedAt, reason: checkId === 'onedrive-sync-approved-domains-configured-v1' && value === true
      ? 'The restriction is enabled, but its approved-domain list is missing or malformed.'
      : checkId === 'sharepoint-sharing-domains-allowlisted-v1'
        ? 'The external sharing level, restriction mode, or allowed-domain list is missing or unrecognized.'
        : 'The selected setting is absent or has an unrecognized value.' }
  }
  return { ...base, outcome: met ? 'MET' : 'NEEDS_ACTION', observed, observedAt: usable.observedAt, reason: null }
}
