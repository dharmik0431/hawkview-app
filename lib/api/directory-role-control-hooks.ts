'use client'

import { useCallback, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/components/providers/auth-provider'
import { ApiError, apiClient } from './client'
import { isReadyDataScope } from './pim-schedule-summary-hooks'
import {
  directoryRoleControlAffordance,
  parseDirectoryRoleControl,
  type DirectoryRoleControlAffordance,
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
  /** Refused in the browser before anything was sent. Not a server answer at all. */
  | 'not-sent'

/** Whether a failed write PROVES the durable opt-in was not changed.
 *
 * Only a response the server produced before applying proves that: 403 is refused at authorization,
 * and 400/409 are refused at validation or the compare-and-set. Everything else — a lost response, a
 * timeout, a 500, a body we could not parse — leaves the outcome UNKNOWN, because this contract
 * commits the opt-in and then serialises a reply, so the commit can succeed while the reply is lost.
 * Reporting unknown as "nothing was changed" asserts a state we have no evidence for. */
export function writeOutcomeOf(
  failure: DirectoryRoleControlFailure
): 'refused' | 'unknown' | 'not-sent' {
  if (failure === 'not-sent') return 'not-sent'
  return failure === 'forbidden' || failure === 'conflict' || failure === 'rejected'
    ? 'refused'
    : 'unknown'
}

/** A write refused before any request left the browser. Distinct from every server answer: there is
 * no outcome to be uncertain about, because nothing was sent. */
export class LocalRefusal extends Error {
  readonly localRefusal = true
}

const controlPath = (customerTenantId: string) =>
  `/api/tenants/${encodeURIComponent(customerTenantId)}/collection/directory-roles/control`

export const directoryRoleControlKey = (cacheScope: string, customerTenantId: string) =>
  ['directory-role-control', cacheScope, customerTenantId] as const

const resultsKey = (cacheScope: string, customerTenantId: string) =>
  ['directory-role-results', cacheScope, customerTenantId] as const

/** Classifies a thrown client error. A status we do not recognise stays 'error' rather than being
 * folded into a more specific story. */
export function classifyControlFailure(
  error: unknown,
  phase: 'read' | 'write'
): DirectoryRoleControlFailure {
  if (error instanceof LocalRefusal) return 'not-sent'
  const status = error instanceof ApiError ? error.status : null
  if (status === 403) return 'forbidden'
  if (status === 409) return phase === 'read' ? 'unavailable' : 'conflict'
  if (status === 400 && phase === 'write') return 'rejected'
  return 'error'
}

/** What the screen may say and offer. Derived only from the server's answers and the query
 * lifecycle, never from an assumption about an unfinished write. */
export type DirectoryRoleControlPresentation = {
  /** 'checking' — first read in flight. 'refreshing' — a read we are WAITING on before any further
   * claim or action. 'unresolved' — a write whose outcome is unknown and not yet resolved by a fresh
   * successful read. 'refused' — a write the server proved it did not apply. 'read-failed' — we have
   * no answer we are willing to present. 'current' — a confirmed, fresh read. */
  readonly phase: 'checking' | 'refreshing' | 'unresolved' | 'refused' | 'read-failed' | 'current'
  /** True only when a successful read is current AND no unresolved write is outstanding. Copy that
   * states the opt-in, and any action, is permitted only then. */
  readonly stateIsKnown: boolean
  readonly control: DirectoryRoleControlView | null
  readonly affordance: DirectoryRoleControlAffordance
  readonly readFailure: DirectoryRoleControlFailure | null
  readonly writeFailure: DirectoryRoleControlFailure | null
  /** A read is in flight right now. Reported alongside an unresolved write outcome so the reason is
   * never hidden behind a spinner: the user sees BOTH what happened and that we are re-reading. */
  readonly isRefreshing: boolean
}

export type ControlLifecycle = {
  readonly control: DirectoryRoleControlView | undefined
  readonly isPending: boolean
  /** A read is in flight. TanStack reports this true for a refetch while `isPending` is false. */
  readonly isFetching: boolean
  readonly isReadError: boolean
  readonly readError: unknown
  readonly writeFailure: DirectoryRoleControlFailure | null
  /** When the outstanding write failed, or null when none is outstanding. Cleared once a successful
   * fresh read has resolved it, which is what stops a later read failure reviving it. */
  readonly settledAt: number | null
  /** react-query's `dataUpdatedAt`: when the currently cached answer was accepted. */
  readonly dataUpdatedAt: number
  readonly offered: boolean
}

/** Pure, so every lifecycle combination is testable without a clock or a rendered tree.
 *
 * The ordering is deliberate. A write whose outcome is unknown outranks the cached answer, because
 * that answer predates the write and cannot describe the state afterwards. A read that is merely
 * cached while a refetch is in flight or has failed is NOT current: TanStack keeps `data` across a
 * failed refetch and reports `isError` with `isPending` false, so "we have data" is not "we know the
 * state". Only `dataUpdatedAt` moving past the write's settle time proves the answer on screen was
 * read after the write. */
export function controlPresentation(l: ControlLifecycle): DirectoryRoleControlPresentation {
  const readFailure = l.isReadError ? classifyControlFailure(l.readError, 'read') : null
  const none: DirectoryRoleControlAffordance = {
    canEnable: false, canDisable: false, eligibilityUnavailable: false,
  }
  const base = {
    control: l.control ?? null, readFailure, writeFailure: l.writeFailure,
    isRefreshing: l.isFetching,
  }

  if (!l.offered) return { phase: 'current', stateIsKnown: false, affordance: none, ...base }
  if (l.isPending) return { phase: 'checking', stateIsKnown: false, affordance: none, ...base }

  // Fail closed: an outstanding write is resolved only by an answer accepted strictly AFTER it
  // settled. A same-millisecond tie counts as unresolved, which is the safe direction — the panel
  // says it cannot confirm rather than claiming a state it may not have re-read.
  const resolvedByFreshRead = l.settledAt !== null && !l.isFetching && !l.isReadError
    && l.control !== undefined && l.dataUpdatedAt > l.settledAt
  if (l.settledAt !== null && !resolvedByFreshRead) {
    const outcome = l.writeFailure ? writeOutcomeOf(l.writeFailure) : 'unknown'
    // A refusal the server proved may say so definitely, but it still may not present a state or
    // offer an action until a fresh read lands: the context it refused against is already gone. The
    // phase keeps naming the OUTCOME even while a refresh runs, so the reason stays on screen.
    return {
      phase: outcome === 'refused' ? 'refused' : 'unresolved',
      stateIsKnown: false, affordance: none, ...base,
    }
  }

  if (l.isFetching) return { phase: 'refreshing', stateIsKnown: false, affordance: none, ...base }
  if (readFailure || l.control === undefined) {
    return { phase: 'read-failed', stateIsKnown: false, affordance: none, ...base }
  }
  return {
    phase: 'current',
    stateIsKnown: true,
    affordance: directoryRoleControlAffordance(l.control, true),
    ...base,
  }
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
 * Every settlement path is guarded twice. First by identity GENERATION: `currentIdentityToken()` is
 * captured before the request and compared after, so a completion whose initiating identity is gone
 * applies no cache write, no invalidation and no UI effect — this is what makes A-to-B-to-A safe,
 * since the cache scope string is identical on return to A and cannot distinguish the two visits.
 * Second by cache recency: a success never overwrites same-key data that was accepted after this
 * write started, so an older completion cannot replace a newer read.
 *
 * Nothing is ever retried or recaptured: the POST changes authority, so recovery is a fresh read and
 * a fresh user decision. */
export function useSetDirectoryRoleControl(customerTenantId: string) {
  const { cacheScope, currentIdentityToken } = useAuth()
  const queryClient = useQueryClient()
  const queryKey = directoryRoleControlKey(cacheScope, customerTenantId)
  /** Set when a write fails; cleared once a successful fresh read has resolved it, or when a new
   * explicit action supersedes it. Clearing is what makes the resolution PERSIST: a later failed or
   * pending refetch is then a current read failure, not a revival of the old write outcome. */
  const [settledAt, setSettledAt] = useState<number | null>(null)
  const attempt = useRef<{ identity: string; baseline: DirectoryRoleControlView } | null>(null)

  const clearSettled = useCallback(() => setSettledAt(null), [])

  const mutation = useMutation<DirectoryRoleControlView, unknown, { enabled: boolean }>({
    mutationKey: ['directory-role-control-write', cacheScope, customerTenantId],
    onMutate: () => {
      // A new explicit action supersedes any earlier unresolved one, and must never inherit the
      // previous attempt's identity or baseline.
      attempt.current = null
      setSettledAt(null)
    },
    mutationFn: async ({ enabled }) => {
      const current = queryClient.getQueryData<DirectoryRoleControlView>(queryKey)
      if (!current) {
        // Refused locally: nothing was sent, so there is no remote outcome to be uncertain about.
        // `attempt.current` stays null, which is how the settlement paths tell the two apart.
        throw new LocalRefusal('HawkView has no current directory collection context to act on.')
      }
      // The cached OBJECT we based this write on, not a timestamp. Millisecond timestamps tie, and
      // a tie would let an older completion win; an object identity check cannot tie, because any
      // later accepted answer replaces the stored reference.
      attempt.current = { identity: currentIdentityToken(), baseline: current }
      const raw = await apiClient.post<unknown>(controlPath(customerTenantId), {
        enabled,
        // Echoed verbatim, exactly as observed. Never re-derived, never merged with a newer read.
        expected: current.expected,
      })
      const parsed = parseDirectoryRoleControl(raw)
      if (!parsed) {
        // The write may well have applied; we simply cannot read the answer. The caller must treat
        // this as an unknown outcome, not as a failure to apply.
        throw new Error('HawkView returned an unsupported directory collection control.')
      }
      return parsed
    },
    retry: false,
    onSuccess: (next) => {
      const started = attempt.current
      if (!started || started.identity !== currentIdentityToken()) return
      // Only adopt this answer if the cache still holds exactly the entry we wrote against. If a
      // newer answer landed meanwhile, this completion is stale and must not replace it.
      if (queryClient.getQueryData(queryKey) === started.baseline) {
        queryClient.setQueryData(queryKey, next)
      }
      void queryClient.invalidateQueries({ queryKey })
      void queryClient.invalidateQueries({ queryKey: resultsKey(cacheScope, customerTenantId) })
    },
    onError: () => {
      const started = attempt.current
      // Never sent: no uncertainty to report and nothing to re-read for.
      if (!started) return
      if (started.identity !== currentIdentityToken()) return
      // Only a FAILED write needs a fresh read to resolve it. A success carries the server's own
      // authoritative answer, so marking it unresolved would demand a read for a state we were just
      // told — and with millisecond timestamps that read can tie and never appear to resolve.
      setSettledAt(Date.now())
      // A refused write tells us our observed context may be wrong; an unknown one tells us nothing
      // at all. Both are recovered by re-reading, never by resending.
      void queryClient.invalidateQueries({ queryKey })
      void queryClient.invalidateQueries({ queryKey: resultsKey(cacheScope, customerTenantId) })
    },
  })

  return { ...mutation, settledAt, clearSettled }
}
