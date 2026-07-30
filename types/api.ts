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
  lastSync: z.string().nullable(),
  secureScore: z.number().nullable(),
  licenseCount: z.number().int().nullable(),
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

export type DashboardSummaryResponse = z.infer<typeof DashboardSummaryResponseSchema>
