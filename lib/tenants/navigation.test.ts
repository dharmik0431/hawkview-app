import assert from 'node:assert/strict'
import test from 'node:test'
import {
  legacyRiskyUsersRedirect,
  parseTenantPath,
  tenantEntraPath,
  tenantRiskyUsersPath,
  tenantSectionPath,
} from './navigation.ts'

const tenantId = 'synthetic-tenant'

test('Risky Users is addressable at tenant top level', () => {
  assert.equal(
    tenantRiskyUsersPath(tenantId),
    '/tenants/synthetic-tenant/risky-users'
  )
  assert.equal(
    tenantSectionPath(tenantId, 'risky-users'),
    '/tenants/synthetic-tenant/risky-users'
  )

  const parsed = parseTenantPath(
    '/tenants/synthetic-tenant/risky-users',
    tenantId
  )
  assert.equal(parsed.section, 'risky-users')
  assert.equal(parsed.canonicalPath, '/tenants/synthetic-tenant/risky-users')
})

test('tenant ids are encoded in the path', () => {
  assert.equal(tenantRiskyUsersPath('a b/c'), '/tenants/a%20b%2Fc/risky-users')
})

test('the old four-level address redirects instead of dying', () => {
  // It used to live here, framed as a Microsoft Entra feature.
  const legacy = '/tenants/synthetic-tenant/entra/security/identity-risk'
  assert.equal(
    legacyRiskyUsersRedirect(legacy, tenantId),
    '/tenants/synthetic-tenant/risky-users'
  )
  assert.equal(
    legacyRiskyUsersRedirect(`${legacy}/`, tenantId),
    '/tenants/synthetic-tenant/risky-users'
  )
})

test('no other address is redirected', () => {
  for (const path of [
    '/tenants/synthetic-tenant/entra/security/policies',
    '/tenants/synthetic-tenant/entra/security',
    '/tenants/synthetic-tenant/entra/overview',
    '/tenants/synthetic-tenant/risky-users',
    '/tenants/other-tenant/entra/security/identity-risk',
    '/dashboard',
  ]) {
    assert.equal(legacyRiskyUsersRedirect(path, tenantId), null, path)
  }
})

test('the Entra security tabs no longer route to identity risk', () => {
  // The segment is gone from the Entra security area, so an unknown security
  // view falls back to policies rather than resolving to a tab that is no
  // longer rendered there.
  const parsed = parseTenantPath(
    '/tenants/synthetic-tenant/entra/security/identity-risk',
    tenantId
  )
  assert.equal(parsed.section, 'entra')
  assert.equal(parsed.securityView, 'policies')
  assert.equal(
    parsed.canonicalPath,
    '/tenants/synthetic-tenant/entra/security/policies'
  )
  assert.equal(
    tenantEntraPath(tenantId, 'security', 'policies'),
    '/tenants/synthetic-tenant/entra/security/policies'
  )
})
