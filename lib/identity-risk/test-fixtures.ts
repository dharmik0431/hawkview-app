// Synthetic DTO fixtures only; no tenant data or production requests.
export const observedAt = '2026-09-02T12:00:00.000Z'
export const evaluatedAt = '2026-09-02T13:00:00.000Z'
export const receiptTime = Date.parse('2026-09-02T14:00:00.000Z')
export const boundedCount = (value: number, exact = true, capped = false) => ({ value, exact, capped })

export function syntheticRiskResponses() {
  const meta = {
    version: 1, capability: 'FULL', status: 'AVAILABLE', sourceLabel: 'HawkView Identity Signals',
    engineVersion: 'hawkview-identity-engine/1', catalogVersion: 'hawkview-identity-signals/v1',
    evaluatedAt, observedAt, freshness: 'CURRENT', limitation: null,
  }
  return {
    hawkViewSummary: {
      ...meta, channel: 'HAWKVIEW_IDENTITY_SIGNALS', counts: {
        identitiesNeedingReview: boundedCount(0), openFindings: boundedCount(0), evaluatedRules: boundedCount(1),
        matchedResults: boundedCount(0), suppressedResults: boundedCount(0), notMatchedResults: boundedCount(1), notEvaluatedResults: boundedCount(0),
      },
    } as Record<string, any>,
    hawkViewFindings: { ...meta, channel: 'HAWKVIEW_IDENTITY_SIGNALS', findings: [], pageInfo: { hasMore: false, nextCursor: null } } as Record<string, any>,
    microsoftRiskyUsers: {
      ...meta, sourceLabel: 'Microsoft Entra Risky Users', engineVersion: null, catalogVersion: 'microsoft-entra-risky-users/v1',
      channel: 'MICROSOFT_ENTRA_RISKY_USERS', users: [], pageInfo: { hasMore: false, nextCursor: null },
    } as Record<string, any>,
  }
}

export function syntheticMailboxFinding() {
  return {
    id: 'opaque-finding-1', state: 'OPEN', severity: 'HIGH', confidence: 'HIGH', coverage: 'FULL',
    title: 'Mailbox forwarding outside verified domains requires review',
    explanation: 'An enabled rule targets a domain outside the current Microsoft Graph verified tenant-domain set. This is an investigation lead, not proof of message delivery or compromise.',
    affectedIdentity: { id: 'opaque-mailbox-1', label: 'Reported mailbox', type: 'MAILBOX' }, observedAt,
    ruleIds: ['HV-ID-MBX-001.v1'], sourceLabels: ['Microsoft Graph mailbox-rule snapshot', 'Microsoft Graph verified tenant domains'],
    missingEvidenceLabels: [], benignAlternativeCodes: ['APPROVED_EXTERNAL_FORWARDING'],
    investigationGuidanceCode: 'REVIEW_MAILBOX_RULE', investigationGuidance: 'Review the mailbox rule and confirm the destination is authorized.',
  }
}

export function addSyntheticFinding(responses: ReturnType<typeof syntheticRiskResponses>) {
  responses.hawkViewFindings.findings = [syntheticMailboxFinding()]
  responses.hawkViewSummary.counts = {
    ...responses.hawkViewSummary.counts, identitiesNeedingReview: boundedCount(1), openFindings: boundedCount(1),
    matchedResults: boundedCount(1), notMatchedResults: boundedCount(0),
  }
}

export function setHawkViewMeta(responses: ReturnType<typeof syntheticRiskResponses>, meta: Record<string, unknown>) {
  Object.assign(responses.hawkViewSummary, meta)
  Object.assign(responses.hawkViewFindings, meta)
}

export function unavailableMeta(limitation: string, status = 'UNAVAILABLE') {
  return { status, capability: 'UNAVAILABLE', freshness: 'UNKNOWN', evaluatedAt: null, observedAt: null, limitation }
}
