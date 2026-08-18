import assert from 'node:assert/strict'
import test from 'node:test'
import { investigateDestination } from './investigate-navigation.ts'

const tenantId = '123e4567-e89b-42d3-a456-426614174000'

test('preserves the backend M365 audit investigation route for dashboard and modal consumers', () => {
  const route = `/tenants/${tenantId}/settings?section=sync&resource=M365_AUDIT`
  assert.equal(investigateDestination(route, '/fallback'), route)
})

test('uses the caller fallback for absent or unsafe investigation routes', () => {
  assert.equal(investigateDestination(undefined, '/fallback'), '/fallback')
  assert.equal(investigateDestination('https://example.test', '/fallback'), '/fallback')
})

test('rejects protocol-relative, encoded, credential and control-character redirect forms', () => {
  const fallback = '/fallback'
  for (const value of [
    '//evil.example', '/\\evil.example', '\\\\evil.example', '/%2f%2fevil.example', '/%5cevil.example',
    'javascript:alert(1)', 'https://evil.example', ` /tenants/${tenantId}/settings`, `/tenants/${tenantId}/settings `,
    `/tenants/${tenantId}/settings\n`, '/%ZZ', '/what-changed%00?tenantId=tenant-1',
    '/tenants/../settings', '/tenants/%252e%252e/settings', '/tenants/%EF%BC%8Fsettings',
    '/tenants/123e4567-e89b-42d3-a456-426614174000%2Fsettings', '/tenants/not-a-uuid/settings',
  ]) assert.equal(investigateDestination(value, fallback), fallback, value)
})

test('canonicalizes only approved internal tenant and investigation routes', () => {
  assert.equal(
    investigateDestination(`/tenants/${tenantId.toUpperCase()}/settings?section=sync&resource=M365_AUDIT`, '/fallback'),
    `/tenants/${tenantId}/settings?section=sync&resource=M365_AUDIT`,
  )
  assert.equal(investigateDestination('/what-changed?tenantId=tenant-1', '/fallback'), '/what-changed?tenantId=tenant-1')
  assert.equal(investigateDestination('/dashboard', '/fallback'), '/fallback')
})
