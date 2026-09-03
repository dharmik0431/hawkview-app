import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IDENTITY_RISK_CATALOG_VERSION,
  IDENTITY_RISK_ENGINE_VERSION,
  type IdentitySignalEvaluationContext,
} from './identity-risk.contract.js'
import {
  adaptApprovedIdentitySignalDetector,
  type ApprovedIdentitySignalOutputV1,
} from './identity-risk-approved-evaluator.adapter.js'

const digest = (character: string) => character.repeat(64)
const subjectId = `hvr1_subject_${digest('a')}`
const evaluationAt = new Date('2026-09-02T12:00:00.000Z')
const context: IdentitySignalEvaluationContext = Object.freeze({
  organizationId: '11111111-1111-4111-8111-111111111111',
  customerTenantId: '22222222-2222-4222-8222-222222222222',
  evaluationAt,
  engineVersion: IDENTITY_RISK_ENGINE_VERSION,
  catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
  sources: Object.freeze(Object.create(null)),
})

// Exact shape emitted by approved evaluator commit 5254923 for a matched rule.
const approvedOutput = Object.freeze({
  engineVersion: IDENTITY_RISK_ENGINE_VERSION,
  catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
  channel: 'HAWKVIEW_IDENTITY_SIGNALS',
  ruleId: 'HV-ID-EXP-001.v1',
  subject: Object.freeze({ type: 'USER', opaqueId: subjectId }),
  status: 'MATCHED',
  severity: 'MEDIUM',
  confidence: 'HIGH',
  coverage: 'FULL',
  reasonCodes: Object.freeze(['RULE_MATCHED']),
  evidenceReferences: Object.freeze([`hvr1_evidence_${digest('b')}`]),
  sourceLabels: Object.freeze(['Microsoft Entra directory audit']),
  titleCode: 'PRIVILEGED_IDENTITY_MFA_ENFORCEMENT_GAP',
  explanationCode: 'PRIVILEGED_IDENTITY_LACKS_VERIFIED_EFFECTIVE_MFA',
  investigationGuidanceCode: 'REVIEW_IDENTITY_SIGNAL_EVIDENCE',
  benignAlternativeCodes: Object.freeze(['APPROVED_TEMPORARY_MFA_EXCEPTION']),
}) satisfies ApprovedIdentitySignalOutputV1

test('approved evaluator 5254923 output adapts without losing decision semantics', async () => {
  const detector = adaptApprovedIdentitySignalDetector({
    ruleId: 'HV-ID-EXP-001.v1',
    evaluate: () => [approvedOutput],
    matchedObservedAt: () => evaluationAt,
  })
  assert.deepEqual(await detector.evaluate(context), [{
    ruleId: 'HV-ID-EXP-001.v1',
    outcome: 'MATCHED',
    coverage: 'FULL',
    reasonCodes: ['RULE_MATCHED'],
    subjectType: 'USER',
    subjectId,
    evidenceReferences: [`hvr1_evidence_${digest('b')}`],
    sourceLabels: ['Microsoft Entra directory audit'],
    severity: 'MEDIUM',
    confidence: 'HIGH',
    observedAt: evaluationAt,
  }])
})

test('approved evaluator operational output receives a platform-owned opaque source reference', async () => {
  const operational = Object.freeze({
    ...approvedOutput,
    ruleId: null,
    subject: Object.freeze({ type: 'SOURCE' as const, opaqueId: 'EVALUATION_INPUT' }),
    status: 'NOT_EVALUATED' as const,
    severity: null,
    confidence: null,
    coverage: 'UNAVAILABLE' as const,
    reasonCodes: Object.freeze(['EVIDENCE_MALFORMED']),
    evidenceReferences: Object.freeze([]),
    sourceLabels: Object.freeze([]),
    investigationGuidanceCode: null,
    benignAlternativeCodes: Object.freeze([]),
  }) satisfies ApprovedIdentitySignalOutputV1
  const detector = adaptApprovedIdentitySignalDetector({
    ruleId: 'HV-ID-EXP-001.v1',
    evaluate: () => [operational],
    matchedObservedAt: () => evaluationAt,
  })
  const [result] = await detector.evaluate(context)
  assert.equal(result?.outcome, 'NOT_EVALUATED')
  assert.match(result?.subjectId ?? '', /^hvr1_source_[a-f0-9]{64}$/u)
  assert.ok(!JSON.stringify(result).includes('EVALUATION_INPUT'))
  assert.deepEqual(result?.evidenceReferences, [])
})

test('adapter rejects a raw or secret-shaped approved-evaluator subject', async () => {
  const detector = adaptApprovedIdentitySignalDetector({
    ruleId: 'HV-ID-EXP-001.v1',
    evaluate: () => [{ ...approvedOutput, subject: { type: 'USER', opaqueId: 'ARRAYSECRET1' } }],
    matchedObservedAt: () => evaluationAt,
  })
  await assert.rejects(async () => detector.evaluate(context), /output is invalid/)
})
