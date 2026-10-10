import assert from 'node:assert/strict'
import test from 'node:test'
import { selectedDirectoryHealthTenant } from './directory-health-selection.ts'

const scope = 'identity:a:organizations:org-a'
const tenant = { id: 'tenant', provider: 'microsoft', name: 'Current name' }
const ready = {
  selection: { tenantId: tenant.id, cacheScope: scope, identityToken: 'a:0' },
  cacheScope: scope, identityToken: 'a:0', authLoading: false,
  listSuccessful: true, tenants: [tenant],
}

test('selection admits only the current row, retaining no former payload', () => {
  assert.equal(selectedDirectoryHealthTenant(ready), tenant)
  const renamed = { ...tenant, name: 'Renamed' }
  assert.equal(selectedDirectoryHealthTenant({ ...ready, tenants: [renamed] }), renamed)
})
for (const [label, changed] of Object.entries({
  'no intent': { selection: null },
  'identity loading': { authLoading: true },
  'signed out': { cacheScope: 'signed-out' },
  'bootstrap pending': { cacheScope: 'identity:a:bootstrap-pending' },
  'organization changed without new identity': { cacheScope: 'identity:a:organizations:org-b' },
  'A returned with a new generation': { identityToken: 'a:2' },
  'retained-data error': { listSuccessful: false },
  'tenant removed': { tenants: [] },
  'unsupported provider': { tenants: [{ ...tenant, provider: 'google' }] },
})) test(`selection is absent before effects when ${label}`, () => {
  assert.equal(selectedDirectoryHealthTenant({ ...ready, ...changed }), null)
})
