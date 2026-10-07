'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/components/providers/auth-provider'
import { ApiError, apiClient } from './client'
import { isReadyDataScope } from './pim-schedule-summary-hooks'
import {
  parseDirectoryRoleControl,
  type DirectoryRoleControlView,
} from '@/lib/tenants/directory-role-control-view'

/** Why the control cannot be read or written right now. Each value is something the server actually
 * said; none of them is ever rendered as "collection is off", which would be a claim about the
 * durable opt-in that we do not have. */
export type DirectoryRoleControlFailure =
  /** 403 — this member may view the screen but not change collection. */
  | 'forbidden'
  /** 409 on read — the server has no current control context to offer. */
  | 'unavailable'
  /** 409 on write — the observed context changed under us. Never replayed automatically. */
  | 'conflict'
  /** 400 on write — the server rejected the expectation we echoed. Also requires a fresh read. */
  | 'rejected'
  /** Anything else, including an answer we could not parse. */
  | 'error'

const controlPath = (customerTenantId: string) =>
  `/api/tenants/${encodeURIComponent(customerTenantId)}/collection/directory-roles/control`

export const directoryRoleControlKey = (cacheScope: string, customerTenantId: string) =>
  ['directory-role-control', cacheScope, customerTenantId] as const

/** Classifies a thrown client error. A status we do not recognise stays 'error' rather than being
 * folded into a more specific story. */
export function classifyControlFailure(
  error: unknown,
  phase: 'read' | 'write'
): DirectoryRoleControlFailure {
  const status = error instanceof ApiError ? error.status : null
  if (status === 403) return 'forbidden'
  if (status === 409) return phase === 'read' ? 'unavailable' : 'conflict'
  if (status === 400 && phase === 'write') return 'rejected'
  return 'error'
}

/** The DIRECTORY_ROLES collection control for one tenant.
 *
 * Keyed by authenticated cache scope and customer tenant together and enabled only for a ready
 * scope, so a delayed answer for a previous identity or tenant can never be read as the current
 * one's control. No polling and no automatic retry: a control is read when the screen asks and after
 * an explicit action, never on a timer. */
export function useDirectoryRoleControl(customerTenantId: string) {
  const { cacheScope, isLoading } = useAuth()
  const enabled = !isLoading && isReadyDataScope(cacheScope) && Boolean(customerTenantId)

  return useQuery<DirectoryRoleControlView>({
    queryKey: directoryRoleControlKey(cacheScope, customerTenantId),
    enabled,
    queryFn: async ({ signal }) => {
      const raw = await apiClient.get<unknown>(controlPath(customerTenantId), {
        signal,
        cache: 'no-store',
      })
      const parsed = parseDirectoryRoleControl(raw)
      if (!parsed) {
        // An unreadable answer is a failure. It is never reported as a disabled opt-in.
        throw new Error('HawkView returned an unsupported directory collection control.')
      }
      return parsed
    },
    retry: false,
    staleTime: 0,
  })
}

/** Writes the user's explicit enable/disable decision.
 *
 * The caller supplies only `enabled`. The expectation is read from the cache HERE, under this
 * tenant's own query key, at the moment of submission — so a handler closed over an older render,
 * or over a different tenant, cannot carry that tenant's context into this write. If no current
 * context is cached, the write is refused locally instead of inventing one.
 *
 * On conflict nothing is retried and nothing is recaptured: the cached control and stored results
 * are invalidated so the screen re-reads what is true now, and the user must act again. */
export function useSetDirectoryRoleControl(customerTenantId: string) {
  const { cacheScope } = useAuth()
  const queryClient = useQueryClient()
  const queryKey = directoryRoleControlKey(cacheScope, customerTenantId)

  return useMutation<DirectoryRoleControlView, unknown, { enabled: boolean }>({
    mutationKey: ['directory-role-control-write', cacheScope, customerTenantId],
    mutationFn: async ({ enabled }) => {
      const current = queryClient.getQueryData<DirectoryRoleControlView>(queryKey)
      if (!current) {
        throw new Error('HawkView has no current directory collection context to act on.')
      }
      const raw = await apiClient.post<unknown>(controlPath(customerTenantId), {
        enabled,
        // Echoed verbatim, exactly as observed. Never re-derived, never merged with a newer read.
        expected: current.expected,
      })
      const parsed = parseDirectoryRoleControl(raw)
      if (!parsed) {
        throw new Error('HawkView returned an unsupported directory collection control.')
      }
      return parsed
    },
    retry: false,
    onSuccess: (next) => {
      // Only this tenant's entries. The applied control is written straight in so the screen shows
      // the server's answer, and the stored results are invalidated because an opt-in change makes
      // the previous activation status stale.
      queryClient.setQueryData(queryKey, next)
      void queryClient.invalidateQueries({ queryKey })
      void queryClient.invalidateQueries({
        queryKey: ['directory-role-results', cacheScope, customerTenantId],
      })
    },
    onError: () => {
      // A refused write tells us our observed context may be wrong. Drop it and re-read; do not
      // resend with a freshly captured expectation, which would apply an authority change the user
      // never confirmed against the new state.
      void queryClient.invalidateQueries({ queryKey })
      void queryClient.invalidateQueries({
        queryKey: ['directory-role-results', cacheScope, customerTenantId],
      })
    },
  })
}
