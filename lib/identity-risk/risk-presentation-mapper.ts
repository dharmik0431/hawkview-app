export type RiskMapperResult = {
  ruleId: string
  plainTitle: string
  plainExplanation: string
  evidenceContext: string
  recommendedActions: readonly string[]
}

export type PresentationReason = {
  ruleId: string
  signal?: string | null
  evidenceCount?: number | null
  evidenceCountCapped?: boolean
}

/** Keep all evidence, including evaluated zeros, but title a finding with a
 * positive reason when one exists. Array order alone is not evidence. */
export function primaryReasonFor<T extends PresentationReason>(reasons: readonly T[]): T | undefined {
  return reasons.find(reason => Number.isSafeInteger(reason.evidenceCount) && reason.evidenceCount! > 0) ?? reasons[0]
}

const investigation = [
  'Confirm with the account owner whether the sign-in attempts were expected.',
  'Check applications and devices for an outdated saved password.',
  'Review the sign-in records and any successful authentication separately; these failures do not establish whether other access occurred.',
  'If unauthorized successful access or credential exposure is corroborated, follow the incident-response procedure for password reset, session revocation or account containment.',
] as const

/** A known identifier supplies vocabulary, not proof that an event occurred. */
export function mapRuleToPresentation(reason: PresentationReason): RiskMapperResult {
  const { ruleId, signal, evidenceCount, evidenceCountCapped } = reason
  const unknown = (): RiskMapperResult => ({
    ruleId,
    plainTitle: 'Finding explanation unavailable',
    plainExplanation: 'HawkView returned a finding, but this view cannot interpret its evidence as a specific activity.',
    evidenceContext: 'An unrecognized or missing explanation is not evidence of safety or compromise. Review the recorded finding and source details.',
    recommendedActions: ['Review the finding and its source evidence before deciding what action is needed.'],
  })
  const knownSignal = signal === 'LOCKED_OUT_AFTER_REPEATED_FAILURES' || signal === 'PASSWORD_REJECTED' || signal === 'EXTERNAL_FORWARDING_CONFIGURED'
  const knownLegacy = !signal && ['HV-ID-AUTH-010.v1', 'HV-ID-AUTH-005.v2', 'HV-ID-MBX-001.v1'].includes(ruleId)
  if ((!knownSignal && !knownLegacy) || !Number.isSafeInteger(evidenceCount) || evidenceCount! < 0) return unknown()
  if (evidenceCount === 0) {
    if (evidenceCountCapped) return unknown()
    const label = signal === 'LOCKED_OUT_AFTER_REPEATED_FAILURES' ? 'lockout records'
      : signal === 'PASSWORD_REJECTED' ? 'password-rejection records'
      : signal === 'EXTERNAL_FORWARDING_CONFIGURED' ? 'external forwarding destinations' : 'matching evidence'
    return {
      ruleId,
      plainTitle: `No ${label} observed`,
      plainExplanation: `This check reported zero ${label} in the evaluated evidence.`,
      evidenceContext: 'An evaluated zero is different from an absent check. It does not establish that other activity or risk is absent.',
      recommendedActions: ['Review any positive findings and source coverage separately.'],
    }
  }
  if (signal === 'LOCKED_OUT_AFTER_REPEATED_FAILURES') return {
    ruleId,
    plainTitle: 'Account lockout reported',
    plainExplanation: 'Microsoft reported sign-in requests blocked by account lockout after repeated failures.',
    evidenceContext: 'The count describes sign-in records reporting lockout, not distinct lockout episodes. It does not prove varied passwords, unauthorized access, or that the account is locked now. Unexpected attempts and legitimate client activity both need investigation.',
    recommendedActions: investigation,
  }
  if (signal === 'PASSWORD_REJECTED' || (!signal && ruleId === 'HV-ID-AUTH-010.v1')) return {
    ruleId,
    plainTitle: 'Rejected password attempts observed',
    plainExplanation: 'The evaluated evidence contains sign-in attempts where the password was rejected.',
    evidenceContext: 'These records do not by themselves prove a concentrated attack, exposed credentials or successful access. Typing mistakes and outdated saved passwords are possible explanations.',
    recommendedActions: investigation,
  }
  if (!signal && ruleId === 'HV-ID-AUTH-005.v2') return {
    ruleId,
    plainTitle: 'Authentication failures followed by success',
    plainExplanation: 'The finding reports qualified authentication failures followed by a successful authentication.',
    evidenceContext: 'The sequence does not establish that the same actor made every attempt or that the successful access was unauthorized.',
    recommendedActions: [
      'Review the successful authentication and confirm with the account owner whether it was expected.',
      ...investigation.slice(1),
    ],
  }
  if (signal === 'EXTERNAL_FORWARDING_CONFIGURED' || (!signal && ruleId === 'HV-ID-MBX-001.v1')) return {
    ruleId,
    plainTitle: 'External mailbox forwarding observed',
    plainExplanation: 'The finding reports mailbox forwarding configured to an external destination when the configuration was observed.',
    evidenceContext: 'Configured forwarding does not establish that messages were delivered or data was exfiltrated. Check the observation time and whether the configuration is still present.',
    recommendedActions: [
      'Confirm with the mailbox owner whether the forwarding was authorized.',
      'Review the forwarding configuration and destination in Exchange Online.',
      'If unauthorized forwarding or account access is confirmed, follow the incident-response procedure.',
    ],
  }
  return unknown()
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
