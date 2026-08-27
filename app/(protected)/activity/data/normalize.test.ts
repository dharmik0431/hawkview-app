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
  assert.equal(first.rowKey, second.rowKey)
  assert.match(first.rowKey, /^row-signin-/)
  assert.equal(first.eventId, undefined)
})

test('missing audit evidence remains not reported and gets a stable local key', () => {
  const event = normalizeAuditEvent({}, { tenantId: 'tenant-2', index: 3 })

  assert.equal(event.createdAt, '')
  assert.equal(event.result, 'Not reported')
  assert.equal(event.activity, 'Not reported')
  assert.equal(event.actor, 'Not reported')
  assert.equal(event.actorType, 'Not reported')
  assert.match(event.rowKey, /^row-audit-/)
  assert.equal(event.eventId, undefined)
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
  assert.equal(signIn.eventId, 'signin-id')
  assert.equal(audit.eventId, 'audit-id')
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

test('hostile sign-in diagnostics are scalar-only, redacted, bounded, and URL-safe', () => {
  const event = normalizeSignInEvent(
    {
      failureReason:
        'password=hunter2 access_token=token-value Bearer abc.def.ghi https://user:pass@example.com/path?client_secret=secret#fragment',
      additionalDetails: { nested: { client_secret: 'nested-secret' } },
      userAgent: `safe\u0000value ${'x'.repeat(4_000)}`,
      password: 'top-level-secret',
      access_token: 'top-level-token',
      arbitraryDebug: { client_secret: 'debug-secret' },
    },
    { tenantId: 'tenant-1', index: 1 },
  )

  const serialized = JSON.stringify(event)
  assert.doesNotMatch(serialized, /hunter2|token-value|top-level-secret|top-level-token|nested-secret|debug-secret|user:pass|client_secret=secret/)
  assert.match(event.failureReason ?? '', /password=\[Redacted\]/)
  assert.match(event.failureReason ?? '', /access_token=\[Redacted\]/)
  assert.match(event.failureReason ?? '', /https:\/\/example\.com\/path/)
  assert.equal(event.additionalDetails, undefined)
  assert.equal(event.userAgent?.includes('\u0000'), false)
  assert.equal(event.userAgent?.length, 2_000)
  assert.equal('raw' in event, false)
})

test('audit targets and modified properties use a closed safe shape', () => {
  const event = normalizeAuditEvent(
    {
      targetResources: [
        {
          displayName: 'Safe target',
          id: 'target-id',
          type: 'User',
          password: 'target-password',
          arbitraryDebug: { access_token: 'nested-token' },
          modifiedProperties: [
            { name: 'client_secret', oldValue: 'old-secret', newValue: 'new-secret' },
            { name: 'Display Name', oldValue: '=old', newValue: '+new' },
            { name: '__proto__', oldValue: 'unsafe', newValue: 'unsafe' },
            { name: 'Nested', oldValue: { password: 'nested' }, newValue: ['secret'] },
          ],
        },
      ],
    },
    { tenantId: 'tenant-1', index: 2 },
  )

  assert.deepEqual(event.targetResources, [
    { displayName: 'Safe target', userPrincipalName: undefined, id: 'target-id', type: 'User' },
  ])
  assert.deepEqual(event.modifiedProperties, [
    { name: 'client_secret', oldValue: '[Redacted]', newValue: '[Redacted]' },
    { name: 'Display Name', oldValue: '=old', newValue: '+new' },
    { name: 'Nested', oldValue: undefined, newValue: undefined },
  ])
  const serialized = JSON.stringify(event)
  assert.doesNotMatch(serialized, /target-password|nested-token|old-secret|new-secret|"raw"/)
})

test('prototype-backed objects are not treated as reported event evidence', () => {
  const inherited = Object.create({
    id: 'inherited-id',
    result: 'success',
    password: 'prototype-secret',
  })
  const event = normalizeAuditEvent(inherited, { tenantId: 'tenant-1', index: 4 })

  assert.equal(event.eventId, undefined)
  assert.equal(event.result, 'Not reported')
  assert.doesNotMatch(JSON.stringify(event), /inherited-id|prototype-secret/)
})
