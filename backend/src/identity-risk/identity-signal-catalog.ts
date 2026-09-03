import {
  IDENTITY_SIGNAL_RULE_IDS,
  type CatalogType,
  type IdentitySignalRuleId,
  type IdentitySignalSeverity,
} from './identity-signal-contract.js'

export type IdentitySignalRuleDefinition = Readonly<{
  ruleId: IdentitySignalRuleId
  family: 'EXPOSURE' | 'CHANGE' | 'APPLICATION' | 'MAILBOX' | 'AUTHENTICATION'
  defaultSeverity: IdentitySignalSeverity
  featureFlagDefault: false
  requiredCatalogs: readonly CatalogType[]
  requiresFullCapability: boolean
  requiresMatureBaseline: boolean
  titleCode: string
  sourceLabels: readonly string[]
}>

function sourceLabels(family: IdentitySignalRuleDefinition['family']): readonly string[] {
  if (family === 'EXPOSURE') return ['Microsoft Entra directory configuration']
  if (family === 'CHANGE') return ['Microsoft Entra administrative change evidence']
  if (family === 'APPLICATION') return ['Microsoft Entra application configuration']
  if (family === 'MAILBOX') return ['Microsoft Exchange mailbox-rule evidence']
  return ['Microsoft Entra sign-in evidence']
}

function rule(
  ruleId: IdentitySignalRuleId,
  family: IdentitySignalRuleDefinition['family'],
  defaultSeverity: IdentitySignalSeverity,
  requiredCatalogs: readonly CatalogType[],
  requiresFullCapability: boolean,
  requiresMatureBaseline: boolean,
  titleCode: string,
): IdentitySignalRuleDefinition {
  return Object.freeze({
    ruleId, family, defaultSeverity, featureFlagDefault: false, requiredCatalogs,
    requiresFullCapability, requiresMatureBaseline, titleCode, sourceLabels: sourceLabels(family),
  })
}

const definitions: readonly IdentitySignalRuleDefinition[] = [
  rule('HV-ID-EXP-001.v1', 'EXPOSURE', 'MEDIUM', ['PRIVILEGED_ROLE_GROUP'], false, false, 'PRIVILEGED_IDENTITY_MFA_EXPOSURE'),
  rule('HV-ID-EXP-002.v1', 'EXPOSURE', 'MEDIUM', ['PRIVILEGED_ROLE_GROUP'], false, false, 'PRIVILEGED_GUEST_EXPOSURE'),
  rule('HV-ID-EXP-003.v1', 'EXPOSURE', 'MEDIUM', ['PRIVILEGED_ROLE_GROUP', 'ACCOUNT_CLASS'], true, true, 'DORMANT_PRIVILEGED_IDENTITY'),
  rule('HV-ID-CHG-001.v1', 'CHANGE', 'HIGH', ['PRIVILEGED_ROLE_GROUP'], false, false, 'LIFECYCLE_THEN_PRIVILEGE'),
  rule('HV-ID-CHG-002.v1', 'CHANGE', 'HIGH', ['PRIVILEGED_ROLE_GROUP'], false, false, 'GUEST_OR_NEW_IDENTITY_PRIVILEGED'),
  rule('HV-ID-CHG-003.v1', 'CHANGE', 'MEDIUM', ['HIGH_IMPACT_OPERATION'], false, false, 'PRIVILEGED_CHANGE_BURST'),
  rule('HV-ID-CHG-004.v1', 'CHANGE', 'MEDIUM', ['HIGH_IMPACT_OPERATION'], false, true, 'UNUSUAL_PRIVILEGED_CHANGE'),
  rule('HV-ID-CHG-005.v1', 'CHANGE', 'HIGH', [], false, false, 'IDENTITY_PROTECTION_WEAKENED'),
  rule('HV-ID-APP-001.v1', 'APPLICATION', 'MEDIUM', ['HIGH_IMPACT_APPLICATION_PERMISSION'], false, false, 'NEW_APPLICATION_HIGH_IMPACT_PERMISSION'),
  rule('HV-ID-APP-002.v1', 'APPLICATION', 'MEDIUM', ['HIGH_IMPACT_APPLICATION_PERMISSION'], false, false, 'APPLICATION_CREDENTIAL_METADATA_CHANGED'),
  rule('HV-ID-MBX-001.v1', 'MAILBOX', 'HIGH', [], false, false, 'EXTERNAL_FORWARDING_OR_REDIRECT'),
  rule('HV-ID-MBX-002.v1', 'MAILBOX', 'MEDIUM', [], false, false, 'MAILBOX_CONCEALMENT_RULE'),
  rule('HV-ID-MBX-003.v1', 'MAILBOX', 'HIGH', [], true, false, 'MAILBOX_CHANGE_AFTER_AUTH_SIGNAL'),
  rule('HV-ID-AUTH-001.v1', 'AUTHENTICATION', 'HIGH', [], true, false, 'DISABLED_ACCOUNT_ACTIVITY'),
  rule('HV-ID-AUTH-002.v1', 'AUTHENTICATION', 'MEDIUM', ['ACCOUNT_CLASS'], true, true, 'DORMANT_ACCOUNT_ACTIVITY'),
  rule('HV-ID-AUTH-003.v1', 'AUTHENTICATION', 'MEDIUM', ['ACCOUNT_CLASS', 'NETWORK_CONTEXT'], true, true, 'UNFAMILIAR_SIGN_IN_PROPERTIES'),
  rule('HV-ID-AUTH-004.v1', 'AUTHENTICATION', 'MEDIUM', ['NETWORK_CONTEXT'], true, true, 'ATYPICAL_TRAVEL'),
  rule('HV-ID-AUTH-005.v1', 'AUTHENTICATION', 'MEDIUM', ['ACCOUNT_CLASS', 'NETWORK_CONTEXT'], true, false, 'FAILURE_BURST_THEN_SUCCESS'),
  rule('HV-ID-AUTH-006.v1', 'AUTHENTICATION', 'HIGH', [], true, false, 'MFA_DENIAL_BURST_THEN_SUCCESS'),
  rule('HV-ID-AUTH-007.v1', 'AUTHENTICATION', 'HIGH', ['PRIVILEGED_ROLE_GROUP', 'LEGACY_CLIENT'], true, false, 'PRIVILEGED_LEGACY_AUTHENTICATION'),
  rule('HV-ID-AUTH-008.v1', 'AUTHENTICATION', 'MEDIUM', ['ACCOUNT_CLASS', 'NETWORK_CONTEXT'], true, false, 'PASSWORD_SPRAY_THEN_SUCCESS'),
  rule('HV-ID-AUTH-009.v1', 'AUTHENTICATION', 'CRITICAL', ['ACCOUNT_CLASS', 'NETWORK_CONTEXT'], true, false, 'UNEXPECTED_BREAK_GLASS_USE'),
]

if (definitions.length !== IDENTITY_SIGNAL_RULE_IDS.length) {
  throw new Error('Identity signal catalog does not cover every v1 rule')
}

export const IDENTITY_SIGNAL_RULE_CATALOG = Object.freeze(definitions)

export function identitySignalRuleDefinition(ruleId: IdentitySignalRuleId) {
  const definition = IDENTITY_SIGNAL_RULE_CATALOG.find((entry) => entry.ruleId === ruleId)
  if (!definition) throw new Error('Unknown identity signal rule')
  return definition
}
