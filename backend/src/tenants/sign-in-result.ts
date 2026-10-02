/** Display-code policy, not an authentication or integrity verdict. Accept only
 * canonical nonnegative Int32 codes; numeric negative zero is rejected too.
 * This is a conservative application policy, not a provider/provenance claim. */
export function canonicalSignInCode(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && !Object.is(value, -0) && value >= 0 && value <= 2_147_483_647
      ? String(value) : null
  }
  if (typeof value !== 'string' || value.length > 10 || !/^(0|[1-9][0-9]*)$/.test(value)) return null
  // Conversion is safe only after the original, untrimmed spelling is validated.
  return Number(value) <= 2_147_483_647 ? value : null
}

export function signInResult(value: unknown): 'Success' | 'Failure' | 'Not reported' {
  const code = canonicalSignInCode(value)
  return code === null ? 'Not reported' : code === '0' ? 'Success' : 'Failure'
}

export function signInSource(raw: unknown): string {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) &&
    (raw as Record<string, unknown>).hawkviewSource === 'MICROSOFT_365_MANAGEMENT_ACTIVITY'
    ? 'Microsoft 365 Management Activity' : 'Microsoft Graph auditLogs/signIns'
}
