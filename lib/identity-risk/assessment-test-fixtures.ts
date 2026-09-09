// Isolated synthetic DTOs; no customer records or requests.
import { RISK_ASSESSMENT_RULE_TUPLES } from './types.ts'
import type { RiskAssessmentRuleId } from './types.ts'

export const assessmentNow = Date.parse('2026-09-08T22:00:00.000Z')
export const at = (minutes = 0) =>
  new Date(assessmentNow + minutes * 60_000).toISOString()
export const opaque = (kind: string, character = 'a') =>
  `hvr1_${kind}_${character.repeat(64)}`
export function unknownProtection() {
  const evidence = {
    state: 'UNKNOWN',
    source: 'NOT_REPORTED',
    observedAt: null,
    freshness: 'UNKNOWN',
    reasonCode: 'NOT_REPORTED',
  }
  return {
    conditionalAccess: {
      contractVersion: 1,
      status: 'UNKNOWN',
      policies: [],
      observedAt: null,
      evaluatedAt: null,
      source: 'EFFECTIVE_MFA_V1',
      freshness: 'UNKNOWN',
      reasonCodes: ['EVIDENCE_UNAVAILABLE'],
    },
    securityDefaults: { ...evidence },
    legacyPerUserMfa: { ...evidence },
    registration: { ...evidence },
    explanation: 'Protection has not been verified.',
  }
}

export function assessmentFixture(withFinding = false): Record<string, any> {
  const window = { start: at(-15), end: at() }
  const sources = ['M365_AUDIT_STS', 'GRAPH_SIGN_INS', 'MAILBOX_RULES'].map(
    (source) => ({
      source,
      status: 'READY',
      reasonCode: 'READY',
      explanation: 'Current qualified collection is available.',
      window: { ...window },
      lastSuccessfulCollectionAt: at(),
      latestEventAt: at(-1),
      latestIngestionAt: at(),
      freshness: 'CURRENT',
    })
  )
  const rules = Object.entries(RISK_ASSESSMENT_RULE_TUPLES).map(
    ([ruleId, tuple]) => ({
      ruleId,
      ruleVersion: tuple.version,
      title:
        ruleId === 'HV-ID-AUTH-010.v1'
          ? 'Repeated invalid credentials'
          : ruleId === 'HV-ID-AUTH-005.v2'
            ? 'Failures followed by successful sign-in'
            : 'External mailbox forwarding',
      status: 'READY',
      reasonCode: 'READY',
      explanation: 'This check evaluated its reported evidence window.',
      selectedSource: tuple.sources[0],
      window: { ...window },
      evaluatedAt: at(),
      assessedIdentities: 2,
      matchedIdentities: withFinding && ruleId === 'HV-ID-AUTH-010.v1' ? 1 : 0,
      countsCapped: false,
    })
  )
  return {
    version: 1,
    schemaVersion: 'hawkview-risk-assessment/v1',
    meta: {
      version: 1,
      channel: 'HAWKVIEW_IDENTITY_SIGNALS',
      engineVersion: 'hawkview-identity-engine/1',
      catalogVersion: 'hawkview-identity-signals/v1',
      evaluatedAt: at(),
      capability: 'FULL',
      status: 'AVAILABLE',
      sourceLabel: 'HawkView independent identity evidence',
      observedAt: null,
      freshness: 'CURRENT',
      limitation: null,
    },
    sources,
    rules,
    users: withFinding ? [assessmentUser()] : [],
    page: { hasMore: false, nextCursor: null },
    summary: {
      scope: 'TENANT',
      asOf: at(),
      currentUsers: {
        value: withFinding ? 1 : 0,
        accuracy: 'EXACT',
      },
    },
  }
}

export function assessmentUser(
  ruleId: RiskAssessmentRuleId = 'HV-ID-AUTH-010.v1',
  character = 'a'
): Record<string, any> {
  const tuple = RISK_ASSESSMENT_RULE_TUPLES[ruleId]
  const mailbox = ruleId === 'HV-ID-MBX-001.v1'
  return {
    id: opaque(mailbox ? 'mailbox' : 'subject', character),
    label: 'Synthetic identity',
    subjectType: mailbox ? 'MAILBOX' : 'USER',
    priority: tuple.priority,
    protection: unknownProtection(),
    findings: [
      {
        id: opaque('contribution', character),
        ruleId,
        ruleVersion: tuple.version,
        priority: tuple.priority,
        confidence: 'HIGH',
        activityState: 'CURRENT',
        title: mailbox
          ? 'External mailbox forwarding'
          : ruleId === 'HV-ID-AUTH-010.v1'
            ? 'Repeated invalid credentials'
            : 'Failures followed by successful sign-in',
        explanation: mailbox
          ? 'An enabled forwarding setting requires review; delivery is not established.'
          : 'Qualified invalid-credential attempts were recorded for this account. Confirm whether this activity is expected.',
        firstSeen: at(-10),
        lastSeen: at(-1),
        evaluatedAt: at(),
        activityWindowEndsAt: at(5),
        window: { start: at(-15), end: at() },
        evidenceCount: 10,
        evidenceCountCapped: false,
        selectedSource: tuple.sources[0],
        application: {
          id: mailbox ? null : opaque('application'),
          state: mailbox ? 'NOT_REPORTED' : 'RESOLVED',
          label: mailbox ? null : 'Synthetic authorized application',
        },
        device: { state: 'NOT_REPORTED', label: null },
        clientSource: {
          reference: ruleId === 'HV-ID-AUTH-005.v2' ? opaque('context') : null,
          qualification:
            ruleId === 'HV-ID-AUTH-005.v2' ? 'QUALIFIED' : 'NOT_REPORTED',
        },
        evidenceReferences: [
          { id: opaque('evidence'), recordedAt: at(-1), ingestedAt: at() },
        ],
        eventProtection: 'NOT_REPORTED',
        caveats: [
          'This does not identify an attacker or establish compromise.',
        ],
        recommendedActions: [
          {
            code: 'CONFIRM_EXPECTED_ACTIVITY',
            text: 'Confirm whether this activity is expected.',
          },
        ],
      },
    ],
  }
}
