import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUDIT_RECONCILIATION_RESOURCES,
  deriveAuditReconciliationResources,
  type AuditReconciliationResource,
} from './audit-change-reconciliation.js'
import {
  AuditReconciliationIncompleteError,
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

// A shared in-memory model of committed requests and modeled source completion
// receipts. SQL, lease locks and transaction atomicity belong to the registered
// database witnesses; this fixture exercises the real replay dispatcher.
function createAuditLedger() {
  const rows = new Map<AuditReconciliationResource, { requested: bigint; completed: bigint }>()
  const failedAttempts = new Map<AuditReconciliationResource, Date>()
  return {
    request(resources: readonly AuditReconciliationResource[]) {
      for (const resource of resources) {
        const row = rows.get(resource) ?? { requested: 0n, completed: 0n }
        row.requested += 1n
        rows.set(resource, row)
      }
    },
    complete(resource: AuditReconciliationResource, revision: bigint) {
      const row = rows.get(resource)
      assert.ok(row, `${resource} must have a durable request before completion`)
      assert.equal(revision, row.requested, `${resource} must acknowledge the exact revision`)
      assert.ok(row.completed < revision, `${resource} must not repeat a completion`)
      row.completed = revision
      failedAttempts.delete(resource)
    },
    fail(resource: AuditReconciliationResource) {
      assert.ok(rows.get(resource), `${resource} must have a request before failure`)
      failedAttempts.set(resource, new Date())
    },
    makeFailureRetryDue(resource: AuditReconciliationResource) {
      assert.ok(failedAttempts.has(resource))
      failedAttempts.set(resource, new Date(Date.now() - 25 * 60 * 60 * 1000))
    },
    retryStates(resources: readonly string[]) {
      return resources.flatMap(resource => {
        const failedAt = failedAttempts.get(resource as AuditReconciliationResource)
        return failedAt ? [{ resourceType: resource, status: 'FAILED', lastAttemptAt: failedAt,
          lastSuccessfulAt: null, lastErrorCode: 'SYNTHETIC_COLLECTION_FAILURE',
          lastErrorMessage: 'synthetic inventory refresh failure', consecutiveFailures: 1 }] : []
      })
    },
    pending() {
      return AUDIT_RECONCILIATION_RESOURCES.flatMap(resource => {
        const row = rows.get(resource)
        return row && row.requested > row.completed
          ? [{ resourceType: resource, requestedRevision: row.requested }] : []
      })
    },
  }
}

type AuditLedger = ReturnType<typeof createAuditLedger>

async function runAuditVisit(
  existingRaw: boolean,
  owner: typeof visitOwner | null = visitOwner,
  graphRepeatsEvent = true,
  reconcileChanges = false,
  failReconciliation = false,
  ledger: AuditLedger = createAuditLedger(),
  expectIncomplete = failReconciliation,
) {
  const operations: string[] = []
  const published: Array<{ dedupeKey: string; customerTenantId: string }> = []
  const projectedAuditIds: string[] = []
  const reconciliationResources: string[] = []
  const offeredResources: string[] = []
  const prisma = {
    directoryAuditLog: {
      findMany: async () => {
        operations.push('prior-raw-row')
        return existingRaw ? [{ microsoftAuditId: auditId }] : []
      },
    },
    syncState: {
      findMany: async ({ where }: { where: { organizationId: string; customerTenantId: string;
        resourceType: { in: string[] } } }) => {
        assert.equal(where.organizationId, tenant.organizationId)
        assert.equal(where.customerTenantId, tenant.id)
        assert.deepEqual(where.resourceType.in, ledger.pending().map(item => item.resourceType))
        return ledger.retryStates(where.resourceType.in)
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
    const requestedResources = currentOwner && enqueueReconciliation && !existingRaw
      ? deriveAuditReconciliationResources(currentRecords) : []
    if (requestedResources.length > 0) {
      ledger.request(requestedResources)
      operations.push('ledger-enqueue')
    }
    return {
      count: existingRaw ? 0 : currentRecords.length,
      requestedResources,
    }
  }
  service.pruneExpiredDirectoryAuditLogs = async () => undefined
  service.pendingAuditReconciliationWork = async (
    currentTenant: typeof tenant, currentOwner: typeof visitOwner,
  ) => {
    assert.equal(currentTenant, tenant)
    assert.equal(currentOwner, visitOwner)
    operations.push('ledger-select')
    return ledger.pending()
  }
  service.syncAuthenticationRegistrations = async (
    currentTenant: typeof tenant, token: string, currentOwner: typeof visitOwner, revision: bigint,
  ) => {
    assert.equal(currentTenant, tenant)
    assert.equal(token, 'synthetic-token')
    assert.equal(currentOwner, visitOwner)
    reconciliationResources.push('AUTH_REGISTRATIONS')
    if (failReconciliation) {
      operations.push('authentication-registration-refresh-failed')
      ledger.fail('AUTH_REGISTRATIONS')
      throw new Error('synthetic inventory refresh failure')
    }
    ledger.complete('AUTH_REGISTRATIONS', revision)
    operations.push('authentication-registration-refresh-succeeded')
  }
  service.syncAuthenticationMethodPolicy = async (
    currentTenant: typeof tenant, token: string, currentOwner: typeof visitOwner, revision: bigint,
  ) => {
    assert.equal(currentTenant, tenant)
    assert.equal(token, 'synthetic-token')
    assert.equal(currentOwner, visitOwner)
    reconciliationResources.push('AUTH_METHOD_POLICIES')
    ledger.complete('AUTH_METHOD_POLICIES', revision)
    operations.push('authentication-policy-refresh-succeeded')
  }
  service.logOperationalFailure = () => { operations.push('reconciliation-unavailable') }
  const reconcile = service.reconcileDirectoryAuditResources.bind(service)
  service.reconcileDirectoryAuditResources = async (
    currentTenant: typeof tenant,
    token: string,
    resources: string[],
    currentOwner?: typeof visitOwner,
  ) => {
    offeredResources.push(...resources)
    await reconcile(currentTenant, token, resources, currentOwner)
  }

  let incomplete: AuditReconciliationIncompleteError | null = null
  try {
    await service.syncDirectoryAuditLogs(tenant, 'synthetic-token', reconcileChanges, owner ?? undefined)
  } catch (error) {
    if (!(error instanceof AuditReconciliationIncompleteError)) throw error
    incomplete = error
  }
  if (expectIncomplete) assert.ok(incomplete, 'failed or deferred source must retain an incomplete request')
  else assert.equal(incomplete, null, 'every selected source must have an acknowledged receipt')
  return { published, operations, projectedAuditIds, reconciliationResources, offeredResources, incomplete,
    pending: ledger.pending() }
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

// The predecessor committed a raw row but lost the notice. This checks the
// empty-page orchestration; registered PostgreSQL must prove the real selector.
test('a successor repairs a missing security incident when the Graph page no longer repeats its raw event', async () => {
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

// A raw row does not prove its selected refresh completed. Share the synthetic
// committed ledger across visits; the dispatcher must retry only its unfinished
// revision instead of replaying every resource on a duplicate provider event.
test('a successor retries an unfinished audit-triggered inventory refresh', async () => {
  const ledger = createAuditLedger()
  const first = await runAuditVisit(false, visitOwner, true, true, true, ledger)
  assert.deepEqual(first.offeredResources, ['AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES'])
  assert.deepEqual(first.reconciliationResources, ['AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES'])
  assert.ok(first.operations.includes('authentication-registration-refresh-failed'))
  assert.ok(first.operations.includes('reconciliation-unavailable'),
    'the dispatcher records the collector failure before reporting incomplete work')
  assert.deepEqual(first.incomplete?.failedResources, ['AUTH_REGISTRATIONS'])
  assert.deepEqual(first.incomplete?.pendingResources, ['AUTH_REGISTRATIONS'])
  assert.deepEqual(first.pending, [{ resourceType: 'AUTH_REGISTRATIONS', requestedRevision: 1n }])

  const tooSoon = await runAuditVisit(true, visitOwner, true, true, false, ledger, true)
  assert.deepEqual(tooSoon.offeredResources, [], 'a repeated event cannot create a new request')
  assert.deepEqual(tooSoon.reconciliationResources, [], 'a recent failure retains its existing retry delay')
  assert.deepEqual(tooSoon.incomplete?.pendingResources, ['AUTH_REGISTRATIONS'])
  ledger.makeFailureRetryDue('AUTH_REGISTRATIONS')
  const successor = await runAuditVisit(true, visitOwner, true, true, false, ledger)
  assert.ok(successor.operations.includes('prior-raw-row'))
  assert.ok(successor.operations.includes('graph-page'))
  assert.deepEqual(successor.offeredResources, [], 'a repeated raw row cannot create another work request')
  assert.deepEqual(successor.reconciliationResources, ['AUTH_REGISTRATIONS'],
    'only the previously failed revision needs another collection')
  assert.deepEqual(successor.pending, [])
})

// An empty provider page cannot reconstruct the failed resource, but the
// committed ledger can. Notice/evidence repair must not clear that request.
test('a successor retries an unfinished audit-selected refresh after an empty provider page', async () => {
  const ledger = createAuditLedger()
  const first = await runAuditVisit(false, visitOwner, true, true, true, ledger)
  assert.deepEqual(first.reconciliationResources, ['AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES'])
  assert.ok(first.operations.includes('authentication-registration-refresh-failed'))
  assert.ok(first.operations.includes('reconciliation-unavailable'))
  assert.deepEqual(first.pending, [{ resourceType: 'AUTH_REGISTRATIONS', requestedRevision: 1n }])

  const tooSoon = await runAuditVisit(true, visitOwner, false, true, false, ledger, true)
  assert.deepEqual(tooSoon.reconciliationResources, [], 'an empty page cannot bypass the failure retry delay')
  assert.deepEqual(tooSoon.incomplete?.pendingResources, ['AUTH_REGISTRATIONS'])
  assert.deepEqual(tooSoon.pending, first.pending)
  ledger.makeFailureRetryDue('AUTH_REGISTRATIONS')
  const successor = await runAuditVisit(true, visitOwner, false, true, false, ledger)
  assert.ok(successor.operations.includes('graph-page'))
  assert.ok(!successor.operations.includes('raw-upsert'))
  assert.equal(successor.operations.filter((operation) => operation === 'repair-evidence-scan').length, 1)
  assert.equal(successor.operations.filter((operation) => operation === 'repair-notice-scan').length, 1)
  assert.deepEqual(successor.offeredResources, [], 'an empty page offers no new resource request')
  assert.deepEqual(successor.reconciliationResources, ['AUTH_REGISTRATIONS'],
    'an empty page must not erase the failed refresh or needlessly repeat the completed one')
  assert.deepEqual(successor.pending, [])
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
