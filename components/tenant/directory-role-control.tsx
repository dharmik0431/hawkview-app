'use client'

import { useEffect } from 'react'
import { AlertTriangle, HelpCircle, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/components/providers/auth-provider'
import {
  classifyControlFailure,
  controlPresentation,
  useDirectoryRoleControl,
  useSetDirectoryRoleControl,
} from '@/lib/api/directory-role-control-hooks'
import { isDirectoryControlOffered } from '@/lib/tenants/directory-role-control-view'

const READ_COPY = {
  forbidden: 'Your role cannot change directory role collection for this tenant.',
  unavailable: 'HawkView cannot read this collection setting right now, so it cannot be changed here.',
  conflict: 'HawkView cannot read this collection setting right now, so it cannot be changed here.',
  rejected: 'HawkView cannot read this collection setting right now, so it cannot be changed here.',
  error: 'HawkView cannot read this collection setting right now, so it cannot be changed here.',
} as const

/** Copy for a write the server PROVED it did not apply. Even here the setting is not restated and no
 * action is offered: the context the server refused against is already gone, so the only honest next
 * step is a fresh read. */
const REFUSED_COPY = {
  conflict:
    'HawkView refused the change because this tenant’s collection context is no longer the one it read — it changed, or the tenant is no longer eligible for managed collection. The setting was not changed. Re-read it below before choosing again.',
  rejected:
    'HawkView could not apply your change against the setting it had read, so the setting was not changed. Re-read it below before choosing again.',
  forbidden: 'Your role cannot change directory role collection for this tenant.',
  unavailable: 'The setting was not changed. This control is unavailable right now.',
  error: '',
  'not-sent': '',
} as const

/** Explicit opt-in control for stored DIRECTORY_ROLES collection.
 *
 * `enabled` here is the durable opt-in and nothing more. It does not say the connection is eligible,
 * that a collection is running, or that any stored result is trustworthy — the results panel above
 * reports those separately. Switching this on does not fetch anything; HawkView collects on its own
 * schedule afterwards.
 *
 * The panel states the setting, and offers an action, ONLY while a confirmed current read is on
 * screen. A write whose outcome it could not confirm is reported as uncertain rather than as a
 * no-op, because this contract commits the opt-in before serialising its reply: a lost response is
 * indistinguishable from a successful change. Nothing is ever resent automatically. */
export function DirectoryRoleControl({ customerTenantId }: { customerTenantId: string }) {
  const { session } = useAuth()
  const offered = isDirectoryControlOffered(session?.user?.memberships)
  const read = useDirectoryRoleControl(customerTenantId)
  const write = useSetDirectoryRoleControl(customerTenantId)

  const presented = controlPresentation({
    control: read.data,
    isPending: read.isPending,
    isFetching: read.isFetching,
    isReadError: read.isError,
    readError: read.error,
    writeFailure: write.isError ? classifyControlFailure(write.error, 'write') : null,
    settledAt: write.settledAt,
    dataUpdatedAt: read.dataUpdatedAt,
    offered,
  })

  // Declared BEFORE the eligibility return so the hook order cannot change when a role or tenant
  // changes. Releasing the latch on resolution is what persists it: once a successful fresh read
  // has resolved a failed write, a later failed or pending refetch is reported as a current read
  // failure and never revives that write's outcome.
  const resolved = presented.phase === 'current' && presented.stateIsKnown
  useEffect(() => {
    if (resolved && write.settledAt !== null) write.clearSettled()
  }, [resolved, write.settledAt, write.clearSettled])

  if (!customerTenantId || !offered) return null

  const { phase, stateIsKnown, control, affordance, readFailure, writeFailure, isRefreshing } =
    presented
  const { canEnable, canDisable, eligibilityUnavailable } = affordance
  const rereading = isRefreshing

  return (
    <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
      <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
        Directory role assignment collection
      </p>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        A durable choice for this tenant. Turning it on does not collect anything now, and it is not
        a statement that the connection is ready or that a stored result is current.
      </p>

      {phase === 'checking' && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Checking this setting…
        </p>
      )}

      {/* An unconfirmed write. The panel says what it does not know, and does not resend. */}
      {phase === 'unresolved' && (
        <div className="mt-2 space-y-2">
          <p className="flex items-start gap-1.5 text-xs text-slate-700 dark:text-slate-200">
            <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
            <span>
              HawkView could not confirm the result of your change. It may or may not have been
              applied. HawkView did not resend it automatically. Re-read the setting to see where it
              stands.
            </span>
          </p>
          <Refresh busy={rereading} onClick={() => void read.refetch()} />
        </div>
      )}

      {writeFailure === 'not-sent' && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-slate-700 dark:text-slate-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
          <span>
            HawkView had no current setting to act on, so nothing was sent and nothing was changed.
          </span>
        </p>
      )}

      {phase === 'refused' && writeFailure && REFUSED_COPY[writeFailure] && (
        <div className="mt-2 space-y-2">
          <p className="flex items-start gap-1.5 text-xs text-slate-700 dark:text-slate-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
            <span>{REFUSED_COPY[writeFailure]}</span>
          </p>
          <Refresh busy={rereading} onClick={() => void read.refetch()} />
        </div>
      )}

      {/* A read is in flight. No setting is stated and no action is offered: cached data from before
          this refresh cannot describe the state we are re-reading. */}
      {phase === 'refreshing' && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Re-reading this setting…
        </p>
      )}

      {phase === 'read-failed' && (
        <div className="mt-2 space-y-2">
          <p className="flex items-start gap-1.5 text-xs text-slate-700 dark:text-slate-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
            <span>{READ_COPY[readFailure ?? 'error']}</span>
          </p>
          {readFailure !== 'forbidden' && (
            <Refresh busy={rereading} onClick={() => void read.refetch()} />
          )}
        </div>
      )}

      {/* Only a confirmed current read may state the setting or offer a change. */}
      {phase === 'current' && stateIsKnown && control && (
        <div className="mt-2 space-y-2">
          <p className="flex items-start gap-1.5 text-xs text-slate-700 dark:text-slate-200">
            {control.enabled && (
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
            )}
            <span>
              {control.enabled
                ? 'Collection is switched on for this tenant.'
                : 'Collection is switched off for this tenant.'}
            </span>
          </p>

          {eligibilityUnavailable && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              This tenant has no current connection or configuration, so collection cannot be
              switched on yet.
            </p>
          )}

          {(canEnable || canDisable) && (
            <Button
              variant={canDisable ? 'ghost' : 'default'}
              size="sm"
              disabled={write.isPending}
              onClick={() => write.mutate({ enabled: canEnable })}
            >
              {write.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
              {canEnable ? 'Switch on collection' : 'Switch off collection'}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** Recovery is always a READ, never a resend of the authority-changing request. While a read is
 * already running we say so instead of offering the button, so the outcome message above stays
 * visible with an honest account of what is happening. */
function Refresh({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  if (busy) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        Re-reading this setting…
      </p>
    )
  }
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
      Re-read setting
    </Button>
  )
}
