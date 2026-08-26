import assert from 'node:assert/strict'
import test from 'node:test'
import type { TenantBundle } from '../types/tenant-data.ts'
import { deriveTenantWorkspaceDisplay } from './tenant-workspace-state.ts'

function bundle(overrides: Partial<TenantBundle> = {}): TenantBundle {
  return {
    tenant: {
      id: 'tenant-1',
      status: 'healthy',
      lastSync: '2026-08-26T16:00:00.000Z',
      initialSync: {
        status: 'IN_PROGRESS',
        startedAt: '2026-08-26T17:00:00.000Z',
        pendingResources: [],
        retryingResources: ['SIGN_INS', 'M365_AUDIT'],
        actionRequiredResources: [],
      },
    },
    users: [],
    signIns: [],
    exchange: {},
    sharepoint: {},
    teams: {},
    sync: {
      signIns: {
        status: 'failed',
        lastSuccessfulAt: '2026-08-26T16:00:00.000Z',
        lastError: 'Microsoft returned a temporary service error.',
      },
      m365Audit: {
        status: 'failed',
        lastSuccessfulAt: null,
        lastError: 'Microsoft is preparing the audit subscription.',
      },
    },
    ...overrides,
  }
}

test('presents first-attempt collector retries as initial sync in progress', () => {
  const display = deriveTenantWorkspaceDisplay(bundle())

  assert.equal(display.state, 'syncing')
  assert.equal(display.stateLabel, 'Syncing')
  assert.equal(display.isInitialSync, true)
  assert.equal(display.issueCount, 0)
  assert.deepEqual(display.issues, [])
  assert.equal(display.lastSuccessfulSync, null)
})

test('does not hide a collector that requires administrator action', () => {
  const data = bundle()
  data.tenant.initialSync = {
    ...data.tenant.initialSync,
    status: 'ACTION_REQUIRED',
    retryingResources: [],
    actionRequiredResources: ['SIGN_INS'],
  }
  data.sync = {
    signIns: {
      status: 'failed',
      lastSuccessfulAt: null,
      lastError: 'Microsoft returned 403 Forbidden: admin consent required.',
    },
  }

  const display = deriveTenantWorkspaceDisplay(data)

  assert.equal(display.state, 'needs-attention')
  assert.equal(display.issueCount, 1)
  assert.equal(display.issues[0]?.title, 'Sign-ins access denied')
})

test('uses one customer-friendly delayed message instead of raw retry failures', () => {
  const data = bundle()
  data.tenant.initialSync = {
    ...data.tenant.initialSync,
    status: 'DELAYED',
  }

  const display = deriveTenantWorkspaceDisplay(data)

  assert.equal(display.state, 'partially-synchronized')
  assert.equal(display.isInitialSync, true)
  assert.equal(display.issueCount, 1)
  assert.equal(
    display.issues[0]?.title,
    'Initial synchronization is taking longer than expected'
  )
})
