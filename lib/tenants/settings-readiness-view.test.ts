import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCollectionReadiness, synchronizationReadinessSummary } from './collection-readiness.ts'
import {
  settingsConnectionHealth,
  settingsOverallHealth,
  settingsPriorityAttentionItems,
  settingsSynchronizationAttention,
  settingsSynchronizationStateLabel,
  settingsSynchronizationRows,
} from './settings-readiness-view.ts'

test('does not infer a healthy connection when connection status is absent', () => {
  assert.deepEqual(settingsConnectionHealth(undefined), { state: 'UNKNOWN', label: 'Unknown' })
  assert.deepEqual(settingsConnectionHealth('connected'), { state: 'CONNECTED', label: 'Connected' })
  assert.deepEqual(settingsConnectionHealth('revoked'), { state: 'DISCONNECTED', label: 'Disconnected' })
})

const readinessPayload = {
  version: 1,
  overallState: 'FAILED_TRANSIENT',
  evaluatedAt: '2026-08-19T15:00:00.000Z',
  workloads: [
    {
      key: 'sharepoint_onedrive',
      workload: 'SharePoint and OneDrive',
      state: 'FAILED_TRANSIENT',
      configuredCapability: 'CONFIGURED',
      permissionStatus: 'CONFIRMED',
      requiredPermissions: ['Sites.Read.All'],
      lastAttemptAt: '2026-08-19T14:59:00.000Z',
      lastSuccessfulAt: '2026-08-18T14:59:00.000Z',
      freshness: 'STALE',
      reasonCode: 'UPSTREAM_FAILURE',
      reason: 'Microsoft returned a transient failure.',
      remediation: 'Wait for the next eligible collection.',
      components: [],
    },
    {
      key: 'm365_unified_audit',
      workload: 'Microsoft 365 Unified Audit',
      state: 'READY',
      configuredCapability: 'CONFIGURED',
      permissionStatus: 'CONFIRMED',
      requiredPermissions: ['ActivityFeed.Read'],
      lastAttemptAt: '2026-08-19T14:58:00.000Z',
      lastSuccessfulAt: '2026-08-19T14:58:00.000Z',
      freshness: 'CURRENT',
      reasonCode: null,
      reason: null,
      remediation: 'No action required.',
      components: [],
    },
  ],
}

test('uses the backend readiness keys and states without synthetic READY rows', () => {
  const readiness = normalizeCollectionReadiness(readinessPayload)
  const rows = settingsSynchronizationRows(readiness)
  assert.deepEqual(rows.map((row) => row.key), ['sharepoint_onedrive', 'm365_unified_audit'])
  assert.equal(rows[0]?.status, 'FAILED_TRANSIENT')
  assert.equal(rows.some((row) => row.key === 'SHAREPOINT_SITES'), false)
})

test('distinguishes a transient failure from a processing backlog', () => {
  const readiness = normalizeCollectionReadiness({
    ...readinessPayload,
    workloads: [
      readinessPayload.workloads[0],
      {
        ...readinessPayload.workloads[1],
        state: 'BACKLOGGED',
        reasonCode: 'COLLECTION_BACKLOGGED',
        reason: 'Known audit content remains queued for bounded processing.',
      },
    ],
  })
  const attention = settingsSynchronizationAttention(settingsSynchronizationRows(readiness))
  assert.deepEqual(attention, {
    total: 2,
    failed: 1,
    blocked: 0,
    backlogged: 1,
    stale: 0,
    other: 0,
    label: '1 temporary failure · 1 processing backlog',
  })
})

test('uses user-facing synchronization state labels without changing state truth', () => {
  assert.equal(settingsSynchronizationStateLabel('FAILED_TRANSIENT'), 'Temporary Collection Failure')
  assert.equal(settingsSynchronizationStateLabel('BACKLOGGED'), 'Processing Backlog')
  assert.equal(settingsSynchronizationStateLabel('BLOCKED_PERMISSION'), 'Permission Blocked')
})

test('fails closed when readiness data is absent', () => {
  assert.deepEqual(settingsSynchronizationRows(null), [])
  assert.deepEqual(settingsOverallHealth(null), {
    state: 'UNVERIFIED',
    label: 'Collection unverified',
  })
})

test('does not call collection healthy while a required workload is failing', () => {
  const readiness = normalizeCollectionReadiness(readinessPayload)
  assert.deepEqual(settingsOverallHealth(synchronizationReadinessSummary(readiness)), {
    state: 'NEEDS_ATTENTION',
    label: 'Collection needs attention',
  })
})

test('keeps successful and informational readiness out of Priority attention', () => {
  const readiness = normalizeCollectionReadiness({
    ...readinessPayload,
    overallState: 'PARTIAL',
    workloads: ['READY', 'INITIALIZING', 'PARTIAL', 'UNVERIFIED', 'NOT_LICENSED', 'UNSUPPORTED'].map((state, index) => ({
      ...readinessPayload.workloads[1], key: `neutral-${index}`, state,
    })),
  })
  const summary = synchronizationReadinessSummary(readiness)
  assert.equal(summary?.attentionWorkloads, 0)
  assert.deepEqual(settingsSynchronizationAttention(settingsSynchronizationRows(readiness)), {
    total: 0, failed: 0, blocked: 0, backlogged: 0, stale: 0, other: 0, label: 'None',
  })
  assert.deepEqual(settingsOverallHealth(summary), {
    state: 'UNVERIFIED', label: 'Collection status informational',
  })
})

test('deduplicates actionable Unified Audit readiness and resource health by canonical workload key', () => {
  const readiness = normalizeCollectionReadiness({
    ...readinessPayload,
    workloads: [{
      ...readinessPayload.workloads[1],
      key: 'm365_unified_audit',
      state: 'FAILED_TRANSIENT',
      reasonCode: 'UPSTREAM_FAILURE',
      reason: 'The selected audit workload failed.',
    }],
  })
  const items = settingsPriorityAttentionItems(readiness, {
    classification: 'FAILED_TRANSIENT',
    message: 'The audit resource health also reports a failure.',
    lastAttemptAt: '2026-08-19T14:58:00.000Z',
  })

  assert.equal(items.length, 1)
  assert.equal(items[0]?.id, 'collection-m365_unified_audit')
  assert.equal(items[0]?.targetRowId, 'row-m365_unified_audit')
})
