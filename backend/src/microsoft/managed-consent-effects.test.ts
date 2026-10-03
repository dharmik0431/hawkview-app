import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { applyManagedConsentEffects } from './managed-consent-effects.js'
const key={organizationId:randomUUID(),customerTenantId:randomUUID(),operationId:randomUUID(),flow:'EXISTING_TENANT' as const,stateHash:'a'.repeat(64)}
test('malformed effect identity cannot enter persistence',async()=>{
  let calls=0
  const db={async $transaction(){calls++;throw Error('unexpected')}}
  for(const change of [{organizationId:'bad'},{customerTenantId:'bad'},{operationId:'bad'},{stateHash:'bad'},{flow:'DISCOVER_TENANT'}]) {
    await assert.rejects(applyManagedConsentEffects(db,{...key,...change} as any),/INVALID_CONSENT_EFFECT_KEY/)
  }
  assert.equal(calls,0)
})
test('persistence failure is unavailable rather than an authority failure',async()=>{
  assert.equal(await applyManagedConsentEffects({async $transaction(){throw Error('synthetic sensitive connection data')}},key),'unavailable')
})
