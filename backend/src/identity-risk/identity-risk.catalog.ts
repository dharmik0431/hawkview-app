import type { IdentityRiskFindingDto } from './identity-risk.contract.js'

type GuidanceCode = IdentityRiskFindingDto['investigationGuidanceCode']

export type IdentityRiskRulePresentation = Readonly<{
  title: string
  explanation: string
  investigationGuidanceCode: GuidanceCode
  investigationGuidance: string
  benignAlternativeCodes: readonly string[]
  sourceLabels: readonly string[]
}>

const access = (
  title: string,
  explanation: string,
  sourceLabels: readonly string[] = ['Microsoft Entra directory audit'],
): IdentityRiskRulePresentation => Object.freeze({
  title,
  explanation,
  investigationGuidanceCode: 'REVIEW_ACCESS',
  investigationGuidance:
    'Review the identity, role assignment, and related authorized change evidence.',
  benignAlternativeCodes: ['APPROVED_ACCOUNT_PROVISIONING'],
  sourceLabels,
})

const activity = (
  title: string,
  explanation: string,
): IdentityRiskRulePresentation => Object.freeze({
  title,
  explanation,
  investigationGuidanceCode: 'REVIEW_ACTIVITY',
  investigationGuidance:
    'Review the bounded source evidence with an authorized administrator.',
  benignAlternativeCodes: ['APPROVED_SHARED_CONTEXT'],
  sourceLabels: ['Microsoft Entra sign-in activity'],
})

const configuration = (
  title: string,
  explanation: string,
): IdentityRiskRulePresentation => Object.freeze({
  title,
  explanation,
  investigationGuidanceCode: 'REVIEW_CONFIGURATION',
  investigationGuidance:
    'Review the configuration and confirm the change is authorized.',
  benignAlternativeCodes: [],
  sourceLabels: ['Microsoft Entra directory audit'],
})

const mailbox = (
  title: string,
  explanation: string,
): IdentityRiskRulePresentation => Object.freeze({
  title,
  explanation,
  investigationGuidanceCode: 'REVIEW_MAILBOX_RULE',
  investigationGuidance:
    'Review the mailbox rule and confirm the destination is authorized.',
  benignAlternativeCodes: [],
  sourceLabels: ['Exchange Online mailbox audit'],
})

export const IDENTITY_RISK_RULE_CATALOG = Object.freeze({
  'HV-ID-EXP-001.v1': access(
    'Privileged identity has an MFA enforcement gap',
    'Current evidence did not verify effective MFA enforcement for a privileged identity. This is an exposure finding, not proof of compromise.',
  ),
  'HV-ID-EXP-002.v1': access(
    'Privileged guest identity is enabled',
    'A currently enabled guest identity holds access classified as privileged by the approved tenant catalog.',
  ),
  'HV-ID-EXP-003.v1': access(
    'Dormant privileged identity remains enabled',
    'A privileged identity remained enabled after the approved dormant-activity threshold was met.',
    ['Microsoft Entra sign-in activity'],
  ),
  'HV-ID-CHG-001.v1': access(
    'New identity received privileged access',
    'An authoritative lifecycle event was followed by a privileged access assignment within the versioned rule window.',
  ),
  'HV-ID-CHG-002.v1': access(
    'Guest or newly created identity received privilege',
    'A guest or authoritatively newly created identity received access classified as privileged.',
  ),
  'HV-ID-CHG-003.v1': access(
    'Burst of privileged administrative changes',
    'One actor performed the versioned threshold of distinct high-impact administrative operations inside the rule window.',
  ),
  'HV-ID-CHG-004.v1': access(
    'Unusual privileged change for this actor',
    'A high-impact operation was absent from the actor baseline and rare in the tenant baseline.',
  ),
  'HV-ID-CHG-005.v1': configuration(
    'Identity protection configuration was weakened',
    'Authoritative evidence showed a security control moving from a stronger approved state to a weaker state.',
  ),
  'HV-ID-APP-001.v1': configuration(
    'New application declares high-impact permissions',
    'A newly created application declared a permission in the approved high-impact permission catalog. Declaration does not prove consent.',
  ),
  'HV-ID-APP-002.v1': configuration(
    'Application credential metadata changed',
    'Authoritative evidence showed credential metadata added or replaced for an application covered by the approved catalog.',
  ),
  'HV-ID-MBX-001.v1': Object.freeze({
    ...mailbox('Mailbox forwarding outside verified domains requires review',
      'An enabled rule targets a domain outside the current Microsoft Graph verified tenant-domain set. This is an investigation lead, not proof of message delivery or compromise.'),
    sourceLabels: ['Microsoft Graph mailbox-rule snapshot', 'Microsoft Graph verified tenant domains'],
    benignAlternativeCodes: ['APPROVED_EXTERNAL_FORWARDING'],
  }),
  'HV-ID-MBX-002.v1': mailbox(
    'Mailbox concealment rule requires investigation',
    'A complete authoritative rule projection matched the versioned concealment-rule condition.',
  ),
  'HV-ID-MBX-003.v1': mailbox(
    'Mailbox rule changed after suspicious authentication',
    'A complete mailbox-rule change followed an independent HawkView authentication signal within the rule window.',
  ),
  'HV-ID-AUTH-001.v1': activity(
    'Authentication activity followed account disablement',
    'Authentication activity occurred after the authoritative account-disable time.',
  ),
  'HV-ID-AUTH-002.v1': activity(
    'Dormant account became active',
    'A successful interactive sign-in followed the versioned dormant-account interval.',
  ),
  'HV-ID-AUTH-003.v1': activity(
    'Multiple unfamiliar sign-in properties',
    'At least two independent, usable sign-in properties were unfamiliar after approved context masking.',
  ),
  'HV-ID-AUTH-004.v1': activity(
    'Sign-in travel pattern requires investigation',
    'Consecutive sign-ins met the versioned distance and travel-speed thresholds after approved context checks.',
  ),
  'HV-ID-AUTH-005.v1': activity(
    'Authentication failure burst followed by success',
    'One supported human identity reached the versioned failure threshold and then authenticated successfully.',
  ),
  'HV-ID-AUTH-006.v1': activity(
    'Repeated MFA denials followed by success',
    'Authoritative authentication details met the versioned MFA denial-or-timeout threshold before a success.',
  ),
  'HV-ID-AUTH-007.v1': activity(
    'Privileged identity used legacy authentication',
    'A privileged identity successfully used a client classified as legacy authentication by the approved catalog.',
  ),
  'HV-ID-AUTH-008.v1': activity(
    'Password-spray pattern followed by success',
    'A non-approved shared source met the cross-identity failure threshold and then succeeded for a targeted identity.',
  ),
  'HV-ID-AUTH-009.v1': activity(
    'Break-glass account used outside an approved window',
    'An explicitly classified break-glass account signed in interactively outside every approved active exercise window.',
  ),
} satisfies Readonly<Record<string, IdentityRiskRulePresentation>>)

export type IdentityRiskRuleId = keyof typeof IDENTITY_RISK_RULE_CATALOG

export function identityRiskRulePresentation(
  ruleId: string,
): IdentityRiskRulePresentation | null {
  return Object.prototype.hasOwnProperty.call(IDENTITY_RISK_RULE_CATALOG, ruleId)
    ? IDENTITY_RISK_RULE_CATALOG[ruleId as IdentityRiskRuleId]
    : null
}

export function isIdentityRiskRuleId(ruleId: unknown): ruleId is IdentityRiskRuleId {
  return typeof ruleId === 'string' && identityRiskRulePresentation(ruleId) !== null
}
