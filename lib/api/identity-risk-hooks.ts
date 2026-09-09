'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/components/providers/auth-provider'
import { apiClient } from './client'
import { parseInvestigationAccess } from './mailbox-investigation'
import {
  adaptMicrosoftRiskyUsersResponse,
  adaptRiskAssessmentResponse,
  unavailableMicrosoftEntraRiskyUsers,
} from '@/lib/identity-risk/adapter'

export function useIdentityRiskChannels(tenantId: string, enabled: boolean) {
  const { cacheScope } = useAuth()
  const encodedTenantId = encodeURIComponent(tenantId)

  const assessment = useQuery<unknown>({
    queryKey: ['identity-risk', cacheScope, tenantId, 'hawkview-assessment'],
    queryFn: ({ signal }) =>
      apiClient.get(
        `/api/tenants/${encodedTenantId}/identity-signals/assessment`,
        {
          signal,
        }
      ),
    enabled: enabled && Boolean(tenantId),
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  })
  const microsoft = useQuery<unknown>({
    queryKey: ['identity-risk', cacheScope, tenantId, 'microsoft-risky-users'],
    queryFn: ({ signal }) =>
      apiClient.get(
        `/api/tenants/${encodedTenantId}/microsoft-entra-risky-users`,
        {
          signal,
        }
      ),
    enabled: enabled && Boolean(tenantId),
    retry: false,
    staleTime: 60_000,
  })

  const assessmentView = useMemo(
    () => adaptRiskAssessmentResponse(assessment.data),
    [assessment.data]
  )
  const microsoftView = useMemo(() => {
    if (microsoft.isError) {
      return unavailableMicrosoftEntraRiskyUsers(
        'ERROR',
        'Microsoft Entra risky-user evidence could not be loaded. This does not mean no risky users were reported.'
      )
    }
    return adaptMicrosoftRiskyUsersResponse(microsoft.data)
  }, [microsoft.data, microsoft.isError])

  return {
    cacheScope,
    assessmentView,
    assessmentLoading: assessment.isLoading,
    assessmentRequestError: assessment.isError,
    assessmentContractError:
      !assessment.isLoading &&
      !assessment.isError &&
      assessment.data !== undefined &&
      assessmentView === null,
    microsoftView,
    microsoftLoading: microsoft.isLoading,
    retryAssessment: () => assessment.refetch(),
    retryMicrosoft: () => microsoft.refetch(),
  }
}

export function useIdentityRiskInvestigationAccess(tenantId: string) {
  const { cacheScope } = useAuth()
  const access = useQuery<unknown>({
    queryKey: ['identity-risk', cacheScope, tenantId, 'investigation-access'],
    queryFn: ({ signal }) =>
      apiClient.get(
        `/api/tenants/${encodeURIComponent(tenantId)}/identity-signals/investigation-access`,
        { signal, cache: 'no-store' }
      ),
    enabled: Boolean(tenantId),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })
  return {
    allowed: !access.isError && parseInvestigationAccess(access.data),
    cacheScope,
  }
}
