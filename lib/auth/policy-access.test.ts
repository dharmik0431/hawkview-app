import assert from 'node:assert/strict'
import test from 'node:test'
import { canManagePolicies, manageablePolicyOrganizationIds } from './policy-access.ts'
import type { HawkViewSession } from './types'

function session(memberships: Array<{ role: string; status?: string; organizationStatus?: string; organizationId: string }>): HawkViewSession {
  return { user: { memberships: memberships.map((membership) => ({
    role: membership.role,
    status: membership.status ?? 'ACTIVE',
    organization: { id: membership.organizationId, status: membership.organizationStatus ?? 'ACTIVE' },
  })) } } as HawkViewSession
}

test('Policies excludes viewer, technician, inactive memberships and inactive workspaces', () => {
  const readonly = session([
    { role: 'MSP_VIEWER', organizationId: 'a' },
    { role: 'MSP_TECHNICIAN', organizationId: 'b' },
    { role: 'MSP_ADMIN', status: 'INVITED', organizationId: 'c' },
    { role: 'MSP_OWNER', organizationStatus: 'SUSPENDED', organizationId: 'd' },
  ])
  assert.equal(canManagePolicies(readonly), false)
  assert.deepEqual(Array.from(manageablePolicyOrganizationIds(readonly)), [])
})

test('Policies includes only actively administered workspaces for a mixed-role user', () => {
  const mixed = session([
    { role: 'MSP_VIEWER', organizationId: 'viewer-org' },
    { role: 'MSP_ADMIN', organizationId: 'admin-org' },
    { role: 'MSP_OWNER', organizationId: 'owner-org' },
  ])
  assert.equal(canManagePolicies(mixed), true)
  assert.deepEqual(Array.from(manageablePolicyOrganizationIds(mixed)), ['admin-org', 'owner-org'])
})
