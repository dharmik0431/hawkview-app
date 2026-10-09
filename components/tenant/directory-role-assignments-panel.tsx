'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DirectoryRoleControl } from './directory-role-control'
import { useDirectoryRoleResults } from '@/lib/api/directory-role-results-hooks'
import { DIRECTORY_ROLE_SOURCE, type DirectoryRoleResultsView, type DirectoryRoleHealthView } from '@/lib/tenants/directory-role-results-view'
import { tenantEntraPath } from '@/lib/tenants/navigation'
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
  RUNNING: 'The latest recorded collection attempt reports running.',
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

const REASON_COPY: Record<DirectoryRoleHealthView['reasonCode'], string> = {
  ACTIVATION_EVIDENCE_UNAVAILABLE: 'Usable activation evidence is unavailable for this source. HawkView cannot vouch for any stored results here.',
  NO_COMPLETE_RECEIPT: 'No complete directory role observation has been recorded yet.',
  CURRENT_ELIGIBILITY_UNAVAILABLE: 'The current tenant or connection setup cannot vouch for the stored receipt.',
  RECEIPT_BINDING_CHANGED: 'The stored receipt no longer matches the current connection, authority, or collection scope.',
  SNAPSHOT_BINDING_UNVERIFIED: 'The stored snapshot cannot be matched to its complete receipt.',
  PUBLICATION_TIME_MISMATCH: 'The stored snapshot and receipt completion times do not match.',
  STORED_PAYLOAD_INVALID: 'The stored assignment payload could not be verified.',
  STORED_CONTENT_MISMATCH: 'The stored assignments do not match the receipt’s verified content or count.',
  COMPLETE_OBSERVATION_CURRENT: 'Verified complete observation within the one-hour currentness window.',
  COMPLETE_EMPTY_CURRENT: 'Verified complete check within the one-hour currentness window observed zero assignments.',
  COMPLETE_OBSERVATION_STALE: 'The verified complete observation is older than the one-hour currentness window.',
}
const RECOVERY_COPY: Record<DirectoryRoleHealthView['recoveryCode'], string | null> = {
  REVIEW_SOURCE_CONTROL: 'Review the collection setting in Entra directory results.',
  AWAIT_NORMAL_COLLECTION: 'Await an eligible normal collection. Normal scheduling is daily; a stale receipt does not establish a missed daily collection. No next completion time is promised.',
  REVIEW_CONNECTION_SETUP: 'Review the existing tenant and connection setup.',
  REQUIRE_NEW_COMPLETE_OBSERVATION: 'A new complete observation matching the current setup is required before assignments can be shown.',
  REREAD_OR_REPORT: 'Re-read stored results. If the verification issue remains, report it for investigation.',
  NONE: null,
}

function explanation(data: DirectoryRoleResultsView, stale: boolean) {
  // A response's CURRENT explanation expires with its locally aged observation.
  if (stale) return { reason: REASON_COPY.COMPLETE_OBSERVATION_STALE, recovery: RECOVERY_COPY.AWAIT_NORMAL_COLLECTION }
  if (data.health) return { reason: REASON_COPY[data.health.reasonCode], recovery: RECOVERY_COPY[data.health.recoveryCode] }
  switch (data.status) {
    case 'not-activated': return { reason: REASON_COPY.ACTIVATION_EVIDENCE_UNAVAILABLE, recovery: RECOVERY_COPY.REVIEW_SOURCE_CONTROL }
    case 'never-collected': return { reason: 'No directory role results collected yet.', recovery: RECOVERY_COPY.AWAIT_NORMAL_COLLECTION }
    case 'superseded': return { reason: 'HawkView cannot currently verify the stored directory role results.', recovery: RECOVERY_COPY.REREAD_OR_REPORT }
    default: return { reason: data.observation?.verifiedCompleteEmpty ? REASON_COPY.COMPLETE_EMPTY_CURRENT : REASON_COPY.COMPLETE_OBSERVATION_CURRENT, recovery: null }
  }
}

