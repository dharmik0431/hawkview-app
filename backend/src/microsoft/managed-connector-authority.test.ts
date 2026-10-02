import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { publishManagedAuthority, withManagedAuthority, type AuthorityDatabase, type PreparedManagedPublication } from './managed-connector-authority.js'

function request(): PreparedManagedPublication {
  return { expectedRevision: null, revision: randomUUID(), operationId: randomUUID(),
    clientId: randomUUID(), homeTenantId: randomUUID(), credentialExpiresAt: null,
    sealed: { ciphertext: Buffer.from('synthetic'), initializationVector: Buffer.alloc(12),
      authenticationTag: Buffer.alloc(16), keyVersion: 1 } }
}
const neverDatabase: AuthorityDatabase = { $transaction: async () => { throw new Error('DATABASE_TOUCHED') } }
for (const field of ['revision', 'operationId', 'clientId', 'homeTenantId', 'expectedRevision'] as const) {
  test(`reject malformed ${field} before DB access`, async () => {
    await assert.rejects(publishManagedAuthority(neverDatabase, { ...request(), [field]: 'invalid' }), /INVALID_MANAGED_AUTHORITY_ID/)
  })
}
for (const [name, change] of [
  ['empty ciphertext', { ciphertext: Buffer.alloc(0) }],
  ['oversized ciphertext', { ciphertext: Buffer.alloc(65537) }],
  ['wrong IV', { initializationVector: Buffer.alloc(11) }],
  ['wrong tag', { authenticationTag: Buffer.alloc(15) }],
  ['zero version', { keyVersion: 0 }],
  ['fractional version', { keyVersion: 1.5 }],
  ['overflow version', { keyVersion: 2147483648 }],
] as const) {
  test(`reject ${name} before DB access`, async () => {
    const input = request()
    await assert.rejects(publishManagedAuthority(neverDatabase, { ...input, sealed: { ...input.sealed, ...change } }), /INVALID_MANAGED_PUBLICATION/)
  })
}
test('invalid date and authority expectation fail before transaction', async () => {
  await assert.rejects(publishManagedAuthority(neverDatabase, { ...request(), credentialExpiresAt: new Date(NaN) }), /INVALID_MANAGED_PUBLICATION/)
  await assert.rejects(withManagedAuthority(neverDatabase, 'invalid', async () => undefined), /INVALID_MANAGED_AUTHORITY_ID/)
})
