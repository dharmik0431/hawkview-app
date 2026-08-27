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
  assert.equal(event.failureReason, undefined)
  assert.equal(event.additionalDetails, undefined)
  assert.equal(event.userAgent, undefined)
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
    { name: 'Display Name' },
    { name: 'Nested' },
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

test('exact multiword and alias payloads fail closed across diagnostics and property values', () => {
  const payloads = [
    'password=top secret phrase',
    'client_secret: alpha beta gamma',
    'token=GENERICTOKENSECRET',
    'code=OAUTHCODESECRET',
    'sig=SIGNATURESECRET',
    '{"access_token":["ARRAYSECRET1","ARRAYSECRET2"]}',
  ]
  const secretFragments = [
    'top secret phrase',
    'secret phrase',
    'alpha beta gamma',
    'beta gamma',
    'GENERICTOKENSECRET',
    'OAUTHCODESECRET',
    'SIGNATURESECRET',
    'ARRAYSECRET1',
    'ARRAYSECRET2',
  ]

  payloads.forEach((payload, index) => {
    const signIn = normalizeSignInEvent(
      { failureReason: payload, additionalDetails: payload },
      { tenantId: 'tenant-1', index },
    )
    const audit = normalizeAuditEvent(
      {
        resultReason: payload,
        targetResources: [
          {
            displayName: 'Target',
            modifiedProperties: [
              { name: 'Display Name', oldValue: payload, newValue: payload },
            ],
          },
        ],
      },
      { tenantId: 'tenant-1', index },
    )

    assert.equal(signIn.failureReason, undefined)
    assert.equal(signIn.additionalDetails, undefined)
    assert.equal(audit.resultReason, undefined)
    assert.deepEqual(audit.modifiedProperties, [{ name: 'Display Name' }])
    const serialized = JSON.stringify({ signIn, audit })
    secretFragments.forEach((fragment) => {
      assert.equal(serialized.includes(fragment), false)
    })
  })
})

test('safe Microsoft diagnostics retain only bounded message and sanitized host/path', () => {
  const event = normalizeSignInEvent(
    {
      errorCode: 'AADSTS50011',
      failureReason:
        'AADSTS50011: Redirect URI mismatch at https://user:pass@login.microsoftonline.com/common/path%20name?request=unsafe#fragment',
    },
    { tenantId: 'opaque-tenant-reference', index: 10 },
  )

  assert.equal(event.errorCode, 'AADSTS50011')
  assert.match(event.failureReason ?? '', /https:\/\/login\.microsoftonline\.com\/common\/path%20name/)
  assert.doesNotMatch(event.failureReason ?? '', /user:pass|request=unsafe|fragment/)
  assert.equal(event.tenantId, 'opaque-tenant-reference')
})

test('percent-encoded credentials, malformed encodings, and encoded JSON fail closed', () => {
  const payloads = [
    'password%3DENCODEDSECRET',
    'password%253DDOUBLESECRET',
    'client%5Fsecret%3DENCODEDCLIENTSECRET',
    'password%3GMALFORMEDSECRET',
    'client_secret%E0%A4%AMALFORMEDUTF8SECRET',
    '%7B%22access_token%22%3A%5B%22JSONARRAYSECRET1%22%5D%7D',
    '%257B%2522access_token%2522%253A%255B%2522JSONARRAYSECRET2%2522%255D%257D',
  ]
  const secretFragments = [
    'ENCODEDSECRET',
    'DOUBLESECRET',
    'ENCODEDCLIENTSECRET',
    'MALFORMEDSECRET',
    'MALFORMEDUTF8SECRET',
    'JSONARRAYSECRET1',
    'JSONARRAYSECRET2',
  ]

  payloads.forEach((payload, index) => {
    const signIn = normalizeSignInEvent(
      { failureReason: payload, additionalDetails: payload },
      { tenantId: 'tenant-1', index },
    )
    const audit = normalizeAuditEvent(
      { resultReason: payload },
      { tenantId: 'tenant-1', index },
    )

    assert.equal(signIn.failureReason, undefined)
    assert.equal(signIn.additionalDetails, undefined)
    assert.equal(audit.resultReason, undefined)
    const serialized = JSON.stringify({ signIn, audit })
    assert.equal(serialized.includes(payload), false)
    secretFragments.forEach((fragment) => {
      assert.equal(serialized.includes(fragment), false)
    })
  })
})