/** Both entry points consume the same scoped read and receipt clock. Compact mode adds no control
 * or assignment payload display; the collection setting stays in its existing Entra location. */
function DirectoryRoleStoredResults({ customerTenantId, className, compact = false }: {
  customerTenantId: string
  className?: string
  compact?: boolean
}) {
  const { data, dataUpdatedAt, isPending, isError, isFetching, refetch } = useDirectoryRoleResults(customerTenantId)
  const now = useWallClock(data?.observation !== undefined && data?.observation !== null)
  if (!customerTenantId) return null
  const presented = data?.observation ? elapsedPresentation(data.observation.ageMs, dataUpdatedAt, now) : null
  const stale = data?.status === 'stale' || (presented?.agedStale ?? false)
  const copy = data ? explanation(data, stale) : null
  const observation = data?.observation
  const attempt = data?.latestAttempt
  return (
    <section aria-label={compact ? 'Directory role receipt health' : 'Directory role assignments'} className={cn('rounded-xl border border-slate-200 p-4 dark:border-slate-700', className)}>
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{compact ? 'Directory role receipt health' : 'Directory role assignments'}</h3>
      <p className="mb-3 mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        Stored results HawkView collected from {data?.source ?? DIRECTORY_ROLE_SOURCE}. Assignments are
        what was observed, not a statement about effective privilege.
      </p>
      {isPending && <p className="text-sm text-slate-500 dark:text-slate-400">Loading stored results…</p>}
      {isError && <p className="flex items-start gap-1.5 text-sm text-slate-700 dark:text-slate-200">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
        <span>These results are unavailable right now.</span>
      </p>}
      {!isError && data && copy && <div className="space-y-2">
        {stale && <p className="text-xs font-medium text-slate-600 dark:text-slate-300">Showing the last completed collection</p>}
        <p className="text-sm text-slate-700 dark:text-slate-200">{copy.reason}</p>
        {observation && <>
          {compact
            ? <p className="text-sm">{observation.verifiedCompleteEmpty ? 'Verified complete-empty observation: zero directory role assignments.' : `Complete observation: ${observation.observedCount} directory role assignment${observation.observedCount === 1 ? '' : 's'}.`}</p>
            : <Assignments results={data} />}
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Checked <time dateTime={observation.checkedAt.toISOString()}>{storedTime(observation.checkedAt)}</time> · {ageLabel(presented?.elapsedMs ?? observation.ageMs)}.
            {' '}Receipt completion time; source change time is not reported.
          </p>
        </>}
        {copy.recovery && <p className="text-sm">Next step: {copy.recovery}</p>}
        {attempt?.outcome && <p className="text-xs text-slate-500 dark:text-slate-400">
          {ATTEMPT_COPY[attempt.outcome]}
          {attempt.terminalAt && <> Recorded terminal time: <time dateTime={attempt.terminalAt.toISOString()}>{storedTime(attempt.terminalAt)}</time>.</>}
        </p>}
      </div>}
      {(isError || compact) && <Button variant="ghost" size="sm" onClick={() => void refetch()} disabled={isFetching || isPending}>
        <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', isFetching && 'animate-spin')} aria-hidden />
        {isError ? 'Try again' : 'Re-read stored results'}
      </Button>}
      {compact
        ? <a className="mt-2 block text-sm text-blue-700 hover:underline dark:text-blue-300" href={tenantEntraPath(customerTenantId, 'overview')}>Open Entra directory results and collection setting</a>
        : <DirectoryRoleControl customerTenantId={customerTenantId} />}
    </section>
  )
}

export function DirectoryRoleAssignmentsPanel(props: { customerTenantId: string; className?: string }) {
  return <DirectoryRoleStoredResults {...props} />
}

export function DirectoryRoleReceiptHealth(props: { customerTenantId: string; className?: string }) {
  return <DirectoryRoleStoredResults {...props} compact />
}
