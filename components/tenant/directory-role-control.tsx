'use client'

import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/components/providers/auth-provider'
import {
  classifyControlFailure,
  useDirectoryRoleControl,
  useSetDirectoryRoleControl,
} from '@/lib/api/directory-role-control-hooks'
import {
  directoryRoleControlAffordance,
  isDirectoryControlOffered,
} from '@/lib/tenants/directory-role-control-view'

const READ_COPY = {
  forbidden: 'Your role cannot change directory role collection for this tenant.',
  unavailable: 'HawkView cannot read this collection setting right now, so it cannot be changed here.',
  conflict: 'HawkView cannot read this collection setting right now, so it cannot be changed here.',
  rejected: 'HawkView cannot read this collection setting right now, so it cannot be changed here.',
  error: 'HawkView cannot read this collection setting right now, so it cannot be changed here.',
} as const

const WRITE_COPY = {
  // Nothing was applied and nothing is resent: the context the user acted on is gone, and silently
  // recapturing it would apply an authority change against a state they never saw.
  conflict:
    'This tenant’s connection or configuration changed before your change was applied, so nothing was changed. The current setting is shown again — choose again if you still want it.',
  rejected:
    'HawkView could not apply your change against the setting it had read, so nothing was changed. The current setting is shown again.',
  forbidden: 'Your role cannot change directory role collection for this tenant.',
  unavailable: 'Nothing was changed. This collection setting is unavailable right now.',
  error: 'Nothing was changed. Please try again.',
} as const

/** Explicit opt-in control for stored DIRECTORY_ROLES collection.
 *
 * `enabled` here is the durable opt-in and nothing more. It does not say the connection is eligible,
 * that a collection is running, or that any stored result is trustworthy — the results panel above
 * reports those separately. Switching this on does not fetch anything; HawkView collects on its own
 * schedule afterwards. */
export function DirectoryRoleControl({ customerTenantId }: { customerTenantId: string }) {
  const { session } = useAuth()
  const offered = isDirectoryControlOffered(session?.user?.memberships)
  const { data, isPending, isError, error } = useDirectoryRoleControl(customerTenantId)
  const write = useSetDirectoryRoleControl(customerTenantId)

  if (!customerTenantId || !offered) return null

  const { canEnable, canDisable, eligibilityUnavailable } = directoryRoleControlAffordance(
    data ?? null,
    offered
  )
  const busy = write.isPending
  const readFailure = isError ? classifyControlFailure(error, 'read') : null
  const writeFailure = write.isError ? classifyControlFailure(write.error, 'write') : null

  return (
    <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
      <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
        Directory role assignment collection
      </p>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        A durable choice for this tenant. Turning it on does not collect anything now, and it is not
        a statement that the connection is ready or that a stored result is current.
      </p>

      {isPending && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Checking this setting…
        </p>
      )}

      {readFailure && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-slate-700 dark:text-slate-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
          <span>{READ_COPY[readFailure]}</span>
        </p>
      )}

      {data && (
        <div className="mt-2 space-y-2">
          <p className="flex items-start gap-1.5 text-xs text-slate-700 dark:text-slate-200">
            {data.enabled && <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />}
            <span>
              {data.enabled
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
              disabled={busy}
              onClick={() => write.mutate({ enabled: canEnable })}
            >
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
              {canEnable ? 'Switch on collection' : 'Switch off collection'}
            </Button>
          )}
        </div>
      )}

      {writeFailure && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-slate-700 dark:text-slate-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
          <span>{WRITE_COPY[writeFailure]}</span>
        </p>
      )}
    </div>
  )
}
