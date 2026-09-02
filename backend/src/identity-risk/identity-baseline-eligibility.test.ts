import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BASELINE_PERSISTENCE_CONTRACT_VERSION,
  assessBaselineContribution,
  type BaselineContributionInput,
  type BaselinePersistenceObligation,
} from './identity-baseline-eligibility.js'

const base: BaselineContributionInput = {
  subjectId: 'user-1',
  propertyKey: 'device:opaque-device-1',
  accountClass: 'HUMAN',
  evaluatedAt: '2026-09-10T12:00:00.000Z',
  observations: [
    { id: 'event-1', observedAt: '2026-09-01T12:00:00.000Z', utcDay: '2026-09-01' },
    { id: 'event-2', observedAt: '2026-09-02T12:00:00.000Z', utcDay: '2026-09-02' },
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
    review: { outcome: 'AUTHORIZED_BENIGN', decidedAt: '2026-09-02T12:00:00.000Z', reviewerIds: ['reviewer-1'] },
  })
  assert.deepEqual([pending.status, pending.reasonCode], ['PENDING', 'BASELINE_REVIEW_COOLING'])
  const eligible = assessBaselineContribution({
    ...base,
    evaluatedAt: '2026-09-03T12:00:00.000Z',
    review: { outcome: 'AUTHORIZED_BENIGN', decidedAt: '2026-09-02T12:00:00.000Z', reviewerIds: ['reviewer-1'] },
  })
  assert.deepEqual([eligible.status, eligible.reasonCode], ['ELIGIBLE', 'BASELINE_REVIEW_ELIGIBLE'])
})

test('sensitive classes require two distinct reviewers and seven-day cooling', () => {
  const oneReviewer = assessBaselineContribution({
    ...base,
    accountClass: 'PRIVILEGED_HUMAN',
    review: { outcome: 'AUTHORIZED_BENIGN', decidedAt: '2026-09-01T00:00:00.000Z', reviewerIds: ['same', 'same'] },
  })
  assert.equal(oneReviewer.reasonCode, 'BASELINE_REVIEW_DUAL_APPROVAL_REQUIRED')
  const eligible = assessBaselineContribution({
    ...base,
    accountClass: 'PRIVILEGED_HUMAN',
    evaluatedAt: '2026-09-08T00:00:00.000Z',
    review: { outcome: 'AUTHORIZED_BENIGN', decidedAt: '2026-09-01T00:00:00.000Z', reviewerIds: ['reviewer-1', 'reviewer-2'] },
  })
  assert.equal(eligible.status, 'ELIGIBLE')
})

test('break-glass and non-authorized-benign outcomes never enter ordinary baselines', () => {
  assert.equal(assessBaselineContribution({ ...base, accountClass: 'BREAK_GLASS' }).reasonCode, 'BASELINE_ACCOUNT_CLASS_UNSUPPORTED')
  assert.equal(assessBaselineContribution({ ...base, accountClass: 'SERVICE' }).reasonCode, 'BASELINE_ACCOUNT_CLASS_UNSUPPORTED')
  assert.equal(assessBaselineContribution({ ...base, accountClass: 'SHARED' }).reasonCode, 'BASELINE_ACCOUNT_CLASS_UNSUPPORTED')
  assert.equal(assessBaselineContribution({
    ...base,
    review: { outcome: 'FALSE_POSITIVE', decidedAt: '2026-09-01T00:00:00.000Z', reviewerIds: ['reviewer-1'] },
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
    organizationId: 'org-a',
    customerTenantId: 'tenant-a',
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
