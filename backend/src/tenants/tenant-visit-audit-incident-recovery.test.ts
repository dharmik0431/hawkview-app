import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveAuditReconciliationResources } from './audit-change-reconciliation.js'
import {
  DIRECTORY_AUDIT_EVIDENCE_REPAIR_BATCH_LIMIT,
  DIRECTORY_AUDIT_NOTICE_REPAIR_BATCH_LIMIT,
  TenantSyncService,
} from './tenant-sync.service.js'

const tenant = {
  id: '22222222-2222-4222-8222-222222222222',
  organizationId: '11111111-1111-4111-8111-111111111111',
}
const auditId = 'synthetic-audit-event-1'
const visitOwner = {
  customerTenantId: tenant.id,
  organizationId: tenant.organizationId,
  token: 'new-visitor-token',
  generation: 2n,
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
}

async function runAuditVisit(
  existingRaw: boolean,
  owner: typeof visitOwner | null = visitOwner,
  graphRepeatsEvent = true,
  reconcileChanges = false,
  failReconciliation = false,
) {
  const operations: string[] = []
  const published: Array<{ dedupeKey: string; customerTenantId: string }> = []
  const projectedAuditIds: string[] = []
  const reconciliationResources: string[] = []
  const prisma = {
    directoryAuditLog: {
      findMany: async () => {
        operations.push('prior-raw-row')
        return existingRaw ? [{ microsoftAuditId: auditId }] : []
      },
    },
  }
  const notifications = {
    publishIncident: async (input: { dedupeKey: string; customerTenantId: string }) => {
      operations.push('publish-incident-legacy')
      published.push(input)
      return { id: 'synthetic-incident' }
    },
    publishIncidentIfMissing: async () => {
      assert.fail('owner-bound audit notice must not open a second transaction')
    },
  }
  const changeEvidence = {
    projectDirectoryAudits: async (_tenant: unknown, records: Array<{ microsoftAuditId: string }>,
      currentOwner?: typeof visitOwner, transaction?: object) => {
      operations.push('project-evidence-attempt')
      if (currentOwner) assert.ok(transaction, 'owner-bound evidence must share the raw write transaction')
      else assert.equal(transaction, undefined)
      projectedAuditIds.push(...records.map((record) => record.microsoftAuditId))
      operations.push('project-evidence')
    },
    projectRetainedDirectoryAuditsMissingEvidence: async (
      currentTenant: typeof tenant, currentOwner: typeof visitOwner, limit: number,
    ) => {
      operations.push('repair-evidence-scan')
      assert.equal(currentTenant, tenant)
      assert.equal(currentOwner, visitOwner)
      assert.equal(limit, DIRECTORY_AUDIT_EVIDENCE_REPAIR_BATCH_LIMIT)
      // The synthetic predecessor left a raw-only row, and the successor's
      // provider page does not repeat it. The evidence service's own tests
      // cover the missing-evidence selection and owner-checked transaction.
      if (existingRaw && !graphRepeatsEvent) {
        projectedAuditIds.push(auditId)
        operations.push('repair-evidence')
        return { attempted: 1, hasMore: false }
      }
      return { attempted: 0, hasMore: false }
    },
    pruneExpired: async () => undefined,
  }
  const service = new TenantSyncService(prisma as any, {} as any, {} as any,
    notifications as any, changeEvidence as any, {} as any) as any
  service.repairRetainedDirectoryAuditNotices = async (
    currentTenant: typeof tenant, currentOwner: typeof visitOwner, limit: number,
  ) => {
    operations.push('repair-notice-scan')
    assert.equal(currentTenant, tenant)
    assert.equal(currentOwner, visitOwner)
    assert.equal(limit, DIRECTORY_AUDIT_NOTICE_REPAIR_BATCH_LIMIT)
    if (existingRaw && !graphRepeatsEvent) {
      published.push({
        dedupeKey: `security:directory-audit:${auditId}`,
        customerTenantId: tenant.id,
      })
      operations.push('repair-notice')
      return { attempted: 1, hasMore: false }
    }
    return { attempted: 0, hasMore: false }
  }
  service.runSnapshotSync = async (_tenant: unknown, _resource: string, collect: () => Promise<void>) => collect()
  service.logSyncStart = async () => new Date('2026-11-09T00:00:00.000Z')
  service.fetchGraphCollection = async () => {
    operations.push('graph-page')
    return graphRepeatsEvent ? [{
      id: auditId,
      activityDateTime: '2026-11-09T12:00:00.000Z',
      activityDisplayName: 'Update authentication method',
    }] : []
  }
  service.persistDirectoryAuditRows = async (
    _tenant: unknown,
    currentRecords: Array<{ microsoftAuditId: string; activityDisplayName: string }>,
    currentOwner?: typeof visitOwner,
    enqueueReconciliation = false,
  ) => {
    operations.push('raw-upsert')
    if (currentOwner) {
      assert.equal(currentOwner, visitOwner)
      operations.push('publish-incident-atomic')
      published.push({
        dedupeKey: `security:directory-audit:${auditId}`,
        customerTenantId: tenant.id,
      })
      await changeEvidence.projectDirectoryAudits(tenant, currentRecords, currentOwner, { synthetic: 'raw-write-transaction' })
    }
    return {
      count: existingRaw ? 0 : currentRecords.length,
      requestedResources: currentOwner && enqueueReconciliation && !existingRaw
        ? deriveAuditReconciliationResources(currentRecords)
        : [],
    }
  }
  service.pruneExpiredDirectoryAuditLogs = async () => undefined
  const reconcile = service.reconcileDirectoryAuditResources.bind(service)
  service.reconcileDirectoryAuditResources = async (
    currentTenant: typeof tenant,
    token: string,
    resources: string[],
    currentOwner?: typeof visitOwner,
  ) => {
    reconciliationResources.push(...resources)
    if (failReconciliation && resources.length > 0) {
      service.syncAuthenticationRegistrations = async () => {
        operations.push('authentication-registration-refresh-failed')
        throw new Error('synthetic inventory refresh failure')
      }
      service.syncAuthenticationMethodPolicy = async () => {
        operations.push('authentication-policy-refresh-succeeded')
      }
      service.logOperationalFailure = () => {
        operations.push('reconciliation-unavailable')
      }
      await reconcile(currentTenant, token, resources, currentOwner)
    }
  }

  await service.syncDirectoryAuditLogs(tenant, 'synthetic-token', reconcileChanges, owner ?? undefined)
  return { published, operations, projectedAuditIds, reconciliationResources }
}

