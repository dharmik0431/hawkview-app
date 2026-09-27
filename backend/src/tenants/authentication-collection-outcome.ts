/** A primary authentication record was dropped before the collection window
 * could be certified. This is distinct from complete audit-feed fallback with
 * optional enrichment missing. Keep the persisted reason readable on retry. */
export const CORE_AUTHENTICATION_PARTIAL = 'sign-ins-record-validation-partial'

export function isCoreAuthenticationPartial(resourceType: string, reasonCode: string | null | undefined) {
  return resourceType === 'SIGN_INS' && reasonCode === CORE_AUTHENTICATION_PARTIAL
}
