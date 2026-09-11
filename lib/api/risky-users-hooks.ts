'use client'

import { useMemo } from 'react'
import { microsoftChannel } from '@/lib/identity-risk/risky-users-view'
import {
  nativeRiskyUserCount,
  nativeRiskyUserList,
} from '@/lib/identity-risk/native-view'
import { useNativeRiskyUsersRead } from './risky-users-assessment-hooks'

/**
 * The single read behind all three Risky Users views. The count on the tenant
 * overview, the list and the detail all derive from one assessment, so they
 * cannot show a technician three different answers about the same tenant.
 *
 * Pointed at the rebuilt engine's own endpoint. This previously reached the old
 * engine through useIdentityRiskChannels, which meant every view here rendered
 * the previous engine's output regardless of what was built on top of it --
 * a state that builds green, passes both suites and changes nothing a
 * technician sees, because nothing in either suite asserts which URL is
 * fetched.
 *
 * The old hook is deliberately untouched rather than repointed. The frontend
 * already in front of customers keeps its route, and the two vocabularies stay
 * in separate modules so neither can be handed the other's payload.
 */
export function useRiskyUsers(tenantId: string, enabled = true) {
  const {
    nativeView,
    assessmentLoading,
    assessmentRequestError,
    assessmentContractError,
    microsoftView,
    microsoftLoading,
    cacheScope,
    retryAssessment,
    retryMicrosoft,
  } = useNativeRiskyUsersRead(tenantId, enabled)

  const channel = useMemo(
    () => microsoftChannel(microsoftView),
    [microsoftView]
  )

  // A failed read and an unreadable response both yield null here rather than
  // an empty assessment, so the surface reports an absence instead of a result.
  const readable =
    assessmentRequestError || assessmentContractError ? null : nativeView

  const count = useMemo(() => nativeRiskyUserCount(readable), [readable])
  const list = useMemo(() => nativeRiskyUserList(readable), [readable])

  return {
    /**
     * The native response, or null. Kept so a surface can say WHY there is
     * nothing rather than rendering an empty screen, which is the one reading
     * that must never be available by accident.
     */
    native: nativeView,
    channel,
    count,
    list,
    microsoftView,
    loading: assessmentLoading || microsoftLoading,
    requestFailed: assessmentRequestError,
    contractFailed: assessmentContractError,
    cacheScope,
    retry: () => {
      void retryAssessment()
      void retryMicrosoft()
    },
  }
}
