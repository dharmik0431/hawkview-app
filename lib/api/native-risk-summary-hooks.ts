'use client'

import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/components/providers/auth-provider'
import { apiClient } from './client'
import type { NativeRiskSummaryResponse } from '@/lib/dashboard/hawkview-risk-summary'
import { parseNativeRiskSummary } from './native-risk-summary-parser'

export function useNativeRiskSummary() {
  const { cacheScope } = useAuth()
  return useQuery<NativeRiskSummaryResponse>({
    queryKey: ['native-risk-summary', cacheScope],
    queryFn: async ({ signal }) => {
      const raw = await apiClient.get<unknown>('/api/risky-users/summary', {
        signal,
        cache: 'no-store',
      })
      const parsed = parseNativeRiskSummary(raw)
      if (!parsed) {
        throw new Error('HawkView returned an unsupported risk summary.')
      }
      return parsed
    },
    retry: false,
    staleTime: 60_000,
  })
}
