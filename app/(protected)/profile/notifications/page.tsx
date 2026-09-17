'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Bell, Loader2, Mail } from 'lucide-react'
import { useAuth } from '@/components/providers/auth-provider'
import { useNotifications } from '@/components/providers/notification-provider'
import { Button } from '@/components/ui/button'
import { apiClient } from '@/lib/api/client'
import {
  emailAvailabilityCopy,
  hasPreferenceChanges,
  NOTIFICATION_SEVERITIES,
  notificationPreferencesPatch,
  readNotificationPreferences,
  type NotificationPreferences,
} from '@/lib/notifications/preferences-contract'
import {
  NotificationScopedRequestGuard,
  notificationRequestScope,
  notificationRequestScopeKey,
  type NotificationRequestScope,
} from '@/lib/notifications/scoped-request-guard'

const categoryRows = [
  { key: 'securityEnabled', label: 'Security alerts', description: 'Risky identity and security events available to the notification center.' },
  { key: 'connectionEnabled', label: 'Tenant connections', description: 'Microsoft tenant connection and consent events.' },
  { key: 'synchronizationEnabled', label: 'Synchronization health', description: 'Supported tenant data synchronization events.' },
  { key: 'accountEnabled', label: 'Account activity', description: 'Important changes to your HawkView account.' },
] as const

type OrganizationOption = { id: string; name: string }

