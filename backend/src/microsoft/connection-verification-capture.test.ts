import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { CapturedVerificationCredentialsUnavailable, MicrosoftConsentService } from './microsoft-consent.service.js'

test('captured verifier keeps the immutable reference/client/tenant across awaits without recapture', async () => {
  const revision = randomUUID(), authority = { configurationRevision: revision, clientId: randomUUID(), homeTenantId: randomUUID(), credentialReference: `encrypted-secret:${revision}` }
  const input = { microsoftTenantId: randomUUID(), authority }, before = structuredClone(input)
  let release!: (value: string) => void
  const secret = new Promise<string>(resolve => { release = resolve })
  const references: string[] = [], calls: unknown[] = []
  const service = new MicrosoftConsentService({} as any, { access: async (reference: string) => { references.push(reference); return secret } } as any)
  ;(service as any).getManagedConnector = () => { throw Error('unexpected configuration recapture') }
  service.verifyTenantWithCredentials = async (tenant, credentials) => {
    calls.push({ tenant, credentials })
    return { displayName: 'Synthetic', primaryDomain: null, grantedPermissions: [], missingPermissions: [], missingRequiredPermissions: [], missingNonConnectionPermissions: [] }
  }
  const pending = service.verifyCapturedConnectedTenant(input)
  input.microsoftTenantId = randomUUID(); input.authority.clientId = randomUUID(); input.authority.credentialReference = 'changed'
  release('injected-secret'); await pending
  assert.deepEqual(references, [before.authority.credentialReference])
  assert.deepEqual(calls, [{ tenant: before.microsoftTenantId, credentials: { clientId: before.authority.clientId, clientSecret: 'injected-secret' } }])
})

test('captured verifier refuses a mutable reference before reading credentials', async () => {
  let reads = 0
  const service = new MicrosoftConsentService({} as any, { access: async () => { reads++; throw Error('unexpected access') } } as any)
  await assert.rejects(service.verifyCapturedConnectedTenant({ microsoftTenantId: randomUUID(), authority: {
    configurationRevision: randomUUID(), clientId: randomUUID(), homeTenantId: randomUUID(), credentialReference: 'mutable-legacy-reference',
  } }), CapturedVerificationCredentialsUnavailable)
  assert.equal(reads, 0)
})

test('captured verifier makes one verification call and propagates provider failure', async () => {
  const revision = randomUUID(); let calls = 0
  const service = new MicrosoftConsentService({} as any, { access: async () => 'injected-secret' } as any)
  service.verifyTenantWithCredentials = async () => { calls++; throw Error('injected-provider-failure') }
  await assert.rejects(service.verifyCapturedConnectedTenant({ microsoftTenantId: randomUUID(), authority: {
    configurationRevision: revision, clientId: randomUUID(), homeTenantId: randomUUID(), credentialReference: `encrypted-secret:${revision}`,
  } }), /injected-provider-failure/)
  assert.equal(calls, 1)
})

test('shared writer token seam retains captured credentials across awaits and validates Exchange-only consent', async () => {
  for (const exchange of [false,true]) {
    const revision=randomUUID(),tenant=randomUUID(),authority={configurationRevision:revision,clientId:randomUUID(),homeTenantId:randomUUID(),credentialReference:`encrypted-secret:${revision}`}
    const original=structuredClone(authority);let release!:(value:string)=>void
    const pendingSecret=new Promise<string>(resolve=>{release=resolve});const calls:any[]=[]
    const service:any=new MicrosoftConsentService({} as any,{access:async(reference:string)=>{assert.equal(reference,original.credentialReference);return pendingSecret}} as any)
    service.getManagedConnector=()=>{throw Error('unexpected recapture')}
    service.requestAccessToken=async(...args:any[])=>{calls.push(args);return {accessToken:'captured',grantedPermissions:['Exchange.ManageAsAppV2'],directoryRoleIds:[]}}
    const pending=service.getCapturedManagedAccessToken(authority,tenant,exchange)
    authority.clientId=randomUUID();authority.credentialReference='changed';release('synthetic-secret')
    assert.equal(await pending,'captured')
    assert.deepEqual(calls,[[tenant,{clientId:original.clientId,clientSecret:'synthetic-secret'},exchange?'https://outlook.office365.com/.default':undefined]])
    service.requestAccessToken=async()=>({accessToken:'broad',grantedPermissions:['Exchange.ManageAsAppV2'],directoryRoleIds:['broad-role']})
    if(exchange) await assert.rejects(service.getCapturedManagedAccessToken(original,tenant,true),/Get-Mailbox-only/)
  }
})
test('shared token credential preparation failures never call the provider', async () => {
  for(const fail of ['missing','empty','mutable'] as const) {
    const revision=randomUUID(),authority={configurationRevision:revision,clientId:randomUUID(),homeTenantId:randomUUID(),credentialReference:fail==='mutable'?'legacy':`encrypted-secret:${revision}`}
    let calls=0,reads=0
    const service:any=new MicrosoftConsentService({} as any,{access:async()=>{reads++;if(fail==='missing')throw Error('private-store-detail');return ''}} as any)
    service.requestAccessToken=()=>{calls++;throw Error('unexpected provider')}
    await assert.rejects(service.getCapturedManagedAccessToken(authority,randomUUID()),CapturedVerificationCredentialsUnavailable)
    assert.equal(calls,0);assert.equal(reads,fail==='mutable'?0:1)
  }
})
