import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  IDENTITY_RISK_CATALOG_VERSION,
  IDENTITY_RISK_ENGINE_VERSION,
  IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION,
  type IdentitySignalEvaluationContext,
} from './identity-risk.contract.js'
import {
  APPROVED_IDENTITY_SIGNAL_EVALUATOR_COMMIT,
  adaptApprovedIdentitySignalDetector,
  approvedIdentitySignalDetectors,
} from './identity-risk-approved-evaluator.adapter.js'
import {
  IDENTITY_SIGNAL_RULE_IDS,
  type IdentitySignalCandidate as ApprovedIdentitySignalCandidate,
} from './identity-signal-contract.js'

function opaque(kind: string, label: string) {
  return `hvr1_${kind}_${createHash('sha256').update(`${kind}:${label}`).digest('hex')}`
}

const evaluationAt = new Date('2026-09-02T12:00:00.000Z')
const evidenceObservedAt = '2026-09-02T11:30:00.000Z'
const evidenceReference = opaque('evidence', 'weakened-policy')
const subjectReference = opaque('subject', 'user-1')

// This is the actual candidate type exported by approved evaluator commit
// 525492313cfb893f03c096bc62c0637f60169e8e, not a local lookalike.
const approvedCandidate = Object.freeze({
  ruleId: 'HV-ID-CHG-005.v1',
  subject: Object.freeze({ type: 'USER', opaqueId: subjectReference }),
  evidenceReferences: Object.freeze([evidenceReference]),
  evidence: Object.freeze([{
    observedAt: evidenceObservedAt,
    maxAgeHours: 2,
  }]),
  evidenceState: 'COMPLETE',
  change: 'SECURITY_DEFAULTS',
  before: true,
  after: false,
  succeeded: true,
}) satisfies ApprovedIdentitySignalCandidate

const context: IdentitySignalEvaluationContext = Object.freeze({
  organizationId: '11111111-1111-4111-8111-111111111111',
  customerTenantId: '22222222-2222-4222-8222-222222222222',
  evaluationAt,
  engineVersion: IDENTITY_RISK_ENGINE_VERSION,
  catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
  capability: 'FULL',
  sources: Object.freeze(Object.assign(Object.create(null), {
    DIRECTORY_AUDIT: Object.freeze([Object.freeze({
      schemaVersion: IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION,
      recordReference: opaque('event', 'directory-event-1'),
      subjectReference,
      candidate: approvedCandidate,
    })]),
  })),
})

test('adapter invokes the actual approved evaluator and preserves its matched result', async () => {
  const detector = adaptApprovedIdentitySignalDetector({
    ruleId: 'HV-ID-CHG-005.v1',
    configuration: {
      readiness: 'READY',
      featureFlags: { 'HV-ID-CHG-005.v1': true },
    },
  })
  const [result] = await detector.evaluate(context)
  assert.match(result?.candidateReference ?? '', /^hvr1_contribution_[a-f0-9]{64}$/u)
  assert.deepEqual({ ...result, candidateReference: undefined }, {
    ruleId: 'HV-ID-CHG-005.v1',
    outcome: 'MATCHED',
    coverage: 'FULL',
    reasonCodes: ['RULE_MATCHED'],
    subjectType: 'USER',
    subjectId: subjectReference,
    candidateReference: undefined,
    evidenceReferences: [evidenceReference],
    sourceLabels: ['Microsoft Entra administrative change evidence'],
    severity: 'HIGH',
    confidence: 'HIGH',
    observedAt: new Date(evidenceObservedAt),
  })
})

test('adapter projects the trusted platform clock and capability into actual fail-closed gates', async () => {
  const detector = adaptApprovedIdentitySignalDetector({
    ruleId: 'HV-ID-CHG-005.v1',
    configuration: {
      readiness: 'READY',
      featureFlags: { 'HV-ID-CHG-005.v1': true },
    },
  })
  const [result] = await detector.evaluate({ ...context, capability: 'PARTIAL' })
  assert.equal(result?.outcome, 'NOT_EVALUATED')
  assert.equal(result?.coverage, 'PARTIAL')
  assert.deepEqual(result?.reasonCodes, ['EVIDENCE_PARTIAL'])

  const futureCandidate = {
    ...approvedCandidate,
    evidence: [{ observedAt: '2026-09-02T12:05:00.001Z', maxAgeHours: 2 }],
  } satisfies ApprovedIdentitySignalCandidate
  const futureContext = {
    ...context,
    sources: {
      DIRECTORY_AUDIT: [{
        ...context.sources.DIRECTORY_AUDIT![0]!,
        candidate: futureCandidate,
      }],
    },
  }
  const [future] = await detector.evaluate(futureContext)
  assert.equal(future?.outcome, 'NOT_EVALUATED')
  assert.deepEqual(future?.reasonCodes, ['EVIDENCE_FUTURE_DATED'])
})

