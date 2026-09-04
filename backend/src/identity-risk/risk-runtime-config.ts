import type { PseudonymScope } from './identity-risk-pseudonym.js'
import { pilotRiskConfig, pilotScopeAllowed, RISK_ENVIRONMENT, RISK_UUID, type PilotRiskConfig } from './pilot-risk-config.js'

export type GlobalRiskConfig = Readonly<{ rollout: 'global'; environment: string; provider: 'wrapped-v1' }>
export type RiskRuntimeConfig = GlobalRiskConfig | PilotRiskConfig

/** Global availability is explicit and independent of subscription/tenant enrollment.
 * Legacy pilot configuration is supported only when rollout is absent. Unknown or
 * contradictory configuration never widens a scope or falls back to a provider.
 */
export function riskRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RiskRuntimeConfig | null {
  if (env.HAWKVIEW_IDENTITY_RISK_ROLLOUT === undefined) return pilotRiskConfig(env)
  if (env.HAWKVIEW_IDENTITY_RISK_ROLLOUT !== 'global' || env.HAWKVIEW_IDENTITY_RISK_MODE !== 'shadow' ||
    env.HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER !== 'wrapped-v1' || env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE !== undefined) return null
  const environment = env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT
  return environment && RISK_ENVIRONMENT.test(environment)
    ? Object.freeze({ rollout: 'global', provider: 'wrapped-v1', environment }) : null
}

export function isGlobalRiskConfig(config: RiskRuntimeConfig | null): config is GlobalRiskConfig {
  return config !== null && 'rollout' in config && config.rollout === 'global'
}


export function isWrappedRiskConfig(config: RiskRuntimeConfig | null) {
  return config?.provider === 'wrapped-v1' || config?.provider === 'wrapped-pilot-v1'
}

/** Configuration gate only. Callers MUST separately enforce DB ownership,
 * authorization, operational controls and per-source/key eligibility.
 */
export function riskScopeAllowed(scope: PseudonymScope, config = riskRuntimeConfig()): boolean {
  if (!config || !RISK_UUID.test(scope.organizationId) || !RISK_UUID.test(scope.customerTenantId) ||
    scope.environment !== config.environment) return false
  return isGlobalRiskConfig(config) || pilotScopeAllowed(scope, config)
}
