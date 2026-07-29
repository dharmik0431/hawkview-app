import { useQuery } from '@tanstack/react-query'
import type { TenantsResponse, DashboardSummaryResponse } from '@/types/api'
import { apiClient } from './client'

export function useTenants() {
  return useQuery<TenantsResponse>({
    queryKey: ['tenants'],
    queryFn: ({ signal }) =>
      apiClient.get<TenantsResponse>('/api/tenants', { signal }),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
}

export function useTenantBundle(tenantId?: string) {
  return useQuery<any>({
    queryKey: ['tenant', tenantId],
    queryFn: ({ signal }) =>
      apiClient.get(`/api/tenants/${encodeURIComponent(tenantId!)}`, { signal }),
    enabled: Boolean(tenantId),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
}

export function useDashboardSummary() {
  return useQuery<DashboardSummaryResponse>({
    queryKey: ['dashboard-summary'],
    queryFn: ({ signal }) =>
      apiClient.get<DashboardSummaryResponse>('/api/dashboard/summary', {
        signal,
      }),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
}
