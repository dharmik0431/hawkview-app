import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'audit-tenant', organizationId: 'audit-organization' }
const owner = {
  customerTenantId: tenant.id, organizationId: tenant.organizationId,
  token: 'visit-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

function fixture() {
  const warnings: string[] = []
  const service = new TenantSyncService({} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  ;(service as any).logger = { warn: (message: string) => warnings.push(message) }
  ;(service as any).pendingAuditReconciliationWork = async () => []
  return { service: service as any, warnings }
}

test('audit reentry keeps an ordinary collector failure best effort', async () => {
  const { service, warnings } = fixture()
  service.syncLicenses = async () => { throw new Error('synthetic provider failure') }
  await assert.doesNotReject(() => service.reconcileDirectoryAuditResources(
    tenant, 'synthetic-token', ['LICENSES'],
  ))
  assert.deepEqual(warnings.map((warning) => JSON.parse(warning)), [{
    event: 'microsoft_collection_runtime_failure', resource: 'LICENSES',
    phase: 'RECONCILIATION', outcome: 'FAILED', reasonCode: 'AUDIT_RECONCILIATION_UNAVAILABLE',
  }])
})

// Held call-level witness. Passing the owner is necessary, but each selected
// collector must also check it in its own write transaction before activation.
test('audit-selected guarded collectors receive the exact visit owner', {
  skip: process.env.HAWKVIEW_SYNC_VISIT_FAIL_FIRST !== '1',
}, async () => {
  const { service } = fixture()
  const calls = new Map<string, unknown[]>()
  service.syncLicenses = async (...args: unknown[]) => { calls.set('LICENSES', args) }
  service.syncOrganizationConfiguration = async (...args: unknown[]) => {
    calls.set('ORGANIZATION_CONFIGURATION', args)
  }
  await service.reconcileDirectoryAuditChanges(tenant, 'synthetic-token', [
    { activityDisplayName: 'Change user license' },
    { activityDisplayName: 'Update organization profile' },
  ], owner)
  assert.deepEqual(calls.get('LICENSES'), [tenant, 'synthetic-token', owner])
  assert.deepEqual(calls.get('ORGANIZATION_CONFIGURATION'), [tenant, 'synthetic-token', owner])
})

// An exact owner loss must abort its visitor instead of being logged as a
// routine provider failure. This is independent of the pass-through witness.
test('audit reentry propagates exact visit ownership loss', {
  skip: process.env.HAWKVIEW_SYNC_VISIT_FAIL_FIRST !== '1',
}, async () => {
  const { service, warnings } = fixture()
  service.syncLicenses = async () => { throw new TenantVisitLeaseLostError() }
  await assert.rejects(() => service.reconcileDirectoryAuditResources(
    tenant, 'synthetic-token', ['LICENSES'], owner,
  ), TenantVisitLeaseLostError)
  assert.deepEqual(warnings, [])
})
