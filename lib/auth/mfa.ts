export type HawkViewMfaAccessStatus =
  | 'enrollment-required'
  | 'challenge-required'
  | 'verified'

/**
 * Fail closed when Supabase reports a stale AAL2 token after the last factor
 * was removed. A user is verified only when both current and next AAL are
 * AAL2 and at least one verified TOTP factor still exists.
 */
export function mfaAccessStatus(
  currentLevel: string | null,
  nextLevel: string | null,
  verifiedFactorCount: number
): HawkViewMfaAccessStatus {
  if (
    currentLevel === 'aal2' &&
    nextLevel === 'aal2' &&
    verifiedFactorCount > 0
  ) {
    return 'verified'
  }
  if (nextLevel === 'aal2' && verifiedFactorCount > 0) {
    return 'challenge-required'
  }
  return 'enrollment-required'
}
