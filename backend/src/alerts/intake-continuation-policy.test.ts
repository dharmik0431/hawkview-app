import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  classifyLockedIntakeMode, intakeReviewReason, isActiveIntakeFinding, sameIntakeSourceSnapshot,
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
  findingId: selected.id, organizationId: selected.organizationId,
  customerTenantId: selected.customerTenantId, ruleId: selected.ruleId,
  ruleVersion: selected.ruleVersion, outcome, mappingRevision: 'reviewed-map-a',
})

const processingClock = '2026-10-26T10:00:00.000000Z'
const locked = {
  state: 'OPEN', observedAt: '2026-10-25T10:00:00.000000Z',
  expiresAt: '2026-10-27T10:00:00.000000Z',
}

test('locked intake mode compares an injected UTC clock at the exact 24-hour boundary', () => {
  const oneMillisecondNewer = '2026-10-25T10:00:00.001000Z'
  const oneMillisecondOlder = '2026-10-25T09:59:59.999000Z'
  for (const observedAt of [oneMillisecondNewer, locked.observedAt]) {
    assert.deepEqual(classifyLockedIntakeMode({ ...locked, observedAt }, processingClock), {
      kind: 'ACTIVE_ELIGIBLE', observedAtExact: observedAt,
      processedAtExact: processingClock,
    })
  }
  assert.deepEqual(classifyLockedIntakeMode({ ...locked, observedAt: oneMillisecondOlder }, processingClock), {
    kind: 'HISTORICAL_ONLY', reason: 'AGED_OUT', observedAtExact: oneMillisecondOlder,
    processedAtExact: processingClock,
  })
  assert.equal(classifyLockedIntakeMode({ ...locked,
    observedAt: '2026-10-25T09:59:59.999999Z' }, processingClock).kind, 'HISTORICAL_ONLY')
  assert.equal(classifyLockedIntakeMode({ ...locked,
    observedAt: '2026-10-25T10:00:00.000001Z' }, processingClock).kind, 'ACTIVE_ELIGIBLE')
})

test('expiry equality and EXPIRED source state are historical-only even when recent', () => {
  const recent = { ...locked, observedAt: '2026-10-26T09:00:00.123456Z' }
  assert.deepEqual(classifyLockedIntakeMode({ ...recent, expiresAt: processingClock }, processingClock), {
    kind: 'HISTORICAL_ONLY', reason: 'EXPIRED_AT_PROCESSING',
    observedAtExact: recent.observedAt, processedAtExact: processingClock,
  })
  assert.equal(classifyLockedIntakeMode({ ...recent,
    expiresAt: '2026-10-26T10:00:00.000001Z' }, processingClock).kind, 'ACTIVE_ELIGIBLE')
  assert.deepEqual(classifyLockedIntakeMode({ ...recent, state: 'EXPIRED' }, processingClock), {
    kind: 'HISTORICAL_ONLY', reason: 'SOURCE_EXPIRED',
    observedAtExact: recent.observedAt, processedAtExact: processingClock,
  })
  for (const state of ['UNKNOWN', 'RESOLVED']) {
    assert.equal(classifyLockedIntakeMode({ ...recent, state }, processingClock).kind, 'INELIGIBLE')
  }
})

test('future, missing, malformed and non-finite times never become active', () => {
  assert.deepEqual(classifyLockedIntakeMode({ ...locked,
    observedAt: '2026-10-26T10:00:00.000001Z' }, processingClock), {
    kind: 'UNTRUSTED_TIME', reason: 'OBSERVATION_IN_FUTURE',
    observedAtExact: null, processedAtExact: processingClock,
  })
  for (const observedAt of ['', 'infinity', '2026-02-30T10:00:00.000000Z',
    '2026-10-25T10:00:00']) {
    const result = classifyLockedIntakeMode({ ...locked, observedAt }, processingClock)
    assert.deepEqual(result, { kind: 'UNTRUSTED_TIME', reason: 'OBSERVATION_INVALID',
      observedAtExact: null, processedAtExact: processingClock }, observedAt)
  }
  assert.equal(classifyLockedIntakeMode({ ...locked,
    observedAt: null as unknown as string }, processingClock).kind, 'UNTRUSTED_TIME')
  assert.deepEqual(classifyLockedIntakeMode(locked, '2026-10-26T10:00:00'), {
    kind: 'UNTRUSTED_TIME', reason: 'PROCESSING_CLOCK_INVALID',
    observedAtExact: null, processedAtExact: null,
  })
  assert.deepEqual(classifyLockedIntakeMode({ ...locked, expiresAt: '-infinity' }, processingClock), {
    kind: 'UNTRUSTED_TIME', reason: 'EXPIRY_INVALID',
    observedAtExact: null, processedAtExact: processingClock,
  })
  assert.deepEqual(classifyLockedIntakeMode({ ...locked,
    expiresAt: '2026-10-25T09:59:59.999999Z' }, processingClock), {
    kind: 'UNTRUSTED_TIME', reason: 'EXPIRY_BEFORE_OBSERVATION',
    observedAtExact: null, processedAtExact: processingClock,
  })
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
    receipt('COMPLETED'), 'reviewed-map-a'), 'UNCHANGED')
  assert.equal(intakeReviewReason({ ...source, id: 'finding-b' },
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
  for (const changedIdentity of [{ id: 'finding-b' }])
    assert.equal(intakeReviewReason({ ...source, ...changedIdentity }, blocked, 'reviewed-map-a'),
      'IDENTITY_CHANGED')
  assert.equal(intakeReviewReason({ ...source, dedupeKey: 'evidence-b' }, blocked,
    'reviewed-map-a'), 'BLOCKED_UNMAPPED')
  for (const changedScope of [{ organizationId: 'org-b' }, { customerTenantId: 'tenant-b' }])
    assert.equal(intakeReviewReason({ ...source, ...changedScope }, blocked, 'reviewed-map-a'),
      'SCOPE_MISMATCH')
  for (const changedSubject of [{ subjectType: 'APPLICATION' }, { subjectId: 'subject-b' }])
    assert.equal(intakeReviewReason({ ...source, ...changedSubject }, blocked, 'reviewed-map-a'),
      'BLOCKED_UNMAPPED')
})

test('both current producers keep the dedupe identity on same-row upsert', () => {
  const evaluator = readFileSync(new URL('../identity-risk/identity-risk-evaluator.service.ts', import.meta.url), 'utf8')
  const evaluatorUpsert = evaluator.split('transaction.identityRiskFinding.upsert({')[1]
  assert.ok(evaluatorUpsert, 'expected the evaluator finding upsert')
  assert.match(evaluatorUpsert, /organizationId_customerTenantId_dedupeKey/)
  const evaluatorUpdate = evaluatorUpsert.split('update: {')[1]?.split('},\n        })')[0]
  assert.ok(evaluatorUpdate, 'expected the evaluator finding update projection')
  assert.doesNotMatch(evaluatorUpdate, /\bdedupeKey\s*:/)

  const native = readFileSync(new URL('../risky-users-wiring/native-alert-publisher.ts', import.meta.url), 'utf8')
  const nativeUpdate = native.split('ON CONFLICT (organization_id, customer_tenant_id, dedupe_key) DO UPDATE SET')[1]
    ?.split('`')[0]
  assert.ok(nativeUpdate, 'expected the native publisher conflict update')
  assert.doesNotMatch(nativeUpdate, /\bdedupe_key\s*=/)
})
