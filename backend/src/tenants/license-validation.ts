function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function requiredText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw new Error('Microsoft returned an invalid license inventory response.')
  return value.trim()
}
function optionalText(value: unknown, maximum: number): string | null {
  return value == null ? null : requiredText(value, maximum)
}
function units(value: unknown): number {
  if (value == null) return 0
  if (!Number.isSafeInteger(value) || ((value as number) < 0 || (value as number) > 2147483647)) throw new Error('Microsoft returned an invalid license inventory response.')
  return value as number
}

export function validatedServicePlans(value: unknown) {
  if (!Array.isArray(value)) throw new Error('Microsoft returned an invalid license service-plan response.')
  if (value.length > 128) throw new Error('Microsoft license service plans exceeded the bounded record limit.')
  const ids = new Set<string>()
  const plans = value.map((plan) => {
    if (!record(plan)) throw new Error('Microsoft returned an invalid license service-plan response.')
    const servicePlanId = requiredText(plan.servicePlanId, 80)
    if (ids.has(servicePlanId.toLowerCase())) throw new Error('Microsoft returned an invalid duplicate license service-plan response.')
    ids.add(servicePlanId.toLowerCase())
    const servicePlanName = requiredText(plan.servicePlanName, 120)
    const provisioningStatus = requiredText(plan.provisioningStatus, 50)
    const appliesTo = optionalText(plan.appliesTo, 50)
    return { servicePlanId, servicePlanName, provisioningStatus, ...(appliesTo ? { appliesTo } : {}) }
  })
  return plans.sort((a, b) => `${a.servicePlanId}:${a.servicePlanName}`.localeCompare(`${b.servicePlanId}:${b.servicePlanName}`))
}

/** Validate the whole bounded inventory before any snapshot or row can advance. */
export function validatedLicenseRows(value: unknown) {
  if (!Array.isArray(value)) throw new Error('Microsoft returned an invalid license inventory response.')
  if (value.length > 1000) throw new Error('Microsoft licenses exceeded the bounded record limit.')
  const ids = new Set<string>()
  return value.map((sku) => {
    if (!record(sku)) throw new Error('Microsoft returned an invalid license inventory response.')
    const skuId = requiredText(sku.skuId, 100)
    if (ids.has(skuId.toLowerCase())) throw new Error('Microsoft returned an invalid duplicate license inventory response.')
    ids.add(skuId.toLowerCase())
    const prepaid = sku.prepaidUnits
    if (prepaid != null && !record(prepaid)) throw new Error('Microsoft returned an invalid license inventory response.')
    return {
      skuId, skuPartNumber: requiredText(sku.skuPartNumber, 200),
      consumedUnits: units(sku.consumedUnits), capabilityStatus: optionalText(sku.capabilityStatus, 50),
      prepaidUnits: { enabled: units(prepaid?.enabled), warning: units(prepaid?.warning), suspended: units(prepaid?.suspended), lockedOut: units(prepaid?.lockedOut) },
      servicePlans: validatedServicePlans(sku.servicePlans),
    }
  })
}

