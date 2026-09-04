import assert from 'node:assert/strict'
import test from 'node:test'
import { ManagedHmacPseudonymProvider } from './identity-risk-pseudonym.js'
import { mailboxKey, syntheticManagedProvider } from './mailbox-risk.test-fixtures.js'

test('managed MAC separates environment, tenant, organization, purpose and immutable version', async () => {
  const provider = syntheticManagedProvider()
  const pin = () => provider.pin(mailboxKey, Date.now() + 30000)
  const original = await (await pin()).reference('mailbox', ['synthetic-user'])
  assert.equal(await (await pin()).reference('mailbox', ['synthetic-user']), original)
  for (const key of [{ ...mailboxKey, environment: 'other' }, { ...mailboxKey, organizationId: mailboxKey.id },
    { ...mailboxKey, customerTenantId: mailboxKey.id }, { ...mailboxKey, id: mailboxKey.organizationId }]) {
    assert.notEqual(await (await provider.pin(key, Date.now() + 30000)).reference('mailbox', ['synthetic-user']), original)
  }
  assert.notEqual(await (await pin()).reference('evidence', ['synthetic-user']), original)
  const session = await pin()
  await assert.rejects(() => session.reference('mailbox', ['x'.repeat(4097)]), /KEY_UNAVAILABLE/)
  await assert.rejects(() => session.reference('mailbox', ['secret\nlog']), /KEY_UNAVAILABLE/)
  assert.notEqual(await session.reference('evidence', ['ab', 'c']), await session.reference('evidence', ['a', 'bc']))
})

test('disabled, foreign, malformed and timed-out provider responses fail safely without raw diagnostics', async () => {
  const valid = { keyId: mailboxKey.immutableKeyId, enabled: true, keySpec: 'HMAC_256', keyUsage: 'GENERATE_VERIFY_MAC' }
  for (const describe of [async () => ({ ...valid, enabled: false }), async () => ({ ...valid, keyId: 'foreign' }), async () => { throw new Error('token=DO-NOT-LOG') }]) {
    const provider = new ManagedHmacPseudonymProvider({ describe, generateMac: async () => { throw new Error('must not call') } })
    await assert.rejects(() => provider.pin(mailboxKey, Date.now() + 30000), { message: 'IDENTITY_RISK_KEY_UNAVAILABLE' })
  }
  const provider = new ManagedHmacPseudonymProvider({ describe: async () => valid,
    generateMac: async () => ({ keyId: mailboxKey.immutableKeyId, macAlgorithm: 'HMAC_SHA_256', mac: new Uint8Array(2) }) })
  await assert.rejects(() => provider.pin(mailboxKey, Date.now() - 1), /KEY_UNAVAILABLE/)
  await assert.rejects(() => provider.pin({ ...mailboxKey, immutableKeyId: 'alias/mutable' }, Date.now() + 30000), /KEY_UNAVAILABLE/)
  const session = await provider.pin(mailboxKey, Date.now() + 30000)
  await assert.rejects(() => session.reference('mailbox', ['synthetic']), /KEY_UNAVAILABLE/)
})
