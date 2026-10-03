import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { SignJWT } from 'jose'
import { MicrosoftConsentService } from '../microsoft/microsoft-consent.service.js'
import { TenantsService } from './tenants.service.js'

const configuration={stateSecret:'synthetic-consent-signing-secret-at-least-32-bytes',redirectUri:'https://fixture.invalid/callback'}
function microsoft() {
  const service=new MicrosoftConsentService({} as any,{} as any)
  ;(service as any).getStateConfiguration=async()=>configuration
  return service
}
test('issued URL binds nonce, operation, captured client and committed expiry',async()=>{
  const service=microsoft(),nonce='synthetic-nonce',operationId=randomUUID(),clientId=randomUUID(),tenant=randomUUID(),organizationId=randomUUID()
  const stateHash=createHash('sha256').update(nonce).digest('hex'),expiresAt=new Date(Date.now()+60000)
  const url=new URL(await service.createIssuedConsentUrl({nonce,stateHash,configuration,authority:{clientId,configurationRevision:randomUUID(),homeTenantId:randomUUID(),credentialReference:'synthetic'}} as any,
    {operation:{operationId,organizationId,customerTenantId:tenant,flow:'EXISTING_TENANT',stateHash},expiresAt},tenant))
  assert.equal(url.searchParams.get('client_id'),clientId)
  const parsed=await service.verifyConsentState(url.searchParams.get('state')!)
  assert.deepEqual(parsed,{operationVersion:1,operationId,customerTenantId:tenant,organizationId,nonce,flow:'existing-tenant'})
  await assert.rejects(service.createIssuedConsentUrl({nonce:'wrong',configuration} as any,
    {operation:{operationId,organizationId,customerTenantId:tenant,flow:'EXISTING_TENANT',stateHash},expiresAt},tenant),/NONCE_MISMATCH/)
})
test('malformed versioned state cannot fall back into discovery or Exchange',async()=>{
  const service=microsoft()
  for(const fields of [{operationVersion:2,operationId:randomUUID(),flow:'existing-tenant'},
    {operationVersion:1,operationId:randomUUID(),flow:'discover-tenant'},
    {operationVersion:1,operationId:randomUUID(),flow:'exchange-readonly'},
    {operationVersion:1,operationId:'bad',flow:'existing-tenant'}]) {
    const signed=await new SignJWT({organizationId:randomUUID(),customerTenantId:randomUUID(),nonce:'synthetic',...fields})
      .setProtectedHeader({alg:'HS256'}).setExpirationTime('1m').setIssuer('hawkview-api').setAudience('microsoft-admin-consent')
      .sign(new TextEncoder().encode(configuration.stateSecret))
    await assert.rejects(service.verifyConsentState(signed),/operation state is invalid/)
  }
})
test('legacy existing callback never reaches old consumption or provider',async()=>{
  const service=new TenantsService({} as any,{verifyConsentState:async()=>({flow:'existing-tenant',organizationId:randomUUID(),customerTenantId:randomUUID(),nonce:'legacy'})} as any,{} as any)
  ;(service as any).consumeConsentAttempt=()=>{throw Error('legacy consumer entered')}
  ;(service as any).buildFrontendConsentRedirect=(result:string,error:string)=>({result,error})
  assert.deepEqual(await service.completeMicrosoftConsent({state:'synthetic'}),{result:'error',error:'expired-or-used-state'})
})
test('unauthorized issuance stops before operation or URL creation',async()=>{
  const service=new TenantsService({customerTenant:{findFirst:async()=>null}} as any,{} as any,{} as any)
  ;(service as any).getAccessibleOrganizationIds=async()=>[]
  await assert.rejects(service.createConsentUrlForIdentity({subject:'synthetic'} as any,randomUUID()),/not found/)
})
test('verification retries keep one captured credential and deadline',async()=>{
  const refs:string[]=[],calls:any[]=[]
  const service=new MicrosoftConsentService({} as any,{access:async(ref:string)=>{refs.push(ref);return 'synthetic-secret'}} as any)
  ;(service as any).getManagedConnector=()=>{throw Error('recaptured managed authority')}
  const deadline=new Date(Date.now()+60000)
  service.verifyTenantWithCredentials=async(tenant,credentials,deadlineAt)=>{
    calls.push({tenant,credentials,deadlineAt})
    return {displayName:'Synthetic',primaryDomain:null,grantedPermissions:[],missingPermissions:calls.length===1?['Directory.Read.All']:[],missingRequiredPermissions:[],missingNonConnectionPermissions:[]}
  }
  const context={microsoftTenantId:randomUUID(),clientId:randomUUID(),credentialReference:'encrypted-secret:'+randomUUID(),finalDeadline:deadline} as any
  await service.verifyClaimedTenantAfterConsent(context)
  assert.deepEqual(refs,[context.credentialReference]);assert.equal(calls.length,2)
  for(const call of calls)assert.deepEqual(call,{tenant:context.microsoftTenantId,credentials:{clientId:context.clientId,clientSecret:'synthetic-secret'},deadlineAt:deadline.getTime()})
  const prior=refs.length
  await assert.rejects(service.verifyClaimedTenantAfterConsent({...context,finalDeadline:new Date(0)}),/EXPIRED/)
  assert.equal(refs.length,prior)
})
