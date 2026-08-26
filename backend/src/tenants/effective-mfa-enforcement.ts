export const EFFECTIVE_MFA_ENFORCEMENT_CONTRACT_VERSION = 1 as const

export type EffectiveMfaEnforcementStatus =
  | 'COVERED_BY_CONDITIONAL_ACCESS'
  | 'CONDITIONALLY_COVERED'
  | 'REPORT_ONLY'
  | 'NOT_COVERED'
  | 'UNKNOWN'

export type MfaEvidenceState = {
  status: 'FRESH' | 'STALE' | 'MISSING' | 'FAILED' | 'PERMISSION_LIMITED'
  observedAt: string | null
  reason: string | null
}

export type EffectiveMfaPolicyEvidence = {
  id: string
  name: string
  state: 'ENABLED' | 'REPORT_ONLY' | 'DISABLED'
  outcome: 'UNIVERSAL' | 'CONDITIONAL' | 'NOT_ENFORCED'
  materialConditions: string[]
}

export type EffectiveMfaEnforcementProjection = {
  contractVersion: typeof EFFECTIVE_MFA_ENFORCEMENT_CONTRACT_VERSION
  status: EffectiveMfaEnforcementStatus
  label: string
  policies: EffectiveMfaPolicyEvidence[]
  reasonCodes: string[]
  evaluatedAt: string
  evidenceObservedAt: string | null
  riskReductionAllowed: boolean
}

export type EffectiveMfaSubject = {
  id: string
  userType: 'Member' | 'Guest' | 'Unknown'
  externalTenantId?: string | null
  transitiveGroupIds: string[] | null
  activeRoleTemplateIds: string[] | null
}

export type EffectiveMfaEvaluationInput = {
  subject: EffectiveMfaSubject
  policies: unknown
  authenticationStrengths: unknown
  evidence: {
    policies: MfaEvidenceState
    membership: MfaEvidenceState
    roles: MfaEvidenceState
    authenticationStrengths: MfaEvidenceState
  }
  now?: Date
}

export type MicrosoftRiskFact = {
  value: 'low' | 'medium' | 'high' | 'none' | 'unknown'
  source: string
  observedAt: string | null
  state: 'REPORTED' | 'NOT_REPORTED' | 'STALE' | 'FAILED' | 'PERMISSION_LIMITED'
}

export type UserPostureRiskProjection = {
  contractVersion: 1
  mfaEnforcementExposure: 'low' | 'medium' | 'unknown'
  microsoftUserRisk: MicrosoftRiskFact
  microsoftSignInRisk: MicrosoftRiskFact
  overall: 'low' | 'medium' | 'high' | 'unknown'
  components: Array<{ key: string; value: string; source: string }>
}

type RecordLike = Record<string, unknown>

function record(value: unknown): RecordLike | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordLike
    : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim()))]
    : []
}

function text(value: unknown, fallback: string, max = 256) {
  return typeof value === 'string' && value.trim()
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
    : fallback
}

function evidenceReason(key: string, evidence: MfaEvidenceState) {
  return `${key}_${evidence.status}`
}

function isFresh(evidence: MfaEvidenceState) {
  return evidence.status === 'FRESH'
}

function selectorSet(values: string[] | null) {
  return new Set((values ?? []).map((value) => value.toLowerCase()))
}

function externalSelectorMatches(
  raw: unknown,
  subject: EffectiveMfaSubject,
): { matches: boolean; unknown: boolean } {
  const selector = record(raw)
  if (!selector || subject.userType !== 'Guest') return { matches: false, unknown: false }
  const types = text(selector.guestOrExternalUserTypes, '', 500).toLowerCase()
  if (types && !types.includes('guest') && !types.includes('external')) {
    return { matches: false, unknown: false }
  }
  const tenants = record(selector.externalTenants)
  const kind = text(tenants?.membershipKind, '', 40).toLowerCase()
  if (!kind || kind === 'all') return { matches: true, unknown: false }
  const members = strings(tenants?.members).map((value) => value.toLowerCase())
  if (!subject.externalTenantId) return { matches: false, unknown: true }
  const included = members.includes(subject.externalTenantId.toLowerCase())
  return { matches: kind === 'enumerated' ? included : false, unknown: kind !== 'enumerated' }
}

