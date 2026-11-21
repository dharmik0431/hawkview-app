import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveTenantSyncFreshness } from './service-sync-freshness.js'

const now = new Date('2026-08-13T14:02:00.000Z')
const success = (resourceType: string, at = '2026-08-13T14:00:00.000Z') => ({ resourceType, status: 'SUCCEEDED', lastAttemptAt: new Date(at), lastSuccessfulAt: new Date(at), lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0 })
const failed = (resourceType: string, lastSuccessfulAt: string | null = null, code = '500') => ({ resourceType, status: 'FAILED', lastAttemptAt: now, lastSuccessfulAt: lastSuccessfulAt ? new Date(lastSuccessfulAt) : null, lastErrorCode: code, lastErrorMessage: code === '403' ? 'Forbidden: consent required' : 'Microsoft API error', consecutiveFailures: 1 })

test('full20 freshness follows the exact opt-in with inclusive eligibility and existing inventory grace', () => {
  const saved = process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED
  const minute = 60000
  const inventory = (age: number) => ['LICENSES', 'DOMAINS', 'ORGANIZATION_CONFIGURATION', 'SECURITY_DEFAULTS', 'DOMAIN_DNS_HEALTH']
    .map(resource => success(resource, new Date(now.getTime() - age).toISOString()))
  try {
    for (const flag of [undefined, 'false', 'TRUE', '1']) {
      if (flag === undefined) delete process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED
      else process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED = flag
      assert.equal(deriveTenantSyncFreshness(inventory(23 * 60 * minute), now).services.office365.freshnessStatus, 'CURRENT')
    }
    process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED = 'true'
    for (const [age, freshness] of [[20 * minute, 'CURRENT'], [20 * minute + 1, 'AGING'],
      [140 * minute, 'AGING'], [140 * minute + 1, 'STALE']] as const) {
      const result = deriveTenantSyncFreshness(inventory(age), now).services.office365
      assert.equal(result.freshnessStatus, freshness)
      assert.equal(result.staleCollectors, freshness === 'STALE' ? 5 : 0)
      assert.equal(result.nextScheduledAttemptAt, null)
    }
    const activity = deriveTenantSyncFreshness([success('SIGN_INS', new Date(now.getTime() - 16 * minute).toISOString())], now)
    assert.equal(activity.services.signInLogs.freshnessStatus, 'AGING', 'activity keeps its existing 15-minute window')
    const failure = failed('SHAREPOINT_USAGE', new Date(now.getTime() - 21 * minute).toISOString())
    const before = structuredClone(failure)
    const result = deriveTenantSyncFreshness([failure], now).services.sharePointOneDrive
    assert.equal(result.failedCollectors, 1)
    assert.equal(result.partialFailures.find(item => item.collector === 'SHAREPOINT_USAGE')?.nextRetryAt, null)
    assert.deepEqual(failure, before, 'freshness must not mutate failure policy state')
  } finally {
    if (saved === undefined) delete process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED
    else process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED = saved
  }
})

test('reports a fully successful service only when every expected collector succeeded', () => {
  const data = deriveTenantSyncFreshness(['LICENSES', 'DOMAINS', 'ORGANIZATION_CONFIGURATION', 'SECURITY_DEFAULTS', 'DOMAIN_DNS_HEALTH'].map((resourceType) => success(resourceType)), now)
  assert.equal(data.services.office365.status, 'SUCCESS')
  assert.equal(data.services.office365.freshnessStatus, 'CURRENT')
  assert.equal(data.services.office365.successfulCollectors, 5)
})

test('keeps a service partial when one Graph collector fails after other usable data succeeded', () => {
  const data = deriveTenantSyncFreshness([success('EXCHANGE_MAILBOXES'), success('EXCHANGE_MAILBOX_SETTINGS'), success('EXCHANGE_MAILBOX_CONFIGURATION'), success('EXCHANGE_MAILBOX_USAGE'), success('EXCHANGE_ACCEPTED_DOMAINS'), failed('EXCHANGE_MAILBOX_RULES', '2026-08-13T13:45:00.000Z')], now)
  assert.equal(data.services.exchange.status, 'PARTIAL')
  assert.equal(data.services.exchange.partialFailures[0]?.collector, 'EXCHANGE_MAILBOX_RULES')
  assert.equal(data.services.exchange.partialFailures[0]?.lastSuccessfulAt, '2026-08-13T13:45:00.000Z')
})

test('treats the six Exchange collectors as the complete standard service', () => {
  const data = deriveTenantSyncFreshness([
    success('EXCHANGE_MAILBOXES'),
    success('EXCHANGE_MAILBOX_SETTINGS'),
    success('EXCHANGE_MAILBOX_CONFIGURATION'),
    success('EXCHANGE_MAILBOX_USAGE'),
    success('EXCHANGE_ACCEPTED_DOMAINS'),
    success('EXCHANGE_MAILBOX_RULES'),
  ], now)
  assert.equal(data.services.exchange.status, 'SUCCESS')
  assert.equal(data.services.exchange.expectedCollectors, 6)
})

