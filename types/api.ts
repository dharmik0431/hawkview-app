import { z } from 'zod'

export const TenantSchema = z.object({
  id: z.string(),
  name: z.string(),
  microsoftTenantId: z.string(),
  provider: z.literal('microsoft'),
  domain: z.string().nullable(),
  status: z.enum(['pending', 'active', 'suspended', 'disconnected']),
  connectionStatus: z
    .enum(['pending-consent', 'connected', 'error', 'revoked'])
    .nullable(),
  connectionMode: z.enum(['hawkview-managed', 'customer-managed']),
  lastSync: z.string().nullable(),
  secureScore: z.number().nullable(),
  healthScore: z.number().min(0).max(100),
  mfaCoverage: z.number().min(0).max(100).nullable(),
  riskyIdentityCount: z.number().int().nonnegative(),
  attention: z.array(z.object({
    key: z.string(),
    label: z.string(),
    severity: z.enum(['critical', 'high', 'medium']),
    why: z.string(),
    detectedAt: z.string().nullable(),
    actionLabel: z.string().optional(),
    actionUrl: z.string().optional(),
  })),
  licenseCount: z.number().int().nullable(),
  requiredPermissions: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
    })
  ),
  consentedPermissions: z.array(z.string()),
  missingPermissions: z.array(z.string()),
  connectionErrorCode: z.string().nullable(),
  organization: z.object({
    name: z.string(),
    slug: z.string(),
  }),
})

export type Tenant = z.infer<typeof TenantSchema>

export const TenantsResponseSchema = z.object({
  tenants: z.array(TenantSchema),
  error: z.string().optional(),
})

export type TenantsResponse = z.infer<typeof TenantsResponseSchema>

export const CreateTenantResponseSchema = z.object({
  tenant: TenantSchema,
  requiresConsent: z.boolean(),
})

export type CreateTenantResponse = z.infer<typeof CreateTenantResponseSchema>

export const MicrosoftConsentResponseSchema = z.object({
  consentUrl: z.string().url(),
  requiredPermissions: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
    })
  ),
})

export type MicrosoftConsentResponse = z.infer<
  typeof MicrosoftConsentResponseSchema
>

export const DashboardStatsSchema = z.object({
  totalUsers: z.number(),
  activeLicenses: z.number(),
  groups: z.number(),
  apps: z.number(),
})

export type DashboardStats = z.infer<typeof DashboardStatsSchema>

export const DashboardSummaryResponseSchema = z.object({
  hasTenant: z.boolean(),
  stats: DashboardStatsSchema.optional(),
})

export type DashboardSummaryResponse = z.infer<
  typeof DashboardSummaryResponseSchema
>