test('first-seen directory security audit reaches the synthetic incident publisher', async () => {
  const { published, operations } = await runAuditVisit(false)
  assert.ok(operations.includes('prior-raw-row'))
  assert.ok(operations.includes('raw-upsert'))
  assert.ok(operations.includes('project-evidence'))
  assert.equal(operations.filter((operation) => operation === 'project-evidence').length, 1)
  assert.ok(operations.indexOf('publish-incident-atomic') < operations.indexOf('project-evidence'))
  assert.deepEqual(operations.filter((operation) => operation.startsWith('publish-')), ['publish-incident-atomic'])
  assert.ok(!operations.includes('publish-incident-legacy'))
  assert.deepEqual(published.map(({ dedupeKey }) => dedupeKey), [
    `security:directory-audit:${auditId}`,
  ])
})

// A legacy ownerless visitor may have committed the raw row before its
// separate notice write. An owner-bound successor must repair that notice in
// its atomic persistence transaction when Graph repeats the event.
test('a successor repairs a missing security incident after a prior raw audit commit', async () => {
  const { published, operations } = await runAuditVisit(true)
  assert.ok(operations.includes('prior-raw-row'))
  assert.ok(operations.includes('raw-upsert'))
  assert.ok(operations.includes('project-evidence'))
  assert.deepEqual(operations.filter((operation) => operation.startsWith('publish-')), ['publish-incident-atomic'])
  assert.ok(!operations.includes('publish-incident-legacy'))
  assert.deepEqual(published.map(({ dedupeKey, customerTenantId }) => ({ dedupeKey, customerTenantId })), [{
    dedupeKey: `security:directory-audit:${auditId}`,
    customerTenantId: tenant.id,
  }], 'a committed raw row alone cannot establish that its separate incident was published')
})

// Hook witness: the predecessor committed the raw audit row and lost its
// lease before publishing the notice, but the successor's Graph page no
// longer contains that event. The stub models a bounded repair result; the
// registered PostgreSQL suite must prove the real selector and write.
test('a successor repairs a missing security incident when the Graph page no longer repeats its raw event', {
  skip: process.env.HAWKVIEW_SYNC_AUDIT_ABSENT_PAGE_RECOVERY_WITNESS !== '1'
    ? 'held pending registered disposable-PostgreSQL repair proof'
    : false,
}, async () => {
  const { published, operations } = await runAuditVisit(true, visitOwner, false)
  assert.ok(operations.includes('graph-page'))
  assert.ok(!operations.includes('raw-upsert'))
  assert.equal(operations.filter((operation) => operation === 'repair-notice-scan').length, 1)
  assert.deepEqual(published.map(({ dedupeKey, customerTenantId }) => ({ dedupeKey, customerTenantId })), [{
    dedupeKey: `security:directory-audit:${auditId}`,
    customerTenantId: tenant.id,
  }], 'a committed raw row still needs its incident after the provider stops repeating it')
})