test('reports a complete service failure when no collector has usable data', () => {
  const data = deriveTenantSyncFreshness(['SHAREPOINT_SITES', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE'].map((resourceType) => failed(resourceType)), now)
  assert.equal(data.services.sharePointOneDrive.status, 'FAILED')
  assert.equal(data.services.sharePointOneDrive.freshnessStatus, 'NEVER_SYNCED')
})

test('reports initial collection as not collected instead of a fabricated failure', () => {
  const data = deriveTenantSyncFreshness([], now)
  assert.equal(data.services.entraId.status, 'NOT_COLLECTED')
  assert.equal(data.services.entraId.lastSuccessfulCollectionAt, null)
})

test('reports fully excluded licensing and support reasons from the original service registry', () => {
  const sharePoint = ['SHAREPOINT_SITES', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE']
  const excluded = deriveTenantSyncFreshness([], now, sharePoint, { notLicensed: sharePoint })
  assert.equal(excluded.services.sharePointOneDrive.status, 'UNKNOWN')
  assert.equal(excluded.services.sharePointOneDrive.expectedCollectors, 0)
  assert.equal(excluded.services.sharePointOneDrive.notLicensedCollectors, 3)
  assert.equal(excluded.services.sharePointOneDrive.unsupportedCollectors, 0)

  const audit = ['AUDIT_LOGS', 'M365_AUDIT']
  const unsupported = deriveTenantSyncFreshness([], now, audit, { unsupported: audit })
  assert.equal(unsupported.services.auditLogs.expectedCollectors, 0)
  assert.equal(unsupported.services.auditLogs.unsupportedCollectors, 2)

  // A legacy unclassified exclusion cannot claim a licensing cause.
  const unclassified = deriveTenantSyncFreshness([], now, sharePoint)
  assert.equal(unclassified.services.sharePointOneDrive.expectedCollectors, 0)
  assert.equal(unclassified.services.sharePointOneDrive.notLicensedCollectors, 0)
})

test('reports an active collector as running', () => {
  const data = deriveTenantSyncFreshness([{ ...success('SIGN_INS'), status: 'RUNNING', lastSuccessfulAt: null }], now)
  assert.equal(data.services.signInLogs.status, 'RUNNING')
  assert.equal(data.services.signInLogs.partialFailures[0]?.status, 'RUNNING')
})

test('marks previous data stale without losing its last successful timestamp', () => {
  const data = deriveTenantSyncFreshness([
    success('AUDIT_LOGS', '2026-08-13T10:00:00.000Z'),
    success('M365_AUDIT', '2026-08-13T10:00:00.000Z'),
  ], now)
  assert.equal(data.services.auditLogs.status, 'STALE')
  assert.equal(data.services.auditLogs.freshnessStatus, 'STALE')
  assert.equal(data.services.auditLogs.lastSuccessfulCollectionAt, '2026-08-13T10:00:00.000Z')
})

test('keeps daily inventory current until its daily grace window expires', () => {
  const data = deriveTenantSyncFreshness(
    ['LICENSES', 'DOMAINS', 'ORGANIZATION_CONFIGURATION', 'SECURITY_DEFAULTS', 'DOMAIN_DNS_HEALTH'].map((resourceType) =>
      success(resourceType, '2026-08-12T15:00:00.000Z'),
    ),
    now,
  )

  assert.equal(data.services.office365.status, 'SUCCESS')
  assert.equal(data.services.office365.freshnessStatus, 'CURRENT')
})

test('maps permission failures separately from ordinary API failures', () => {
  const data = deriveTenantSyncFreshness([failed('SIGN_INS', null, '403')], now)
  assert.equal(data.services.signInLogs.permissionRequiredCollectors, 1)
  assert.equal(data.services.signInLogs.partialFailures[0]?.status, 'PERMISSION_REQUIRED')
})

test('keeps freshness independent across services', () => {
  const data = deriveTenantSyncFreshness([
    success('AUDIT_LOGS'),
    success('M365_AUDIT'),
    success('SIGN_INS', '2026-08-13T10:00:00.000Z'),
  ], now)
  assert.equal(data.services.auditLogs.freshnessStatus, 'CURRENT')
  assert.equal(data.services.signInLogs.freshnessStatus, 'STALE')
})

test('reports audit coverage as partial when the M365 workload collector has never run', () => {
  const data = deriveTenantSyncFreshness([success('AUDIT_LOGS')], now)
  assert.equal(data.services.auditLogs.status, 'PARTIAL')
  assert.equal(data.services.auditLogs.partialFailures[0]?.collector, 'M365_AUDIT')
})

test('does not report audit coverage healthy after a newer M365 subscription failure', () => {
  const data = deriveTenantSyncFreshness([
    success('AUDIT_LOGS'),
    failed(
      'M365_AUDIT',
      '2026-08-13T13:50:00.000Z',
      'm365-audit-subscription-incomplete',
    ),
  ], now)
  assert.equal(data.services.auditLogs.status, 'PARTIAL')
  assert.equal(data.services.auditLogs.failedCollectors, 1)
  assert.equal(
    data.services.auditLogs.partialFailures[0]?.reasonCode,
    'm365-audit-subscription-incomplete',
  )
})

test('does not present a global scheduler heartbeat as a resource retry promise', () => {
  const data = deriveTenantSyncFreshness([success('AUDIT_LOGS')], now)
  assert.equal(data.services.auditLogs.scheduleSource, 'scheduler cadence; resource eligibility unknown')
  assert.equal(data.services.auditLogs.nextScheduledAttemptAt, null)
})
