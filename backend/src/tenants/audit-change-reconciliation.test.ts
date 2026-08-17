import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveAuditReconciliationResources,
  deriveAuditReconciliationResourcesForChange,
} from './audit-change-reconciliation.js'

test('routes group membership changes to the groups collector', () => {
  assert.deepEqual(
    deriveAuditReconciliationResourcesForChange({
      activityDisplayName: 'Add member to group',
      category: 'GroupManagement',
    }),
    ['GROUPS']
  )
})

test('routes licence and domain changes to their independent collectors', () => {
  assert.deepEqual(
    deriveAuditReconciliationResources([
      { activityDisplayName: 'Assign license to user' },
      { activityDisplayName: 'Add verified domain' },
    ]),
    ['LICENSES', 'DOMAINS', 'DOMAIN_DNS_HEALTH']
  )
})

test('routes policy and application changes without triggering group refreshes', () => {
  assert.deepEqual(
    deriveAuditReconciliationResources([
      { activityDisplayName: 'Update conditional access policy' },
      { activityDisplayName: 'Add service principal' },
    ]),
    ['CONDITIONAL_ACCESS', 'SERVICE_PRINCIPALS']
  )
})

test('does not guess a collector for unrecognized audit activity', () => {
  assert.deepEqual(
    deriveAuditReconciliationResourcesForChange({
      activityDisplayName: 'Read directory audit logs',
    }),
    []
  )
})
