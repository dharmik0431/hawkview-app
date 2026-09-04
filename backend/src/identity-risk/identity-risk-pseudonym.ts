import { Injectable } from '@nestjs/common'
import { isIdentityRiskOpaqueReferenceKind } from './identity-risk.validation.js'

export type PseudonymScope = Readonly<{ organizationId: string; customerTenantId: string; environment: string }>
export type PseudonymKeyVersion = PseudonymScope & Readonly<{
  id: string; provider: 'AWS_KMS_HMAC_256'; immutableKeyId: string
}>
export type PseudonymPurpose = 'mailbox' | 'evidence' | 'observation'
export interface PinnedPseudonymSession {
  readonly keyVersion: PseudonymKeyVersion
  reference(purpose: PseudonymPurpose, identifiers: readonly string[]): Promise<string>
}

/** No runtime fake, app-secret fallback, or implicit provisioning. */
@Injectable()
export class IdentityRiskPseudonymProvider {
  readonly configured: boolean = false
  async pin(_key: PseudonymKeyVersion, _deadlineAt: number): Promise<PinnedPseudonymSession> {
    throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
  }
}

export interface ManagedMacTransport {
  describe(keyId: string, signal: AbortSignal): Promise<{ keyId: string; enabled: boolean; keySpec: string; keyUsage: string }>
  generateMac(keyId: string, message: Uint8Array, algorithm: 'HMAC_SHA_256', signal: AbortSignal): Promise<{ keyId: string; macAlgorithm: string; mac: Uint8Array }>
}

/** Transport is deliberately supplied separately: no credentials, account, region or SDK default chain here. */
export class ManagedHmacPseudonymProvider extends IdentityRiskPseudonymProvider {
  override readonly configured = true
  constructor(private readonly transport: ManagedMacTransport) { super() }
  override async pin(key: PseudonymKeyVersion, deadlineAt: number): Promise<PinnedPseudonymSession> {
    const validId = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i
    if (key.provider !== 'AWS_KMS_HMAC_256' || !validId.test(key.id) || !validId.test(key.organizationId) || !validId.test(key.customerTenantId) ||
      !/^[a-z][a-z0-9-]{0,39}$/.test(key.environment) || !/^arn:aws(?:-us-gov|-cn)?:kms:[a-z0-9-]+:\d{12}:key\/[a-f0-9-]{36}$/.test(key.immutableKeyId)) throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
    const pinned = Object.freeze({ ...key })
    let calls = 0
    // Run-local deduplication only; raw input never leaves this bounded lifetime except to managed KMS.
    const cache = new Map<string, string>()
    const bounded = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const remaining = Math.min(5000, deadlineAt - Date.now())
      if (remaining <= 0 || ++calls > 6002) throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([work(controller.signal), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('IDENTITY_RISK_KEY_UNAVAILABLE')) }, remaining)
        })])
      } catch { throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE') }
      finally { if (timer) clearTimeout(timer) }
    }
    const state = await bounded((signal) => this.transport.describe(pinned.immutableKeyId, signal))
    if (state.keyId !== pinned.immutableKeyId || !state.enabled || state.keySpec !== 'HMAC_256' || state.keyUsage !== 'GENERATE_VERIFY_MAC') throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
    return Object.freeze({ keyVersion: pinned, reference: async (purpose: PseudonymPurpose, identifiers: readonly string[]) => {
      if (!['mailbox', 'evidence', 'observation'].includes(purpose) || identifiers.length === 0 || identifiers.length > 8 || identifiers.some((id) => typeof id !== 'string' || !id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id))) throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
      // JSON array encoding is unambiguous and length-bounded; all separation domains are included.
      const message = JSON.stringify(['hvr1', pinned.environment, pinned.organizationId, pinned.customerTenantId, purpose, pinned.id, ...identifiers])
      if (Buffer.byteLength(message) > 4096 || Date.now() >= deadlineAt) throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
      const cached = cache.get(message)
      if (cached) return cached
      const result = await bounded((signal) => this.transport.generateMac(pinned.immutableKeyId, Buffer.from(message), 'HMAC_SHA_256', signal))
      if (result.keyId !== pinned.immutableKeyId || result.macAlgorithm !== 'HMAC_SHA_256' || !(result.mac instanceof Uint8Array) || result.mac.length !== 32) throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
      const reference = `hvr1_${purpose}_${Buffer.from(result.mac).toString('hex')}`
      if (!isIdentityRiskOpaqueReferenceKind(reference, purpose) || cache.size >= 6001) throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
      cache.set(message, reference)
      return reference
    } })
  }
}
