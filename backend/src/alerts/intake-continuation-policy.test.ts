import assert from 'node:assert/strict'
import test from 'node:test'
import {
  intakeReviewReason, isActiveIntakeFinding, sameIntakeSourceSnapshot,
  type IntakeDecisionReceipt, type IntakeSourceSnapshot,
} from './intake-continuation-policy.js'

const source: IntakeSourceSnapshot = {
  id: 'finding-a',
  organizationId: 'org-a',
  customerTenantId: 'tenant-a',
  matchedResultId: 'match-a',
  dedupeKey: 'evidence-a',
  ruleId: 'HV-ID-AUTH-001.v1',
  ruleVersion: 'v1',
  subjectType: 'USER',
  subjectId: 'subject-a',
  state: 'OPEN',
  severity: 'HIGH',
  confidence: 'MEDIUM',
  coverage: 'FULL',
  observedAt: '2026-10-25T10:00:00.123456Z',
  expiresAt: '2026-10-26T10:00:00.123456Z',
  updatedAt: '2026-10-25T10:01:00.123456Z',
}

const receipt = (
  outcome: IntakeDecisionReceipt['outcome'],
  selected: IntakeSourceSnapshot = source,
): IntakeDecisionReceipt => ({
  source: selected, outcome, mappingRevision: 'reviewed-map-a',
})

test('OPEN and UPDATED are both active; resolved, expired and unknown are not', () => {
  for (const state of ['OPEN', 'UPDATED']) {
    assert.equal(isActiveIntakeFinding(state), true)
    assert.equal(intakeReviewReason({ ...source, state }, null, 'reviewed-map-a'), 'UNSEEN')
  }
  for (const state of ['RESOLVED', 'EXPIRED', 'UNKNOWN']) {
    assert.equal(isActiveIntakeFinding(state), false)
    assert.equal(intakeReviewReason({ ...source, state }, null, 'reviewed-map-a'), 'INACTIVE')
  }
})

test('selected and locked source must match the entire tuple, including same-observation updates', () => {
  assert.equal(sameIntakeSourceSnapshot(source, { ...source }), true)
  const differences: Array<[keyof IntakeSourceSnapshot, string]> = [
    ['id', 'finding-b'], ['organizationId', 'org-b'], ['customerTenantId', 'tenant-b'],
    ['matchedResultId', 'match-b'], ['dedupeKey', 'evidence-b'],
    ['ruleId', 'HV-ID-AUTH-002.v1'], ['ruleVersion', 'v2'],
    ['subjectType', 'APPLICATION'], ['subjectId', 'subject-b'], ['state', 'UPDATED'],
    ['severity', 'CRITICAL'], ['confidence', 'HIGH'], ['coverage', 'PARTIAL'],
    ['observedAt', '2026-10-25T10:00:00.123457Z'],
    ['expiresAt', '2026-10-26T10:00:00.123457Z'],
    ['updatedAt', '2026-10-25T10:01:00.123457Z'],
  ]
  for (const [field, value] of differences) {
    assert.equal(sameIntakeSourceSnapshot(source, { ...source, [field]: value }), false, field)
  }
  assert.equal(intakeReviewReason({ ...source, state: 'UPDATED' }, receipt('COMPLETED'), 'reviewed-map-a'), 'UNCHANGED')
})

test('completed findings remain terminal across ordinary source refreshes', () => {
  assert.equal(intakeReviewReason(source, receipt('COMPLETED'), 'reviewed-map-a'), 'UNCHANGED')
  assert.equal(intakeReviewReason({ ...source, matchedResultId: 'match-new' },
    receipt('COMPLETED'), 'reviewed-map-a'), 'UNCHANGED')
  assert.equal(intakeReviewReason({ ...source, subjectType: 'APPLICATION' },
    receipt('COMPLETED'), 'reviewed-map-a'), 'UNCHANGED')
  assert.equal(intakeReviewReason({ ...source, subjectId: 'subject-new' },
    receipt('COMPLETED'), 'reviewed-map-a'), 'UNCHANGED')
  assert.equal(intakeReviewReason({ ...source, state: 'UPDATED',
    observedAt: '2026-10-25T11:00:00.123456Z', updatedAt: '2026-10-25T11:01:00.123456Z' },
  receipt('COMPLETED'), 'reviewed-map-a'), 'UNCHANGED')
  assert.equal(intakeReviewReason({ ...source, dedupeKey: 'new-evidence' },
    receipt('COMPLETED'), 'reviewed-map-a'), 'IDENTITY_CHANGED')
  assert.equal(intakeReviewReason({ ...source, organizationId: 'another-org' },
    receipt('COMPLETED'), 'reviewed-map-a'), 'SCOPE_MISMATCH')
})

