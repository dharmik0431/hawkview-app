import assert from 'node:assert/strict'
import test from 'node:test'
import { tenantNameFromBundleResponse } from './tenant-api-view.ts'

test('reads the canonical tenant bundle response used by the top bar', () => {
  assert.equal(
    tenantNameFromBundleResponse({ bundle: { tenant: { name: 'Biolink Online' } } }),
    'Biolink Online',
  )
})

test('does not accept the obsolete response shape or inherited values', () => {
  assert.equal(tenantNameFromBundleResponse({ tenant: { name: 'Wrong shape' } }), null)
  assert.equal(tenantNameFromBundleResponse(Object.create({ bundle: { tenant: { name: 'Inherited' } } })), null)
})
