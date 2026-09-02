export type HawkViewFeatureFlags = Readonly<{
  identityRiskUi: boolean
}>

export const DEFAULT_HAWKVIEW_FEATURE_FLAGS: HawkViewFeatureFlags =
  Object.freeze({
    identityRiskUi: false,
  })

function explicitlyEnabled(value: string | null | undefined) {
  return value?.trim().toLowerCase() === 'true'
}

export function resolveServerFeatureFlags(input: {
  identityRiskUi?: string | null
}): HawkViewFeatureFlags {
  return Object.freeze({
    identityRiskUi: explicitlyEnabled(input.identityRiskUi),
  })
}
