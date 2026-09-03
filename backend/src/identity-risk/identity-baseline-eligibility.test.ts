import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  BASELINE_PERSISTENCE_CONTRACT_VERSION,
  assessBaselineContribution,
  type BaselineContributionInput,
  type BaselinePersistenceObligation,
} from './identity-baseline-eligibility.js'

function opaque(kind: string, label: string): string {
  return `hvr1_${kind}_${createHash('sha256').update(`${kind}:${label}`).digest('hex')}`
}

const base: BaselineContributionInput = {
  subjectId: opaque('subject', 'user-1'),
  propertyKey: opaque('property', 'device-1'),
  accountClass: 'HUMAN',
  evaluatedAt: '2026-09-10T12:00:00.000Z',
  futureClockSkewToleranceMs: 300_000,
  observations: [
    { id: opaque('event', 'event-1'), observedAt: '2026-09-01T12:00:00.000Z', utcDay: '2026-09-01' },
    { id: opaque('event', 'event-2'), observedAt: '2026-09-02T12:00:00.000Z', utcDay: '2026-09-02' },
  ],
  unresolvedFinding: false,
  existingContributionKeys: [],
}

test('requires recurrence on two distinct UTC days and deduplicates replayed observations', () => {
  assert.equal(assessBaselineContribution(base).status, 'ELIGIBLE')
  assert.equal(assessBaselineContribution({ ...base, observations: [base.observations[0]!, base.observations[0]!] }).reasonCode, 'BASELINE_RECURRENCE_REQUIRED')
})

test('unresolved suspicious episodes and one-per-property-subject-day cap prevent poisoning', () => {
  assert.equal(assessBaselineContribution({ ...base, unresolvedFinding: true }).reasonCode, 'BASELINE_UNRESOLVED_FINDING')
  const first = assessBaselineContribution(base)
  assert.equal(assessBaselineContribution({ ...base, existingContributionKeys: [first.contributionKey!] }).reasonCode, 'BASELINE_DUPLICATE_OR_DAILY_CAP')
})

test('ordinary authorized-benign review needs one reviewer and 24-hour cooling', () => {
  const pending = assessBaselineContribution({
    ...base,
    evaluatedAt: '2026-09-03T11:59:59.999Z',
    review: { outcome: 'AUTHORIZED_BENIGN', decidedAt: '2026-09-02T12:00:00.000Z', reviewerIds: [opaque('reviewer', 'reviewer-1')] },
  })
  assert.deepEqual([pending.status, pending.reasonCode], ['PENDING', 'BASELINE_REVIEW_COOLING'])
  const eligible = assessBaselineContribution({
    ...base,
    evaluatedAt: '2026-09-03T12:00:00.000Z',
    review: { outcome: 'AUTHORIZED_BENIGN', decidedAt: '2026-09-02T12:00:00.000Z', reviewerIds: [opaque('reviewer', 'reviewer-1')] },
  })
  assert.deepEqual([eligible.status, eligible.reasonCode], ['ELIGIBLE', 'BASELINE_REVIEW_ELIGIBLE'])
})

test('sensitive classes require two distinct reviewers and seven-day cooling', () => {
  const oneReviewer = assessBaselineContribution({
    ...base,
    accountClass: 'PRIVILEGED_HUMAN',
    review: { outcome: 'AUTHORIZED_BENIGN', decidedAt: '2026-09-01T00:00:00.000Z', reviewerIds: [opaque('reviewer', 'same'), opaque('reviewer', 'same')] },
  })
  assert.equal(oneReviewer.reasonCode, 'BASELINE_REVIEW_DUAL_APPROVAL_REQUIRED')
  const eligible = assessBaselineContribution({
    ...base,
    accountClass: 'PRIVILEGED_HUMAN',
    evaluatedAt: '2026-09-08T00:00:00.000Z',
    review: { outcome: 'AUTHORIZED_BENIGN', decidedAt: '2026-09-01T00:00:00.000Z', reviewerIds: [opaque('reviewer', 'reviewer-1'), opaque('reviewer', 'reviewer-2')] },
  })
  assert.equal(eligible.status, 'ELIGIBLE')
})

test('break-glass and non-authorized-benign outcomes never enter ordinary baselines', () => {
  assert.equal(assessBaselineContribution({ ...base, accountClass: 'BREAK_GLASS' }).reasonCode, 'BASELINE_ACCOUNT_CLASS_UNSUPPORTED')
  assert.equal(assessBaselineContribution({ ...base, accountClass: 'SERVICE' }).reasonCode, 'BASELINE_ACCOUNT_CLASS_UNSUPPORTED')
  assert.equal(assessBaselineContribution({ ...base, accountClass: 'SHARED' }).reasonCode, 'BASELINE_ACCOUNT_CLASS_UNSUPPORTED')
  assert.equal(assessBaselineContribution({
    ...base,
    review: { outcome: 'FALSE_POSITIVE', decidedAt: '2026-09-01T00:00:00.000Z', reviewerIds: [opaque('reviewer', 'reviewer-1')] },
  }).reasonCode, 'BASELINE_REVIEW_OUTCOME_INELIGIBLE')
})

