import { z } from 'zod'
import type { NativeRiskSummaryResponse } from '../dashboard/hawkview-risk-summary.ts'

const LIMITATIONS = [
  'NO_TENANTS',
  'SCOPE_CAPPED',
  'NOT_ENABLED_FOR_TENANT',
  'EVALUATION_DISABLED',
  'NO_CURRENT_RUN',
  'INVALID_RUN',
  'COUNT_WITHHELD',
  'PARTIAL_ASSESSMENT',
  'READ_LIMIT_EXCEEDED',
] as const

const availability = z.enum(['AVAILABLE', 'PARTIAL', 'UNAVAILABLE'])
const accuracy = z.enum(['EXACT', 'AT_LEAST', 'NOT_AVAILABLE'])
const limitations = z.array(z.enum(LIMITATIONS)).max(100)
const clock = z.string().datetime().refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
const nullableClock = clock.nullable()
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

const tenantSummary = z.object({
  tenantId: z.string().min(1).max(200),
  availability,
  accuracy,
  distinctUserCount: count.nullable(),
  evaluatedAt: nullableClock,
  windowStart: nullableClock,
  windowEnd: nullableClock,
  complete: z.boolean(),
  limitations,
}).strict()

const responseSchema = z.object({
  contractVersion: z.literal('hawkview-native-risk-summary/v1'),
  source: z.literal('HAWKVIEW_NATIVE_ASSESSMENT'),
  countUnit: z.literal('TENANT_USER_IDENTITIES'),
  generatedAt: clock,
  fleet: z.object({
    availability,
    accuracy,
    distinctUserCount: count.nullable(),
    assessedTenants: count,
    totalTenants: count,
    enumeratedTenants: count,
    scopeComplete: z.boolean(),
    limitations,
  }).strict(),
  tenants: z.array(tenantSummary).max(100),
}).strict()

function validCount(
  availabilityValue: z.infer<typeof availability>,
  accuracyValue: z.infer<typeof accuracy>,
  count: number | null,
  complete: boolean,
) {
  if (accuracyValue === 'NOT_AVAILABLE') return count === null && !complete && availabilityValue !== 'AVAILABLE'
  if (count === null) return false
  if (accuracyValue === 'AT_LEAST') return count > 0 && !complete && availabilityValue === 'PARTIAL'
  return availabilityValue === 'AVAILABLE' && complete
}

function plainDocument(value: unknown, depth = 0, budget = { left: 10_000 }): boolean {
  if (--budget.left < 0 || depth > 12) return false
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every((item) => plainDocument(item, depth + 1, budget))
  return typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype &&
    Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && plainDocument(item, depth + 1, budget))
}

export function parseNativeRiskSummary(
  value: unknown
): NativeRiskSummaryResponse | null {
  if (!plainDocument(value)) return null
  const parsed = responseSchema.safeParse(value)
  if (!parsed.success) return null

  const result = parsed.data
  const fleet = result.fleet
  if (
    fleet.assessedTenants > fleet.enumeratedTenants ||
    fleet.enumeratedTenants > fleet.totalTenants ||
    fleet.enumeratedTenants !== result.tenants.length ||
    fleet.enumeratedTenants !== Math.min(fleet.totalTenants, 100) ||
    fleet.scopeComplete !== (fleet.enumeratedTenants === fleet.totalTenants) ||
    !validCount(
      fleet.availability,
      fleet.accuracy,
      fleet.distinctUserCount,
      fleet.accuracy === 'EXACT',
    ) ||
    (fleet.accuracy === 'EXACT' &&
      (fleet.totalTenants === 0 ||
        fleet.assessedTenants !== fleet.totalTenants ||
        fleet.enumeratedTenants !== fleet.totalTenants))
  ) {
    return null
  }

  const tenantIds = new Set<string>()
  let assessed = 0
  let known = 0
  const expectedLimitations = new Set<string>()
  for (const tenant of result.tenants) {
    const clocks = [tenant.windowStart, tenant.windowEnd, tenant.evaluatedAt]
    const hasClocks = clocks.every((value) => value !== null)
    if (
      tenantIds.has(tenant.tenantId) ||
      (!hasClocks && clocks.some((value) => value !== null)) ||
      (hasClocks && (tenant.windowStart! > tenant.windowEnd! || tenant.windowEnd! > tenant.evaluatedAt! || tenant.evaluatedAt! > result.generatedAt)) ||
      (tenant.accuracy !== 'NOT_AVAILABLE' && !hasClocks) ||
      (tenant.complete ? tenant.limitations.length !== 0 : tenant.limitations.length === 0) ||
      new Set(tenant.limitations).size !== tenant.limitations.length ||
      !validCount(
        tenant.availability,
        tenant.accuracy,
        tenant.distinctUserCount,
        tenant.complete,
      )
    ) {
      return null
    }
    tenantIds.add(tenant.tenantId)
    if (hasClocks) assessed++
    known += tenant.distinctUserCount ?? 0
    tenant.limitations.forEach((reason) => expectedLimitations.add(reason))
  }

  if (!fleet.scopeComplete) expectedLimitations.add('SCOPE_CAPPED')
  if (fleet.totalTenants === 0) expectedLimitations.add('NO_TENANTS')
  // Consistency validation only: consumers still render the SERVER aggregate,
  // never a sum computed from filtered, rendered or paginated UI rows.
  const exact = fleet.totalTenants > 0 && fleet.scopeComplete && result.tenants.every((tenant) => tenant.complete)
  const expectedAccuracy = exact ? 'EXACT' : known > 0 ? 'AT_LEAST' : 'NOT_AVAILABLE'
  const expectedAvailability = exact ? 'AVAILABLE' : known > 0 ? 'PARTIAL' : 'UNAVAILABLE'
  if (assessed !== fleet.assessedTenants || fleet.accuracy !== expectedAccuracy || fleet.availability !== expectedAvailability ||
    fleet.distinctUserCount !== (exact || known > 0 ? known : null) ||
    new Set(fleet.limitations).size !== fleet.limitations.length ||
    fleet.limitations.length !== expectedLimitations.size || fleet.limitations.some((reason) => !expectedLimitations.has(reason))) return null

  return result
}
