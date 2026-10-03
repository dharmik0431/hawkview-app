/**
 * Eligibility for the explicit administrator account-recovery action.
 *
 * The action exists for one state: a member of the caller's own organization who
 * never completed HawkView account setup, whose email may already have a sign-in
 * account at the authentication provider. `sendPasswordReset` refuses exactly
 * these members by design, and resend refuses them because the provider reports
 * the address is already registered.
 *
 * This predicate mirrors the server gate field for field rather than
 * approximating it. On the server, `hasHawkViewAccount` is literally
 * `Boolean(user.inviteAcceptedAt)`, so `false` means "has not accepted".
 *
 * It must only ever be offered where it is actually invocable. A member with no
 * local membership row has no `membershipId`, so the endpoint cannot be called
 * for them at all — offering it would replace a false success with a dead end.
 */

export type RecoveryCandidate = {
  membershipId?: string
  status?: 'ACTIVE' | 'SUSPENDED'
  disabled?: boolean
  hasHawkViewAccount?: boolean
}

export function canSendAccountRecovery(
  member: RecoveryCandidate,
  organizationId: string | null
): boolean {
  // Without an organization the request cannot be authorized server-side.
  if (!organizationId) return false
  // No membership id means no callable endpoint. Fail closed rather than
  // rendering an action that cannot run.
  if (!member.membershipId) return false
  if (member.status !== 'ACTIVE') return false
  if (member.disabled === true) return false
  // Strictly `false`. `undefined` is unknown, not eligible: an action offered on
  // incomplete data is how an administrator ends up triggering a refusal.
  if (member.hasHawkViewAccount !== false) return false
  return true
}

/**
 * Why the action is unavailable, for a disabled control's tooltip. Returning a
 * reason rather than hiding the entry is deliberate: a menu that silently omits
 * entries reads as a broken admin panel, which is the complaint this work began
 * with.
 */
export function accountRecoveryUnavailableReason(
  member: RecoveryCandidate,
  organizationId: string | null
): string | null {
  if (canSendAccountRecovery(member, organizationId)) return null
  if (!organizationId || !member.membershipId) {
    return 'Account recovery is unavailable for this member.'
  }
  if (member.disabled === true) {
    return 'This HawkView account is disabled. Re-enable it before sending account recovery.'
  }
  if (member.status !== 'ACTIVE') {
    return 'This membership is not active. Reactivate it before sending account recovery.'
  }
  if (member.hasHawkViewAccount === true) {
    return 'This member has already completed HawkView account setup. Send a password reset instead.'
  }
  return 'Account recovery is unavailable for this member.'
}

/**
 * Wording for a completed request. It must never assert delivery: the provider
 * answers 200 with an empty body for an address it cannot resolve, so a
 * successful response establishes that the request was accepted and nothing
 * about an email arriving.
 *
 * It must also not invite a repeat. Pressing the button again asks the provider
 * for a second email, which is how this account hit its sending limit.
 */
export function accountRecoveryRequestedNotice(email: string): string {
  return (
    `Account recovery was requested for ${email}. HawkView cannot confirm delivery — ` +
    'ask them to check their inbox, including spam, and to wait a few minutes before trying again.'
  )
}
