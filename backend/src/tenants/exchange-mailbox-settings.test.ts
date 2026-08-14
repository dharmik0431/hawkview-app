import assert from 'node:assert/strict'
import test from 'node:test'

import { graphMailboxPurposeToType } from './tenant-sync.service.js'

test('maps Microsoft Graph mailbox userPurpose values to HawkView mailbox types', () => {
  assert.equal(graphMailboxPurposeToType({ value: 'user' }), 'User')
  assert.equal(graphMailboxPurposeToType({ value: 'shared' }), 'Shared')
  assert.equal(graphMailboxPurposeToType({ value: 'room' }), 'Room')
  assert.equal(graphMailboxPurposeToType({ value: 'equipment' }), 'Equipment')
})

test('does not manufacture a mailbox type when Graph has not reported one', () => {
  assert.equal(graphMailboxPurposeToType(undefined), null)
  assert.equal(graphMailboxPurposeToType({ value: 'unknown' }), null)
})
