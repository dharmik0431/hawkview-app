import assert from 'node:assert/strict'
import test from 'node:test'
import { ChangeEvidenceService } from '../changes/change-evidence.service.js'
import { organizationConfigurationSnapshotForTenant } from './tenant-sync.service.js'

const microsoftTenantId = '11111111-2222-3333-4444-555555555555'

test('accepts exactly one Graph organization matching the connected Microsoft tenant', () => {
  assert.deepEqual(
    organizationConfigurationSnapshotForTenant(microsoftTenantId, {
      value: [{ id: microsoftTenantId.toUpperCase(), displayName: 'Contoso MSP' }],
    }),
    { id: microsoftTenantId, tenantId: microsoftTenantId, displayName: 'Contoso MSP' },
  )
})

test('rejects missing, mismatched, partial, and multi-record Graph organization responses before a snapshot can be saved', () => {
  for (const body of [
    undefined,
    { value: [] },
    { value: [{}] },
    { value: [{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', displayName: 'Wrong tenant' }] },
    { value: [{ id: microsoftTenantId }, { id: microsoftTenantId }] },
  ]) {
    assert.throws(() => organizationConfigurationSnapshotForTenant(microsoftTenantId, body), /organization/i)
  }
})

test('first baseline is quiet, subsequent A to B and B to A identity transitions are tenant-isolated and retry-idempotent', () => {
  const service = new ChangeEvidenceService({} as never)
  const common = {
    resourceType: 'ORGANIZATION_CONFIGURATION' as const,
    observedAt: new Date('2026-08-18T12:00:00.000Z'),
    baselineObservedAt: new Date('2026-08-18T11:00:00.000Z'),
    expiresAt: new Date('2027-02-18T12:00:00.000Z'),
  }
  const a = [{ id: microsoftTenantId, tenantId: microsoftTenantId, displayName: 'Contoso A' }]
  const b = [{ id: microsoftTenantId, tenantId: microsoftTenantId, displayName: 'Contoso B' }]
  assert.deepEqual(service.buildSnapshotDifferenceEvidence({ ...common, tenant: { id: 'tenant-a', organizationId: 'org-a' }, previousPayload: null, currentPayload: a }), [])
  const forward = service.buildSnapshotDifferenceEvidence({ ...common, tenant: { id: 'tenant-a', organizationId: 'org-a' }, previousPayload: a, currentPayload: b })
  const retry = service.buildSnapshotDifferenceEvidence({ ...common, tenant: { id: 'tenant-a', organizationId: 'org-a' }, previousPayload: a, currentPayload: b })
  const reverse = service.buildSnapshotDifferenceEvidence({ ...common, tenant: { id: 'tenant-a', organizationId: 'org-a' }, previousPayload: b, currentPayload: a })
  const reverseRetry = service.buildSnapshotDifferenceEvidence({ ...common, tenant: { id: 'tenant-a', organizationId: 'org-a' }, previousPayload: b, currentPayload: a })
  const otherTenant = service.buildSnapshotDifferenceEvidence({ ...common, tenant: { id: 'tenant-b', organizationId: 'org-b' }, previousPayload: a, currentPayload: b })
  assert.equal(forward.length, 1)
  assert.equal(forward[0]?.sourceEventId, retry[0]?.sourceEventId)
  assert.equal(reverse.length, 1)
  assert.equal(reverse[0]?.sourceEventId, reverseRetry[0]?.sourceEventId)
  assert.deepEqual(reverse[0]?.beforeState, { displayName: 'Contoso B', tenantId: microsoftTenantId })
  assert.deepEqual(reverse[0]?.afterState, { displayName: 'Contoso A', tenantId: microsoftTenantId })
  assert.equal(otherTenant.length, 1)
  assert.equal(forward[0]?.organizationId, 'org-a')
  assert.equal(forward[0]?.customerTenantId, 'tenant-a')
  assert.equal(otherTenant[0]?.organizationId, 'org-b')
  assert.equal(otherTenant[0]?.customerTenantId, 'tenant-b')
})
