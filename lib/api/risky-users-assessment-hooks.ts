'use client'

/**
 * The reads behind Risky Users, pointed at the rebuilt engine's own endpoint.
 *
 * A separate module from identity-risk-hooks rather than a change to it, and
 * the reason is the deploy topology rather than tidiness. The backend
 * auto-deploys on merge while the frontend publishes separately, so the old
 * route must keep working unchanged for the frontend already in front of
 * customers. A second fetch cannot affect it; an edited one can.
 *
 * The two responses also speak different vocabularies -- one carries
 * `capability` and `sources`, the other `collectors` and a `because` -- and a
 * single module serving both would need a discriminator, which is one refactor
 * away from feeding an adapter the other's payload.
 *
 * Microsoft's channel is fetched here too rather than borrowed from the old
 * hook. It is an independent endpoint, and borrowing it would keep this path
 * resolving to the module it exists to replace.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/components/providers/auth-provider'
import { apiClient } from './client'
import {
  adaptMicrosoftRiskyUsersResponse,
  unavailableMicrosoftEntraRiskyUsers,
} from '@/lib/identity-risk/adapter'
import { adaptNativeAssessment } from '@/lib/identity-risk/native-assessment'

export function useNativeRiskyUsersRead(tenantId: string, enabled = true) {
  const { cacheScope } = useAuth()
  const encodedTenantId = encodeURIComponent(tenantId)

  const assessment = useQuery<unknown>({
    queryKey: ['risky-users', cacheScope, tenantId, 'assessment'],
    queryFn: ({ signal }) =>
      apiClient.get(`/api/tenants/${encodedTenantId}/risky-users/assessment`, {
        signal,
        // The endpoint sets no-store; asking for it here too keeps a stale
        // assessment out of a surface whose whole claim is about currency.
        cache: 'no-store',
      }),
    enabled: enabled && Boolean(tenantId),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })

  const microsoft = useQuery<unknown>({
    queryKey: ['risky-users', cacheScope, tenantId, 'microsoft-risky-users'],
    queryFn: ({ signal }) =>
      apiClient.get(
        `/api/tenants/${encodedTenantId}/microsoft-entra-risky-users`,
        { signal }
      ),
    enabled: enabled && Boolean(tenantId),
    retry: false,
    staleTime: 60_000,
  })

  const nativeView = useMemo(
    () => adaptNativeAssessment(assessment.data),
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
    nativeView,
    assessmentLoading: assessment.isLoading,
    /** The request failed. Distinct from a response that arrived and refused. */
    assessmentRequestError: assessment.isError,
    /**
     * A response arrived and this build could not read it at all.
     *
     * Separate from a request failure because they are different sentences and
     * different next steps: one may resolve on retry, the other means the
     * contract moved and a retry changes nothing.
     */
    assessmentContractError:
      !assessment.isError && !assessment.isLoading
        ? assessment.data !== undefined && nativeView === null
        : false,
    microsoftView,
    microsoftLoading: microsoft.isLoading,
    retryAssessment: () => {
      void assessment.refetch()
    },
    retryMicrosoft: () => {
      void microsoft.refetch()
    },
  }
}
