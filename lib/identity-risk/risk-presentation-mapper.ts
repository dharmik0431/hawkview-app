export type RiskMapperResult = {
  ruleId: string
  plainTitle: string
  plainExplanation: string
  evidenceContext: string
  recommendedActions: readonly string[]
}

/**
  Translates rule IDs and signal identifiers into clear, plain-English security explanations and guidance.
 */
export function mapRuleToPresentation(ruleId: string, signal?: string | null): RiskMapperResult {
  // If signal explicitly indicates account lockout
  if (signal === 'LOCKED_OUT_AFTER_REPEATED_FAILURES') {
    return {
      ruleId,
      plainTitle: 'Account lockout following failed sign-ins',
      plainExplanation: 'The account was locked out after repeated unsuccessful sign-in attempts.',
      evidenceContext: 'Multiple consecutive failed sign-in attempts triggered an automatic account lockout in Microsoft 365 logs.',
      recommendedActions: [
        'Review the user’s recent Microsoft sign-in activity and locations.',
        'Confirm whether the attempts were expected with the user or tenant administrator.',
        'Reset the account password if the activity is unexplained.',
        'Revoke active sessions if unauthorized access is suspected.',
        'Confirm MFA registration and effective Conditional Access coverage.',
        'Escalate or temporarily disable the account if suspicious attempts continue.',
      ],
    }
  }

  // Handle repeated-credential-failure rule or password rejection signals
  if (
    ruleId === 'repeated-credential-failure' ||
    ruleId === 'HV-ID-AUTH-010.v1' ||
    ruleId === 'HV-ID-AUTH-005.v2' ||
    signal === 'PASSWORD_REJECTED'
  ) {
    return {
      ruleId,
      plainTitle: 'Repeated unsuccessful sign-in activity',
      plainExplanation: 'HawkView observed repeated credential failures associated with this identity.',
      evidenceContext: 'Multiple invalid password attempts were recorded for this account across evaluated sign-in logs.',
      recommendedActions: [
        'Review the user’s recent Microsoft sign-in activity and locations.',
        'Confirm whether the attempts were expected with the user or tenant administrator.',
        'Reset the account password if the activity is unexplained.',
        'Revoke active sessions if unauthorized access is suspected.',
        'Confirm MFA registration and effective Conditional Access coverage.',
        'Escalate or temporarily disable the account if suspicious attempts continue.',
      ],
    }
  }

  // Handle external mailbox forwarding rule or signal
  if (
    ruleId === 'external-mailbox-forwarding' ||
    ruleId === 'HV-ID-MBX-001.v1' ||
    signal === 'EXTERNAL_FORWARDING_CONFIGURED'
  ) {
    return {
      ruleId,
      plainTitle: 'External mailbox forwarding configured',
      plainExplanation: 'HawkView observed an active email forwarding rule routing mail outside the organization.',
      evidenceContext: 'Exchange Online inbox rules or mailbox configuration actively direct incoming messages to an external recipient.',
      recommendedActions: [
        'Confirm with the mailbox owner whether the forwarding was set up deliberately.',
        'Review inbox and forwarding rules in Exchange Online to verify the external recipient address.',
        'Check when the rule was created relative to the account’s recent password changes or sign-in logs.',
        'Remove unauthorized forwarding rules and reset credentials if compromised.',
        'Verify whether sensitive data may have been forwarded outside the domain.',
      ],
    }
  }

  // Safe fallback for unknown rule codes
  return {
    ruleId,
    plainTitle: 'Security activity needs review',
    plainExplanation: 'HawkView found activity associated with this identity that requires investigation.',
    evidenceContext: 'Observed security indicators require manual verification in tenant logs.',
    recommendedActions: [
      'Review recent sign-in logs and directory activity for this identity.',
      'Verify recent configuration or credential changes with the account owner.',
      'Inspect Microsoft Entra ID Protection and audit logs for context.',
    ],
  }
}

/**
 * Validates whether a value is a genuine email or UPN rather than a subject ID, object ID, or UUID.
 */
export function isRealEmailOrUpn(value: string | null | undefined): boolean {
  if (!value) return false
  const trimmed = value.trim()
  if (
    trimmed.startsWith('subject:') ||
    trimmed.startsWith('user:') ||
    trimmed.startsWith('mailbox:') ||
    trimmed.startsWith('object:')
  ) {
    return false
  }
  // GUID / UUID check
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return false
  }
  return trimmed.includes('@')
}

/**
 * Returns user display name without leaking subject IDs or raw UUIDs.
 */
export function getUserDisplayName(row: { name?: string | null; reference?: string | null }): string {
  if (
    row.name &&
    !row.name.startsWith('subject:') &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.name)
  ) {
    return row.name
  }
  return 'Identity not resolved'
}

/**
 * Returns the email/UPN if available and valid, otherwise "Email not reported."
 */
export function getUserEmailOrUpn(row: { email?: string | null; reference?: string | null }): string {
  if (isRealEmailOrUpn(row.email)) return row.email!.trim()
  if (isRealEmailOrUpn(row.reference)) return row.reference!.trim()
  return 'Email not reported.'
}
