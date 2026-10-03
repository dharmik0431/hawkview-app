/**
 * Recovery from abandoned TOTP enrollments.
 *
 * Supabase holds at most one factor per friendly name per user, and an enrollment
 * that is started but never verified stays on the account as an `unverified`
 * factor. A user who closes the tab, refreshes, or fails the code step therefore
 * cannot call `enroll()` under that name again: the provider answers with a name
 * conflict forever. That is a permanent self-service lockout, not a transient error.
 *
 * Two independent recoveries are applied, because either one alone can fail:
 *
 *  1. Clear the unverified factors we can see, then enroll normally.
 *  2. If the provider still reports a name conflict, enroll under a fresh name.
 *
 * (2) is not redundant. An unverified factor is not guaranteed to appear in
 * `listFactors()` — that payload is derived from the user record, and which
 * factors it carries has varied by provider version. Without the fallback, a user
 * whose blocking factor is invisible to us stays locked out exactly as before.
 *
 * A `verified` factor is a working authenticator. It is never removed here; only
 * the admin MFA-reset path may do that, deliberately and with an audit entry.
 */

/** Loose by intent: the provider returns snake_case, some SDK surfaces expose
 * camelCase, and this code must not silently stop matching if that changes. */
export type MfaFactorRecord = {
  id?: unknown
  status?: unknown
  factor_type?: unknown
  factorType?: unknown
  friendly_name?: unknown
  friendlyName?: unknown
}

export type MfaEnrollmentFailure =
  | 'unavailable'
  | 'name-conflict'
  | 'factor-limit'
  | 'failed'

export type MfaEnrollmentOutcome =
  | { ok: true; factorId: string; qrCode: string; secret: string }
  | { ok: false; reason: MfaEnrollmentFailure }

export type MfaEnrollmentClient = {
  listFactors: () => Promise<{
    data: { all?: unknown; totp?: unknown } | null
    error: unknown
  }>
  unenroll: (input: { factorId: string }) => Promise<{ error: unknown }>
  enroll: (input: { factorType: 'totp'; friendlyName: string }) => Promise<{
    data: { id?: unknown; totp?: { qr_code?: unknown; secret?: unknown } } | null
    error: unknown
  }>
}

export const HAWKVIEW_AUTHENTICATOR_NAME = 'HawkView Authenticator'

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function factorStatus(factor: MfaFactorRecord): string | null {
  return text(factor.status)?.toLowerCase() ?? null
}

export function factorType(factor: MfaFactorRecord): string | null {
  return (
    text(factor.factor_type)?.toLowerCase() ??
    text(factor.factorType)?.toLowerCase() ??
    null
  )
}

export function factorFriendlyName(factor: MfaFactorRecord): string | null {
  return text(factor.friendly_name) ?? text(factor.friendlyName) ?? null
}

/**
 * Ids of abandoned TOTP enrollments, selected fail-closed.
 *
 * A record is swept only when it states explicitly that it is an `unverified`
 * `totp` factor. Missing or unrecognised status, and missing or unrecognised
 * type, are RETAINED. Absence of evidence that a factor is verified is not
 * evidence that it is abandoned, and the two errors are not symmetric: leaving
 * a stale factor costs one fallback rename, while deleting a working
 * authenticator destroys the user's second factor irreversibly.
 *
 * Nothing is stranded by that caution. `startTotpEnrollment` falls back to a
 * distinct friendly name for any blocker this sweep declines to remove, so
 * being conservative here cannot reinstate the lockout.
 *
 * An id seen as `verified` in ANY record vetoes every other representation of
 * the same id, because the provider returns the same factor through more than
 * one collection and a duplicate carrying less information must not override
 * the one that proves the factor works.
 */
export function pendingTotpFactorIds(factors: unknown): string[] {
  if (!Array.isArray(factors)) return []
  const verified: string[] = []
  for (const candidate of factors) {
    if (!candidate || typeof candidate !== 'object') continue
    const factor = candidate as MfaFactorRecord
    const id = text(factor.id)
    if (id && factorStatus(factor) === 'verified') verified.push(id)
  }
  const ids: string[] = []
  for (const candidate of factors) {
    if (!candidate || typeof candidate !== 'object') continue
    const factor = candidate as MfaFactorRecord
    const id = text(factor.id)
    if (!id || verified.includes(id) || ids.includes(id)) continue
    if (factorStatus(factor) !== 'unverified') continue
    if (factorType(factor) !== 'totp') continue
    ids.push(id)
  }
  return ids
}

/** `all` carries every factor; `totp` is filtered to verified ones on some
 * versions. Both are read so cleanup does not depend on which is populated. */
export function collectFactorRecords(
  data: { all?: unknown; totp?: unknown } | null
): unknown[] {
  if (!data) return []
  const all = Array.isArray(data.all) ? data.all : []
  const totp = Array.isArray(data.totp) ? data.totp : []
  return [...all, ...totp]
}

function providerText(error: unknown): string {
  if (!error || typeof error !== 'object') return typeof error === 'string' ? error : ''
  const record = error as Record<string, unknown>
  return [record.code, record.error_code, record.name, record.message]
    .map((value) => (typeof value === 'string' ? value : ''))
    .join(' ')
}

/** A name conflict is the signature of a surviving unverified factor. */
export function isFactorNameConflict(error: unknown): boolean {
  const description = providerText(error)
  if (!description) return false
  return (
    /mfa_factor_name_conflict/i.test(description) ||
    /friendly[_\s-]?name/i.test(description) ||
    /factor[^.]*already\s+exists/i.test(description) ||
    /factor[^.]*conflict/i.test(description)
  )
}

