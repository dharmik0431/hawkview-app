import { createHash } from 'node:crypto'
import type { IdentitySignalDetector, IdentitySignalResult } from './identity-risk.contract.js'
import { RISK_ASSESSMENT_RULE_IDS } from './identity-risk-assessment.contract.js'
import { projectStoredRiskAssessment } from './risk-assessment-projection.js'

/** Internal scheduler-only adapter. Formula evaluation occurs in the bounded
 * source projector; this bridge binds validated outputs to existing persistence. */
export function riskAssessmentDetectors(): readonly IdentitySignalDetector[] {
  return RISK_ASSESSMENT_RULE_IDS.map(ruleId => ({
    ruleId,
    evaluate(context): IdentitySignalResult[] {
      const assessment = projectStoredRiskAssessment(context.assessment, context.evaluationAt)
      if (!assessment) throw new Error('IDENTITY_RISK_ASSESSMENT_INVALID')
      const rule = assessment.rules.find(rule => rule.ruleId === ruleId)!
      const outcomes: IdentitySignalResult[] = []
      for (const subject of assessment.subjects) for (const finding of subject.findings) {
        if (finding.ruleId !== ruleId || finding.activityState !== 'CURRENT') continue
        outcomes.push({ ruleId, subjectId: subject.id, subjectType: subject.subjectType,
          outcome: 'MATCHED', coverage: rule.status === 'READY' ? 'FULL' : 'PARTIAL',
          reasonCodes: ['RULE_MATCHED'], candidateReference: finding.id,
          evidenceReferences: finding.evidenceReferences.map(ref => ref.id),
          severity: finding.priority, confidence: finding.confidence, observedAt: new Date(finding.lastSeen),
        })
      }
      if (!outcomes.length) outcomes.push({ ruleId, subjectType: 'UNKNOWN',
        subjectId: `hvr1_source_${createHash('sha256').update([context.organizationId, context.customerTenantId, ruleId].join(':')).digest('hex')}`,
        outcome: rule.status === 'READY' ? 'NOT_MATCHED' : 'NOT_EVALUATED',
        coverage: rule.status === 'READY' ? 'FULL' : rule.status === 'PARTIAL' ? 'PARTIAL' : 'UNAVAILABLE',
        reasonCodes: [rule.status === 'READY' ? 'NO_MATCH' : rule.status === 'PARTIAL' ? 'EVIDENCE_PARTIAL' : 'EVIDENCE_UNAVAILABLE'],
      })
      return outcomes
    },
  }))
}
