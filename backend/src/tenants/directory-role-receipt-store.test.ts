import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'
import { randomUUID } from 'node:crypto'
import type { AuthorityDatabase } from '../microsoft/managed-connector-authority.js'
import { captureRoleAttempt, claimRoleAttempt, completeRoleAttempt, finishRoleAttempt, DIRECTORY_ROLE_RECEIPT_SCOPE } from './directory-role-receipt-store.js'
const ctx=()=>({ organizationId:randomUUID(),customerTenantId:randomUUID(),microsoftTenantId:randomUUID(),configurationRevision:randomUUID(),connectionIncarnation:randomUUID(),scopeIncarnation:randomUUID(),scopeVersion:DIRECTORY_ROLE_RECEIPT_SCOPE,attemptId:randomUUID() })
const noDatabase:AuthorityDatabase={$transaction:async()=>{throw Error('unexpected database access')}}
test('bad authority identity and unsupported scope fail before database access',async()=>{
  await assert.rejects(claimRoleAttempt(noDatabase,{...ctx(),organizationId:'bad'}),/INVALID_ROLE_ID/)
  await assert.rejects(captureRoleAttempt(noDatabase,{...ctx(),microsoftTenantId:'bad'}),/INVALID_ROLE_ID/)
  await assert.rejects(claimRoleAttempt(noDatabase,{...ctx(),scopeVersion:'unapproved'}),/UNSUPPORTED_ROLE_SCOPE/)
})
test('prepared persistence boundary refuses over-count, over-bytes and malformed digest',async()=>{
  for(const rows of [Array.from({length:1001},()=>({})),['x'.repeat(180000)]]) {
    await assert.rejects(completeRoleAttempt(noDatabase,ctx(),{rows,contentDigest:'a'.repeat(64)},()=>[]),/INVALID_PREPARED|TOO_LARGE/)
  }
  await assert.rejects(completeRoleAttempt(noDatabase,ctx(),{rows:[],contentDigest:'bad'},()=>[]),/INVALID_PREPARED/)
})
test('current role terminal outcomes exclude generic SUCCEEDED or caller-supplied COMPLETE',async()=>{
  // Deliberately crossing the runtime boundary from an untyped caller.
  await assert.rejects(finishRoleAttempt(noDatabase,ctx(),'COMPLETE' as 'FAILED'),/INVALID_ROLE_OUTCOME/)
})


test('all role visit entry points reject mismatched owner scope before database access', async () => {
  const scope = ctx()
  for (const field of ['organizationId', 'customerTenantId'] as const) {
    const owner = { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
      token: randomUUID(), generation: 1n, expiresAt: new Date('2030-01-01'), [field]: randomUUID() }
    await assert.rejects(captureRoleAttempt(noDatabase, scope, owner), TenantVisitLeaseLostError)
    await assert.rejects(claimRoleAttempt(noDatabase, scope, owner), TenantVisitLeaseLostError)
    await assert.rejects(finishRoleAttempt(noDatabase, scope, 'FAILED', owner), TenantVisitLeaseLostError)
    await assert.rejects(completeRoleAttempt(noDatabase, scope, { rows: [], contentDigest: 'a'.repeat(64) }, () => [], owner), TenantVisitLeaseLostError)
  }
})


test('role publication rejects invalid audit revisions before database work', async () => {
  const scope = ctx()
  const owner = { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
    token: randomUUID(), generation: 1n, expiresAt: new Date('2030-01-01') }
  for (const revision of [0n, -1n, 9223372036854775808n]) {
    await assert.rejects(completeRoleAttempt(noDatabase, scope, { rows: [], contentDigest: 'a'.repeat(64) },
      () => [], owner, revision), /SNAPSHOT_RECEIPT_INVALID/)
  }
  await assert.rejects(completeRoleAttempt(noDatabase, scope, { rows: [], contentDigest: 'a'.repeat(64) },
    () => [], undefined, 2n), /SNAPSHOT_RECEIPT_INVALID/)
})
