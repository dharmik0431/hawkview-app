import type { HawkViewIdentitySignalsView, IdentityRiskBoundedCount, MicrosoftEntraRiskyUsersView } from './types'

const exactZero = (count: IdentityRiskBoundedCount) => count.exact && !count.capped && count.value === 0

/** A complete page alone cannot establish that any rule was evaluated. */
export function hawkViewEmptyPresentation(view: HawkViewIdentitySignalsView) {
  if (view.findings?.length !== 0 || view.meta.status !== 'AVAILABLE') return null
  const counts = view.counts
  if (view.pageInfo?.hasMore || (counts && (counts.openFindings.value > 0 || counts.matchedResults.value > 0))) {
    return {
      label: 'No findings in this page',
      detail: 'The reported summary or pagination indicates additional findings or matched results. This empty page is not a no-findings result.',
    }
  }
  const completeEvaluation = view.meta.capability === 'FULL' && view.meta.freshness === 'CURRENT' &&
    view.pageInfo?.hasMore === false && counts && counts.evaluatedRules.exact && counts.evaluatedRules.value > 0 &&
    counts.notMatchedResults.value > 0 && (counts.notMatchedResults.exact || counts.notMatchedResults.capped) &&
    [counts.identitiesNeedingReview, counts.openFindings, counts.matchedResults, counts.suppressedResults, counts.notEvaluatedResults].every(exactZero)
  if (completeEvaluation) {
    return {
      label: 'No findings in evaluated evidence',
      detail: 'The reported current evaluation contains only not-matched outcomes. This does not establish that any identity is safe or that unimplemented checks were performed.',
    }
  }
  if (counts && [counts.matchedResults, counts.suppressedResults, counts.notMatchedResults].every(exactZero)) {
    return {
      label: 'No evaluated outcomes reported',
      detail: 'An empty findings list does not confirm that a check ran against sufficient evidence. Review the reported coverage and not-evaluated outcomes.',
    }
  }
  return {
    label: 'No findings returned',
    detail: 'Limited coverage, suppressed outcomes, or incomplete evaluation information prevents a complete no-findings conclusion. Review the reported outcomes and evidence context.',
  }
}

export function microsoftHasConfirmedEmptySnapshot(view: MicrosoftEntraRiskyUsersView) {
  return view.meta.status === 'AVAILABLE' && view.meta.capability === 'FULL' &&
    view.meta.freshness === 'CURRENT' && view.users?.length === 0 && view.pageInfo?.hasMore === false
}

const missingEvidenceLabels: Readonly<Record<string, string>> = {
  ACCOUNT_CLASS_COVERAGE_INCOMPLETE: 'Account classification coverage is incomplete',
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
  return Object.hasOwn(missingEvidenceLabels, code) ? missingEvidenceLabels[code] : 'An evidence limitation was reported'
}

export function benignAlternativeLabel(code: string) {
  return Object.hasOwn(benignAlternativeLabels, code) ? benignAlternativeLabels[code] : 'An authorized activity alternative was reported'
}
