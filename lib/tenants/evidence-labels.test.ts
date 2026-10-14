import assert from 'node:assert/strict'
import test from 'node:test'
import {
  enterpriseAppEnabled,
  licenseAuditOutcome,
  reportedText,
  reportedYesNo,
  sharePointDomainRestriction,
  sharePointStorageLimitMode,
} from './evidence-labels.ts'

test('license audit results distinguish success, failure, and absent or ambiguous evidence', () => {
  assert.deepEqual(licenseAuditOutcome('Success', null), {
    label: 'Successful', outcome: 'success',
  })
  assert.deepEqual(licenseAuditOutcome('unsuccessful', null), {
    label: 'unsuccessful', outcome: 'failure',
  })
  assert.deepEqual(licenseAuditOutcome(null, 'Failed'), {
    label: 'Failed', outcome: 'failure',
  })
  assert.deepEqual(licenseAuditOutcome('Pending', null), {
    label: 'Pending', outcome: 'unreported',
  })
  assert.deepEqual(licenseAuditOutcome(' ', null), {
    label: 'Result not reported', outcome: 'unreported',
  })
})

test('SharePoint settings do not infer an open posture from missing values', () => {
  assert.equal(sharePointDomainRestriction(null), 'Not available')
  assert.equal(sharePointDomainRestriction('none'), 'No domain restriction')
  assert.equal(sharePointDomainRestriction('allowList'), 'allowList')
  assert.equal(sharePointStorageLimitMode(null), 'Not available')
  assert.equal(sharePointStorageLimitMode(false), 'Manual')
  assert.equal(sharePointStorageLimitMode(true), 'Automatic')
})

test('blank provider labels remain unreported rather than inheriting a favorable default', () => {
  assert.equal(reportedText(' ', 'Status not reported'), 'Status not reported')
  assert.equal(reportedText('Granted by admin', 'Not reported'), 'Granted by admin')
})

test('enterprise application account state remains unknown without an explicit field', () => {
  assert.equal(enterpriseAppEnabled(undefined, undefined), null)
  assert.equal(enterpriseAppEnabled(undefined, 'Disabled'), false)
  assert.equal(enterpriseAppEnabled(false, 'Enabled'), false)
  assert.equal(enterpriseAppEnabled(undefined, 'Enabled'), true)
  assert.equal(reportedYesNo(undefined), 'Not reported')
  assert.equal(reportedYesNo(false), 'No')
})
