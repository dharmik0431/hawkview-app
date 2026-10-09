'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/components/providers/auth-provider'
import { apiClient } from '@/lib/api/client'
import {
  DIRECTORY_ROLE_EXPORT_UNAVAILABLE,
  EXPORT_REFUSAL_COPY,
  EXPORT_REJECTION_COPY,
  EXPORT_TRANSPORT_COPY,
  browserDownloadHost,
  emitDirectoryRoleExport,
  readDirectoryRoleExport,
} from '@/lib/tenants/directory-role-export'

type Phase =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }

/** True for the server's finite refusal, which is not a retryable failure. */
function isExportRefusal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { status?: unknown; code?: unknown }
  return candidate.status === 409 && candidate.code === DIRECTORY_ROLE_EXPORT_UNAVAILABLE
}

/** Downloads the already-stored directory-role projection for one tenant.
 *
 * The click re-reads through the export endpoint rather than saving whatever the
 * panel happens to be showing: the rows on screen may have aged, and a file
 * outlives the screen that explained it. Nothing here triggers collection or
 * contacts a provider.
 */
export function DirectoryRoleExportButton({ customerTenantId }: { customerTenantId: string }) {
  const { session, isLoading, currentIdentityToken } = useAuth()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const generation = useRef(0)
  const inFlight = useRef<AbortController | null>(null)

  // Held in refs, but the effect below depends on the token's VALUE: depending
  // on the function identity would re-run whenever the provider returns a fresh
  // closure, and depending on neither would miss an account change.
  const identityTokenRef = useRef(currentIdentityToken)
  identityTokenRef.current = currentIdentityToken
  const tenantRef = useRef(customerTenantId)
  tenantRef.current = customerTenantId

  const ready = !isLoading && Boolean(session)
  const identityToken = ready ? currentIdentityToken() : null

  useEffect(() => {
    // An account or tenant change, a sign-out, or unmount invalidates anything
    // in flight and clears any result from the previous subject. The refs are
    // captured in locals so the cleanup reads the same objects this effect saw.
    const invalidate = generation
    const pending = inFlight
    invalidate.current++
    pending.current?.abort()
    setPhase({ kind: 'idle' })
    return () => {
      invalidate.current++
      pending.current?.abort()
    }
  }, [identityToken, customerTenantId])

  const requesting = phase.kind === 'requesting'

  const download = async () => {
    if (!ready || identityToken === null) return
    const requested = ++generation.current
    const token = identityToken
    const tenant = customerTenantId
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setPhase({ kind: 'requesting' })

    // A reply may be used only if it still belongs to the request, the account
    // and the tenant on screen. Stale errors are discarded for the same reason
    // as stale successes.
    const admissible = () =>
      requested === generation.current &&
      identityTokenRef.current() === token &&
      tenantRef.current === tenant

    try {
      const raw = await apiClient.get<unknown>(
        `/tenants/${tenant}/directory-roles/export`,
        { cache: 'no-store', signal: controller.signal }
      )
      if (!admissible()) return
      const read = readDirectoryRoleExport(raw, { customerTenantId: tenant })
      if (!read.ok) {
        setPhase({ kind: 'error', message: EXPORT_REJECTION_COPY[read.rejection] })
        return
      }
      emitDirectoryRoleExport(read.view.body, browserDownloadHost(document))
      setPhase({ kind: 'saved' })
    } catch (error) {
      if (!admissible()) return
      setPhase({
        kind: 'error',
        message: isExportRefusal(error) ? EXPORT_REFUSAL_COPY : EXPORT_TRANSPORT_COPY,
      })
    }
  }

  return (
    <div className="mt-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void download()}
        disabled={!ready || requesting}
      >
        {requesting ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        )}
        Download stored results
      </Button>
      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
        Saves the stored observation HawkView already holds, as a derived snapshot. It is not
        provider-original data and is not proof of who holds a role now.
      </p>
      {phase.kind === 'saved' && (
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
          Saved the stored observation as it was read just now.
        </p>
      )}
      {phase.kind === 'error' && (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-slate-700 dark:text-slate-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
          <span>{phase.message}</span>
        </p>
      )}
    </div>
  )
}
