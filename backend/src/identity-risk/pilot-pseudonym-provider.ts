import { createHmac } from 'node:crypto'
import { IdentityRiskPseudonymProvider, ManagedHmacPseudonymProvider, type ManagedMacTransport, type PseudonymKeyVersion, type PseudonymPurpose, type PseudonymScope, type PinnedPseudonymSession } from './identity-risk-pseudonym.js'
import { pilotRiskConfig, pilotScopeAllowed } from './pilot-risk-config.js'
import { keyUnavailable, readRiskWrappingRoot, unwrapRiskKey, wrappedRiskName, WRAPPED_RISK_PROVIDER } from './wrapped-risk-crypto.js'
import { WrappedRiskKeyStore } from './wrapped-risk-key-store.js'

export const IDENTITY_RISK_MANAGED_MAC_TRANSPORT = Symbol('IDENTITY_RISK_MANAGED_MAC_TRANSPORT')

export class WrappedRiskPseudonymProvider extends IdentityRiskPseudonymProvider {
  override readonly configured = true
  constructor(private readonly store: Pick<WrappedRiskKeyStore, 'ciphertext' | 'recordFailure'> = new WrappedRiskKeyStore()) { super() }
  override allowsScope(scope: PseudonymScope) {
    return pilotRiskConfig()?.provider === 'wrapped-pilot-v1' && pilotScopeAllowed(scope)
  }
  override async pin(key: PseudonymKeyVersion, requestedDeadline: number): Promise<PinnedPseudonymSession> {
    if (wrappedRiskName(key) !== key.immutableKeyId) throw keyUnavailable()
    if (!this.allowsScope(key) || key.provider !== WRAPPED_RISK_PROVIDER || !Number.isSafeInteger(requestedDeadline) || requestedDeadline <= Date.now()) throw keyUnavailable()
    const deadline = Math.min(requestedDeadline, Date.now() + 30000)
    const root = readRiskWrappingRoot()
    let material: Buffer | undefined
    try {
      const row = await this.store.ciphertext(key, deadline)
      material = unwrapRiskKey(key, row, root)
      if (Date.now() >= deadline) throw keyUnavailable()
      const pinned = Object.freeze({ ...key })
      let closed = false; let calls = 0
      const close = () => { closed = true; material?.fill(0); material = undefined; clearTimeout(timer) }
      const timer = setTimeout(close, Math.max(1, deadline - Date.now()))
      timer.unref()
      return Object.freeze({ keyVersion: pinned, close,
        reference: async (purpose: PseudonymPurpose, identifiers: readonly string[]) => {
          if (closed || !material || Date.now() >= deadline || !this.allowsScope(pinned) || ++calls > 6002 ||
            !['mailbox','evidence','observation'].includes(purpose) || !Array.isArray(identifiers) || identifiers.length === 0 || identifiers.length > 8 ||
            identifiers.some((id) => typeof id !== 'string' || !id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id))) { close(); throw keyUnavailable() }
          const message = JSON.stringify(['hvr1', pinned.environment, pinned.organizationId, pinned.customerTenantId, purpose, pinned.id, ...identifiers])
          if (Buffer.byteLength(message) > 4096) { close(); throw keyUnavailable() }
          const input = Buffer.from(message)
          let mac: Buffer | undefined
          try { mac = createHmac('sha256', material).update(input).digest(); return `hvr1_${purpose}_${mac.toString('hex')}` }
          catch { close(); throw keyUnavailable() }
          finally { input.fill(0); mac?.fill(0) }
        },
      })
    } catch {
      material?.fill(0)
      await this.store.recordFailure(key, deadline)
      throw keyUnavailable()
    } finally { root.fill(0) }
  }
}

/** Nest runtime selection. Missing/invalid config never falls back or provisions a key.
 * Managed transport stays available through explicit DI, not an implicit SDK credential chain.
 */
export function createPilotPseudonymProvider(transport: ManagedMacTransport | null = null): IdentityRiskPseudonymProvider {
  const config = pilotRiskConfig()
  let delegate: IdentityRiskPseudonymProvider | undefined
  if (config?.provider === 'wrapped-pilot-v1') {
    try { const root = readRiskWrappingRoot(); root.fill(0); delegate = new WrappedRiskPseudonymProvider() } catch { /* Fail closed. */ }
  } else if (config?.provider === 'managed-kms' && transport) delegate = new ManagedHmacPseudonymProvider(transport)
  if (!delegate || !config) return new IdentityRiskPseudonymProvider()
  const configuredDelegate = delegate
  return new class extends IdentityRiskPseudonymProvider {
    override readonly configured = true
    override allowsScope(scope: PseudonymScope) {
      const current = pilotRiskConfig()
      return current?.provider === config.provider && pilotScopeAllowed(scope, current)
    }
    override pin(key: PseudonymKeyVersion, deadline: number) {
      if (!this.allowsScope(key)) return Promise.reject(keyUnavailable())
      return configuredDelegate.pin(key, deadline)
    }
  }()
}
