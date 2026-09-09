import type {
  HawkViewIdentitySignalsView,
  IdentityRiskBoundedCount,
  MicrosoftEntraRiskyUsersView,
  RiskAssessment,
  RiskAssessmentReadiness,
  RiskAssessmentSource,
  RiskAssessmentUser,
  RiskRecommendedAction,
} from './types'

const exactZero = (count: IdentityRiskBoundedCount) =>
  count.exact && !count.capped && count.value === 0

/** A complete page alone cannot establish that any rule was evaluated. */
export function hawkViewEmptyPresentation(view: HawkViewIdentitySignalsView) {
  if (view.findings?.length !== 0 || view.meta.status !== 'AVAILABLE')
    return null
  const counts = view.counts
  if (
    view.pageInfo?.hasMore ||
    (counts &&
      (counts.openFindings.value > 0 || counts.matchedResults.value > 0))
  ) {
    return {
      label: 'No findings in this page',
      detail:
        'The reported summary or pagination indicates additional findings or matched results. This empty page is not a no-findings result.',
    }
  }
  const completeEvaluation =
    view.meta.capability === 'FULL' &&
    view.meta.freshness === 'CURRENT' &&
    view.pageInfo?.hasMore === false &&
    counts &&
    counts.evaluatedRules.exact &&
    counts.evaluatedRules.value > 0 &&
    counts.notMatchedResults.value > 0 &&
    (counts.notMatchedResults.exact || counts.notMatchedResults.capped) &&
    [
      counts.identitiesNeedingReview,
      counts.openFindings,
      counts.matchedResults,
      counts.suppressedResults,
      counts.notEvaluatedResults,
    ].every(exactZero)
  if (completeEvaluation) {
    return {
      label: 'No findings in evaluated evidence',
      detail:
        'The reported current evaluation contains only not-matched outcomes. This does not establish that any identity is safe or that unimplemented checks were performed.',
    }
  }
  if (
    counts &&
    [
      counts.matchedResults,
      counts.suppressedResults,
      counts.notMatchedResults,
    ].every(exactZero)
  ) {
    return {
      label: 'No evaluated outcomes reported',
      detail:
        'An empty findings list does not confirm that a check ran against sufficient evidence. Review the reported coverage and not-evaluated outcomes.',
    }
  }
  return {
    label: 'No findings returned',
    detail:
      'Limited coverage, suppressed outcomes, or incomplete evaluation information prevents a complete no-findings conclusion. Review the reported outcomes and evidence context.',
  }
}

export function microsoftHasConfirmedEmptySnapshot(
  view: MicrosoftEntraRiskyUsersView
) {
  return (
    view.meta.status === 'AVAILABLE' &&
    view.meta.capability === 'FULL' &&
    view.meta.freshness === 'CURRENT' &&
    view.users?.length === 0 &&
    view.pageInfo?.hasMore === false
  )
}

const missingEvidenceLabels: Readonly<Record<string, string>> = {
  ACCOUNT_CLASS_COVERAGE_INCOMPLETE:
    'Account classification coverage is incomplete',
  ACCOUNT_CLASS_UNSUPPORTED: 'This account classification is not supported',
  ACCOUNT_CLASS_UNVERIFIED: 'Account classification has not been verified',
  INSUFFICIENT_INDEPENDENT_CONTEXT: 'Insufficient independent context',
  MAILBOX_RULE_PROJECTION_INCOMPLETE: 'Mailbox-rule evidence is incomplete',
  RULE_CONFIG_UNAPPROVED: 'Rule configuration has not been approved',
}

const benignAlternativeLabels: Readonly<Record<string, string>> = {
  APPROVED_ACCOUNT_PROVISIONING: 'Authorized account provisioning',
  APPROVED_SHARED_CONTEXT: 'An authorized shared activity context',
  APPROVED_EXTERNAL_FORWARDING: 'Authorized external forwarding',
}

