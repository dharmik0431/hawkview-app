import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeOwnerOrganizations,
  WorkspaceOrganizationLoadGuard,
  workspaceOrganizationContext,
} from './workspace-organization-context.ts'

const ORG_A = '123e4567-e89b-42d3-a456-426614174000'
const ORG_B = '223e4567-e89b-42d3-a456-426614174000'

function session(order: string[]) {
  return {
    user: {
      id: 'user-1',
      email: 'owner@example.test',
      displayName: 'Owner',
      timeZone: null,
      dateFormat: 'yyyy-MM-dd',
      timeFormat: '12h' as const,
      platformRole: 'STANDARD_USER' as const,
      memberships: order.map((id) => ({
        id: `membership-${id}`,
        role: 'MSP_OWNER' as const,
        status: 'ACTIVE' as const,
        organization: {
          id,
          name: id === ORG_A ? 'Alpha MSP' : 'Beta MSP',
          slug: 'internal',
          status: 'ACTIVE',
        },
      })),
    },
  }
}

test('multi-organization context never depends on membership order', () => {
  const forward = activeOwnerOrganizations(session([ORG_A, ORG_B]))
  const reversed = activeOwnerOrganizations(session([ORG_B, ORG_A]))
  assert.deepEqual(reversed, forward)
  assert.equal(workspaceOrganizationContext(session([ORG_A, ORG_B]), null).state, 'selection-required')
  assert.equal(workspaceOrganizationContext(session([ORG_B, ORG_A]), null).state, 'selection-required')
})

test('an explicit authorized UUID selects exactly one organization', () => {
  const context = workspaceOrganizationContext(session([ORG_B, ORG_A]), ORG_B)
  assert.equal(context.state, 'selected')
  assert.equal(context.state === 'selected' && context.selected.id, ORG_B)

  assert.equal(
    workspaceOrganizationContext(session([ORG_A, ORG_B]), 'not-a-uuid').state,
    'selection-required'
  )
  assert.equal(
    workspaceOrganizationContext(
      session([ORG_A, ORG_B]),
      '323e4567-e89b-42d3-a456-426614174000'
    ).state,
    'selection-required'
  )
})

test('inactive organizations and non-owner memberships are unavailable', () => {
  const value = session([ORG_A])
  value.user.memberships[0].organization.status = 'SUSPENDED'
  assert.equal(workspaceOrganizationContext(value, ORG_A).state, 'unavailable')
})

test('a late selected-organization response cannot overwrite a newer refresh', async () => {
  const guard = new WorkspaceOrganizationLoadGuard()
  let releaseOld!: () => void
  const oldResponse = new Promise<void>((resolve) => {
    releaseOld = resolve
  })
  const oldTicket = guard.begin(ORG_A)
  const newerTicket = guard.begin(ORG_A)

  releaseOld()
  await oldResponse
  assert.equal(guard.isCurrent(oldTicket, ORG_A), false)
  assert.equal(guard.isCurrent(newerTicket, ORG_A), true)
  assert.equal(guard.isCurrent(newerTicket, ORG_B), false)

  guard.invalidate()
  assert.equal(guard.isCurrent(newerTicket, ORG_A), false)
})