function targetEvaluation(
  policy: RecordLike,
  subject: EffectiveMfaSubject,
  evidence: EffectiveMfaEvaluationInput['evidence'],
) {
  const users = record(record(policy.conditions)?.users) ?? {}
  const includeUsers = selectorSet(strings(users.includeUsers))
  const excludeUsers = selectorSet(strings(users.excludeUsers))
  const includeGroups = selectorSet(strings(users.includeGroups))
  const excludeGroups = selectorSet(strings(users.excludeGroups))
  const includeRoles = selectorSet(strings(users.includeRoles))
  const excludeRoles = selectorSet(strings(users.excludeRoles))
  const subjectId = subject.id.toLowerCase()
  const needsMembership = includeGroups.size > 0 || excludeGroups.size > 0
  const needsRoles = includeRoles.size > 0 || excludeRoles.size > 0
  if (needsMembership && (!isFresh(evidence.membership) || !subject.transitiveGroupIds)) {
    return { matches: false, excluded: false, unknown: true, reason: evidenceReason('MEMBERSHIP', evidence.membership) }
  }
  if (needsRoles && (!isFresh(evidence.roles) || !subject.activeRoleTemplateIds)) {
    return { matches: false, excluded: false, unknown: true, reason: evidenceReason('ROLES', evidence.roles) }
  }
  const groups = selectorSet(subject.transitiveGroupIds)
  const roles = selectorSet(subject.activeRoleTemplateIds)
  const externalInclude = externalSelectorMatches(users.includeGuestsOrExternalUsers, subject)
  const externalExclude = externalSelectorMatches(users.excludeGuestsOrExternalUsers, subject)
  if (externalInclude.unknown || externalExclude.unknown) {
    return { matches: false, excluded: false, unknown: true, reason: 'EXTERNAL_TENANT_UNKNOWN' }
  }
  const excluded =
    excludeUsers.has(subjectId) ||
    [...excludeGroups].some((id) => groups.has(id)) ||
    [...excludeRoles].some((id) => roles.has(id)) ||
    externalExclude.matches
  if (excluded) return { matches: false, excluded: true, unknown: false, reason: 'EFFECTIVE_EXCLUSION' }
  const included =
    includeUsers.has('all') ||
    includeUsers.has(subjectId) ||
    [...includeGroups].some((id) => groups.has(id)) ||
    [...includeRoles].some((id) => roles.has(id)) ||
    externalInclude.matches
  return { matches: included, excluded: false, unknown: false, reason: included ? null : 'NOT_TARGETED' }
}

const BUILT_IN_MFA_STRENGTH_IDS = new Set([
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000004',
])

const SINGLE_METHOD_MFA_STRENGTHS = new Set([
  'fido2',
  'windowshelloforbusiness',
  'x509certificatemultifactor',
])

function authenticationStrengthGuaranteesMfa(strength: RecordLike) {
  const id = text(strength.id, '').toLowerCase()
  if (BUILT_IN_MFA_STRENGTH_IDS.has(id)) return true
  if (strength.isMfa === true || text(strength.requirementsSatisfied, '').toLowerCase() === 'mfa') return true
  const combinations = strings(strength.allowedCombinations)
  return combinations.length > 0 && combinations.every((combination) => {
    const methods = combination.toLowerCase().split(',').map((item) => item.trim()).filter(Boolean)
    return methods.length >= 2 || (methods.length === 1 && SINGLE_METHOD_MFA_STRENGTHS.has(methods[0]!))
  })
}

