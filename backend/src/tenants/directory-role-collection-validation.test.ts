import assert from 'node:assert/strict'
import test from 'node:test'
import { directoryRolePage, prepareDirectoryRoles } from './directory-role-collection-validation.js'
const guid = '11111111-1111-4111-8111-111111111111'
const row = (id = 'assignment') => ({ id, principalId: guid, roleDefinitionId: guid, directoryScopeId: '/',
  appScopeId: null, roleDefinition: { id: guid, displayName: 'Role', templateId: guid } })
test('closed projection, detached canonical rows and stable digest include valid empty completion', () => {
  const a = row('a'), b = row('b')
  const prepared = prepareDirectoryRoles([{ ...b, privateField: 'omit' }, a])
  assert.deepEqual(prepared, prepareDirectoryRoles([a, b]))
  a.roleDefinition.displayName = 'mutated'
  assert.equal((prepared.rows[0] as any).roleDefinition.displayName, 'Role')
  assert.equal(JSON.stringify(prepared.rows).includes('privateField'), false)
  assert.equal(prepareDirectoryRoles([]).rows.length, 0)
})
test('malformed identities, expansion, duplicate, scopes and bounds reject the complete set', () => {
  for (const value of [null, {}, { ...row(), principalId: 'bad' }, { ...row(), roleDefinition: null },
    { ...row(), roleDefinition: { ...row().roleDefinition, id: '22222222-2222-4222-8222-222222222222' } },
    { ...row(), directoryScopeId: null }, { ...row(), appScopeId: '/app' },
    { ...row(), directoryScopeId: 'https://bad' }, { ...row(), id: 'x\n' }]) {
    assert.throws(() => prepareDirectoryRoles([value]), /INCOMPLETE/)
  }
  assert.throws(() => prepareDirectoryRoles([row(), row()]), /INCOMPLETE/)
  assert.throws(() => prepareDirectoryRoles(Array.from({ length: 1001 }, (_, i) => row(String(i)))), /INCOMPLETE/)
  assert.throws(() => prepareDirectoryRoles(Array.from({ length: 700 }, (_, i) => row(String(i)))), /INCOMPLETE/)
})
test('page completion is explicit; errors, delta, null/empty next links and malformed envelopes reject', () => {
  assert.deepEqual(directoryRolePage({ value: [] }), { rows: [], next: null })
  for (const page of [null, [], {}, { value: null }, { value: [], error: {} },
    { value: [], '@odata.nextLink': '' }, { value: [], '@odata.nextLink': null },
    { value: [], '@odata.deltaLink': 'link' }]) assert.throws(() => directoryRolePage(page), /INCOMPLETE/)
})
