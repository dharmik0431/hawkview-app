import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCollectionReadiness, readinessDiagnostic, readinessLabel, readinessRemediation, synchronizationReadinessSummary } from './collection-readiness.ts'

const valid = {
  version: 1,
  overallState: 'PARTIAL',
  evaluatedAt: '2026-08-18T12:00:00.000Z',
  workloads: [{
    key: 'm365_unified_audit', workload: 'Microsoft 365 Unified Audit', state: 'PARTIAL', configuredCapability: 'CONFIGURED', permissionStatus: 'CONFIRMED', requiredPermissions: ['ActivityFeed.Read'],
    lastAttemptAt: '2026-08-18T12:00:00.000Z', lastSuccessfulAt: '2026-08-18T11:55:00.000Z', freshness: 'CURRENT',
    reason: 'One content type is provisioning.', remediation: 'HawkView will recheck.',
    components: [{ key: 'Audit.Exchange', label: 'Audit.Exchange', state: 'READY', lastAttemptAt: '2026-08-18T11:55:00.000Z', lastSuccessfulAt: '2026-08-18T11:55:00.000Z', lastVerifiedAt: '2026-08-18T11:56:00.000Z', reasonCode: null, reason: null }],
  }],
}

test('normalizes a bounded readiness response and preserves useful M365 subscription status', () => {
  const result = normalizeCollectionReadiness(valid)
  assert.equal(result?.overallState, 'PARTIAL')
  assert.equal(result?.workloads[0]?.components[0]?.state, 'READY')
  assert.equal(result?.workloads[0]?.components[0]?.lastVerifiedAt, '2026-08-18T11:56:00.000Z')
  assert.equal(readinessLabel('BLOCKED_TENANT_CONFIGURATION'), 'Blocked Tenant Configuration')
})

test('drops malformed, unsafe, and unexpected readiness values instead of rendering them', () => {
  const hostile = {
    ...valid,
    workloads: [
      { ...valid.workloads[0], state: 'READY<script>', remediation: { html: 'bad' } },
      { ...valid.workloads[0], key: 'safe', components: [{ __proto__: { state: 'READY' } }] },
    ],
  }
  const result = normalizeCollectionReadiness(hostile)
  assert.equal(result?.workloads.length, 2)
  assert.equal(result?.workloads.some((workload) => workload.key === 'safe'), true)
  assert.equal(result?.workloads.some((workload) => workload.key.startsWith('invalid_readiness_row_')), true)
})

test('fails closed for future workload states while keeping a bounded visible row', () => {
  const result = normalizeCollectionReadiness({
    ...valid,
    overallState: 'READY',
    workloads: [{ ...valid.workloads[0], key: 'future_collector', workload: 'Future collector', state: 'FUTURE_LICENSE_STATE', components: [{ key: 'new', label: 'New', state: 'UNKNOWN_FUTURE', lastAttemptAt: null, lastSuccessfulAt: null }] }],
  })
  assert.equal(result?.workloads.length, 1)
  assert.equal(result?.workloads[0]?.state, 'UNSUPPORTED')
  assert.equal(result?.overallState, 'UNSUPPORTED')
})

test('does not hide a blocked row after an oversized response and deterministically keeps the worst duplicate', () => {
  const many = Array.from({ length: 65 }, (_, index) => ({ ...valid.workloads[0], key: `workload_${index}` }))
  many[64] = { ...valid.workloads[0], key: 'blocked_last', state: 'BLOCKED_PERMISSION' }
  const result = normalizeCollectionReadiness({ ...valid, overallState: 'READY', workloads: many })
  assert.equal(result?.overallState, 'BLOCKED_PERMISSION')
  assert.equal(result?.workloads.some((row) => row.key === 'blocked_last'), true)
  assert.equal(result?.workloads.some((row) => row.key === 'invalid_readiness_data'), true)

  const duplicates = normalizeCollectionReadiness({ ...valid, workloads: [{ ...valid.workloads[0], state: 'READY' }, { ...valid.workloads[0], state: 'BLOCKED_PERMISSION' }] })
  assert.equal(duplicates?.workloads.length, 1)
  assert.equal(duplicates?.workloads[0]?.state, 'BLOCKED_PERMISSION')
})

