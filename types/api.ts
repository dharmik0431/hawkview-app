import { z } from 'zod'

export const TenantSchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  status: z.enum(['active', 'inactive', 'pending']),
})

export type Tenant = z.infer<typeof TenantSchema>

export const TenantsResponseSchema = z.object({
  tenants: z.array(TenantSchema),
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
