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
const nullableClock = z.string().datetime().nullable()

const tenantSummary = z.object({
  tenantId: z.string().min(1).max(200),
  availability,
  accuracy,
  distinctUserCount: z.number().int().nonnegative().nullable(),
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
  generatedAt: z.string().datetime(),
  fleet: z.object({
    availability,
    accuracy,
    distinctUserCount: z.number().int().nonnegative().nullable(),
    assessedTenants: z.number().int().nonnegative(),
    totalTenants: z.number().int().nonnegative(),
    enumeratedTenants: z.number().int().nonnegative(),
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
  if (accuracyValue === 'NOT_AVAILABLE') return count === null
  if (count === null) return false
  if (accuracyValue === 'AT_LEAST') return count > 0
  return availabilityValue === 'AVAILABLE' && complete
}

export function parseNativeRiskSummary(
  value: unknown
): NativeRiskSummaryResponse | null {
  const parsed = responseSchema.safeParse(value)
  if (!parsed.success) return null

  const result = parsed.data
  const fleet = result.fleet
  if (
    fleet.assessedTenants > fleet.enumeratedTenants ||
    fleet.enumeratedTenants > fleet.totalTenants ||
    !validCount(
      fleet.availability,
      fleet.accuracy,
      fleet.distinctUserCount,
      fleet.scopeComplete,
    ) ||
    (fleet.accuracy === 'EXACT' &&
      (fleet.totalTenants === 0 ||
        fleet.assessedTenants !== fleet.totalTenants ||
        fleet.enumeratedTenants !== fleet.totalTenants))
  ) {
    return null
  }

  const tenantIds = new Set<string>()
  for (const tenant of result.tenants) {
    if (
      tenantIds.has(tenant.tenantId) ||
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
  }

  return result
}