function grantEvaluation(
  policy: RecordLike,
  strengths: RecordLike[],
  evidence: EffectiveMfaEvaluationInput['evidence'],
) {
  const grants = record(policy.grantControls) ?? {}
  const builtIns = strings(grants.builtInControls).map((value) => value.toLowerCase())
  const operator = text(grants.operator, 'OR', 10).toUpperCase()
  const strengthRef = record(grants.authenticationStrength)
  let strengthMfa = false
  if (strengthRef) {
    if (!isFresh(evidence.authenticationStrengths)) {
      return { guarantees: false, unknown: true, reason: evidenceReason('AUTHENTICATION_STRENGTHS', evidence.authenticationStrengths) }
    }
    const strengthId = text(strengthRef.id, '').toLowerCase()
    const strength = strengths.find((entry) => text(entry.id, '').toLowerCase() === strengthId)
    if (!strength) return { guarantees: false, unknown: true, reason: 'AUTHENTICATION_STRENGTH_NOT_RESOLVED' }
    strengthMfa = authenticationStrengthGuaranteesMfa(strength)
    if (!strengthMfa) return { guarantees: false, unknown: true, reason: 'AUTHENTICATION_STRENGTH_AMBIGUOUS' }
  }
  const hasMfa = builtIns.includes('mfa') || strengthMfa
  if (!hasMfa) return { guarantees: false, unknown: false, reason: 'MFA_NOT_REQUIRED' }
  if (operator === 'OR' && builtIns.length + (strengthRef ? 1 : 0) > 1) {
    return { guarantees: false, unknown: false, reason: 'GRANT_OR_ALTERNATIVE' }
  }
  if (operator !== 'AND' && operator !== 'OR') {
    return { guarantees: false, unknown: true, reason: 'GRANT_OPERATOR_UNKNOWN' }
  }
  return { guarantees: true, unknown: false, reason: null }
}

function materialConditions(policy: RecordLike) {
  const conditions = record(policy.conditions) ?? {}
  const applications = record(conditions.applications) ?? {}
  const material: string[] = []
  const includeApplications = strings(applications.includeApplications)
  const excludeApplications = strings(applications.excludeApplications)
  if (!includeApplications.some((value) => value.toLowerCase() === 'all')) {
    material.push('application subset')
  }
  if (excludeApplications.length > 0) material.push('application exclusions')
  if (strings(applications.includeUserActions).length > 0) material.push('user actions')
  if (strings(applications.includeAuthenticationContextClassReferences).length > 0) material.push('authentication context')
  const platforms = record(conditions.platforms)
  if (
    platforms &&
    (!strings(platforms.includePlatforms).some((value) => value.toLowerCase() === 'all') ||
      strings(platforms.excludePlatforms).length > 0)
  ) material.push('platform')
  const locations = record(conditions.locations)
  if (
    locations &&
    (!strings(locations.includeLocations).some((value) => value.toLowerCase() === 'all') ||
      strings(locations.excludeLocations).length > 0)
  ) material.push('location')
  const clientAppTypes = strings(conditions.clientAppTypes)
  if (clientAppTypes.length > 0 && !clientAppTypes.some((value) => value.toLowerCase() === 'all')) {
    material.push('client app')
  }
  const conditionLabels: Array<[string, string]> = [
    ['devices', 'device state'],
    ['signInRiskLevels', 'sign-in risk'],
    ['userRiskLevels', 'user risk'],
    ['servicePrincipalRiskLevels', 'service-principal risk'],
    ['authenticationFlows', 'authentication flow'],
  ]
  for (const [key, label] of conditionLabels) {
    const value = conditions[key]
    const nested = record(value)
    const hasValue = Array.isArray(value)
      ? value.length > 0
      : nested
        ? Object.values(nested).some((entry) => Array.isArray(entry) ? entry.length > 0 : entry !== null && entry !== undefined && entry !== false && entry !== '')
        : Boolean(value)
    if (hasValue) material.push(label)
  }
  return [...new Set(material)]
}

function policyState(value: unknown): EffectiveMfaPolicyEvidence['state'] {
  if (value === 'enabled') return 'ENABLED'
  if (value === 'enabledForReportingButNotEnforced') return 'REPORT_ONLY'
  return 'DISABLED'
}

