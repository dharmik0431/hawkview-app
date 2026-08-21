export const ENTRA_PREMIUM_SERVICE_PLAN_IDS = new Set([
  '41781fb2-bc02-4b7c-bd55-b576c07bb09d', // Microsoft Entra ID P1
  'eec0eb4f-6444-4f95-aba0-50c24d67f998', // Microsoft Entra ID P2
])

export const ENTRA_PREMIUM_SERVICE_PLAN_NAMES = new Set([
  'AAD_PREMIUM',
  'AAD_PREMIUM_P2',
])

export type SignInEntitlement = 'PREMIUM' | 'NON_PREMIUM' | 'UNVERIFIED'

type LicenseSyncEvidence = {
  status?: unknown
  lastSuccessfulAt?: unknown
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (Object.getPrototypeOf(value) !== Object.prototype) return null
  return value as Record<string, unknown>
}

function currentSuccessfulLicenseEvidence(
  evidence: LicenseSyncEvidence | null | undefined,
  now: Date,
) {
  if (evidence?.status !== 'SUCCEEDED') return false
  const lastSuccessfulAt =
    evidence.lastSuccessfulAt instanceof Date
      ? evidence.lastSuccessfulAt
      : typeof evidence.lastSuccessfulAt === 'string'
        ? new Date(evidence.lastSuccessfulAt)
        : null
  if (!lastSuccessfulAt || !Number.isFinite(lastSuccessfulAt.getTime())) {
    return false
  }
  const age = now.getTime() - lastSuccessfulAt.getTime()
  return age >= 0 && age <= 26 * 60 * 60 * 1000
}

/**
 * Decide only from a complete, recent /subscribedSkus projection. Missing,
 * stale, malformed, or still-provisioning evidence must never be interpreted
 * as proof that a tenant lacks Microsoft Entra ID P1/P2.
 */
export function deriveSignInEntitlement(input: {
  licenses: Array<{ servicePlans?: unknown }>
  licenseSync: LicenseSyncEvidence | null | undefined
  now?: Date
}): SignInEntitlement {
  const now = input.now ?? new Date()
  if (!currentSuccessfulLicenseEvidence(input.licenseSync, now)) {
    return 'UNVERIFIED'
  }

  let sawUnverifiablePremiumPlan = false
  for (const license of input.licenses) {
    if (!Array.isArray(license.servicePlans)) return 'UNVERIFIED'
    for (const candidate of license.servicePlans) {
      const plan = ownRecord(candidate)
      if (!plan) return 'UNVERIFIED'
      const name =
        typeof plan.servicePlanName === 'string'
          ? plan.servicePlanName.trim().toUpperCase()
          : ''
      const id =
        typeof plan.servicePlanId === 'string'
          ? plan.servicePlanId.trim().toLowerCase()
          : ''
      const isPremium =
        ENTRA_PREMIUM_SERVICE_PLAN_NAMES.has(name) ||
        ENTRA_PREMIUM_SERVICE_PLAN_IDS.has(id)
      if (!isPremium) continue

      const provisioningStatus =
        typeof plan.provisioningStatus === 'string'
          ? plan.provisioningStatus.trim().toUpperCase()
          : ''
      if (provisioningStatus === 'SUCCESS') return 'PREMIUM'
      if (provisioningStatus !== 'DISABLED') {
        sawUnverifiablePremiumPlan = true
      }
    }
  }

  return sawUnverifiablePremiumPlan ? 'UNVERIFIED' : 'NON_PREMIUM'
}