export function missingEvidenceLabel(code: string) {
  return Object.hasOwn(missingEvidenceLabels, code)
    ? missingEvidenceLabels[code]
    : 'An evidence limitation was reported'
}

export function benignAlternativeLabel(code: string) {
  return Object.hasOwn(benignAlternativeLabels, code)
    ? benignAlternativeLabels[code]
    : 'An authorized activity alternative was reported'
}

const readinessLabels: Record<RiskAssessmentReadiness, string> = {
  READY: 'Ready',
  PARTIAL: 'Partial coverage',
  WAITING: 'Waiting for first collection',
  MISSING_PERMISSION: 'Permission required',
  LICENSE_REQUIRED: 'License required',
  STALE: 'Stale collection',
  FAILED: 'Collection failed',
  INSUFFICIENT_FIELDS: 'Insufficient record fields',
  UNSUPPORTED: 'Unsupported',
  DISABLED: 'Disabled',
}

const sourceLabels: Record<RiskAssessmentSource, string> = {
  M365_AUDIT_STS: 'Microsoft 365 audit sign-ins',
  GRAPH_SIGN_INS: 'Microsoft Graph sign-ins',
  MAILBOX_RULES: 'Exchange mailbox rules',
}

export function riskReadinessLabel(status: RiskAssessmentReadiness) {
  return readinessLabels[status]
}

export function riskSourceLabel(source: RiskAssessmentSource | null) {
  return source ? sourceLabels[source] : 'No source selected'
}

function evidenceTimestamp(value: string | null) {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19)
    ? timestamp
    : null
}

type ProtectionFact = RiskAssessmentUser['protection'][
  | 'securityDefaults'
  | 'legacyPerUserMfa'
  | 'registration']

// Keep protection presentation within the projector's 26-hour evidence boundary.
const protectionEvidenceMaxAgeMs = 26 * 60 * 60 * 1000

export function riskProtectionEvidenceIsCurrent(evidence: ProtectionFact) {
  const observedAt = evidenceTimestamp(evidence.observedAt)
  const now = Date.now()
  return (
    evidence.freshness === 'CURRENT' &&
    evidence.reasonCode === 'VERIFIED' &&
    (evidence.source === 'MICROSOFT_GRAPH' ||
      evidence.source === 'EFFECTIVE_MFA_V1') &&
    evidence.state !== 'UNKNOWN' &&
    observedAt !== null &&
    observedAt <= now &&
    now - observedAt <= protectionEvidenceMaxAgeMs
  )
}

export function riskConditionalAccessIsCurrent(
  conditionalAccess: RiskAssessmentUser['protection']['conditionalAccess']
) {
  const observedAt = evidenceTimestamp(conditionalAccess.observedAt)
  const evaluatedAt = evidenceTimestamp(conditionalAccess.evaluatedAt)
  const now = Date.now()
  const current =
    conditionalAccess.contractVersion === 1 &&
    conditionalAccess.source === 'EFFECTIVE_MFA_V1' &&
    conditionalAccess.freshness === 'CURRENT' &&
    observedAt !== null &&
    evaluatedAt !== null &&
    observedAt <= evaluatedAt &&
    evaluatedAt <= now &&
    now - observedAt <= protectionEvidenceMaxAgeMs
  if (!current) return false
  if (conditionalAccess.status === 'COVERED_BY_CONDITIONAL_ACCESS') {
    return conditionalAccess.policies.some(
      (policy) =>
        policy.state === 'ENABLED' &&
        policy.outcome === 'UNIVERSAL' &&
        policy.materialConditions.length === 0
    )
  }
  if (conditionalAccess.status === 'CONDITIONALLY_COVERED') {
    return conditionalAccess.policies.some(
      (policy) => policy.state === 'ENABLED' && policy.outcome === 'CONDITIONAL'
    )
  }
  if (conditionalAccess.status === 'REPORT_ONLY') {
    return conditionalAccess.policies.some(
      (policy) => policy.state === 'REPORT_ONLY'
    )
  }
  return true
}

