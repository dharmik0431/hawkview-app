'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/components/providers/auth-provider'
import { apiClient } from '@/lib/api/client'
import {
  describeSessionState,
  formatAsOfAge,
  parseConsoleSessionHistory,
  visibleForIdentity,
  type ConsoleSessionHistory,
  type IdentityBoundPhase,
} from '@/lib/auth/console-session-history'

/** Every phase carries the identity token it was produced for.
 *
 * Without that binding, a render occurring after an account switch but before
 * the effect clears state will paint the previous account's rows. Clearing in an
 * effect is too late: the offending frame has already been shown. */
type Phase = IdentityBoundPhase<ConsoleSessionHistory>

/** Recorded sign-in history for this account only.
 *
 * Deliberately narrow: it reports the lifecycle of console sessions this account
 * created, across workspaces. It is not an organisation sign-in audit, it is not
 * proof that anyone is online now, and HawkView records nothing about where a
 * sign-in came from — no address, device or authentication method. The panel
 * says all of that on screen rather than letting the table imply more.
 *
 * Every read is discarded unless it still belongs to the identity and request
 * that asked for it, so an account switch, a sign-out, or an A→B→A sequence can
 * never paint an earlier account's rows. Old rows are never left on screen while
 * a replacement is in flight: a stale table is worse than an honest spinner. */
export function ConsoleSessionHistoryPanel() {
  const { session, isLoading, currentIdentityToken } = useAuth()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle', token: null })
  const generation = useRef(0)
  const abort = useRef<AbortController | null>(null)

  // The callback is held in a ref, but the effect depends on the token's VALUE.
  // Depending on the function identity would loop whenever a provider returns a
  // fresh closure per render; depending on nothing would miss an account change
  // entirely. The value is the thing that actually decides admissibility.
  const identityTokenRef = useRef(currentIdentityToken)
  identityTokenRef.current = currentIdentityToken

  const ready = !isLoading && Boolean(session)
  const identityToken = ready ? currentIdentityToken() : null

  const load = useCallback(async () => {
    if (!ready || identityToken === null) return
    const requested = ++generation.current
    // The token captured at request time is the rendered value, so a changed
    // identity both retriggers this callback and invalidates anything in flight.
    const token = identityToken
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setPhase({ kind: 'loading', token })

    // A response is only admissible if BOTH the request generation and the
    // identity token still match. The generation alone would admit a reply that
    // arrived after a sign-out and back in; the token alone would admit a
    // superseded request from the same identity.
    const admissible = () =>
      requested === generation.current && identityTokenRef.current() === token

    try {
      const payload = await apiClient.get<unknown>('/auth/session/history', {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!admissible()) return
      const history = parseConsoleSessionHistory(payload)
      setPhase(history ? { kind: 'ready', token, history } : { kind: 'unreadable', token })
    } catch {
      // Stale errors are suppressed for the same reason as stale successes: they
      // describe a request we no longer care about.
      if (!admissible()) return
      setPhase({ kind: 'unreadable', token })
    }
  }, [ready, identityToken])

  useEffect(() => {
    const invalidate = generation
    const inFlight = abort
    if (!ready) {
      // Losing readiness invalidates anything in flight and anything on screen.
      invalidate.current++
      inFlight.current?.abort()
      setPhase({ kind: 'idle', token: null })
      return
    }
    void load()
    return () => {
      invalidate.current++
      inFlight.current?.abort()
    }
  }, [load, ready])

  if (!ready) return null

  // Suppressed synchronously, during the render that first sees the new token.
  // The rule is a pure function so it can be tested where the stale frame is
  // actually observable; a mounted test cannot see it, because effects flush
  // before assertions.
  const visible = visibleForIdentity<ConsoleSessionHistory>(phase, identityToken)

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">Recorded sign-in history</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Sessions created by this account, across workspaces. This is not an organisation
            access audit and does not show who is signed in right now. HawkView does not record
            where a sign-in came from — no address, device or authentication method.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          disabled={visible.kind === 'loading'}
        >
          {visible.kind === 'loading' ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          )}
          Refresh
        </Button>
      </div>

      {visible.kind === 'loading' && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Reading your recorded sessions…
        </p>
      )}

      {visible.kind === 'unreadable' && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
          <span>
            HawkView cannot read your session history right now. This does not mean there is no
            recorded activity — only that it could not be read.
          </span>
        </p>
      )}

      {visible.kind === 'ready' && visible.history.sessions.length === 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          No sessions are recorded for this account.
        </p>
      )}

      {visible.kind === 'ready' && visible.history.sessions.length > 0 && (
        <div className="mt-3 space-y-2">
          {visible.history.sessions.map((row, position) => {
            const age = formatAsOfAge(row.createdAt, visible.history.generatedAt)
            return (
              <div
                // Position within this response is the only unique, stable and
                // non-sensitive key available: rows legitimately tie on every
                // timestamp, and the session id must never reach the client.
                key={`session-${position}`}
                className="flex items-start justify-between gap-3 border-t border-border/60 pt-2 text-xs first:border-t-0 first:pt-0"
              >
                <div>
                  <p className="text-foreground">
                    {describeSessionState(row.state)}
                    {row.isCurrent && (
                      <span className="ml-1.5 text-[11px] text-muted-foreground">
                        · this browser
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Started {row.createdAt}
                    {age ? ` · ${age} before this reading` : ''}
                  </p>
                </div>
                <div className="text-right text-[11px] text-muted-foreground">
                  {row.revokedAt ? (
                    // An `unknown` row carries a revocation the server refused
                    // to confirm — a future or contradictory one. Reporting it
                    // as "Signed out" would assert exactly what the state
                    // denies, so the timestamp is shown as unconfirmed instead.
                    row.state === 'unknown' ? (
                      <p>Unconfirmed sign-out recorded as {row.revokedAt}</p>
                    ) : (
                      <p>Signed out {row.revokedAt}</p>
                    )
                  ) : (
                    <p>Inactivity deadline {row.idleExpiresAt}</p>
                  )}
                  {row.authenticatedAt === null && <p>No sign-in recorded</p>}
                </div>
              </div>
            )
          })}
          <p className="pt-1 text-[11px] text-muted-foreground">
            As of {visible.history.generatedAt} (server time).
            {visible.history.truncated
              ? ' Showing the 50 most recent recorded sessions; older ones are not listed.'
              : ''}
          </p>
        </div>
      )}
    </div>
  )
}
