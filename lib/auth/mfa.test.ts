import assert from 'node:assert/strict'
import test from 'node:test'
import { mfaAccessStatus } from './mfa.ts'

test('requires enrollment when no verified factor exists', () => {
  assert.equal(mfaAccessStatus('aal1', 'aal1', 0), 'enrollment-required')
})

test('requires a challenge after primary authentication', () => {
  assert.equal(mfaAccessStatus('aal1', 'aal2', 1), 'challenge-required')
})

test('allows access only for a current and future AAL2 session', () => {
  assert.equal(mfaAccessStatus('aal2', 'aal2', 1), 'verified')
})

test('fails closed for a stale AAL2 token after factor removal', () => {
  assert.equal(mfaAccessStatus('aal2', 'aal1', 0), 'enrollment-required')
})