const recommendedActionLabels: Readonly<
  Record<RiskRecommendedAction['code'], string>
> = {
  CONFIRM_EXPECTED_ACTIVITY:
    'Confirm with the account owner whether the activity was expected.',
  REVIEW_SIGN_INS:
    'Review the relevant sign-in evidence in the authorized Microsoft tenant.',
  CHECK_SAVED_CREDENTIALS:
    'Check for outdated credentials saved in an application or device.',
  VERIFY_MFA_ENFORCEMENT:
    'Verify current MFA enforcement and review event-specific authentication evidence separately.',
  REVIEW_MAILBOX_FORWARDING:
    'Review the mailbox rule and confirm that its destinations are authorized.',
  FOLLOW_INCIDENT_PROCEDURE:
    'If activity is unauthorized, follow your incident response procedure. HawkView does not make Microsoft account changes.',
}

export function riskRecommendedActionLabel(
  code: RiskRecommendedAction['code']
) {
  return Object.hasOwn(recommendedActionLabels, code)
    ? recommendedActionLabels[code]
    : 'Review the available evidence.'
}

export function riskProtectionSummary(user: RiskAssessmentUser) {
  const protection = user.protection
  const conditionalAccess = protection.conditionalAccess
  const currentConditionalAccess =
    riskConditionalAccessIsCurrent(conditionalAccess)
  const names = conditionalAccess.policies
    .filter(
      (policy) =>
        policy.state === 'ENABLED' &&
        policy.outcome === 'UNIVERSAL' &&
        policy.materialConditions.length === 0
    )
    .map((policy) => policy.name)
  if (
    currentConditionalAccess &&
    conditionalAccess.status === 'COVERED_BY_CONDITIONAL_ACCESS' &&
    names.length > 0
  ) {
    return {
      label: `MFA required by Conditional Access — ${names.join(', ')}`,
      tone: 'positive' as const,
    }
  }
  if (
    currentConditionalAccess &&
    conditionalAccess.status === 'CONDITIONALLY_COVERED'
  ) {
    return { label: 'Conditional MFA coverage', tone: 'attention' as const }
  }
  if (
    riskProtectionEvidenceIsCurrent(protection.securityDefaults) &&
    protection.securityDefaults.state === 'ENABLED'
  ) {
    return { label: 'Security Defaults enabled', tone: 'positive' as const }
  }
  if (
    riskProtectionEvidenceIsCurrent(protection.legacyPerUserMfa) &&
    protection.legacyPerUserMfa.state === 'ENFORCED'
  ) {
    return { label: 'Per-user MFA enforced', tone: 'positive' as const }
  }
  if (currentConditionalAccess && conditionalAccess.status === 'REPORT_ONLY') {
    return {
      label: 'Conditional Access is report-only',
      tone: 'attention' as const,
    }
  }
  if (
    currentConditionalAccess &&
    conditionalAccess.status === 'NOT_COVERED' &&
    riskProtectionEvidenceIsCurrent(protection.securityDefaults) &&
    protection.securityDefaults.state === 'DISABLED' &&
    riskProtectionEvidenceIsCurrent(protection.legacyPerUserMfa) &&
    (protection.legacyPerUserMfa.state === 'DISABLED' ||
      protection.legacyPerUserMfa.state === 'ENABLED')
  ) {
    return {
      label: 'No enforced MFA protection verified',
      tone: 'attention' as const,
    }
  }
  if (
    [
      conditionalAccess,
      protection.securityDefaults,
      protection.legacyPerUserMfa,
    ].some((evidence) => evidence.freshness === 'STALE')
  ) {
    return { label: 'Protection evidence is stale', tone: 'unknown' as const }
  }
  return { label: 'Protection not verified', tone: 'unknown' as const }
}

