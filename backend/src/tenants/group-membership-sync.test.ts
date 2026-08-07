import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectGroupMemberships,
  collectGroupOwners,
  uniquePrincipalLabels,
} from './group-membership-sync.js'

test('deduplicates principal labels and uses stable fallbacks', () => {
  assert.deepEqual(
    uniquePrincipalLabels([
      { id: 'owner-1', displayName: 'Dharmik Pandya' },
      { id: 'owner-2', displayName: ' dharmik pandya ' },
      { id: 'owner-3', userPrincipalName: 'admin@example.com' },
      { microsoftUserId: 'user-4' },
      {},
    ]),
    ['Dharmik Pandya', 'admin@example.com', 'user-4']
  )
})

test('collects successful memberships and removes duplicate user IDs', async () => {
  const result = await collectGroupMemberships(
    [
      { id: 'group-1', displayName: 'Operations' },
      { id: 'group-2', displayName: 'Security' },
    ],
    async (group) =>
      group.id === 'group-1' ? ['user-1', 'user-1', 'user-2'] : ['user-3']
  )

  assert.deepEqual(result.memberIdsByGroupId.get('group-1'), [
    'user-1',
    'user-2',
  ])
  assert.deepEqual(result.memberIdsByGroupId.get('group-2'), ['user-3'])
  assert.deepEqual(result.failures, [])
})

test('records a failed group without discarding successful groups', async () => {
  const result = await collectGroupMemberships(
    [
      { id: 'visible', displayName: 'Visible group' },
      { id: 'hidden', displayName: 'Hidden group' },
    ],
    async (group) => {
      if (group.id === 'hidden') {
        throw new Error('Microsoft Graph returned 403')
      }
      return ['user-1']
    }
  )

  assert.deepEqual(result.memberIdsByGroupId.get('visible'), ['user-1'])
  assert.equal(result.memberIdsByGroupId.has('hidden'), false)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]?.groupId, 'hidden')
  assert.equal(result.failures[0]?.groupName, 'Hidden group')
})

test('keeps a successful empty membership result distinct from a failure', async () => {
  const result = await collectGroupMemberships(
    [{ id: 'empty-group' }],
    async () => []
  )

  assert.equal(result.memberIdsByGroupId.has('empty-group'), true)
  assert.deepEqual(result.memberIdsByGroupId.get('empty-group'), [])
  assert.deepEqual(result.failures, [])
})

test('keeps group inventory usable when an optional owner lookup is denied', async () => {
  const result = await collectGroupOwners(
    [
      { id: 'visible', displayName: 'Visible group' },
      { id: 'restricted', displayName: 'Restricted group' },
    ],
    async (group) => {
      if (group.id === 'restricted') {
        throw new Error('Microsoft Graph returned 403')
      }
      return [{ id: 'owner-1', displayName: 'Alex Owner' }]
    }
  )

  assert.deepEqual(result.ownersByGroupId.get('visible'), [
    { id: 'owner-1', displayName: 'Alex Owner' },
  ])
  assert.equal(result.ownersByGroupId.has('restricted'), false)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]?.groupId, 'restricted')
})
