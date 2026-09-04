import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { PseudonymKeyVersion } from './identity-risk-pseudonym.js'
import { RISK_ENVIRONMENT, RISK_UUID } from './pilot-risk-config.js'

export const WRAPPED_RISK_PROVIDER = 'WRAPPED_AES_GCM_V1' as const
export const keyUnavailable = () => new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
export type WrappedRiskCiphertext = { name: string; ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array }

export function wrappedRiskName(key: PseudonymKeyVersion): string {
  if (!key || typeof key !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(key)) ||
    Object.keys(key).sort().join(',') !== 'customerTenantId,environment,id,immutableKeyId,organizationId,provider' ||
    Object.keys(key).some((name) => { const d = Object.getOwnPropertyDescriptor(key, name); return !d || !('value' in d) || typeof d.value !== 'string' })) throw keyUnavailable()
  if (key.provider !== WRAPPED_RISK_PROVIDER || !RISK_UUID.test(key.id) || !RISK_UUID.test(key.organizationId) ||
    !RISK_UUID.test(key.customerTenantId) || !RISK_ENVIRONMENT.test(key.environment)) throw keyUnavailable()
  return `risk-wrapped:v1:${key.environment}:${key.organizationId}:${key.customerTenantId}:${key.id}`
}

/** Same existing root custody, separate crypto domain. Never derive tenant keys from the root. */
export function readRiskWrappingRoot(env = process.env): Buffer {
  const encoded = env.SECRET_ENCRYPTION_KEY ?? ''
  if (encoded.length > 64 || (!/^[a-fA-F0-9]{64}$/.test(encoded) && !/^[A-Za-z0-9+/]{43}=$/.test(encoded))) throw keyUnavailable()
  const root = Buffer.from(encoded, encoded.length === 64 ? 'hex' : 'base64')
  if (root.length !== 32) { root.fill(0); throw keyUnavailable() }
  return root
}

export function wrapRiskKey(key: PseudonymKeyVersion, plaintext: Buffer, root: Buffer): WrappedRiskCiphertext {
  const name = wrappedRiskName(key)
  if (key.immutableKeyId !== name || root.length !== 32 || plaintext.length !== 32) throw keyUnavailable()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', root, iv)
  cipher.setAAD(Buffer.from(name, 'utf8'))
  return { name, iv, ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]), tag: cipher.getAuthTag() }
}

export function unwrapRiskKey(key: PseudonymKeyVersion, row: WrappedRiskCiphertext, root: Buffer): Buffer {
  let plaintext: Buffer | undefined
  try {
    const expected = wrappedRiskName(key)
    if (key.immutableKeyId !== expected || row.name !== expected || root.length !== 32 ||
      !(row.iv instanceof Uint8Array) || row.iv.length !== 12 || !(row.tag instanceof Uint8Array) || row.tag.length !== 16 ||
      !(row.ciphertext instanceof Uint8Array) || row.ciphertext.length !== 32) throw keyUnavailable()
    const decipher = createDecipheriv('aes-256-gcm', root, row.iv)
    // AAD comes from the trusted requested scope/version, never the returned row.
    decipher.setAAD(Buffer.from(expected, 'utf8')); decipher.setAuthTag(row.tag)
    plaintext = decipher.update(row.ciphertext)
    const final = decipher.final()
    if (final.length !== 0 || plaintext.length !== 32) { final.fill(0); throw keyUnavailable() }
    return plaintext
  } catch { plaintext?.fill(0); throw keyUnavailable() }
}
