import assert from 'node:assert/strict'
import test from 'node:test'
import {
  accountRecoveryRequestedNotice,
  accountRecoveryUnavailableReason,
  canSendAccountRecovery,
  type RecoveryCandidate,
} from './workspace-member-recovery.ts'

const org = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

/** The one state the action exists for: active, not disabled, not accepted. */
const eligible: RecoveryCandidate = {
  membershipId: 'membership-four',
  status: 'ACTIVE',
  disabled: false,
  hasHawkViewAccount: false,
}

test('the pending member the action exists for is eligible', () => {
  assert.equal(canSendAccountRecovery(eligible, org), true)
  assert.equal(accountRecoveryUnavailableReason(eligible, org), null)
})

test('it is never offered where it could not be invoked', () => {
  // No membership id means no callable endpoint. This is the case Codex ruled
  // out explicitly: a missing local membership cannot be repaired by pointing an
  // administrator at an action they cannot run.
  assert.equal(canSendAccountRecovery({ ...eligible, membershipId: undefined }, org), false)
  assert.equal(canSendAccountRecovery(eligible, null), false)
})

test('it mirrors each server refusal rather than approximating it', () => {
  assert.equal(canSendAccountRecovery({ ...eligible, hasHawkViewAccount: true }, org), false)
  assert.equal(canSendAccountRecovery({ ...eligible, disabled: true }, org), false)
  assert.equal(canSendAccountRecovery({ ...eligible, status: 'SUSPENDED' }, org), false)
})

test('unknown account state is not eligible', () => {
  // `undefined` is missing data, not a pending member. An action offered on
  // incomplete data only produces a server refusal the administrator cannot act on.
  assert.equal(canSendAccountRecovery({ ...eligible, hasHawkViewAccount: undefined }, org), false)
})

test('every refusal gives a reason, and each names something actionable', () => {
  const cases: Array<[RecoveryCandidate, RegExp]> = [
    [{ ...eligible, hasHawkViewAccount: true }, /password reset instead/i],
    [{ ...eligible, disabled: true }, /disabled/i],
    [{ ...eligible, status: 'SUSPENDED' }, /not active/i],
    [{ ...eligible, membershipId: undefined }, /unavailable/i],
  ]
  for (const [member, pattern] of cases) {
    const reason = accountRecoveryUnavailableReason(member, org)
    assert.equal(typeof reason, 'string')
    assert.match(String(reason), pattern)
  }
})

test('the completed-request notice never claims delivery and never invites a repeat', () => {
  const notice = accountRecoveryRequestedNotice('pending@example.com')
  assert.match(notice, /pending@example\.com/)
  assert.match(notice, /cannot confirm delivery/i)
  // The exact failure this whole incident is about: asserting an email went out.
  assert.doesNotMatch(notice, /\bwas sent\b|\bhas been sent\b|\bdelivered\b/i)
  // Repeating is what exhausted the provider's sending limit.
  assert.doesNotMatch(notice, /try again now|resend|send again/i)
  assert.match(notice, /wait a few minutes/i)
})

test('no message leaks provider or credential detail', () => {
  const messages = [
    accountRecoveryRequestedNotice('pending@example.com'),
    ...[
      { ...eligible, hasHawkViewAccount: true },
      { ...eligible, disabled: true },
      { ...eligible, status: 'SUSPENDED' as const },
    ].map(member => String(accountRecoveryUnavailableReason(member, org))),
  ]
  for (const message of messages) {
    assert.doesNotMatch(message, /supabase|gotrue|email_exists|service.role|recover\b/i)
  }
})
