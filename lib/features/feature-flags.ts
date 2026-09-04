export type HawkViewFeatureFlags = Readonly<{
  identityRiskUi: boolean
}>

// Fail closed without the server provider; distinct from server exposure policy.
export const DEFAULT_HAWKVIEW_FEATURE_FLAGS: HawkViewFeatureFlags =
  Object.freeze({
    identityRiskUi: false,
  })

function globallyVisibleUnlessDisabled(value: string | null | undefined) {
  // Absent configuration exposes the UI globally. Explicit false is the
  // emergency hide; blank and unrecognized values also fail closed.
  if (value == null) return true
  return value.trim().toLowerCase() === 'true'
}

export function resolveServerFeatureFlags(input: {
  identityRiskUi?: string | null
}): HawkViewFeatureFlags {
  return Object.freeze({
    identityRiskUi: globallyVisibleUnlessDisabled(input.identityRiskUi),
  })
}
