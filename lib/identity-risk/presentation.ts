import type {
  HawkViewIdentitySignalsView,
  IdentityRiskBoundedCount,
  MicrosoftEntraRiskyUsersView,
  RiskAssessment,
  RiskAssessmentReadiness,
  RiskAssessmentRuleId,
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

export function currentRiskAssessmentUsers(assessment: RiskAssessment) {
  return assessment.users.filter(
    (user) =>
      user.subjectType === 'USER' &&
      user.findings.some((finding) => finding.activityState === 'CURRENT')
  )
}

export function hawkViewRiskyUserCountPresentation(assessment: RiskAssessment) {
  const count = assessment.summary?.currentUsers
  if (!count || count.accuracy === 'UNKNOWN' || count.value === null) {
    return {
      value: '—',
      accessibleValue: 'Not available',
      label: 'Risky user count unavailable',
      detail:
        'HawkView has not reported an authoritative distinct current-user total. This is not zero; available user findings remain listed below.',
      exact: false,
      asOf: assessment.summary?.asOf ?? null,
    }
  }
  if (count.accuracy === 'AT_LEAST') {
    return {
      value: `≥${count.value.toLocaleString()}`,
      accessibleValue: `At least ${count.value.toLocaleString()}`,
      label: 'Risky users identified',
      detail:
        'This is a distinct-user lower bound from current findings. Partial coverage or capacity limits prevent a complete tenant count.',
      exact: false,
      asOf: assessment.summary?.asOf ?? null,
    }
  }
  return {
    value: count.value.toLocaleString(),
    accessibleValue: count.value.toLocaleString(),
    label: 'Risky users identified',
    detail:
      'Distinct users with at least one current HawkView finding in the reported tenant assessment. Multiple findings for one user count once.',
    exact: true,
    asOf: assessment.summary?.asOf ?? null,
  }
}

export function microsoftRiskyUserCountPresentation(
  view: MicrosoftEntraRiskyUsersView
) {
  if (microsoftHasConfirmedEmptySnapshot(view)) {
    return {
      value: '0',
      accessibleValue: '0',
      label: 'Microsoft records reported',
      detail:
        'The latest complete, current Microsoft snapshot is empty. This is not a HawkView safety verdict.',
      exact: true,
    }
  }
  if (!view.users || view.meta.status !== 'AVAILABLE') {
    return {
      value: '—',
      accessibleValue: 'Not available',
      label: 'Microsoft count unavailable',
      detail:
        'Microsoft has not reported a current count. Missing evidence must not be interpreted as zero.',
      exact: false,
    }
  }
  const returned = new Set(view.users.map((user) => user.id)).size
  // A page that returned nothing while reporting more pages cannot be stated
  // as a bound. "At least 0" is the one reading this product forbids
  // everywhere else — the assessment adapter refuses a zero lower bound
  // outright — and it would arrive here as a confident-looking glyph.
  if (returned === 0 && view.pageInfo?.hasMore) {
    return {
      value: '—',
      accessibleValue: 'Not available',
      label: 'Microsoft count unavailable',
      detail:
        'This page of Microsoft records was empty while Microsoft reported further pages, so no count can be stated. It is not zero.',
      exact: false,
    }
  }
  return {
    value: view.pageInfo?.hasMore
      ? `≥${returned.toLocaleString()}`
      : returned.toLocaleString(),
    accessibleValue: view.pageInfo?.hasMore
      ? `At least ${returned.toLocaleString()}`
      : returned.toLocaleString(),
    label: 'Microsoft records shown',
    detail:
      'This is the returned Microsoft record count, not an active-risk total. Microsoft states such as at risk, remediated, dismissed, or confirmed safe remain distinct in the list.',
    exact: view.pageInfo?.hasMore === false,
  }
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
  INAPPLICABLE: 'Cannot run on this tenant',
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
  // For a rule this client carries metadata for, the published version and
  // permitted sources are an extra cross-check. A rule it does not recognise
  // still has to clear every evidence requirement below — a complete, current,
  // uncapped window over a READY source that assessed identities and matched
  // none. Those are the facts the claim rests on; whether this client happens
  // to know the rule's name is not one of them, and requiring it would make
  // "genuinely clean" unreachable for good the moment the rule set changes.
  const catalogueConsistent = Object.hasOwn(assessmentRuleVersions, rule.ruleId)
    ? assessmentRuleVersions[rule.ruleId] === rule.ruleVersion && sourceAllowed
    : true
  return (
    catalogueConsistent &&
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
  // A check that cannot run on this tenant's evidence is not a coverage
  // failure — it is a bound on what any result here can claim. It is excluded
  // from what has to be assessed, and named in the claim instead.
  const applicable = assessment.rules.filter(
    (rule) => rule.status !== 'INAPPLICABLE'
  )
  const inapplicable = assessment.rules.length - applicable.length
  const scopeNote = inapplicable
    ? ` ${inapplicable} further ${inapplicable === 1 ? 'check cannot' : 'checks cannot'} run on this tenant’s evidence, so nothing here covers ${inapplicable === 1 ? 'it' : 'them'}.`
    : ''
  const completeEvaluation =
    assessment.meta.status === 'AVAILABLE' &&
    assessment.meta.capability === 'FULL' &&
    assessment.meta.freshness === 'CURRENT' &&
    evidenceTimestamp(assessment.meta.evaluatedAt) !== null &&
    applicable.length > 0 &&
    new Set(assessment.rules.map((rule) => rule.ruleId)).size ===
      assessment.rules.length &&
    assessed.length === applicable.length &&
    assessed.every((rule) => rule.status === 'READY')
  if (completeEvaluation) {
    return {
      label: 'No findings in evaluated evidence',
      detail: `${applicable.length === 1 ? 'The single check this tenant’s evidence supports' : `All ${applicable.length} checks this tenant’s evidence supports`} assessed identities in complete, current evidence windows and reported no matches.${scopeNote} This applies only to those checks and their reported windows; it does not establish that an identity is safe.`,
    }
  }
  if (assessed.length > 0) {
    return {
      label: 'No findings in partially evaluated evidence',
      detail: `${assessed.length} of ${applicable.length} applicable checks evaluated identities without matches.${scopeNote} The overall assessment is incomplete or not current; unavailable checks, capped counts, and uncovered windows cannot support a complete no-findings conclusion.`,
    }
  }
  return {
    label: 'No findings can be confirmed yet',
    detail:
      'No per-user findings were returned, but one or more checks lack a complete evaluated scope. Review collection and rule readiness below.',
  }
}


/**
 * The words for one signal: what to call it, and what its count counts.
 *
 * This is the division the contract was changed to make possible, and the two
 * halves come from different places on purpose.
 *
 * The UNIT is human copy and belongs to the client. The core holds no Microsoft
 * vocabulary and should not learn one, so "lockouts" and "external
 * destinations" live here, keyed by signal name.
 *
 * The KIND -- whether a timestamp marks an event occurring or a state being
 * observed -- travels on the value itself and is never looked up here. Keying
 * the kind on the name would move the convention rather than remove it, and
 * would look like progress because the key sits closer to the data. The unit
 * being name-keyed and the kind being value-carried is not an inconsistency:
 * copy is a client concern and can be wrong only cosmetically, while a kind
 * read from the wrong place renders a read time as an event.
 */
const signalCopy: Record<
  string,
  { title: string; singular: string; plural: string }
> = {
  LOCKED_OUT_AFTER_REPEATED_FAILURES: {
    title: 'Locked out after repeated failures',
    singular: 'lockout',
    plural: 'lockouts',
  },
  PASSWORD_REJECTED: {
    title: 'Password rejected',
    singular: 'rejected sign-in',
    plural: 'rejected sign-ins',
  },
  EXTERNAL_FORWARDING_CONFIGURED: {
    title: 'Forwarding to an external address',
    singular: 'external destination',
    plural: 'external destinations',
  },
}

/**
 * What to call a signal on screen.
 *
 * The closed set lives in the wiring layer and the core's type is a plain
 * string, so a fourth signal can appear without anything failing to compile.
 * One that does gets a sentence saying this build does not know it, never the
 * raw identifier: an identifier is not something a technician can act on, and
 * printing it invites the reading that it is a name.
 */
export function signalTitle(signal: string): string {
  return (
    signalCopy[signal]?.title ??
    'A detector signal this build of HawkView does not recognise'
  )
}

export function signalIsRecognised(signal: string): boolean {
  return Object.hasOwn(signalCopy, signal)
}

/* -------------------------------------------------------------------------- */
/* What a finding's count counts, and what its date marks                     */
/* -------------------------------------------------------------------------- */

/**
 * Every rule reports its evidence in the same two fields — a number and a
 * timestamp — and those fields do not mean the same thing in every rule. The
 * difference is invisible in the data, so it has to be carried by the copy.
 *
 * A repeated-failure check counts events that happened, each at a time of its
 * own, and its date is when the most recent one occurred. The mailbox check
 * counts the external destinations a mailbox is currently configured to forward
 * to. Those are a state, not a sequence, and its date is when HawkView read the
 * configuration.
 *
 * One phrase for both makes the second reading false twice over. "3 records,
 * last 3:04 p.m." says three things happened and the newest was minutes ago,
 * where the truth is that one setting names three destinations and 3:04 p.m. is
 * when we looked. The read time is always recent, so every forwarding finding
 * would read as though it were unfolding right now — exactly backwards, because
 * a forwarding rule set six months ago is the more alarming case, not the less.
 *
 * This is the same defect this surface keeps producing: a true sentence
 * positioned where a reader takes it as an answer to a different question. It
 * is worth stating why it only became load-bearing now. Until the detector was
 * corrected, one destination and four produced the same finding, so the number
 * was not meaningful and nobody could act on it. Making it meaningful is what
 * made mislabelling it dangerous — a correct number under the wrong noun earns
 * a trust the meaningless one never had.
 *
 * A rule this build does not know gets neither phrase. "Records" asserts that
 * the count is of events and "last" asserts that the date is an occurrence, and
 * the mailbox rule is the proof that a new check can falsify both. So an
 * unrecognised rule reports that it is unrecognised, and its two values are
 * shown without a reading attached.
 *
 * THIS TABLE IS A STOPGAP, and should be read as one rather than as the design.
 * It works by knowing which rules produce which kind of time, which is the very
 * arrangement that caused the defect: two kinds of fact in one field, told
 * apart by a convention held somewhere else. It is the right thing to do only
 * while the value does not carry its own kind.
 *
 * The agreed replacement puts the kind on the value — a timestamp that says
 * whether it marks an event occurring or a state being observed. When that
 * arrives, read the kind and delete this table.
 *
 * Specifically, do not re-key it on the signal name. A name is a proxy for the
 * kind in exactly the way a rule id is, so that would move the convention
 * rather than remove it, while looking like progress because the key is closer
 * to the data.
 */
export type FindingEvidenceShape =
  | { kind: 'OCCURRENCES'; singular?: string; plural?: string }
  | { kind: 'CONFIGURED_STATE'; singular: string; plural: string }
  | { kind: 'UNRECOGNISED' }

const evidenceShapes: Record<RiskAssessmentRuleId, FindingEvidenceShape> = {
  'HV-ID-AUTH-010.v1': { kind: 'OCCURRENCES' },
  'HV-ID-AUTH-005.v2': { kind: 'OCCURRENCES' },
  'HV-ID-MBX-001.v1': {
    kind: 'CONFIGURED_STATE',
    singular: 'external destination',
    plural: 'external destinations',
  },
}

export function findingEvidenceShape(ruleId: string): FindingEvidenceShape {
  return Object.hasOwn(evidenceShapes, ruleId)
    ? evidenceShapes[ruleId as RiskAssessmentRuleId]
    : { kind: 'UNRECOGNISED' }
}

export type FindingEvidenceSummary = {
  /** How much evidence, in the unit this rule actually counts. */
  count: string | null
  /** What the rule's timestamp marks, said in words rather than implied. */
  timing: string | null
  /** Why neither of the above could be said. Never set alongside them. */
  note: string | null
}

/**
 * The count and timing phrases for one finding.
 *
 * The date formatter is supplied by the caller because the list and the drawer
 * format times differently, and neither of those choices belongs here.
 */

/**
 * The shape for one reason, preferring what the value carries.
 *
 * A signal this build does not recognise is unrecognised even if its kind is
 * known: without a unit there is no honest noun for its count, and "records"
 * is the guess the mailbox check already proved wrong.
 */
function evidenceShapeFor(finding: {
  ruleId: string
  signal?: string | null
  kind?: 'EVENT_OCCURRED' | 'STATE_OBSERVED' | null
}): FindingEvidenceShape {
  if (finding.signal === undefined || finding.signal === null) {
    return findingEvidenceShape(finding.ruleId)
  }
  const copy = signalCopy[finding.signal]
  if (!copy) return { kind: 'UNRECOGNISED' }
  if (finding.kind === 'STATE_OBSERVED') {
    return {
      kind: 'CONFIGURED_STATE',
      singular: copy.singular,
      plural: copy.plural,
    }
  }
  return {
    kind: 'OCCURRENCES',
    singular: copy.singular,
    plural: copy.plural,
  }
}

export function findingEvidenceSummary(
  finding: {
    ruleId: string
    /** Set when this reason came from a signal rather than a whole finding. */
    signal?: string | null
    /**
     * The kind carried by the signal's own timestamp. Preferred over anything
     * inferred from the rule, and null when the signal has no timestamp.
     */
    kind?: 'EVENT_OCCURRED' | 'STATE_OBSERVED' | null
    evidenceCount: number
    evidenceCountCapped: boolean
    /**
     * Null when the check ran and its evidence carries no time at all.
     *
     * That is a real state rather than a missing field, and it has to stay
     * distinguishable from one. No detector produces it today, but that is a
     * property of the two detectors that exist, not of the contract, and the
     * alternative to handling it is a default — now, the epoch, the empty
     * string — that would place a row somewhere specific in a column meaning
     * recency on the strength of a value nobody supplied.
     */
    lastSeen: string | null
  },
  formatDate: (value: string) => string
): FindingEvidenceSummary {
  const shape = evidenceShapeFor(finding)
  const when = finding.lastSeen === null ? null : formatDate(finding.lastSeen)
  if (shape.kind === 'UNRECOGNISED') {
    return {
      count: null,
      timing: null,
      note:
        'This build of HawkView does not know this check, so it cannot say what its count of ' +
        finding.evidenceCount.toLocaleString() +
        ' counts' +
        (when === null ? '.' : ', or what ' + when + ' marks.'),
    }
  }
  // A signal can be evaluated and find nothing. That is a result, and it has to
  // read as one: "0 records" describes evidence that exists and was not
  // counted, and beside "no time recorded" it reads as evidence that exists and
  // was not dated. Neither is what happened. Two of the nine findings on the
  // fleet today carry a zero lockout count beside a real rejection count, so
  // this is a live shape and not a hypothetical one.
  //
  // A capped zero is a different answer again, and the difference matters more
  // than the wording. Capped means the window was truncated before the check
  // saw anything, so a zero from a capped window is not a finding of none — it
  // is the absence of a reading. Rendering it as a floor would also produce
  // "at least 0", a lower bound that excludes nothing and that this surface has
  // already removed once, from the tenant count card. It came back here by a
  // different path, which is the argument for the phrase never being assembled
  // from parts in more than one place.
  if (finding.evidenceCount === 0) {
    if (finding.evidenceCountCapped) {
      return {
        count: 'none read before the evidence window was truncated',
        timing: null,
        note: null,
      }
    }
    return {
      count:
        shape.kind === 'CONFIGURED_STATE' ? 'none configured' : 'none recorded',
      // A state read that found nothing still happened, and when it happened is
      // worth knowing. Nothing occurred for an event check to have timed.
      timing:
        shape.kind === 'CONFIGURED_STATE' && when !== null
          ? 'configuration read ' + when
          : null,
      note: null,
    }
  }
  // A capped count is a floor, never a total: the evidence was truncated before
  // the check ran, so the check could not have known there was more.
  const amount =
    (finding.evidenceCountCapped ? 'at least ' : '') +
    finding.evidenceCount.toLocaleString()
  if (shape.kind === 'CONFIGURED_STATE') {
    return {
      count:
        amount +
        ' ' +
        (finding.evidenceCount === 1 ? shape.singular : shape.plural),
      // Deliberately not "last". Nothing here happened at this time; this is
      // when HawkView read a setting that may be far older.
      timing:
        when === null ? 'no read time recorded' : 'configuration read ' + when,
      note: null,
    }
  }
  return {
    count:
      amount +
      ' ' +
      (finding.evidenceCount === 1
        ? (shape.singular ?? 'record')
        : (shape.plural ?? 'records')),
    timing: when === null ? 'no time recorded' : 'last ' + when,
    note: null,
  }
}

/**
 * How many identities a check actually had in front of it.
 *
 * The live engine reports zero eligible subjects on every tenant, including
 * three that are under attack, so "0 identities evaluated by this check" beside
 * a readiness of Ready is the line a technician is most likely to meet. It
 * reads as a check that ran over a population and came back empty. The truth is
 * that the check had nobody to examine, and those are different enough to send
 * someone to different places: one is a quiet tenant, the other is a broken
 * pipeline.
 *
 * A truncated zero is a third answer. If the scope reading was capped before
 * anything was counted, the check cannot say nobody was in scope either — and
 * putting it through the ordinary floor wording would produce "at least 0",
 * which excludes nothing. That phrase has now been assembled twice on this
 * surface from parts that had no knowledge of each other, which is the argument
 * for every count phrase being built here rather than at the site that renders
 * it.
 */
export function ruleScopeSummary(rule: {
  assessedIdentities: number | null
  countsCapped: boolean
}): string {
  if (rule.assessedIdentities === null) {
    return 'identities evaluated not reported'
  }
  if (rule.assessedIdentities === 0) {
    return rule.countsCapped
      ? 'no identities read before the scope was truncated'
      : 'no identities were in scope for this check'
  }
  const amount =
    (rule.countsCapped ? 'at least ' : '') +
    rule.assessedIdentities.toLocaleString()
  return (
    amount +
    (rule.assessedIdentities === 1
      ? ' identity evaluated by this check'
      : ' identities evaluated by this check')
  )
}
