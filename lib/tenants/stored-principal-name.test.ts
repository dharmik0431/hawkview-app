import assert from 'node:assert/strict'
import test from 'node:test'
import { storedPrincipalNames, storedPrincipalName } from './stored-principal-name.ts'
const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
test('tenant-bound stored principal lookup accepts canonical and established alternate datasets', () => {
  const bundle = { tenant: { id: 'A' }, users: [{ id, name: '   ', email: 'alice@example.invalid' }],
    entra: { servicePrincipals: [{ objectId: 'sp-object', appId: 'client-id', displayName: 'Application' }] },
    groups: [{ id: 'group-id', name: 'Ops' }] }
  const names = storedPrincipalNames(bundle, 'A')
  assert.equal(storedPrincipalName(names, id.toUpperCase()), 'alice@example.invalid')
  assert.equal(storedPrincipalName(names, 'sp-object'), 'Application')
  assert.equal(storedPrincipalName(names, 'client-id'), null)
  assert.equal(storedPrincipalName(names, 'group-id'), 'Ops')
  assert.equal(storedPrincipalNames(bundle, 'B').size, 0)
  assert.equal(storedPrincipalName(storedPrincipalNames({ ...bundle, tenant: { id: 'B' }, users: [{ id, name: 'Bob' }] }, 'B'), id), 'Bob')
  assert.equal(storedPrincipalName(names, id), 'alice@example.invalid', 'no shared mutable index')
})
test('conflicts, blank names and ID labels do not create false resolutions; canonical empty wins', () => {
  const names = storedPrincipalNames({ tenant: { id: 'A' }, users: [
    { id, name: id }, { id: 'conflict', name: 'First' }, { id: 'CONFLICT', name: 'Second' }, { id: 'conflict', name: 'First' },
  ], entra: { enterpriseApplications: [] }, servicePrincipals: [{ id: 'old', displayName: 'Old snapshot' }] }, 'A')
  for (const key of [id, 'conflict', 'old', 'missing']) assert.equal(storedPrincipalName(names, key), null)
  for (const value of [null, [], {}, 'invalid']) assert.equal(storedPrincipalNames(value, 'A').size, 0)
})
