'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw, ShieldQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDirectoryRoleResults } from '@/lib/api/directory-role-results-hooks'
import type { DirectoryRoleResultsView } from '@/lib/tenants/directory-role-results-view'
import { cn } from '@/lib/utils'

function storedTime(at: Date) {
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export const DIRECTORY_ROLE_CURRENT_MS = 60 * 60 * 1000
const CURRENT_MS = DIRECTORY_ROLE_CURRENT_MS

/** Pure, so the boundary is testable without a clock or a rendered tree.
 *
 * The origin is the ACCEPTED RESPONSE, never the component's mount: `baseAgeMs` is the age the server
 * measured when it read, `anchoredAt` is when this response was accepted (react-query's
 * `dataUpdatedAt`, which already carries cache age because a replayed cached response keeps its
 * original acceptance time), and `now` is the current wall clock. A replacement response moves
 * `anchoredAt`, so the displayed age resets even when the new `baseAgeMs` is identical. */
export function elapsedPresentation(baseAgeMs: number, anchoredAt: number, now: number) {
  const sinceAccepted = Math.max(0, now - anchoredAt)
  const elapsedMs = Math.max(0, baseAgeMs) + sinceAccepted
  return { elapsedMs, agedStale: elapsedMs > CURRENT_MS }
}

/** A ticking wall clock for the mounted view. Advances on an interval and recomputes on resume,
 * because a backgrounded tab throttles or skips intervals. It issues no request. */
function useWallClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const advance = () => setNow(Date.now())
    advance()
    const timer = setInterval(advance, 30_000)
    const onResume = () => advance()
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onResume)
    if (typeof window !== 'undefined') window.addEventListener('focus', onResume)
    return () => {
      clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onResume)
      if (typeof window !== 'undefined') window.removeEventListener('focus', onResume)
    }
  }, [active])
  return now
}

function ageLabel(ageMs: number) {
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 1) return 'less than a minute old'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} old`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} old`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} old`
}

const ATTEMPT_COPY: Record<'RUNNING' | 'FAILED' | 'PARTIAL' | 'EXPIRED', string> = {
  RUNNING: 'A collection attempt is in progress.',
  FAILED: 'The most recent collection attempt failed.',
  PARTIAL: 'The most recent collection attempt did not finish.',
  EXPIRED: 'The most recent collection attempt expired.',
}

function Assignments({ results }: { results: DirectoryRoleResultsView }) {
  const observation = results.observation
  if (!observation) return null
  if (observation.verifiedCompleteEmpty) {
    return (
      <p className="text-sm text-slate-700 dark:text-slate-200">
        No directory role assignments were found in this tenant.
      </p>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-slate-500 dark:text-slate-400">
          <tr>
            <th className="py-1 pr-3 font-medium">Role</th>
            <th className="py-1 pr-3 font-medium">Principal</th>
            <th className="py-1 pr-3 font-medium">Scope</th>
            <th className="py-1 font-medium">Assignment</th>
          </tr>
        </thead>
        <tbody className="text-slate-700 dark:text-slate-200">
          {observation.assignments.map((row) => (
            <tr key={row.id} className="border-t border-slate-100 dark:border-slate-800">
              {/* An identifier is a valid display fallback. HawkView does not read users or groups
                  to resolve a name, and shows no name it did not actually observe. */}
              <td className="py-1 pr-3 font-mono">{row.roleDisplayName ?? row.roleDefinitionId ?? '—'}</td>
              <td className="py-1 pr-3 font-mono">{row.principalId ?? '—'}</td>
              <td className="py-1 pr-3 font-mono">{row.directoryScopeId ?? row.appScopeId ?? '—'}</td>
              <td className="py-1 font-mono">{row.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Read-only view of stored directory role assignments.
 *
 * Every state below is the server's own `status`. The panel never infers a trustworthy result from
 * the absence of rows: only a verified complete-empty says "none found", and an unactivated or
 * superseded tenant says so instead of showing a zero. */
export function DirectoryRoleAssignmentsPanel({ customerTenantId, className }: {
  customerTenantId: string
  className?: string
}) {
  const { data, dataUpdatedAt, isPending, isError, isFetching, refetch } = useDirectoryRoleResults(customerTenantId)
  const now = useWallClock(data?.observation !== undefined && data?.observation !== null)
  if (!customerTenantId) return null

  const attempt = data?.latestAttempt.outcome
  // Anchored to THIS response, so a replacement resets the display even when its age value repeats,
  // and a long-open tab cannot accumulate session time onto a freshly accepted result.
  const presented = data?.observation
    ? elapsedPresentation(data.observation.ageMs, dataUpdatedAt, now)
    : null
  const agedStale = presented?.agedStale ?? false

  return (
    <section className={cn('rounded-xl border border-slate-200 p-4 dark:border-slate-700', className)}>
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        Directory role assignments
      </h3>
      <p className="mb-3 mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        Stored results HawkView collected from {data?.source ?? 'Microsoft Graph'}. Assignments are
        what was observed, not a statement about effective privilege.
      </p>

      {isPending && <p className="text-sm text-slate-500 dark:text-slate-400">Loading stored results…</p>}

      {isError && (
        <div className="space-y-2">
          <p className="flex items-start gap-1.5 text-sm text-slate-700 dark:text-slate-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
            <span>These results are unavailable right now.</span>
          </p>
          <Button variant="ghost" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', isFetching && 'animate-spin')} aria-hidden />
            Try again
          </Button>
        </div>
      )}

      {!isError && data?.status === 'not-activated' && (
        <p className="flex items-start gap-1.5 text-sm text-slate-700 dark:text-slate-200">
          <ShieldQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
          <span>
            Verified directory role collection is not switched on for this tenant, so HawkView cannot
            vouch for any stored results here yet.
          </span>
        </p>
      )}

      {!isError && data?.status === 'never-collected' && (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No directory role results collected yet.
        </p>
      )}

      {!isError && data?.status === 'superseded' && (
        <p className="flex items-start gap-1.5 text-sm text-slate-700 dark:text-slate-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
          <span>
            The connection changed after these results were stored, so they are no longer current.
            They will be shown again once a fresh collection completes.
          </span>
        </p>
      )}

      {!isError && (data?.status === 'current' || data?.status === 'stale') && (
        <div className="space-y-2">
          {(data.status === 'stale' || agedStale) && (
            <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
              Showing the last completed collection
            </p>
          )}
          <Assignments results={data} />
          {data.observation && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Checked {storedTime(data.observation.checkedAt)} ·{' '}
              {ageLabel(presented?.elapsedMs ?? data.observation.ageMs)}
            </p>
          )}
        </div>
      )}

      {/* Latest attempt is always reported separately: it never replaces the stored results above
          and never implies that there are none. */}
      {!isError && attempt && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{ATTEMPT_COPY[attempt]}</p>
      )}
    </section>
  )
}
