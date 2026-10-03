import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { issueConsentOperation, claimConsentOperation, finishConsentOperation } from './consent-operation-store.js'
import type { AuthorityDatabase } from './managed-connector-authority.js'
const db: AuthorityDatabase = { async $transaction() { throw Error('unexpected transaction') } }
const who = { organizationId:randomUUID(),customerTenantId:randomUUID(),flow:'EXISTING_TENANT' as const }
const issue = { ...who,microsoftTenantId:randomUUID(),configurationRevision:randomUUID(),expectedConnectionIncarnation:null,stateHash:'a'.repeat(64) }
const key = { ...who,operationId:randomUUID(),stateHash:'a'.repeat(64),claimId:randomUUID() }
test('unsupported flow and malformed identities cannot enter transactions', async()=>{
  for(const flow of ['DISCOVER_TENANT','EXCHANGE_READ_ONLY',null,'']) {
    await assert.rejects(issueConsentOperation(db,{...issue,flow:flow as any}),/UNSUPPORTED_CONSENT_FLOW/)
    await assert.rejects(claimConsentOperation(db,{...key,flow:flow as any}),/UNSUPPORTED_CONSENT_FLOW/)
    await assert.rejects(finishConsentOperation(db,{...key,flow:flow as any},{outcome:'FAILED',code:'CONSENT_DENIED'}),/UNSUPPORTED_CONSENT_FLOW/)
  }
  for(const field of ['organizationId','customerTenantId','operationId','claimId'])await assert.rejects(
    finishConsentOperation(db,{...key,[field]:'bad'},{outcome:'FAILED',code:'CONSENT_DENIED'}),/INVALID_CONSENT_ID/)
  for(const stateHash of ['', 'A'.repeat(64),'a'.repeat(63),null])await assert.rejects(claimConsentOperation(db,{...key,stateHash:stateHash as any}),/INVALID_CONSENT_STATE_HASH/)
})
test('only bounded prepared results enter persistence; raw provider errors are not accepted',async()=>{
  for(const value of [
    {outcome:'FAILED',code:'Bearer synthetic-secret'}, {outcome:'FAILED',code:null}, {outcome:'OTHER'},
    {outcome:'SUCCEEDED',displayName:'',primaryDomain:null,grantedPermissions:[]},
    {outcome:'SUCCEEDED',displayName:'x'.repeat(201),primaryDomain:null,grantedPermissions:[]},
    {outcome:'SUCCEEDED',displayName:'fixture',primaryDomain:'x'.repeat(254),grantedPermissions:[]},
    {outcome:'SUCCEEDED',displayName:'fixture',primaryDomain:null,grantedPermissions:['https://unexpected']},
    {outcome:'SUCCEEDED',displayName:'fixture',primaryDomain:null,grantedPermissions:Array(201).fill('Directory.Read.All')},
  ])await assert.rejects(finishConsentOperation(db,key,value as any),/INVALID_CONSENT_RESULT/)
})