const assessmentRuleVersions: Readonly<Record<string, string>> = {
  'HV-ID-AUTH-010.v1': 'v1',
  'HV-ID-AUTH-005.v2': 'v2',
  'HV-ID-MBX-001.v1': 'v1',
}

function evaluatedRuleScope(
  assessment: RiskAssessment,
  rule: RiskAssessment['rules'][number]
) {
  const start = evidenceTimestamp(rule.window.start)
  const end = evidenceTimestamp(rule.window.end)
  const evaluatedAt = evidenceTimestamp(rule.evaluatedAt)
  const selectedSources = assessment.sources.filter(
    (source) => source.source === rule.selectedSource
  )
  const source = selectedSources.length === 1 ? selectedSources[0] : null
  const sourceStart = source ? evidenceTimestamp(source.window.start) : null
  const sourceEnd = source ? evidenceTimestamp(source.window.end) : null
  const sourceAllowed =
    rule.ruleId === 'HV-ID-MBX-001.v1'
      ? rule.selectedSource === 'MAILBOX_RULES'
      : rule.selectedSource === 'M365_AUDIT_STS' ||
        rule.selectedSource === 'GRAPH_SIGN_INS'
  return (
    Object.hasOwn(assessmentRuleVersions, rule.ruleId) &&
    assessmentRuleVersions[rule.ruleId] === rule.ruleVersion &&
    sourceAllowed &&
    source?.status === 'READY' &&
    source.freshness === 'CURRENT' &&
    evidenceTimestamp(source.lastSuccessfulCollectionAt) !== null &&
    start !== null &&
    end !== null &&
    start <= end &&
    evaluatedAt !== null &&
    evaluatedAt >= end &&
    sourceStart !== null &&
    sourceEnd !== null &&
    sourceStart <= start &&
    sourceEnd >= end &&
    rule.assessedIdentities !== null &&
    Number.isInteger(rule.assessedIdentities) &&
    rule.assessedIdentities > 0 &&
    rule.matchedIdentities === 0 &&
    rule.countsCapped === false
  )
}

export function riskAssessmentEmptyPresentation(assessment: RiskAssessment) {
  if (assessment.users.length > 0) return null
  if (
    assessment.page.hasMore ||
    assessment.page.nextCursor !== null ||
    assessment.rules.some((rule) => (rule.matchedIdentities ?? 0) > 0)
  ) {
    return {
      label: 'No findings in this page',
      detail:
        'The reported matches or pagination indicate additional results. This empty page does not establish a no-findings assessment.',
    }
  }
  const assessed = assessment.rules.filter(
    (rule) =>
      (rule.status === 'READY' || rule.status === 'PARTIAL') &&
      evaluatedRuleScope(assessment, rule)
  )
  const completeEvaluation =
    assessment.meta.status === 'AVAILABLE' &&
    assessment.meta.capability === 'FULL' &&
    assessment.meta.freshness === 'CURRENT' &&
    evidenceTimestamp(assessment.meta.evaluatedAt) !== null &&
    assessment.rules.length === 3 &&
    new Set(assessment.rules.map((rule) => rule.ruleId)).size === 3 &&
    assessed.length === 3 &&
    assessed.every((rule) => rule.status === 'READY')
  if (completeEvaluation) {
    return {
      label: 'No findings in evaluated evidence',
      detail:
        'All three supported checks assessed identities in complete, current evidence windows and reported no matches. This applies only to these checks and their reported windows; it does not establish that an identity is safe.',
    }
  }
  if (assessed.length > 0) {
    return {
      label: 'No findings in partially evaluated evidence',
      detail: `${assessed.length} of 3 supported checks reported evaluated identities without matches. The overall assessment is incomplete or not current; unavailable checks, capped counts, and uncovered windows cannot support a complete no-findings conclusion.`,
    }
  }
  return {
    label: 'No findings can be confirmed yet',
    detail:
      'No per-user findings were returned, but one or more checks lack a complete evaluated scope. Review collection and rule readiness below.',
  }
}