test('aged-out and expired receipts remain terminal across ordinary source refreshes', () => {
  for (const outcome of ['AGED_OUT_RECORDED', 'EXPIRED_BEFORE_INTAKE'] as const) {
    const terminal = receipt(outcome)
    assert.equal(intakeReviewReason(source, terminal, 'reviewed-map-a'), 'UNCHANGED', outcome)
    assert.equal(intakeReviewReason({ ...source, expiresAt: '2026-10-27T10:00:00.123456Z' },
      terminal, 'reviewed-map-a'), 'UNCHANGED', outcome)
    assert.equal(intakeReviewReason({ ...source, observedAt: '2026-10-25T12:00:00.123456Z' },
      terminal, 'reviewed-map-a'), 'UNCHANGED', outcome)
  }
})

test('5,001 completed refreshes do not consume a synthetic candidate page ahead of a new finding', () => {
  const completedHead = Array.from({ length: 5_001 }, (_, index) => {
    const selected = { ...source, id: `finding-${index}`, dedupeKey: `evidence-${index}` }
    return { current: { ...selected, state: 'UPDATED', updatedAt: '2026-10-25T11:00:00.123456Z' },
      decision: receipt('COMPLETED', selected) }
  })
  const tail = { current: { ...source, id: 'pending-tail', dedupeKey: 'pending-tail' }, decision: null }
  const candidateReasons = new Set(['UNSEEN', 'IDENTITY_CHANGED', 'MAPPING_CHANGED'])
  const page = [...completedHead, tail]
    .filter(({ current, decision }) => candidateReasons.has(intakeReviewReason(current, decision, 'reviewed-map-a')))
    .slice(0, 5_000)
  assert.deepEqual(page.map(({ current }) => current.id), ['pending-tail'])
})

test('unmapped rules stay blocked across ordinary refreshes and reopen for mapping changes', () => {
  const blocked = receipt('BLOCKED_UNMAPPED')
  assert.equal(intakeReviewReason(source, blocked, 'reviewed-map-a'), 'BLOCKED_UNMAPPED')
  assert.equal(intakeReviewReason({ ...source, state: 'UPDATED', updatedAt: '2026-10-25T11:00:00Z' },
    blocked, 'reviewed-map-a'), 'BLOCKED_UNMAPPED')
  assert.equal(intakeReviewReason(source, blocked, 'reviewed-map-b'), 'MAPPING_CHANGED')
  assert.equal(intakeReviewReason({ ...source, ruleId: 'HV-ID-AUTH-002.v1' },
    blocked, 'reviewed-map-a'), 'MAPPING_CHANGED')
  assert.equal(intakeReviewReason({ ...source, ruleVersion: 'v2' },
    blocked, 'reviewed-map-a'), 'MAPPING_CHANGED')
  for (const changedIdentity of [{ id: 'finding-b' }, { dedupeKey: 'evidence-b' }])
    assert.equal(intakeReviewReason({ ...source, ...changedIdentity }, blocked, 'reviewed-map-a'),
      'IDENTITY_CHANGED')
  for (const changedScope of [{ organizationId: 'org-b' }, { customerTenantId: 'tenant-b' }])
    assert.equal(intakeReviewReason({ ...source, ...changedScope }, blocked, 'reviewed-map-a'),
      'SCOPE_MISMATCH')
  for (const changedSubject of [{ subjectType: 'APPLICATION' }, { subjectId: 'subject-b' }])
    assert.equal(intakeReviewReason({ ...source, ...changedSubject }, blocked, 'reviewed-map-a'),
      'BLOCKED_UNMAPPED')
})
