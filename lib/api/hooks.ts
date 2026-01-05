import { useQuery } from '@tanstack/react-query'
import type { TenantsResponse, DashboardSummaryResponse } from '@/types/api'

export function useTenants() {
  return useQuery<TenantsResponse>({
    queryKey: ['tenants'],
    queryFn: async () => {
      return { tenants: [] }
    },
  })
}

export function useDashboardSummary() {
  return useQuery<DashboardSummaryResponse>({
    queryKey: ['dashboard-summary'],
    queryFn: async () => {
      return {
        hasTenant: false,
        stats: {
          totalUsers: 0,
          activeLicenses: 0,
          groups: 0,
          apps: 0,
        },
      }
    },
  })
}