test('makes oversized component data visibly unsupported instead of silently dropping it', () => {
  const components = Array.from({ length: 17 }, (_, index) => ({ ...valid.workloads[0].components[0], key: `component_${index}` }))
  const result = normalizeCollectionReadiness({ ...valid, workloads: [{ ...valid.workloads[0], components }] })
  assert.equal(result?.overallState, 'UNSUPPORTED')
  assert.equal(result?.workloads[0]?.components.some((component) => component.key === 'invalid_component_data'), true)
})

test('recomputes parent and overall state from the worst nested component and keeps malformed nested data visible', () => {
  const blocked = normalizeCollectionReadiness({
    ...valid,
    overallState: 'READY',
    workloads: [{ ...valid.workloads[0], state: 'READY', reason: 'Ready', components: [
      { ...valid.workloads[0].components[0], state: 'BLOCKED_PERMISSION', reasonCode: 'MISSING_GRANT', reason: 'MailboxSettings.Read is missing.' },
      { malformed: true },
    ] }],
  })
  assert.equal(blocked?.workloads[0]?.state, 'BLOCKED_PERMISSION')
  assert.equal(blocked?.workloads[0]?.reasonCode, 'MISSING_GRANT')
  assert.equal(blocked?.workloads[0]?.reason, 'MailboxSettings.Read is missing.')
  assert.match(blocked?.workloads[0]?.remediation ?? '', /MailboxSettings\.Read/)
  assert.equal(blocked?.overallState, 'BLOCKED_PERMISSION')
  assert.equal(blocked?.reason, 'MailboxSettings.Read is missing.')
  assert.equal(blocked?.workloads[0]?.components.some((component) => component.key === 'invalid_component_data'), true)
})

test('uses safe administrator-facing readiness copy for completed workloads and legacy snapshot safety assertions', () => {
  assert.equal(
    readinessRemediation('READY', 'Confirm a permission.'),
    'No action required. HawkView will continue normal scheduled collection.',
  )
  assert.equal(
    readinessDiagnostic(
      'sharepoint_sites-sync-failed',
      'Refusing to advance SHAREPOINT_SITES snapshot baseline from a partial or unverified collection.',
    ),
    'SharePoint site access metadata could not be verified completely. HawkView retained the prior site inventory and will retry at the next eligible scheduled collection.',
  )
})

test('drives legacy synchronization summary from required readiness rather than a successful scheduler heartbeat', () => {
  const readiness = normalizeCollectionReadiness({
    ...valid,
    overallState: 'READY',
    workloads: [
      { ...valid.workloads[0], key: 'sharepoint', workload: 'SharePoint and OneDrive', state: 'FAILED_TRANSIENT', reasonCode: 'HTTP_401', reason: 'SharePoint administrative access was denied.', lastAttemptAt: '2026-08-18T12:00:00.000Z', lastSuccessfulAt: '2026-08-17T12:00:00.000Z' },
      { ...valid.workloads[0], key: 'exchange', workload: 'Exchange', state: 'NEVER_SUCCEEDED', reasonCode: 'EXCHANGE_RBAC_UNVERIFIED', reason: 'Exchange Admin RBAC has not succeeded.', lastAttemptAt: '2026-08-18T11:00:00.000Z', lastSuccessfulAt: null },
      { ...valid.workloads[0], key: 'optional_license', workload: 'Optional licensed data', state: 'NOT_LICENSED', reason: 'Not licensed.', lastAttemptAt: null, lastSuccessfulAt: null },
    ],
  })
  const summary = synchronizationReadinessSummary(readiness)
  assert.equal(summary?.overallState, 'FAILED_TRANSIENT')
  assert.equal(summary?.applicableWorkloads, 2)
  assert.equal(summary?.currentWorkloads, 0)
  assert.equal(summary?.failedWorkloads, 2)
  assert.equal(summary?.primaryReasonCode, 'HTTP_401')
  assert.equal(summary?.primaryLastAttemptAt, '2026-08-18T12:00:00.000Z')
})

test('treats an all-unlicensed matrix as not applicable instead of falsely successful', () => {
  const readiness = normalizeCollectionReadiness({
    ...valid,
    workloads: [{ ...valid.workloads[0], state: 'NOT_LICENSED', reason: 'Not licensed.', lastAttemptAt: null, lastSuccessfulAt: null }],
  })
  const summary = synchronizationReadinessSummary(readiness)
  assert.equal(summary?.overallState, 'NOT_LICENSED')
  assert.equal(summary?.applicableWorkloads, 0)
  assert.equal(summary?.failedWorkloads, 0)
})
