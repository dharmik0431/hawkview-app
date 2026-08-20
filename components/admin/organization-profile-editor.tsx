'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Pencil, X } from 'lucide-react'
import { useAuth } from '@/components/providers/auth-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiClient } from '@/lib/api/client'
import { clearIdentityBoundCaches } from '@/lib/auth/data-isolation'
import {
  browserTimeZone,
  organizationSettingsPayload,
  type WorkspaceOnboarding,
} from '@/lib/auth/workspace-onboarding'
import { publishWorkspaceChange } from '@/lib/auth/workspace-onboarding-sync'

const COMMON_TIME_ZONES = [
  'America/Toronto',
  'America/Vancouver',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Australia/Sydney',
  'UTC',
]

function safeError(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.slice(0, 300)
    : 'HawkView could not update the workspace profile.'
}

export function OrganizationProfileEditor({
  onboarding,
  onSaved,
}: {
  onboarding: WorkspaceOnboarding
  onSaved?: () => void | Promise<void>
}) {
  const { identityUser, refreshSession } = useAuth()
  const [editing, setEditing] = useState(false)
  const [organizationName, setOrganizationName] = useState(
    onboarding.organizationName ?? ''
  )
  const [businessDomain, setBusinessDomain] = useState(
    onboarding.businessDomain ?? ''
  )
  const [timeZone, setTimeZone] = useState(
    onboarding.timeZone ?? browserTimeZone()
  )
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const timeZoneOptions = useMemo(
    () => Array.from(new Set([browserTimeZone(), timeZone, ...COMMON_TIME_ZONES])),
    [timeZone]
  )

  useEffect(() => {
    if (editing) return
    setOrganizationName(onboarding.organizationName ?? '')
    setBusinessDomain(onboarding.businessDomain ?? '')
    setTimeZone(onboarding.timeZone ?? browserTimeZone())
  }, [
    editing,
    onboarding.businessDomain,
    onboarding.organizationName,
    onboarding.timeZone,
  ])

  if (
    onboarding.required ||
    !onboarding.organizationId ||
    !onboarding.organizationName
  ) {
    return null
  }

  const reset = () => {
    setOrganizationName(onboarding.organizationName ?? '')
    setBusinessDomain(onboarding.businessDomain ?? '')
    setTimeZone(onboarding.timeZone ?? browserTimeZone())
    setError(null)
    setNotice(null)
    setEditing(false)
  }

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) return
    const normalized = organizationSettingsPayload({
      organizationId: onboarding.organizationId!,
      organizationName,
      businessDomain,
      timeZone,
    })
    if ('error' in normalized) {
      setError(normalized.error ?? 'Review the workspace details and try again.')
      return
    }

    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await apiClient.patch('/api/workspace/organization', normalized.payload)
      if (identityUser?.id) {
        publishWorkspaceChange(identityUser.id, normalized.payload.organizationId)
      }
      clearIdentityBoundCaches()
      const refreshed = await refreshSession()
      if (!refreshed) {
        throw new Error('The update was saved, but HawkView could not refresh the workspace profile.')
      }
      await onSaved?.()
      setNotice('Workspace profile updated.')
      setEditing(false)
    } catch (requestError) {
      setError(safeError(requestError))
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div aria-live="polite" className="min-h-5 text-xs">
          {notice ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
              <Check className="h-3.5 w-3.5" aria-hidden="true" /> {notice}
            </span>
          ) : (
            <span className="text-muted-foreground">
              Workspace owners can update the customer-facing name and regional defaults.
            </span>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 self-start text-xs sm:self-auto"
          onClick={() => {
            setNotice(null)
            setEditing(true)
          }}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Edit workspace profile
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={save} className="space-y-4 border-t border-border pt-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="organization-profile-name" className="text-xs">
            Workspace name
          </Label>
          <Input
            id="organization-profile-name"
            value={organizationName}
            onChange={(event) => setOrganizationName(event.target.value)}
            maxLength={200}
            autoComplete="organization"
            disabled={saving}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="organization-profile-domain" className="text-xs">
            Business domain <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="organization-profile-domain"
            value={businessDomain}
            onChange={(event) => setBusinessDomain(event.target.value)}
            maxLength={253}
            placeholder="example.com"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={saving}
          />
          <p className="text-[11px] text-muted-foreground">
            Informational only; HawkView does not verify domain ownership.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="organization-profile-time-zone" className="text-xs">
            Default time zone
          </Label>
          <Input
            id="organization-profile-time-zone"
            list="organization-profile-time-zones"
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
            maxLength={100}
            disabled={saving}
            required
          />
          <datalist id="organization-profile-time-zones">
            {timeZoneOptions.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </div>
      </div>

      <div aria-live="polite" aria-atomic="true" className="min-h-5 text-xs">
        {error && <p role="alert" className="text-rose-700 dark:text-rose-300">{error}</p>}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 text-xs" onClick={reset} disabled={saving}>
          <X className="h-3.5 w-3.5" aria-hidden="true" /> Cancel
        </Button>
        <Button type="submit" size="sm" className="h-8 gap-1.5 text-xs" disabled={saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
          {saving ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </form>
  )
}