export default function NotificationPreferencesPage() {
  const { session, isLoading: authLoading } = useAuth()
  const { notify } = useNotifications()
  const router = useRouter()
  const searchParams = useSearchParams()
  const organizations = useMemo<OrganizationOption[]>(() => {
    const byId = new Map<string, OrganizationOption>()
    for (const membership of session?.user.memberships ?? []) {
      if (membership.status !== 'ACTIVE' || membership.organization.status !== 'ACTIVE') continue
      byId.set(membership.organization.id, {
        id: membership.organization.id,
        name: membership.organization.name,
      })
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [session])
  const requested = searchParams.get('organizationId')
  const selected = requested
    ? organizations.find((organization) => organization.id === requested) ?? null
    : organizations.length === 1
      ? organizations[0]
      : null
  const requestScope = notificationRequestScope(
    session?.user.id,
    selected?.id
  )
  const requestScopeKey = notificationRequestScopeKey(requestScope)
  const currentScopeRef = useRef<NotificationRequestScope | null>(requestScope)
  const requestGuard = useRef(new NotificationScopedRequestGuard())
  currentScopeRef.current = requestScope
  requestGuard.current.setScope(requestScope)

  const [original, setOriginal] = useState<NotificationPreferences | null>(null)
  const [draft, setDraft] = useState<NotificationPreferences | null>(null)
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null)
  const [loadingScopeKey, setLoadingScopeKey] = useState<string | null>(null)
  const [savingScopeKey, setSavingScopeKey] = useState<string | null>(null)
  const [loadErrorScopeKey, setLoadErrorScopeKey] = useState<string | null>(null)

  const scopedOriginal =
    loadedScopeKey === requestScopeKey &&
    original?.organizationId === requestScope?.organizationId
      ? original
      : null
  const scopedDraft =
    loadedScopeKey === requestScopeKey &&
    draft?.organizationId === requestScope?.organizationId
      ? draft
      : null
  const loading = loadingScopeKey === requestScopeKey
  const saving = savingScopeKey === requestScopeKey
  const loadError = loadErrorScopeKey === requestScopeKey

  const loadPreferences = useCallback(async () => {
    const scope = currentScopeRef.current
    if (!scope) return
    const ticket = requestGuard.current.begin(scope, 'load')
    const scopeKey = notificationRequestScopeKey(scope)
    setLoadingScopeKey(scopeKey)
    setLoadErrorScopeKey(null)
    setLoadedScopeKey(null)
    setOriginal(null)
    setDraft(null)
    try {
      const body = await apiClient.get<unknown>('/api/notifications/preferences', {
        params: { organizationId: scope.organizationId },
      })
      if (!requestGuard.current.isCurrent(ticket, currentScopeRef.current)) return
      const parsed = readNotificationPreferences(body)
      if (!parsed || parsed.organizationId !== scope.organizationId) {
        throw new Error('unreadable')
      }
      setOriginal(parsed)
      setDraft(parsed)
      setLoadedScopeKey(scopeKey)
    } catch {
      if (!requestGuard.current.isCurrent(ticket, currentScopeRef.current)) return
      setLoadErrorScopeKey(scopeKey)
    } finally {
      if (requestGuard.current.isCurrent(ticket, currentScopeRef.current)) {
        setLoadingScopeKey(null)
      }
    }
  }, [])

  useEffect(() => {
    const guard = requestGuard.current
    setOriginal(null)
    setDraft(null)
    setLoadedScopeKey(null)
    setLoadErrorScopeKey(null)
    setLoadingScopeKey(null)
    setSavingScopeKey(null)
    if (requestScopeKey) void loadPreferences()
    return () => guard.invalidate()
  }, [loadPreferences, requestScopeKey])

  const save = async () => {
    const scope = currentScopeRef.current
    if (
      !scope ||
      !scopedOriginal ||
      !scopedDraft ||
      scopedOriginal.organizationId !== scope.organizationId ||
      scopedDraft.organizationId !== scope.organizationId
    ) {
      return
    }
    const patch = notificationPreferencesPatch(scopedOriginal, scopedDraft)
    if (Object.keys(patch).length === 1) return
    requestGuard.current.invalidateLane('load')
    const ticket = requestGuard.current.begin(scope, 'save')
    const scopeKey = notificationRequestScopeKey(scope)
    setSavingScopeKey(scopeKey)
    try {
      const body = await apiClient.patch<unknown>('/api/notifications/preferences', patch)
      if (!requestGuard.current.isCurrent(ticket, currentScopeRef.current)) return
      const parsed = readNotificationPreferences(body)
      if (!parsed || parsed.organizationId !== scope.organizationId) {
        throw new Error('unreadable')
      }
      setOriginal(parsed)
      setDraft(parsed)
      setLoadedScopeKey(scopeKey)
      notify({
        title: 'Notification preferences saved',
        description: 'Your personal preferences were saved. This does not activate unavailable delivery channels.',
        category: 'success',
      })
    } catch {
      if (!requestGuard.current.isCurrent(ticket, currentScopeRef.current)) return
      notify({
        title: 'Unable to save preferences',
        description: 'No unverified change was kept. Try again.',
        category: 'error',
      })
      setDraft(scopedOriginal)
    } finally {
      if (requestGuard.current.isCurrent(ticket, currentScopeRef.current)) {
        setSavingScopeKey(null)
      }
    }
  }

  if (authLoading) {
    return <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Verifying workspace access…</div>
  }

  if (!selected) {
    return (
      <section className="rounded-xl border border-border bg-card p-6">
        <h2 className="text-base font-semibold">{organizations.length ? 'Choose a workspace' : 'Workspace unavailable'}</h2>
        <p className="mt-1 text-sm text-muted-foreground">Personal notification preferences are stored separately for each MSP workspace.</p>
        {organizations.length > 0 && (
          <select
            aria-label="MSP workspace"
            defaultValue=""
            onChange={(event) => event.target.value && router.replace(`/profile/notifications?organizationId=${encodeURIComponent(event.target.value)}`)}
            className="mt-4 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Select a workspace</option>
            {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
          </select>
        )}
      </section>
    )
  }

  if (loading) return <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading notification preferences…</div>

  if (loadError || !scopedOriginal || !scopedDraft) {
    return (
      <div role="alert" className="rounded-xl border border-border bg-card p-6">
        <p className="text-sm font-semibold">Notification preferences could not be loaded.</p>
        <p className="mt-1 text-xs text-muted-foreground">HawkView could not verify channel capabilities, so every preference remains unchanged.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void loadPreferences()} className="mt-4">Retry</Button>
      </div>
    )
  }

  const email = emailAvailabilityCopy(scopedDraft.capabilities)
  const dirty = hasPreferenceChanges(scopedOriginal, scopedDraft)
  const legacyDigest = scopedDraft.digestMode !== 'off'

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-lg font-semibold">My notification delivery</h2>
        <p className="mt-1 text-sm text-muted-foreground">Personal preferences for {selected.name}. Workspace urgency is managed separately by MSP owners.</p>
      </header>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <span className="rounded-lg bg-blue-50 p-2 text-blue-700 dark:bg-blue-950 dark:text-blue-300"><Bell className="h-4 w-4" aria-hidden="true" /></span>
          <div><h3 className="text-base font-semibold">In-app notifications</h3><p className="mt-1 text-sm text-muted-foreground">Choose what appears in your HawkView notification center.</p></div>
        </div>
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Critical in-app notifications remain visible even when personal category or notification-center preferences are off.
        </div>
        <div className="mt-3 divide-y divide-border">
          <PreferenceToggle label="Enable notification center" description="Show supported operational notifications inside HawkView." checked={scopedDraft.inAppEnabled} disabled={saving} onChange={(checked) => setDraft({ ...scopedDraft, inAppEnabled: checked })} />
          {categoryRows.map((row) => (
            <PreferenceToggle key={row.key} label={row.label} description={row.description} checked={scopedDraft[row.key]} disabled={saving} onChange={(checked) => setDraft({ ...scopedDraft, [row.key]: checked })} />
          ))}
        </div>
        <div className="mt-4 rounded-md bg-muted/40 px-3 py-3">
          <label htmlFor="minimum-severity" className="text-sm font-medium">Minimum personal severity</label>
          <select id="minimum-severity" value={scopedDraft.minimumSeverity} disabled={saving} onChange={(event) => setDraft({ ...scopedDraft, minimumSeverity: event.target.value as NotificationPreferences['minimumSeverity'] })} className="mt-2 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-70">
            {NOTIFICATION_SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity.charAt(0).toUpperCase() + severity.slice(1)}</option>)}
          </select>
          <p className="mt-2 text-xs text-muted-foreground">Filters your personal notifications by severity. This is separate from the workspace urgency policy set by MSP owners.</p>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <span className="rounded-lg bg-slate-100 p-2 text-slate-700 dark:bg-slate-900 dark:text-slate-300"><Mail className="h-4 w-4" aria-hidden="true" /></span>
          <div><h3 className="text-base font-semibold">Email preference</h3><p className="mt-1 text-sm text-muted-foreground">{email.title}. {email.detail}</p></div>
        </div>
        <PreferenceToggle label="Opt in to email notifications" description="Stores your preference for supported future or controlled delivery. It does not turn the sender on." checked={scopedDraft.emailEnabled} disabled={saving} onChange={(checked) => setDraft({ ...scopedDraft, emailEnabled: checked })} />
        <div className="mt-2 border-t border-border pt-4">
          <label htmlFor="digest-mode" className="text-sm font-medium">Digest schedule</label>
          <select
            id="digest-mode"
            value={scopedDraft.digestMode}
            disabled={saving || !legacyDigest}
            onChange={(event) => {
              if (event.target.value === 'off') setDraft({ ...scopedDraft, digestMode: 'off' })
            }}
            className="mt-2 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-70"
          >
            {legacyDigest && <option value={scopedDraft.digestMode}>{scopedDraft.digestMode === 'daily' ? 'Daily digest' : 'Weekly digest'} — stored, unsupported</option>}
            <option value="off">No digest — supported</option>
          </select>
          <p className="mt-2 text-xs text-muted-foreground">Daily and weekly digests are not available. An existing stored selection is preserved until you explicitly choose No digest.</p>
        </div>
      </section>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" disabled={!dirty || saving} onClick={() => setDraft(scopedOriginal)}>Cancel</Button>
        <Button type="button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />Saving…</> : 'Save my preferences'}</Button>
      </div>
    </div>
  )
}

function PreferenceToggle({ label, description, checked, disabled, onChange }: { label: string; description: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-start justify-between gap-4 py-4">
      <span><span className="block text-sm font-medium">{label}</span><span className="mt-0.5 block text-xs text-muted-foreground">{description}</span></span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed" />
    </label>
  )
}
