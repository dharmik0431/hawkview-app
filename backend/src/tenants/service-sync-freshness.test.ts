import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveTenantSyncFreshness } from './service-sync-freshness.js'

const now = new Date('2026-08-13T14:02:00.000Z')
const success = (resourceType: string, at = '2026-08-13T14:00:00.000Z') => ({ resourceType, status: 'SUCCEEDED', lastAttemptAt: new Date(at), lastSuccessfulAt: new Date(at), lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0 })
const failed = (resourceType: string, lastSuccessfulAt: string | null = null, code = '500') => ({ resourceType, status: 'FAILED', lastAttemptAt: now, lastSuccessfulAt: lastSuccessfulAt ? new Date(lastSuccessfulAt) : null, lastErrorCode: code, lastErrorMessage: code === '403' ? 'Forbidden: consent required' : 'Microsoft API error', consecutiveFailures: 1 })

test('reports a fully successful service only when every expected collector succeeded', () => {
  const data = deriveTenantSyncFreshness(['LICENSES', 'DOMAINS', 'SECURITY_DEFAULTS', 'DOMAIN_DNS_HEALTH'].map((resourceType) => success(resourceType)), now)
  assert.equal(data.services.office365.status, 'SUCCESS')
  assert.equal(data.services.office365.freshnessStatus, 'CURRENT')
  assert.equal(data.services.office365.successfulCollectors, 4)
})

test('keeps a service partial when one collector fails after other usable data succeeded', () => {
  const data = deriveTenantSyncFreshness([success('EXCHANGE_MAILBOXES'), success('EXCHANGE_MAILBOX_CONFIGURATION'), success('EXCHANGE_MAILBOX_USAGE'), success('EXCHANGE_ACCEPTED_DOMAINS'), failed('EXCHANGE_MAILBOX_RULES', '2026-08-13T13:45:00.000Z')], now)
  assert.equal(data.services.exchange.status, 'PARTIAL')
  assert.equal(data.services.exchange.partialFailures[0]?.collector, 'EXCHANGE_MAILBOX_RULES')
  assert.equal(data.services.exchange.partialFailures[0]?.lastSuccessfulAt, '2026-08-13T13:45:00.000Z')
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

test('reports an active collector as running', () => {
  const data = deriveTenantSyncFreshness([{ ...success('SIGN_INS'), status: 'RUNNING', lastSuccessfulAt: null }], now)
  assert.equal(data.services.signInLogs.status, 'RUNNING')
  assert.equal(data.services.signInLogs.partialFailures[0]?.status, 'RUNNING')
})

test('marks previous data stale without losing its last successful timestamp', () => {
  const data = deriveTenantSyncFreshness([success('AUDIT_LOGS', '2026-08-13T10:00:00.000Z')], now)
  assert.equal(data.services.auditLogs.status, 'STALE')
  assert.equal(data.services.auditLogs.freshnessStatus, 'STALE')
  assert.equal(data.services.auditLogs.lastSuccessfulCollectionAt, '2026-08-13T10:00:00.000Z')
})

test('maps permission failures separately from ordinary API failures', () => {
  const data = deriveTenantSyncFreshness([failed('SIGN_INS', null, '403')], now)
  assert.equal(data.services.signInLogs.permissionRequiredCollectors, 1)
  assert.equal(data.services.signInLogs.partialFailures[0]?.status, 'PERMISSION_REQUIRED')
})

test('keeps freshness independent across services', () => {
  const data = deriveTenantSyncFreshness([success('AUDIT_LOGS'), success('SIGN_INS', '2026-08-13T10:00:00.000Z')], now)
  assert.equal(data.services.auditLogs.freshnessStatus, 'CURRENT')
  assert.equal(data.services.signInLogs.freshnessStatus, 'STALE')
})

test('uses the configured Render cron schedule as the next scheduled attempt source', () => {
  const data = deriveTenantSyncFreshness([success('AUDIT_LOGS')], now)
  assert.equal(data.services.auditLogs.scheduleSource, '*/5 * * * *')
  assert.equal(data.services.auditLogs.nextScheduledAttemptAt, '2026-08-13T14:05:00.000Z')
})