test('ownerless audit reentry retains the existing first-seen notification rule', async () => {
  const first = await runAuditVisit(false, null)
  assert.deepEqual(first.operations.filter((operation) => operation.startsWith('publish-')), ['publish-incident-legacy'])
  assert.ok(!first.operations.includes('repair-evidence-scan'))
  assert.ok(!first.operations.includes('repair-notice-scan'))
  const repeat = await runAuditVisit(true, null)
  assert.deepEqual(repeat.operations.filter((operation) => operation.startsWith('publish-')), [])
  assert.ok(!repeat.operations.includes('repair-evidence-scan'))
  assert.ok(!repeat.operations.includes('repair-notice-scan'))
})

// Held recovery witness: A committed the raw audit event and AUDIT_LOGS success,
// but its selected inventory refresh failed. B sees the same Graph event and
// needs durable proof of reconciliation before treating that event as complete.
// A raw-row existence check alone cannot supply that proof. Do not implement
// an unconditional replay here: it would refresh inventories on every poll.
test('a successor retries an unfinished audit-triggered inventory refresh', {
  skip: process.env.HAWKVIEW_SYNC_AUDIT_REENTRY_RECOVERY_WITNESS !== '1'
    ? 'held pending durable per-event reconciliation completion and bounded replay design'
    : false,
}, async () => {
  const first = await runAuditVisit(false, visitOwner, true, true, true)
  assert.deepEqual(first.reconciliationResources, ['AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES'])
  assert.ok(first.operations.includes('authentication-registration-refresh-failed'))
  assert.ok(first.operations.includes('reconciliation-unavailable'),
    'the real audit reentry dispatcher records an ordinary collector failure and returns')

  const successor = await runAuditVisit(true, visitOwner, true, true)
  assert.ok(successor.operations.includes('prior-raw-row'))
  assert.ok(successor.operations.includes('graph-page'))
  assert.deepEqual(successor.reconciliationResources, ['AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES'],
    'a committed raw audit row does not prove its selected inventory refresh completed')
})

// A provider page is not a durable work queue. The first visitor can commit
// the raw row and security notice, then fail an audit-selected refresh. If
// the next page is empty, the retained notice/evidence repair paths still run
// but neither reconstructs the unfinished inventory resource selection.
test('a successor retries an unfinished audit-selected refresh after an empty provider page', {
  skip: process.env.HAWKVIEW_SYNC_AUDIT_REENTRY_EMPTY_PAGE_WITNESS !== '1'
    ? 'held pending durable per-resource completion and bounded replay'
    : false,
}, async () => {
  const first = await runAuditVisit(false, visitOwner, true, true, true)
  assert.deepEqual(first.reconciliationResources, ['AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES'])
  assert.ok(first.operations.includes('authentication-registration-refresh-failed'))
  assert.ok(first.operations.includes('reconciliation-unavailable'))

  const successor = await runAuditVisit(true, visitOwner, false, true)
  assert.ok(successor.operations.includes('graph-page'))
  assert.ok(!successor.operations.includes('raw-upsert'))
  assert.equal(successor.operations.filter((operation) => operation === 'repair-evidence-scan').length, 1)
  assert.equal(successor.operations.filter((operation) => operation === 'repair-notice-scan').length, 1)
  assert.deepEqual(successor.reconciliationResources, ['AUTH_REGISTRATIONS'],
    'an empty page must not erase the failed refresh or needlessly repeat the completed one')
})

// Held historical-recovery witness: a pre-atomic raw audit row may still lack
// evidence. A later empty Graph page cannot reconstruct it from observations.
test('an owner-bound successor repairs retained raw-only evidence when the later Graph page is empty', async () => {
  const successor = await runAuditVisit(true, visitOwner, false)
  assert.ok(successor.operations.includes('graph-page'))
  assert.ok(!successor.operations.includes('raw-upsert'))
  assert.equal(successor.operations.filter((operation) => operation === 'repair-evidence-scan').length, 1)
  assert.equal(successor.operations.filter((operation) => operation === 'repair-notice-scan').length, 1)
  assert.deepEqual(successor.projectedAuditIds, [auditId],
    'a historical raw audit row does not prove evidence was projected')
})
