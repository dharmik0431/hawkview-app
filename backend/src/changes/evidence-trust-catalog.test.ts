import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyEvidenceTrust, isReadOnlyEvidenceOperation } from './evidence-trust-catalog.js'

test('review suffixes are not read verbs and still require an approved change shape', () => {
  for (const operation of [
    'Create access review', 'Update access review', 'Delete access review',
    'Start access review', 'Stop access review', 'Reset access review',
    'CreateAccessReview', 'Update_access_review', 'Delete-access-review',
    'Create access reviewAsync', 'UpdateAccessReviewAsync',
  ]) {
    assert.equal(isReadOnlyEvidenceOperation(operation), false, operation)
    assert.equal(classifyEvidenceTrust({ source: 'DIRECTORY_AUDIT', operation }).visibility, 'HIDDEN', operation)
  }
})

test('standalone read verbs and separated or camel-case async suffixes remain hidden', () => {
  for (const operation of [
    'View access review', 'ViewAccessReview', 'View_access_review',
    'Get user', 'List users', 'Read report', 'Export users', 'Search users',
    'UserGet', 'UserGetAsync', 'User_GetAsync', 'User-List-Async',
    'User.Read.Async', 'UserReportAsync', 'UserExportAsync',
    'UserViewAsync', 'UserSearchAsync', 'User getasync',
  ]) {
    assert.equal(isReadOnlyEvidenceOperation(operation), true, operation)
    assert.equal(classifyEvidenceTrust({
      source: 'DIRECTORY_AUDIT', operation, operationType: 'Update',
      category: 'Policy', targetResourceTypes: ['conditionalAccessPolicy'], result: 'success',
    }).visibility, 'HIDDEN', operation)
  }
  assert.equal(isReadOnlyEvidenceOperation('Create access review', 'Read'), true)
})

test('embedded suffix letters do not manufacture a read verb without a lexical boundary', () => {
  for (const operation of ['Preview', 'Thread', 'Target', 'usergetasync', 'USERGETASYNC']) {
    assert.equal(isReadOnlyEvidenceOperation(operation), false, operation)
    assert.equal(classifyEvidenceTrust({ source: 'DIRECTORY_AUDIT', operation }).visibility, 'HIDDEN', operation)
  }
})


test('read boundary repair does not enable exact-name bypasses or requested role grants', () => {
  for (const input of [
    { source: 'DIRECTORY_AUDIT', operation: 'Add user', category: null, operationType: null, result: null, targetResourceTypes: [] },
    { source: 'DIRECTORY_AUDIT', operation: 'Add member to role in PIM requested (timebound)', category: 'RoleManagement', operationType: 'Assign', result: 'success', targetResourceTypes: ['User'], afterState: { 'Role.DisplayName': 'Global Administrator' } },
    { source: 'DIRECTORY_AUDIT', operation: 'Invite external user', category: 'DeviceManagement', operationType: 'Delete', result: 'success', targetResourceTypes: ['Device'] },
    { source: 'DIRECTORY_AUDIT', operation: 'Invite external user', category: 'UserManagement', operationType: 'Add', result: 'failed', targetResourceTypes: ['User'] },
  ]) assert.equal(classifyEvidenceTrust(input).visibility, 'HIDDEN', input.operation)
})

// A synthetic shape exercises the existing downstream security-control rule;
// it does not assert that Microsoft emits this operation name.
const securityReview = {
  source: 'DIRECTORY_AUDIT', operation: 'Update conditional access review',
  operationType: 'Update', category: 'Policy',
  targetResourceTypes: ['conditionalAccessPolicy'], result: 'success',
}

test('qualified review reaches the existing security-control rule', () => {
  const result = classifyEvidenceTrust(securityReview)
  assert.equal(result.visibility, 'PRIMARY')
  assert.equal(result.catalogId, 'entra.security-control')
  assert.equal(result.classification, 'security_control_change')
})

for (const [label, override] of Object.entries({
  'unknown source': { source: 'unknown' },
  'missing source': { source: null },
  'missing operation type': { operationType: null },
  'nonmutation operation type': { operationType: 'Execute' },
  'explicit read operation type': { operationType: 'Read' },
  'missing targets': { targetResourceTypes: [] },
  'wrong target': { targetResourceTypes: ['Device'] },
  'failed result': { result: 'failed' },
  'cancelled result': { result: 'cancelled' },
  'genuine view verb': { operation: 'View conditional access review' },
})) {
  test(`review boundary preserves downstream veto: ${label}`, () => {
    assert.equal(classifyEvidenceTrust({ ...securityReview, ...override }).visibility, 'HIDDEN')
  })
}

test('joined lowercase viewasync suffix still protects a genuine read', () => {
  // Unlike ViewAsync, normalization does not create a standalone view token.
  // This assertion therefore exercises the repaired suffix rule itself.
  assert.equal(isReadOnlyEvidenceOperation('User viewasync'), true)
  assert.equal(classifyEvidenceTrust({ ...securityReview, operation: 'Conditional access viewasync' }).visibility, 'HIDDEN')
})

test('existing role and invitation positives remain supported with complete evidence', () => {
  for (const input of [
    { source: 'DIRECTORY_AUDIT', operation: 'Add member to role', category: 'RoleManagement', operationType: 'Assign', result: 'success', targetResourceTypes: ['User'], afterState: { 'Role.DisplayName': 'Global Administrator' } },
    { source: 'DIRECTORY_AUDIT', operation: 'Invite external user', category: 'UserManagement', operationType: 'Add', result: 'success', targetResourceTypes: ['User'] },
  ]) assert.equal(classifyEvidenceTrust(input).visibility, 'PRIMARY', input.operation)
})
