import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasIncompleteActivityEvidence,
  normalizeAuditEvent,
  normalizeSignInEvent,
} from './normalize.ts'

test('missing sign-in evidence remains not reported and never becomes success or a fake identity', () => {
  const first = normalizeSignInEvent({}, { tenantId: 'tenant-1', index: 0 })
  const second = normalizeSignInEvent({}, { tenantId: 'tenant-1', index: 0 })

  assert.equal(first.createdAt, '')
  assert.equal(first.status, 'Not reported')
  assert.equal(first.userPrincipalName, 'Not reported')
  assert.equal(first.userDisplayName, 'Not reported')
  assert.equal(first.appDisplayName, 'Not reported')
  assert.equal(first.conditionalAccess, 'Not reported')
  assert.equal(first.id, second.id)
  assert.match(first.id, /^signin-unreported-id-/)
})

test('missing audit evidence remains not reported and gets a stable local key', () => {
  const event = normalizeAuditEvent({}, { tenantId: 'tenant-2', index: 3 })

  assert.equal(event.createdAt, '')
  assert.equal(event.result, 'Not reported')
  assert.equal(event.activity, 'Not reported')
  assert.equal(event.actor, 'Not reported')
  assert.equal(event.actorType, 'Not reported')
  assert.match(event.id, /^audit-unreported-id-/)
})

test('reported Microsoft evidence is preserved without inference', () => {
  const signIn = normalizeSignInEvent(
    {
      id: 'signin-id',
      createdAt: '2026-08-27T12:00:00.000Z',
      userPrincipalName: 'person@example.com',
      status: 'failure',
      conditionalAccess: 'notApplied',
    },
    { tenantId: 'tenant-1', index: 0 },
  )
  const audit = normalizeAuditEvent(
    {
      id: 'audit-id',
      createdAt: '2026-08-27T12:00:00.000Z',
      activityDisplayName: 'Update user',
      result: 'success',
      initiatedBy: { user: { displayName: 'Admin' } },
    },
    { tenantId: 'tenant-1', index: 0 },
  )

  assert.equal(signIn.status, 'Failure')
  assert.equal(signIn.conditionalAccess, 'Not Applied')
  assert.equal(audit.result, 'success')
  assert.equal(hasIncompleteActivityEvidence([signIn], [audit]), false)
})

test('display evidence is bounded and strips control characters', () => {
  const policies = Array.from({ length: 80 }, (_, index) => `Policy ${index}`)
  const event = normalizeSignInEvent(
    {
      userPrincipalName: 'person@example.com\u0000hidden',
      appliedConditionalAccessPolicies: policies,
    },
    { tenantId: 'tenant-1', index: 1 },
  )

  assert.equal(event.userPrincipalName, 'person@example.com hidden')
  assert.equal(event.appliedCaPolicies?.length, 50)
})
