import { useQuery } from '@tanstack/react-query'
import type { TenantsResponse, DashboardSummaryResponse } from '@/types/api'
import { apiClient } from './client'
import { useAuth } from '@/components/providers/auth-provider'

export function useTenants() {
  const { cacheScope } = useAuth()
  return useQuery<TenantsResponse>({
    queryKey: ['tenants', cacheScope],
    queryFn: ({ signal }) =>
      apiClient.get<TenantsResponse>('/api/tenants', { signal }),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
}

export function useTenantBundle(tenantId?: string) {
  const { cacheScope } = useAuth()
  return useQuery<any>({
    queryKey: ['tenant', cacheScope, tenantId],
    queryFn: ({ signal }) =>
      apiClient.get(`/api/tenants/${encodeURIComponent(tenantId!)}`, { signal }),
    enabled: Boolean(tenantId),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
}

export function useDashboardSummary() {
  const { cacheScope } = useAuth()
  return useQuery<DashboardSummaryResponse>({
    queryKey: ['dashboard-summary', cacheScope],
    queryFn: ({ signal }) =>
      apiClient.get<DashboardSummaryResponse>('/api/dashboard/summary', {
        signal,
      }),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
}
