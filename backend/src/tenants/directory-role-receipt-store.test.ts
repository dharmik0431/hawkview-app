import assert from 'node:assert/strict'
import test from 'node:test'
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
