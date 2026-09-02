import assert from 'node:assert/strict'
import test from 'node:test'
import { canResendInvitation } from './workspace-member-invitation.ts'

const organizationId = '00000000-0000-4000-8000-000000000001'

function member(overrides: Record<string, unknown> = {}) {
  return {
    membershipId: '00000000-0000-4000-8000-000000000002',
    status: 'ACTIVE',
    disabled: false,
    hasHawkViewAccount: false,
    ...overrides,
  }
}

test('active pending membership is eligible to receive a resent invitation', () => {
  assert.equal(canResendInvitation(member(), organizationId), true)
})

test('accepted HawkView account is not eligible for an invitation resend', () => {
  assert.equal(
    canResendInvitation(member({ hasHawkViewAccount: true }), organizationId),
    false,
  )
})

test('suspended membership is not eligible for an invitation resend', () => {
  assert.equal(
    canResendInvitation(member({ status: 'SUSPENDED' }), organizationId),
    false,
  )
})

test('disabled member is not eligible for an invitation resend', () => {
  assert.equal(
    canResendInvitation(member({ disabled: true }), organizationId),
    false,
  )
})

test('missing or malformed membership status fails closed', () => {
  assert.equal(
    canResendInvitation(member({ status: undefined }), organizationId),
    false,
  )
  assert.equal(
    canResendInvitation(member({ status: 'active' }), organizationId),
    false,
  )
  assert.equal(
    canResendInvitation(member({ disabled: undefined }), organizationId),
    false,
  )
  assert.equal(
    canResendInvitation(member({ hasHawkViewAccount: undefined }), organizationId),
    false,
  )
})

test('missing membership or organization identifiers fail closed', () => {
  assert.equal(
    canResendInvitation(member({ membershipId: undefined }), organizationId),
    false,
  )
  assert.equal(
    canResendInvitation(member({ membershipId: '' }), organizationId),
    false,
  )
  assert.equal(canResendInvitation(member(), ''), false)
  assert.equal(canResendInvitation(member(), undefined), false)
})

test('malformed membership or organization identifiers fail closed', () => {
  assert.equal(
    canResendInvitation(member({ membershipId: 'not-a-uuid' }), organizationId),
    false,
  )
  assert.equal(
    canResendInvitation(member({ membershipId: '../member' }), organizationId),
    false,
  )
  assert.equal(canResendInvitation(member(), 'not-a-uuid'), false)
  assert.equal(canResendInvitation(member(), '../organization'), false)
})

test('mixed bulk selections retain only eligible invitation membership IDs', () => {
  const members = [
    member({ membershipId: '00000000-0000-4000-8000-000000000011' }),
    member({
      membershipId: '00000000-0000-4000-8000-000000000012',
      hasHawkViewAccount: true,
    }),
    member({
      membershipId: '00000000-0000-4000-8000-000000000013',
      status: 'SUSPENDED',
    }),
    member({
      membershipId: '00000000-0000-4000-8000-000000000014',
      disabled: true,
    }),
    member({ membershipId: '00000000-0000-4000-8000-000000000015' }),
  ]

  const eligibleIds = members
    .filter((candidate) => canResendInvitation(candidate, organizationId))
    .map((candidate) => candidate.membershipId)

  assert.deepEqual(eligibleIds, [
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000015',
  ])
})
