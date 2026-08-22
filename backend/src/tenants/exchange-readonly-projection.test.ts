import assert from 'node:assert/strict'
import test from 'node:test'
import {
  projectExchangeReadOnlyMailbox,
  projectExchangeReadOnlyPage,
} from './exchange-readonly-projection.js'

test('projects only documented Get-Mailbox read fields', () => {
  assert.deepEqual(projectExchangeReadOnlyMailbox({
    ExternalDirectoryObjectId: '11111111-2222-4333-8444-555555555555',
    UserPrincipalName: 'owner@example.com',
    PrimarySmtpAddress: 'owner@example.com',
    DisplayName: 'Owner',
    RecipientType: 'UserMailbox',
    RecipientTypeDetails: 'UserMailbox',
    MaxSendSize: '35 MB (36,700,160 bytes)',
    GrantSendOnBehalfToWithDisplayNames: [
      { DisplayName: 'Help Desk', PrimarySmtpAddress: 'helpdesk@example.com' },
      'delegate@example.com',
    ],
    RetentionPolicy: 'Must not cross the stable contract',
    ForwardingSmtpAddress: 'Must not cross the stable contract',
    Password: 'secret',
  }), {
    externalDirectoryObjectId: '11111111-2222-4333-8444-555555555555',
    userPrincipalName: 'owner@example.com',
    primarySmtpAddress: 'owner@example.com',
    displayName: 'Owner',
    recipientType: 'UserMailbox',
    recipientTypeDetails: 'UserMailbox',
    maxSendSize: '35 MB (36,700,160 bytes)',
    sendOnBehalfTo: ['Help Desk <helpdesk@example.com>', 'delegate@example.com'],
  })
})

test('fails closed for hostile, inherited, or oversized Exchange output', () => {
  const inherited = Object.create({ UserPrincipalName: 'other@example.com' })
  assert.equal(projectExchangeReadOnlyMailbox(inherited), null)
  assert.equal(projectExchangeReadOnlyMailbox({ UserPrincipalName: 'Bearer secret' }), null)
  assert.equal(projectExchangeReadOnlyMailbox({
    UserPrincipalName: 'owner@example.com',
    GrantSendOnBehalfTo: ['password=secret'],
  })?.sendOnBehalfTo, null)
  assert.equal(projectExchangeReadOnlyMailbox({
    UserPrincipalName: 'owner@example.com',
    GrantSendOnBehalfTo: new Array(257).fill('delegate@example.com'),
  })?.sendOnBehalfTo, null)
  assert.throws(() => projectExchangeReadOnlyPage(new Array(20_001).fill({})), /oversized/i)
})
