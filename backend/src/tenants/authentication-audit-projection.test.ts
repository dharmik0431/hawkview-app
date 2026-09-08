import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectAuthenticationAuditRecord as project, projectAuthenticationAuditPageRow, reportedAuthenticationErrorCode as code } from './authentication-audit-projection.js'

test('malformed applicable STS page records cannot disappear into a clean empty collection',()=>{
  const valid={RecordType:15,Operation:'UserLoginFailed',Id:'synthetic',CreationTime:'2026-09-08T21:00:00Z'}
  for(const change of [{Id:null},{Id:''},{CreationTime:null},{CreationTime:'invalid'},{CreationTime:{access_token:'SYNTHETIC'}}]) {
    assert.throws(()=>[valid,{...valid,...change}].map(projectAuthenticationAuditPageRow),/IDENTITY_AUTH_APPLICABLE_RECORD_INVALID/)
  }
  assert.equal([valid,{RecordType:1,Operation:'Unrelated'}].map(projectAuthenticationAuditPageRow).length,2)
})

test('audit compaction retains qualified source bindings but not arbitrary private fields', () => {
  const source = { RecordType: 15, ApplicationId: 'app-id', ActorIpAddress: '192.0.2.1',
    OrganizationId: 'tenant-id', ActorContextId: 'tenant-id', UserType: 0,
    Actor: [{ ID: 'subject-id', Type: 0, access_token: 'PRIVATE' }],
    password: 'PRIVATE', debug: { secret: 'PRIVATE' } }
  const row = project(source)
  assert.equal(row.ApplicationId, source.ApplicationId)
  assert.equal(row.ActorIpAddress, source.ActorIpAddress)
  assert.equal(row.OrganizationId, source.OrganizationId)
  assert.deepEqual(row.Actor, [{ ID: 'subject-id', Type: 0 }])
  assert.equal(JSON.stringify(row).includes('PRIVATE'), false)
})
test('generic ResultStatus or operation never fabricates successful authentication', () => {
  for (const row of [{ ResultStatus: 'Succeeded' }, { Operation: 'UserLoggedIn' },
    { Operation: 'UserLoggedIn', ErrorCode: '' }, { Operation: 'UserLoggedIn', ErrorCode: 0, LoginStatus: 50126 },
    { Operation: 'UserLoginFailed', ErrorCode: 0 }]) assert.equal(code(project(row)), null)
  assert.equal(code(project({ Operation: 'UserLoggedIn', ErrorCode: 0 })), 0)
  assert.equal(code(project({ Operation: 'UserLoginFailed', ErrorCode: '50126' })), 50126)
})
test('unrecognized diagnostics fail closed without storing their private text', () => {
  for (const secret of ['password=top secret phrase', { access_token: ['PRIVATE'] }, 'X'.repeat(1000)]) {
    const row = project({ Operation: 'UserLoggedIn', ErrorCode: 0, LogonError: secret })
    assert.equal(row.LogonError, 'UnclassifiedAuthenticationError')
    assert.equal(code(row), null)
    assert.equal(JSON.stringify(row).includes('PRIVATE'), false)
    assert.equal(JSON.stringify(row).includes('top secret phrase'), false)
  }
  const row = project({ Operation: 'UserLoggedIn', ErrorCode: 0,
    ExtendedProperties: [{ Name: 'LogonError', Value: { password: 'PRIVATE' } }] })
  assert.equal(code(row), null)
  assert.equal(JSON.stringify(row).includes('PRIVATE'), false)
})
test('inherited, oversized and unsupported nested fields do not pass through projection', () => {
  assert.throws(() => project(Object.create({ ErrorCode: 0 })))
  assert.equal(project({ ApplicationId: 'X'.repeat(513) }).ApplicationId, null)
  assert.equal(project({ ClientIP: { secret: 'PRIVATE' } }).ClientIP, null)
  assert.equal(project({ Application: 'name\nsecret' }).Application, null)
  assert.equal(code(project({ Operation: 'UserLoggedIn', ErrorCode: 0, ExtendedProperties: Array(65).fill({}) })), null)
})
