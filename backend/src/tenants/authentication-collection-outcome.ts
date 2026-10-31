/** A primary authentication record was dropped before the collection window
 * could be certified. This is distinct from complete audit-feed fallback with
 * optional enrichment missing. Keep the persisted reason readable on retry. */
export const CORE_AUTHENTICATION_PARTIAL = 'sign-ins-record-validation-partial'

export function isCoreAuthenticationPartial(resourceType: string, reasonCode: string | null | undefined) {
  return resourceType === 'SIGN_INS' && reasonCode === CORE_AUTHENTICATION_PARTIAL
}

// Only these successfully persisted, limited-source SIGN_INS outcomes may be
// treated as limited coverage. Unknown partial codes must not imply success.
const LIMITED_SIGN_IN_CODES = new Set([
  'sign-ins-premium-graph-fallback-active',
  'sign-ins-non-premium-fallback-active',
  'sign-ins-entitlement-unverified-fallback-active',
  'sign-ins-premium-graph-fallback-active-geolocation-partial',
  'sign-ins-non-premium-fallback-active-geolocation-partial',
  'sign-ins-entitlement-unverified-fallback-active-geolocation-partial',
])

export function isRecognizedLimitedSignInCode(
  resourceType: string,
  reasonCode: string | null | undefined,
): boolean {
  return resourceType === 'SIGN_INS' &&
    typeof reasonCode === 'string' &&
    LIMITED_SIGN_IN_CODES.has(reasonCode)
}