/** Hitting the per-user factor cap is itself usually caused by accumulated
 * abandoned enrollments, so it deserves its own message rather than "try again". */
export function isFactorLimitExceeded(error: unknown): boolean {
  const description = providerText(error)
  if (!description) return false
  return (
    /mfa_factor_limit/i.test(description) ||
    /too\s+many\s+factors/i.test(description) ||
    /maximum\s+number\s+of\s+(enrolled\s+)?factors/i.test(description)
  )
}

/** Distinct from the base name under the provider's uniqueness rule, and still
 * recognisable to a user reading their authenticator app. */
export function uniqueAuthenticatorName(
  base: string,
  token: string
): string {
  const suffix = token.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase()
  return suffix ? `${base} (${suffix})` : base
}

function readEnrollment(
  data: { id?: unknown; totp?: { qr_code?: unknown; secret?: unknown } } | null
): { factorId: string; qrCode: string; secret: string } | null {
  const factorId = text(data?.id)
  const qrCode = text(data?.totp?.qr_code)
  const secret = text(data?.totp?.secret)
  if (!factorId || !qrCode || !secret) return null
  return { factorId, qrCode, secret }
}

/**
 * Remove every abandoned TOTP enrollment we can see. Failures are swallowed on
 * purpose: cleanup is best-effort housekeeping, and turning it into a hard error
 * would reintroduce the lockout it exists to prevent. The caller proceeds to
 * `enroll()` either way, and the unique-name fallback covers what we could not clear.
 */
export async function clearPendingTotpFactors(
  client: Pick<MfaEnrollmentClient, 'listFactors' | 'unenroll'>
): Promise<{ removed: number; inspected: number }> {
  let listed: Awaited<ReturnType<MfaEnrollmentClient['listFactors']>>
  try {
    listed = await client.listFactors()
  } catch {
    return { removed: 0, inspected: 0 }
  }
  if (listed.error) return { removed: 0, inspected: 0 }
  const ids = pendingTotpFactorIds(collectFactorRecords(listed.data))
  let removed = 0
  for (const factorId of ids) {
    try {
      const result = await client.unenroll({ factorId })
      if (!result.error) removed += 1
    } catch {
      // Keep going: one unremovable factor must not strand the others.
    }
  }
  return { removed, inspected: ids.length }
}

/**
 * Start a TOTP enrollment that cannot be blocked by a previous abandoned one.
 * `uniqueToken` is injected rather than generated here so the retry name is
 * deterministic under test; callers pass a per-attempt random value.
 */
export async function startTotpEnrollment(
  client: MfaEnrollmentClient,
  options: { friendlyName?: string; uniqueToken: string }
): Promise<MfaEnrollmentOutcome> {
  const baseName = options.friendlyName ?? HAWKVIEW_AUTHENTICATOR_NAME
  await clearPendingTotpFactors(client)

  const attempt = async (friendlyName: string) => {
    try {
      return await client.enroll({ factorType: 'totp', friendlyName })
    } catch (failure) {
      return { data: null, error: failure }
    }
  }

  let result = await attempt(baseName)
  if (result.error && (isFactorNameConflict(result.error) || isFactorLimitExceeded(result.error))) {
    // The blocking factor was not visible to cleanup. A fresh name sidesteps the
    // uniqueness rule so the user is not stranded by state they cannot see.
    result = await attempt(uniqueAuthenticatorName(baseName, options.uniqueToken))
  }

  if (result.error) {
    if (isFactorLimitExceeded(result.error)) return { ok: false, reason: 'factor-limit' }
    if (isFactorNameConflict(result.error)) return { ok: false, reason: 'name-conflict' }
    return { ok: false, reason: 'failed' }
  }

  const enrollment = readEnrollment(result.data)
  // A success without a usable secret is still a failure: rendering an empty QR
  // code would read as "setup worked" while no authenticator can be added.
  if (!enrollment) return { ok: false, reason: 'unavailable' }
  return { ok: true, ...enrollment }
}

/**
 * Abandon the current enrollment and leave no factor behind to block the next
 * one. The sweep runs even when `factorId` is null, because the case that
 * matters is a failed `enroll()` where the client never learned the id.
 */
export async function cancelTotpEnrollment(
  client: Pick<MfaEnrollmentClient, 'listFactors' | 'unenroll'>,
  factorId: string | null
): Promise<{ removed: number }> {
  let removed = 0
  if (factorId) {
    try {
      const result = await client.unenroll({ factorId })
      if (!result.error) removed += 1
    } catch {
      // Fall through to the sweep, which may still clear it.
    }
  }
  const swept = await clearPendingTotpFactors(client)
  return { removed: removed + swept.removed }
}

export function mfaEnrollmentFailureMessage(
  reason: MfaEnrollmentFailure
): string {
  if (reason === 'factor-limit') {
    return 'This account has too many authenticators registered. Ask a HawkView administrator to reset your MFA, then try again.'
  }
  if (reason === 'name-conflict') {
    return 'A previous authenticator setup could not be cleared. Ask a HawkView administrator to reset your MFA, then try again.'
  }
  if (reason === 'unavailable') {
    return 'HawkView could not start authenticator setup right now. Try again in a moment.'
  }
  return 'Authenticator setup could not be completed. Please try again.'
}
