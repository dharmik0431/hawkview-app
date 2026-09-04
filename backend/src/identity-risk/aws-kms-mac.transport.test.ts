import assert from 'node:assert/strict'
import test from 'node:test'
import { DescribeKeyCommand, GenerateMacCommand, type KMSClient } from '@aws-sdk/client-kms'
import { AwsKmsMacTransport } from './aws-kms-mac.transport.js'
import { ManagedHmacPseudonymProvider } from './identity-risk-pseudonym.js'
import { mailboxKey } from './mailbox-risk.test-fixtures.js'

test('SDK transport pins ARN/algorithm, forwards abort and disables implicit retry amplification', async () => {
  const commands: unknown[] = []
  const client = { config: { maxAttempts: async () => 1 }, send: async (command: unknown, options: { abortSignal: AbortSignal }) => {
    commands.push(command); assert.ok(options.abortSignal instanceof AbortSignal)
    if (command instanceof DescribeKeyCommand) {
      assert.deepEqual(command.input, { KeyId: mailboxKey.immutableKeyId })
      return { KeyMetadata: { Arn: mailboxKey.immutableKeyId, KeyState: 'Enabled', KeySpec: 'HMAC_256', KeyUsage: 'GENERATE_VERIFY_MAC' } }
    }
    assert.ok(command instanceof GenerateMacCommand)
    assert.equal(command.input.KeyId, mailboxKey.immutableKeyId)
    assert.equal(command.input.MacAlgorithm, 'HMAC_SHA_256')
    return { KeyId: mailboxKey.immutableKeyId, MacAlgorithm: 'HMAC_SHA_256', Mac: new Uint8Array(32).fill(1) }
  } } as unknown as KMSClient
  const session = await new ManagedHmacPseudonymProvider(new AwsKmsMacTransport(client)).pin(mailboxKey, Date.now() + 30000)
  await session.reference('mailbox', ['synthetic'])
  await session.reference('mailbox', ['synthetic'])
  assert.equal(commands.length, 2)
  const unsafeClient = { config: { maxAttempts: async () => 3 }, send: async () => { throw new Error('must not send') } } as unknown as KMSClient
  await assert.rejects(() => new AwsKmsMacTransport(unsafeClient).describe(mailboxKey.immutableKeyId, new AbortController().signal), /KEY_UNAVAILABLE/)
})