export function evaluateEffectiveMfaEnforcement(
  input: EffectiveMfaEvaluationInput,
): EffectiveMfaEnforcementProjection {
  const now = input.now ?? new Date()
  const evaluatedAt = now.toISOString()
  if (!isFresh(input.evidence.policies) || !Array.isArray(input.policies)) {
    const reason = evidenceReason('POLICIES', input.evidence.policies)
    return {
      contractVersion: EFFECTIVE_MFA_ENFORCEMENT_CONTRACT_VERSION,
      status: 'UNKNOWN',
      label: 'MFA enforcement unknown',
      policies: [],
      reasonCodes: [reason],
      evaluatedAt,
      evidenceObservedAt: input.evidence.policies.observedAt,
      riskReductionAllowed: false,
    }
  }
  const strengths = Array.isArray(input.authenticationStrengths)
    ? input.authenticationStrengths.map(record).filter((entry): entry is RecordLike => Boolean(entry))
    : []
  const qualifying: EffectiveMfaPolicyEvidence[] = []
  const unknownReasons = new Set<string>()
  const nonCoverageReasons = new Set<string>()
  for (const raw of input.policies) {
    const policy = record(raw)
    if (!policy) {
      unknownReasons.add('POLICY_SHAPE_UNKNOWN')
      continue
    }
    const target = targetEvaluation(policy, input.subject, input.evidence)
    if (target.unknown) {
      unknownReasons.add(target.reason ?? 'TARGET_EVALUATION_UNKNOWN')
      continue
    }
    if (target.excluded) {
      const grant = grantEvaluation(policy, strengths, input.evidence)
      if (!grant.unknown && grant.guarantees) {
        qualifying.push({
          id: text(policy.id, 'Unknown policy ID', 128),
          name: text(policy.displayName, 'Unnamed policy'),
          state: policyState(policy.state),
          outcome: 'NOT_ENFORCED',
          materialConditions: ['effective exclusion'],
        })
        nonCoverageReasons.add('EFFECTIVE_EXCLUSION')
      }
      continue
    }
    if (!target.matches) continue
    const grant = grantEvaluation(policy, strengths, input.evidence)
    if (grant.unknown) {
      unknownReasons.add(grant.reason ?? 'GRANT_EVALUATION_UNKNOWN')
      continue
    }
    if (!grant.guarantees) continue
    const state = policyState(policy.state)
    const conditions = materialConditions(policy)
    qualifying.push({
      id: text(policy.id, 'Unknown policy ID', 128),
      name: text(policy.displayName, 'Unnamed policy'),
      state,
      outcome: state === 'DISABLED'
        ? 'NOT_ENFORCED'
        : conditions.length > 0
          ? 'CONDITIONAL'
          : 'UNIVERSAL',
      materialConditions: conditions,
    })
  }
  qualifying.sort((left, right) => `${left.name}:${left.id}`.localeCompare(`${right.name}:${right.id}`))
  const universal = qualifying.filter((policy) => policy.state === 'ENABLED' && policy.outcome === 'UNIVERSAL')
  const conditional = qualifying.filter((policy) => policy.state === 'ENABLED' && policy.outcome === 'CONDITIONAL')
  const reportOnly = qualifying.filter((policy) => policy.state === 'REPORT_ONLY')
  const evidenceObservedAt = input.evidence.policies.observedAt
  if (universal.length > 0) {
    return {
      contractVersion: 1,
      status: 'COVERED_BY_CONDITIONAL_ACCESS',
      label: `Covered by Conditional Access — ${universal.map((policy) => policy.name).join(', ')}`,
      policies: qualifying,
      reasonCodes: [...unknownReasons].sort(),
      evaluatedAt,
      evidenceObservedAt,
      riskReductionAllowed: true,
    }
  }
  if (unknownReasons.size > 0) {
    return {
      contractVersion: 1,
      status: 'UNKNOWN',
      label: 'MFA enforcement unknown',
      policies: qualifying,
      reasonCodes: [...unknownReasons].sort(),
      evaluatedAt,
      evidenceObservedAt,
      riskReductionAllowed: false,
    }
  }
  if (conditional.length > 0) {
    return {
      contractVersion: 1,
      status: 'CONDITIONALLY_COVERED',
      label: `Conditionally covered — ${conditional.map((policy) => `${policy.name}: ${policy.materialConditions.join(', ')}`).join('; ')}`,
      policies: qualifying,
      reasonCodes: ['MATERIAL_CONDITIONS_PRESENT'],
      evaluatedAt,
      evidenceObservedAt,
      riskReductionAllowed: false,
    }
  }
  if (reportOnly.length > 0) {
    return {
      contractVersion: 1,
      status: 'REPORT_ONLY',
      label: `Would be covered (report-only) — ${reportOnly.map((policy) => policy.name).join(', ')}; not enforced`,
      policies: qualifying,
      reasonCodes: ['REPORT_ONLY_NOT_ENFORCED'],
      evaluatedAt,
      evidenceObservedAt,
      riskReductionAllowed: false,
    }
  }
  return {
    contractVersion: 1,
    status: 'NOT_COVERED',
    label: 'Not covered',
    policies: qualifying,
    reasonCodes: [...nonCoverageReasons, 'NO_UNIVERSAL_MFA_POLICY'].sort(),
    evaluatedAt,
    evidenceObservedAt,
    riskReductionAllowed: false,
  }
}

