import { DescribeKeyCommand, GenerateMacCommand, type KMSClient } from '@aws-sdk/client-kms'
import type { ManagedMacTransport } from './identity-risk-pseudonym.js'

/** No default credentials/region/client construction: activation supplies a reviewed workload client. */
export class AwsKmsMacTransport implements ManagedMacTransport {
  constructor(private readonly client: KMSClient) {}

  async describe(keyId: string, signal: AbortSignal) {
    // No retry amplification inside the bounded sync lane.
    if (await this.client.config.maxAttempts() !== 1) throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
    const output = await this.client.send(new DescribeKeyCommand({ KeyId: keyId }), { abortSignal: signal })
    return { keyId: output.KeyMetadata?.Arn ?? '', enabled: output.KeyMetadata?.KeyState === 'Enabled',
      keySpec: output.KeyMetadata?.KeySpec ?? '', keyUsage: output.KeyMetadata?.KeyUsage ?? '' }
  }

  async generateMac(keyId: string, message: Uint8Array, algorithm: 'HMAC_SHA_256', signal: AbortSignal) {
    const output = await this.client.send(new GenerateMacCommand({ KeyId: keyId, Message: message, MacAlgorithm: algorithm }), { abortSignal: signal })
    return { keyId: output.KeyId ?? '', macAlgorithm: output.MacAlgorithm ?? '', mac: output.Mac ?? new Uint8Array() }
  }
}
