import { useQuery } from '@tanstack/react-query'
import type { TenantsResponse, DashboardSummaryResponse } from '@/types/api'

export function useTenants() {
  return useQuery<TenantsResponse>({
    queryKey: ['tenants'],
    queryFn: async ({ signal }) => {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => {
        controller.abort()
      }, 30000)

      const onAbort = () => controller.abort()
      if (signal) {
        signal.addEventListener('abort', onAbort)
      }

      try {
        const res = await fetch('/api/tenants', { signal: controller.signal })
        clearTimeout(timeoutId)
        if (signal) signal.removeEventListener('abort', onAbort)

        const contentType = res.headers.get('content-type') || ''
        if (!contentType.toLowerCase().includes('application/json')) {
          throw new Error(
            `Tenant service returned HTTP ${res.status} instead of JSON.`
          )
        }

        const data = (await res.json()) as TenantsResponse

        if (!res.ok) {
          throw new Error(data.error || `HTTP ${res.status}: Failed to load tenant directory.`)
        }

        if (data.mode === 'microsoft' && data.error) {
          throw new Error(data.error)
        }

        return data
      } catch (err: any) {
        clearTimeout(timeoutId)
        if (signal) signal.removeEventListener('abort', onAbort)

        if (err.name === 'AbortError') {
          throw new Error('Tenant directory request timed out after 30 seconds.')
        }
        throw err
      }
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
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