test('adapter rejects source candidate and wrapper subject drift before evaluator output', async () => {
  const detector = adaptApprovedIdentitySignalDetector({
    ruleId: 'HV-ID-CHG-005.v1',
    configuration: {
      readiness: 'READY',
      featureFlags: { 'HV-ID-CHG-005.v1': true },
    },
  })
  const unsafeContext = {
    ...context,
    sources: {
      DIRECTORY_AUDIT: [{
        ...context.sources.DIRECTORY_AUDIT![0]!,
        subjectReference: opaque('subject', 'other-user'),
      }],
    },
  }
  await assert.rejects(
    async () => detector.evaluate(unsafeContext),
    /candidate projection is invalid/,
  )
})

test('adapter rejects wrong-kind subject and evidence references accepted by the pinned runtime', async () => {
  const detector = adaptApprovedIdentitySignalDetector({
    ruleId: 'HV-ID-CHG-005.v1',
    configuration: {
      readiness: 'READY',
      featureFlags: { 'HV-ID-CHG-005.v1': true },
    },
  })
  for (const candidate of [
    {
      ...approvedCandidate,
      subject: { type: 'USER' as const, opaqueId: opaque('evidence', 'wrong-user') },
    },
    {
      ...approvedCandidate,
      subject: { type: 'APPLICATION' as const, opaqueId: opaque('mailbox', 'wrong-app') },
    },
    {
      ...approvedCandidate,
      evidenceReferences: [opaque('subject', 'wrong-evidence')],
    },
  ] satisfies ApprovedIdentitySignalCandidate[]) {
    const unsafeContext = {
      ...context,
      sources: {
        DIRECTORY_AUDIT: [{
          ...context.sources.DIRECTORY_AUDIT![0]!,
          subjectReference: candidate.subject.opaqueId,
          candidate,
        }],
      },
    }
    await assert.rejects(
      async () => detector.evaluate(unsafeContext),
      /candidate projection is invalid/,
    )
  }
})

test('adapter projects nested approved authentication candidates into the real evaluator', async () => {
  const nestedSubject = opaque('subject', 'nested-user')
  const nestedEvidence = opaque('evidence', 'nested-auth')
  const nestedCandidate = {
    ruleId: 'HV-ID-AUTH-006.v1',
    subject: { type: 'USER', opaqueId: nestedSubject },
    evidenceReferences: [nestedEvidence],
    evidence: [{ observedAt: evidenceObservedAt, maxAgeHours: 2 }],
    evidenceState: 'COMPLETE',
    normalizedMfaDetailComplete: true,
    events: [
      ['deny-1', 'MFA_DENIED', '2026-09-02T11:30:00.000Z'],
      ['deny-2', 'MFA_DENIED', '2026-09-02T11:31:00.000Z'],
      ['deny-3', 'MFA_DENIED', '2026-09-02T11:32:00.000Z'],
      ['success', 'SUCCESS', '2026-09-02T11:33:00.000Z'],
    ].map(([id, outcome, occurredAt]) => ({
      id: opaque('event', id!),
      occurredAt: occurredAt!,
      outcome: outcome as 'MFA_DENIED' | 'SUCCESS',
      interactive: true,
      subjectId: nestedSubject,
      appId: opaque('application', 'portal'),
      deviceFingerprint: opaque('device', 'device-1'),
      sourceFingerprint: opaque('source', 'network-1'),
    })),
  } satisfies ApprovedIdentitySignalCandidate
  const detector = adaptApprovedIdentitySignalDetector({
    ruleId: 'HV-ID-AUTH-006.v1',
    configuration: {
      readiness: 'READY',
      featureFlags: { 'HV-ID-AUTH-006.v1': true },
    },
  })
  const [result] = await detector.evaluate({
    ...context,
    sources: {
      SIGN_INS: [{
        schemaVersion: IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION,
        recordReference: opaque('event', 'nested-auth-record'),
        subjectReference: nestedSubject,
        candidate: nestedCandidate,
      }],
    },
  })
  assert.equal(result?.outcome, 'MATCHED')
  assert.equal(result?.subjectId, nestedSubject)
  assert.deepEqual(result?.evidenceReferences, [nestedEvidence])
  assert.match(result?.candidateReference ?? '', /^hvr1_contribution_[a-f0-9]{64}$/u)

  const wrongNestedReference = {
    ...nestedCandidate,
    events: [{
      ...nestedCandidate.events[0]!,
      id: opaque('evidence', 'wrong-event-kind'),
    }, ...nestedCandidate.events.slice(1)],
  } satisfies ApprovedIdentitySignalCandidate
  await assert.rejects(
    async () => detector.evaluate({
      ...context,
      sources: {
        SIGN_INS: [{
          schemaVersion: IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION,
          recordReference: opaque('event', 'wrong-nested-record'),
          subjectReference: nestedSubject,
          candidate: wrongNestedReference,
        }],
      },
    }),
    /candidate projection is invalid/,
  )
})

test('detector factory is pinned to every actual approved rule exactly once', () => {
  assert.equal(
    APPROVED_IDENTITY_SIGNAL_EVALUATOR_COMMIT,
    '525492313cfb893f03c096bc62c0637f60169e8e',
  )
  const detectors = approvedIdentitySignalDetectors({ readiness: 'NOT_READY' })
  assert.deepEqual(
    detectors.map((detector) => detector.ruleId).sort(),
    [...IDENTITY_SIGNAL_RULE_IDS].sort(),
  )
  assert.equal(new Set(detectors.map((detector) => detector.ruleId)).size, 22)
})