test('baseline IDs use the same opaque privacy boundary', () => {
  assert.equal(assessBaselineContribution({ ...base, subjectId: 'person@example.com' }).reasonCode, 'BASELINE_INPUT_MALFORMED')
  assert.equal(assessBaselineContribution({ ...base, propertyKey: 'access_token:secret-value' }).reasonCode, 'BASELINE_INPUT_MALFORMED')
  assert.equal(assessBaselineContribution({
    ...base,
    review: { outcome: 'AUTHORIZED_BENIGN', decidedAt: '2026-09-01T00:00:00.000Z', reviewerIds: ['Bearer-secret'] },
  }).reasonCode, 'BASELINE_INPUT_MALFORMED')
  assert.equal(assessBaselineContribution({ ...base, accountClass: 'ADMIN' as BaselineContributionInput['accountClass'] }).reasonCode, 'BASELINE_INPUT_MALFORMED')
  assert.doesNotThrow(() => assessBaselineContribution(new Proxy(base, {
    get() { throw new Error('malformed input must not escape') },
  })))
})

test('platform persistence contract keeps scope and idempotency outside the pure decision', () => {
  const decision = assessBaselineContribution(base)
  const obligation = {
    contractVersion: BASELINE_PERSISTENCE_CONTRACT_VERSION,
    organizationId: opaque('org', 'org-a'),
    customerTenantId: opaque('tenant', 'tenant-a'),
    baselineVersion: 'baseline-v1',
    accountClassCatalogVersion: 'account-class-v1',
    contributionKey: decision.contributionKey!,
    sourceObservationIds: base.observations.map((entry) => entry.id),
    decisionAuditId: null,
    preFeedbackCheckpointId: null,
  } satisfies BaselinePersistenceObligation
  assert.equal(obligation.contractVersion, 'hawkview-identity-baseline-persistence/1')
  assert.equal('organizationId' in decision, false)
  assert.equal('customerTenantId' in decision, false)
})

test('baseline observations and reviews accept +5m and reject +5m+1ms', () => {
  const evaluatedAt = '2026-09-10T12:00:00.000Z'
  const atBoundary = {
    ...base,
    evaluatedAt,
    observations: [
      base.observations[0]!,
      { id: opaque('event', 'future-boundary'), observedAt: '2026-09-10T12:05:00.000Z', utcDay: '2026-09-10' },
    ],
  }
  assert.equal(assessBaselineContribution(atBoundary).status, 'ELIGIBLE')
  assert.equal(assessBaselineContribution({
    ...atBoundary,
    observations: [
      base.observations[0]!,
      { id: opaque('event', 'too-future'), observedAt: '2026-09-10T12:05:00.001Z', utcDay: '2026-09-10' },
    ],
  }).reasonCode, 'BASELINE_INPUT_FUTURE_DATED')

  assert.equal(assessBaselineContribution({
    ...atBoundary,
    review: { outcome: 'AUTHORIZED_BENIGN', decidedAt: '2026-09-10T12:05:00.000Z', reviewerIds: [opaque('reviewer', 'reviewer-1')] },
  }).reasonCode, 'BASELINE_REVIEW_COOLING')
  assert.equal(assessBaselineContribution({
    ...atBoundary,
    review: { outcome: 'AUTHORIZED_BENIGN', decidedAt: '2026-09-10T12:05:00.001Z', reviewerIds: [opaque('reviewer', 'reviewer-1')] },
  }).reasonCode, 'BASELINE_INPUT_FUTURE_DATED')
})

test('baseline rejects impossible calendar dates instead of accepting Date.parse rollover', () => {
  assert.equal(assessBaselineContribution({
    ...base,
    observations: [
      base.observations[0]!,
      { id: opaque('event', 'rollover'), observedAt: '2026-02-30T12:00:00.000Z', utcDay: '2026-02-30' },
    ],
  }).reasonCode, 'BASELINE_INPUT_MALFORMED')
})

test('baseline duplicate observation IDs must be byte-identical in either order', () => {
  const original = base.observations[0]!
  const conflicting = { ...original, observedAt: '2026-09-03T12:00:00.000Z', utcDay: '2026-09-03' }
  assert.equal(assessBaselineContribution({ ...base, observations: [original, original, base.observations[1]!] }).status, 'ELIGIBLE')
  assert.equal(assessBaselineContribution({ ...base, observations: [original, conflicting, base.observations[1]!] }).reasonCode, 'BASELINE_INPUT_MALFORMED')
  assert.equal(assessBaselineContribution({ ...base, observations: [conflicting, original, base.observations[1]!] }).reasonCode, 'BASELINE_INPUT_MALFORMED')
})

test('baseline binds observedAt to canonical UTC day even when the supplied label looks valid', () => {
  assert.equal(assessBaselineContribution({
    ...base,
    evaluatedAt: '2030-01-01T00:00:00.000Z',
    observations: [
      base.observations[0]!,
      { id: opaque('event', 'mismatched-day'), observedAt: '2030-01-01T00:00:00.000Z', utcDay: '2026-01-01' },
    ],
  }).reasonCode, 'BASELINE_INPUT_MALFORMED')
})
