import type { PseudonymScope } from './identity-risk-pseudonym.js'

export const RISK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const RISK_ENVIRONMENT = /^[a-z][a-z0-9-]{0,39}$/
export type PilotRiskConfig = PseudonymScope & { expiresAt: number; provider: 'wrapped-pilot-v1' | 'managed-kms' }

/** One explicit, expiring pilot. No wildcard, all-tenants, coercion or fallback. */
export function pilotRiskConfig(env: NodeJS.ProcessEnv = process.env, now = Date.now()): PilotRiskConfig | null {
  try {
    if (env.HAWKVIEW_IDENTITY_RISK_MODE !== 'shadow') return null
    const provider = env.HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER
    const environment = env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT
    if (!['wrapped-pilot-v1', 'managed-kms'].includes(provider ?? '') || !environment || !RISK_ENVIRONMENT.test(environment)) return null
    const text = env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE
    if (!text || text.length > 512) return null
    // These fields are ASCII UUID/time literals. Reject escaped/duplicate keys,
    // nested objects and ambiguous JSON before parsing rather than last-value wins.
    if (text.includes('\\') || (text.match(/"organizationId"\s*:/g) ?? []).length !== 1 ||
      (text.match(/"customerTenantId"\s*:/g) ?? []).length !== 1 || (text.match(/"expiresAt"\s*:/g) ?? []).length !== 1) return null
    const scope = JSON.parse(text)
    if (!scope || Array.isArray(scope) || typeof scope !== 'object' ||
      Object.keys(scope).sort().join(',') !== 'customerTenantId,expiresAt,organizationId' ||
      typeof scope.organizationId !== 'string' || !RISK_UUID.test(scope.organizationId) ||
      typeof scope.customerTenantId !== 'string' || !RISK_UUID.test(scope.customerTenantId) ||
      typeof scope.expiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(scope.expiresAt)) return null
    const expiresAt = Date.parse(scope.expiresAt)
    if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== scope.expiresAt || expiresAt <= now || expiresAt - now > 7 * 86400000) return null
    return { environment, provider: provider as PilotRiskConfig['provider'], organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, expiresAt }
  } catch { return null }
}

export function pilotScopeAllowed(scope: PseudonymScope, config = pilotRiskConfig()) {
  return Boolean(config && config.environment === scope.environment && config.organizationId === scope.organizationId && config.customerTenantId === scope.customerTenantId)
}
