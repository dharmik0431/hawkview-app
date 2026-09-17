'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, BellRing, Loader2, RefreshCcw, Shield } from 'lucide-react'
import { useAuth } from '@/components/providers/auth-provider'
import { DispositionRow, type SaveState } from '@/components/alerts/disposition-row'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { apiClient } from '@/lib/api/client'
import {
  canEditDisposition,
  type AlertDisposition,
  type AlertDispositionRow,
} from '@/lib/alerts/dispositions'
import { readDispositions } from '@/lib/alerts/read-dispositions'
import { settingsView, type SettingsPhase } from '@/lib/alerts/settings-view'
import {
  NotificationScopedRequestGuard,
  notificationRequestScope,
  notificationRequestScopeKey,
  type NotificationRequestScope,
} from '@/lib/notifications/scoped-request-guard'

type OrganizationOption = { id: string; name: string }

export default function AlertSettingsPage() {
  const { session, isLoading: authLoading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const organizations = useMemo<OrganizationOption[]>(() => {
    const byId = new Map<string, OrganizationOption>()
    for (const membership of session?.user.memberships ?? []) {
      if (membership.status !== 'ACTIVE' || membership.organization.status !== 'ACTIVE') continue
      if (!byId.has(membership.organization.id)) {
        byId.set(membership.organization.id, {
          id: membership.organization.id,
          name: membership.organization.name,
        })
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [session])
  const requested = searchParams.get('organizationId')
  const selected = requested
    ? organizations.find((organization) => organization.id === requested) ?? null
    : organizations.length === 1
      ? organizations[0]
      : null
  const requestScope = notificationRequestScope(session?.user.id, selected?.id)
  const requestScopeKey = notificationRequestScopeKey(requestScope)
  const currentScopeRef = useRef<NotificationRequestScope | null>(requestScope)
  const requestGuard = useRef(new NotificationScopedRequestGuard())
  currentScopeRef.current = requestScope
  requestGuard.current.setScope(requestScope)

  const [state, setState] = useState<SettingsPhase>({ phase: 'LOADING' })
  const [stateScopeKey, setStateScopeKey] = useState<string | null>(null)
  const [rows, setRows] = useState<AlertDispositionRow[]>([])
  const [saves, setSaves] = useState<Record<string, SaveState>>({})
  const saveInFlight = Object.values(saves).some((save) => save.kind === 'SAVING')
  const saveInFlightRef = useRef(saveInFlight)
  saveInFlightRef.current = saveInFlight

  const load = useCallback(async () => {
    if (saveInFlightRef.current) return
    const scope = currentScopeRef.current
    if (!scope) return
    const ticket = requestGuard.current.begin(scope, 'load')
    const scopeKey = notificationRequestScopeKey(scope)
    setState({ phase: 'LOADING' })
    setStateScopeKey(scopeKey)
    setRows([])
    setSaves({})
    try {
      const body = await apiClient.get<unknown>('/api/alerts/dispositions', {
        params: { organizationId: scope.organizationId },
      })
      if (!requestGuard.current.isCurrent(ticket, currentScopeRef.current)) return
      const read = readDispositions(body)
      if (
        read.outcome === 'LOADED' &&
        read.organizationId !== scope.organizationId
      ) {
        setState({
          phase: 'READ',
          read: {
            outcome: 'UNREADABLE',
            because: 'HawkView could not verify the selected workspace response.',
          },
        })
        return
      }
      setState({ phase: 'READ', read })
      setStateScopeKey(scopeKey)
      if (read.outcome === 'LOADED') setRows(read.rows)
    } catch {
      if (!requestGuard.current.isCurrent(ticket, currentScopeRef.current)) return
      setState({
        phase: 'READ',
        read: {
          outcome: 'FAILED',
          because: 'The workspace alert policy request did not complete.',
        },
      })
      setStateScopeKey(scopeKey)
    }
  }, [])

  useEffect(() => {
    const guard = requestGuard.current
    setState({ phase: 'LOADING' })
    setStateScopeKey(requestScopeKey)
    setRows([])
    setSaves({})
    saveInFlightRef.current = false
    if (requestScopeKey) void load()
    return () => guard.invalidate()
  }, [load, requestScopeKey])

  const loaded =
    stateScopeKey === requestScopeKey &&
    state.phase === 'READ' &&
    state.read.outcome === 'LOADED' &&
    state.read.organizationId === requestScope?.organizationId
      ? state.read
      : null

  const choose = useCallback(
    async (row: AlertDispositionRow, disposition: AlertDisposition) => {
      if (
        !requestScope ||
        !loaded ||
        disposition === row.disposition ||
        !canEditDisposition(row, loaded.canManagePolicy)
      ) {
        return
      }
      const scope = requestScope
      requestGuard.current.invalidateLane('load')
      const ticket = requestGuard.current.begin(scope, `save:${row.alertTypeId}`)
      const previous = row.disposition
      setSaves((current) => ({ ...current, [row.alertTypeId]: { kind: 'SAVING' } }))
      setRows((current) =>
        current.map((item) =>
          item.alertTypeId === row.alertTypeId ? { ...item, disposition } : item
        )
      )
      try {
        const body = await apiClient.patch<unknown>(
          `/api/alerts/dispositions/${encodeURIComponent(row.alertTypeId)}`,
          { disposition },
          { params: { organizationId: scope.organizationId } }
        )
        if (!requestGuard.current.isCurrent(ticket, currentScopeRef.current)) return
        const confirmed = readDispositions(body)
        if (
          confirmed.outcome !== 'LOADED' ||
          confirmed.organizationId !== scope.organizationId
        ) {
          throw new Error('unverified response')
        }
        setRows(confirmed.rows)
        setState({ phase: 'READ', read: confirmed })
        setSaves((current) => ({ ...current, [row.alertTypeId]: { kind: 'SAVED' } }))
      } catch {
        if (!requestGuard.current.isCurrent(ticket, currentScopeRef.current)) return
        setRows((current) =>
          current.map((item) =>
            item.alertTypeId === row.alertTypeId
              ? { ...item, disposition: previous }
              : item
          )
        )
        setSaves((current) => ({
          ...current,
          [row.alertTypeId]: {
            kind: 'FAILED',
            because: 'HawkView could not verify the saved workspace policy.',
          },
        }))
      }
    },
    [loaded, requestScope]
  )

  if (authLoading) {
    return (
      <div className="flex min-h-[240px] items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
        Verifying workspace access…
      </div>
    )
  }

  if (!selected) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 p-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {organizations.length ? 'Choose a workspace' : 'Workspace unavailable'}
            </CardTitle>
            <CardDescription>
              {organizations.length
                ? 'Alert policy is workspace-specific. Select the organization you want to review.'
                : 'No active HawkView workspace is available to this account.'}
            </CardDescription>
          </CardHeader>
          {organizations.length > 0 && (
            <CardContent>
              <label htmlFor="alert-workspace" className="text-sm font-medium">MSP workspace</label>
              <select
                id="alert-workspace"
                defaultValue=""
                onChange={(event) => {
                  if (event.target.value) {
                    router.replace(`/settings/alerts?organizationId=${encodeURIComponent(event.target.value)}`)
                  }
                }}
                className="mt-2 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Select a workspace</option>
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>{organization.name}</option>
                ))}
              </select>
            </CardContent>
          )}
        </Card>
      </div>
    )
  }

  const scopedState: SettingsPhase =
    stateScopeKey === requestScopeKey ? state : { phase: 'LOADING' }
  const scopedRows = stateScopeKey === requestScopeKey ? rows : []
  const view = settingsView(scopedState, scopedRows)

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <BellRing className="h-5 w-5 text-blue-600" aria-hidden="true" />
            Alert preferences
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Workspace policy for {selected.name}. MSP owners decide urgency; each member controls their own delivery preferences.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={view.loading || saveInFlight}>
          <RefreshCcw className={`mr-2 h-4 w-4 ${view.loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          Retry
        </Button>
      </header>

      {loaded && (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
          <Shield className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium">Workspace policy</p>
            <p className="text-xs text-muted-foreground">
              {loaded.canManagePolicy
                ? 'You can change alert urgency where HawkView confirms a proven producer and intake wiring.'
                : 'Read-only. Only an MSP owner can change workspace alert policy.'}
            </p>
          </div>
        </div>
      )}

      {view.loading && (
        <Card><CardContent className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading workspace alert policy…</CardContent></Card>
      )}

      {view.empty && (
        <Card>
          <CardHeader><CardTitle className="text-base">{view.empty.title}</CardTitle><CardDescription>{view.empty.detail}</CardDescription></CardHeader>
          <CardContent className="space-y-3 pt-0">
            {view.because && <p role="alert" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">{view.because}</p>}
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>Retry</Button>
          </CardContent>
        </Card>
      )}

      {view.unrecognisedKeys.length > 0 && (
        <p role="status" className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {view.unrecognisedKeys.length} stored setting {view.unrecognisedKeys.length === 1 ? 'uses' : 'use'} an alert type this version cannot recognize. The catalogue default applies.
        </p>
      )}

      {view.discarded > 0 && (
        <p role="status" className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {view.discarded} alert {view.discarded === 1 ? 'type was' : 'types were'} not readable. The list is incomplete.
        </p>
      )}

      {loaded && view.rows.length > 0 && (
        <div className="space-y-3">
          {view.rows.map((row) => (
            <DispositionRow
              key={row.alertTypeId}
              row={row}
              save={saves[row.alertTypeId] ?? { kind: 'IDLE' }}
              onChoose={choose}
              canManagePolicy={loaded.canManagePolicy}
              policyCapabilities={loaded.capabilities}
            />
          ))}
        </div>
      )}
    </div>
  )
}