const RISK_RANK = { none: 0, low: 1, medium: 2, high: 3, unknown: -1 } as const

export function deriveUserPostureRisk(input: {
  mfaRegistration: 'Registered' | 'Not registered' | 'Unknown'
  legacyPerUserMfa: 'Enabled' | 'Enforced' | 'Disabled' | 'Unknown'
  effectiveMfa: EffectiveMfaEnforcementProjection
  microsoftUserRisk: MicrosoftRiskFact
  microsoftSignInRisk: MicrosoftRiskFact
}): UserPostureRiskProjection {
  const legacyEnforced = input.legacyPerUserMfa === 'Enabled' || input.legacyPerUserMfa === 'Enforced'
  const mfaExposure = legacyEnforced || input.effectiveMfa.riskReductionAllowed
    ? 'low'
    : input.mfaRegistration === 'Unknown' || input.legacyPerUserMfa === 'Unknown' || input.effectiveMfa.status === 'UNKNOWN'
      ? 'unknown'
      : 'medium'
  const reported = [input.microsoftUserRisk, input.microsoftSignInRisk]
    .filter((fact) => fact.state === 'REPORTED' && fact.value !== 'unknown')
  const highestMicrosoft = reported.sort((left, right) => RISK_RANK[right.value] - RISK_RANK[left.value])[0]?.value
  const unknownMicrosoft = [input.microsoftUserRisk, input.microsoftSignInRisk].some((fact) => fact.state !== 'REPORTED' || fact.value === 'unknown')
  const overall = highestMicrosoft === 'high' || highestMicrosoft === 'medium'
    ? highestMicrosoft
    : unknownMicrosoft || mfaExposure === 'unknown'
      ? 'unknown'
      : mfaExposure === 'medium'
        ? 'medium'
        : 'low'
  return {
    contractVersion: 1,
    mfaEnforcementExposure: mfaExposure,
    microsoftUserRisk: input.microsoftUserRisk,
    microsoftSignInRisk: input.microsoftSignInRisk,
    overall,
    components: [
      { key: 'mfa-enforcement', value: mfaExposure, source: 'HawkView effective MFA enforcement evaluator' },
      { key: 'microsoft-user-risk', value: input.microsoftUserRisk.value, source: input.microsoftUserRisk.source },
      { key: 'microsoft-sign-in-risk', value: input.microsoftSignInRisk.value, source: input.microsoftSignInRisk.source },
    ],
  }
}
