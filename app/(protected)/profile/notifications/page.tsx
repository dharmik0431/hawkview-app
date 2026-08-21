'use client'

import { useCallback, useEffect, useState } from 'react'
import { apiClient } from '@/lib/api/client'
import { useNotifications } from '@/components/providers/notification-provider'

type Preferences = {
  securityEnabled: boolean
  connectionEnabled: boolean
  synchronizationEnabled: boolean
  accountEnabled: boolean
  inAppEnabled: boolean
  minimumSeverity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  emailEnabled: boolean
  digestMode: 'off' | 'daily' | 'weekly'
}

const categories: Array<{ key: keyof Preferences; label: string; description: string }> = [
  { key: 'securityEnabled', label: 'Security alerts', description: 'Risky identity, MFA, password, application, and role changes.' },
  { key: 'connectionEnabled', label: 'Tenant connections', description: 'Disconnected tenants, permission changes, and recoveries.' },
  { key: 'synchronizationEnabled', label: 'Synchronization health', description: 'Repeated or partial Microsoft data synchronization failures.' },
  { key: 'accountEnabled', label: 'Account activity', description: 'Important changes to your HawkView account.' },
]

export default function NotificationPreferencesPage() {
  const { notify } = useNotifications()
  const [preferences, setPreferences] = useState<Preferences | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const loadPreferences = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      setPreferences(await apiClient.get<Preferences>('/api/notifications/preferences'))
    } catch {
      setLoadError(true)
      notify({ title: 'Unable to load preferences', description: 'Try refreshing this page.', category: 'error' })
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => {
    void loadPreferences()
  }, [loadPreferences])

  const save = async () => {
    if (!preferences) return
    setSaving(true)
    try {
      const updated = await apiClient.patch<Preferences>('/api/notifications/preferences', preferences)
      setPreferences(updated)
      notify({ title: 'Notification preferences saved', description: 'Your alert preferences are now active.', category: 'success' })
    } catch {
      notify({ title: 'Unable to save preferences', description: 'No changes were saved. Try again.', category: 'error' })
    } finally {
      setSaving(false)
    }
  }

  if (loading && !preferences) return <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">Loading notification preferences...</div>

  if (loadError && !preferences) {
    return (
      <div role="alert" className="rounded-xl border border-border bg-card p-6">
        <p className="text-sm font-semibold text-foreground">Notification preferences could not be loaded.</p>
        <p className="mt-1 text-xs text-muted-foreground">Your existing preferences were not changed.</p>
        <button type="button" onClick={() => void loadPreferences()} className="mt-4 rounded-md border border-border px-3 py-2 text-sm font-semibold hover:bg-muted">
          Retry
        </button>
      </div>
    )
  }

  if (!preferences) return null

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-base font-semibold">In-app notifications</h2>
        <p className="mt-1 text-sm text-muted-foreground">Choose which operational events appear in your notification center. Critical alerts always remain visible.</p>
        <div className="mt-5 divide-y divide-border">
          <PreferenceToggle label="Enable notification center" description="Show persisted operational alerts inside HawkView." checked={preferences.inAppEnabled} onChange={(checked) => setPreferences({ ...preferences, inAppEnabled: checked })} />
          {categories.map((category) => (
            <PreferenceToggle key={category.key} label={category.label} description={category.description} checked={Boolean(preferences[category.key])} onChange={(checked) => setPreferences({ ...preferences, [category.key]: checked })} />
          ))}
        </div>
        <label className="mt-5 block text-sm font-medium">
          Minimum severity
          <select value={preferences.minimumSeverity} onChange={(event) => setPreferences({ ...preferences, minimumSeverity: event.target.value as Preferences['minimumSeverity'] })} className="mt-2 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
            <option value="info">All notifications</option><option value="low">Low and above</option><option value="medium">Medium and above</option><option value="high">High and critical</option><option value="critical">Critical only</option>
          </select>
        </label>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-base font-semibold">Email delivery</h2>
        <p className="mt-1 text-sm text-muted-foreground">Stored now for future email delivery. Email sending is not enabled yet.</p>
        <PreferenceToggle label="Email notifications" description="Prepare this account for email alerts when delivery is enabled." checked={preferences.emailEnabled} onChange={(checked) => setPreferences({ ...preferences, emailEnabled: checked })} />
        <select value={preferences.digestMode} disabled={!preferences.emailEnabled} onChange={(event) => setPreferences({ ...preferences, digestMode: event.target.value as Preferences['digestMode'] })} className="mt-2 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50">
          <option value="off">No digest</option><option value="daily">Daily digest</option><option value="weekly">Weekly digest</option>
        </select>
      </section>

      <div className="flex justify-end"><button type="button" disabled={saving} onClick={save} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{saving ? 'Saving...' : 'Save preferences'}</button></div>
    </div>
  )
}

function PreferenceToggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex cursor-pointer items-start justify-between gap-4 py-4"><span><span className="block text-sm font-medium">{label}</span><span className="mt-0.5 block text-xs text-muted-foreground">{description}</span></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1 h-4 w-4 accent-blue-600" /></label>
}
