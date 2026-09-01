import assert from 'node:assert/strict'
import test from 'node:test'
import { projectTenantOperationalHealth } from './operational-health-projection.ts'

const tenant = (id: string, organizationId: string, attention: unknown[]) => ({
  id,
  name: `Tenant ${id}`,
  microsoftTenantId: `microsoft-${id}`,
  provider: 'microsoft',
  domain: `${id}.example.test`,
  status: 'active',
  connectionStatus: 'connected',
  connectionMode: 'hawkview-managed',
  lastSync: '2026-08-26T17:00:00.000Z',
  secureScore: null,
  licenseCount: null,
  requiredPermissions: [],
  consentedPermissions: [],
  missingPermissions: [],
  connectionErrorCode: null,
  attention,
  organization: { id: organizationId, name: organizationId, slug: organizationId },
})

test('selects only the requested tenant projection and preserves organization isolation', () => {
  const result = projectTenantOperationalHealth({
    tenantId: 'tenant-b',
    queryState: 'SUCCESS',
    response: {
      tenants: [
        tenant('tenant-a', 'org-a', [{ key: 'a', label: 'Organization A issue', severity: 'critical', why: 'A only.' }]),
        tenant('tenant-b', 'org-b', [{ key: 'b', label: 'Organization B issue', severity: 'high', why: 'B only.' }]),
      ],
    } as never,
  })

  assert.equal(result.status, 'READY')
  assert.equal(result.tenant?.organization.id, 'org-b')
  assert.deepEqual(result.actionableHealth.items.map((item) => item.key), ['b'])
})

test('does not reuse another tenant projection during a tenant switch or failed list query', () => {
  const missing = projectTenantOperationalHealth({
    tenantId: 'tenant-new',
    queryState: 'SUCCESS',
    response: { tenants: [tenant('tenant-old', 'org-a', [])] } as never,
  })
  assert.equal(missing.status, 'UNAVAILABLE')
  assert.deepEqual(missing.actionableHealth, { status: 'UNAVAILABLE', items: [] })

  const failed = projectTenantOperationalHealth({
    tenantId: 'tenant-old',
    queryState: 'ERROR',
    response: { tenants: [tenant('tenant-old', 'org-a', [])] } as never,
  })
  assert.equal(failed.status, 'UNAVAILABLE')
  assert.deepEqual(failed.actionableHealth, { status: 'UNAVAILABLE', items: [] })
})

test('distinguishes an authoritative empty health result from malformed health evidence', () => {
  const healthy = projectTenantOperationalHealth({
    tenantId: 'tenant-a',
    queryState: 'SUCCESS',
    response: { tenants: [tenant('tenant-a', 'org-a', [])] } as never,
  })
  assert.deepEqual(healthy.actionableHealth, { status: 'VERIFIED', items: [] })

  const malformed = projectTenantOperationalHealth({
    tenantId: 'tenant-a',
    queryState: 'SUCCESS',
    response: {
      tenants: [tenant('tenant-a', 'org-a', [{ key: 'unsafe', label: 'Unsafe', severity: 'high', why: 'line one\nline two' }])],
    } as never,
  })
  assert.deepEqual(malformed.actionableHealth, { status: 'UNAVAILABLE', items: [] })
})
