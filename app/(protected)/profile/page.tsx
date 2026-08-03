'use client'

import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuth } from '@/components/providers/auth-provider'
import { useTheme } from 'next-themes'
import { useNotifications } from '@/components/providers/notification-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Check,
  Loader2,
  Lock,
  Globe,
  Sun,
  Moon,
  Laptop,
  Building2,
  Info,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface ProfileFormData {
  firstName: string
  lastName: string
  displayName: string
  timeZone: string
  dateFormat: string
  timeFormat: '12h' | '24h'
  theme: 'system' | 'light' | 'dark'
}

export default function ProfilePage() {
  const { session } = useAuth()
  const { theme: activeTheme, setTheme } = useTheme()
  const { notify } = useNotifications()

  // User identity details from session
  const rawEmail = session?.user.email || 'user@hawkview.net'
  const rawDisplayName =
    session?.user.displayName || rawEmail.split('@')[0] || 'HawkView User'
  const membership = session?.user.memberships?.[0]
  const orgName = membership?.organization?.name || 'HawkView Organization'
  const rawRole = membership?.role || session?.user.platformRole || 'MSP_ADMIN'
  const roleDisplay = rawRole
    .replace('MSP_', '')
    .replace('PLATFORM_', '')
    .toLowerCase()
    .replace(/^\w/, (l) => l.toUpperCase())

  const signInProvider = session?.signInProvider || 'Firebase Auth'

  // Detect user time zone
  const detectedTimeZone = useMemo(() => {
    try {
      return (
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Toronto'
      )
    } catch {
      return 'America/Toronto'
    }
  }, [])

  // Derive initial first/last name from display name
  const { initialFirstName, initialLastName } = useMemo(() => {
    const parts = rawDisplayName.trim().split(/\s+/)
    if (parts.length >= 2) {
      return {
        initialFirstName: parts[0],
        initialLastName: parts.slice(1).join(' '),
      }
    }
    return {
      initialFirstName: parts[0] || '',
      initialLastName: '',
    }
  }, [rawDisplayName])

  const initialTheme = (activeTheme as 'system' | 'light' | 'dark') || 'system'

  // Initial form values
  const initialValues: ProfileFormData = useMemo(
    () => ({
      firstName: initialFirstName,
      lastName: initialLastName,
      displayName: rawDisplayName,
      timeZone: detectedTimeZone,
      dateFormat: 'MM/DD/YYYY',
      timeFormat: '12h',
      theme: initialTheme,
    }),
    [
      initialFirstName,
      initialLastName,
      rawDisplayName,
      detectedTimeZone,
      initialTheme,
    ]
  )

  const [formData, setFormData] = useState<ProfileFormData>(initialValues)
  const [isSaving, setIsSaving] = useState(false)
  const [timeZoneQuery, setTimeZoneQuery] = useState('')
  const [isTzDropdownOpen, setIsTzDropdownOpen] = useState(false)

  // Sync initial theme once mounted
  useEffect(() => {
    if (activeTheme) {
      setFormData((prev) => ({
        ...prev,
        theme: (activeTheme as 'system' | 'light' | 'dark') || 'system',
      }))
    }
  }, [activeTheme])

  // Supported browser time zones list
  const allTimeZones = useMemo(() => {
    try {
      if (typeof Intl !== 'undefined' && (Intl as any).supportedValuesOf) {
        return (Intl as any).supportedValuesOf('timeZone') as string[]
      }
    } catch {
      // Fallback
    }
    return [
      'America/Toronto',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'America/Vancouver',
      'Europe/London',
      'Europe/Paris',
      'Europe/Berlin',
      'Asia/Tokyo',
      'Asia/Singapore',
      'Australia/Sydney',
      'UTC',
    ]
  }, [])

  const filteredTimeZones = useMemo(() => {
    if (!timeZoneQuery.trim()) return allTimeZones.slice(0, 40)
    const q = timeZoneQuery.toLowerCase()
    return allTimeZones
      .filter((tz) => tz.toLowerCase().includes(q))
      .slice(0, 40)
  }, [allTimeZones, timeZoneQuery])

  // Check if form is dirty
  const isDirty = useMemo(() => {
    return (
      formData.firstName !== initialValues.firstName ||
      formData.lastName !== initialValues.lastName ||
      formData.displayName !== initialValues.displayName ||
      formData.timeZone !== initialValues.timeZone ||
      formData.dateFormat !== initialValues.dateFormat ||
      formData.timeFormat !== initialValues.timeFormat ||
      formData.theme !== (activeTheme || initialValues.theme)
    )
  }, [formData, initialValues, activeTheme])

  // Validation
  const errors = useMemo(() => {
    const errs: Record<string, string> = {}
    if (!formData.displayName.trim()) {
      errs.displayName = 'Display name cannot be empty.'
    }
    return errs
  }, [formData])

  const isValid = Object.keys(errors).length === 0

  const handleFieldChange = (field: keyof ProfileFormData, value: any) => {
    setFormData((prev) => {
      const updated = { ...prev, [field]: value }
      if (field === 'firstName' || field === 'lastName') {
        const combined = `${updated.firstName} ${updated.lastName}`.trim()
        if (combined) {
          updated.displayName = combined
        }
      }
      return updated
    })
  }

  const handleReset = useCallback(() => {
    setFormData({
      firstName: initialFirstName,
      lastName: initialLastName,
      displayName: rawDisplayName,
      timeZone: detectedTimeZone,
      dateFormat: 'MM/DD/YYYY',
      timeFormat: '12h',
      theme: (activeTheme as 'system' | 'light' | 'dark') || 'system',
    })
  }, [
    initialFirstName,
    initialLastName,
    rawDisplayName,
    detectedTimeZone,
    activeTheme,
  ])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid || !isDirty || isSaving) return

    setIsSaving(true)

    try {
      if (formData.theme !== activeTheme) {
        setTheme(formData.theme)
      }

      notify({
        title: 'Appearance preference applied.',
        description:
          'Profile persistence is not connected yet. Your theme is applied on this device.',
        category: 'success',
      })
    } catch {
      notify({
        title: 'Failed to save settings',
        description:
          'An unexpected error occurred while saving profile settings.',
        category: 'error',
      })
    } finally {
      setIsSaving(false)
    }
  }

  // Calculate initials for identity block
  const initials =
    rawDisplayName
      .split(/\s+/)
      .map((part) => part[0])
      .filter(Boolean)
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'HV'

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* Identity Header Card */}
      <div className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 text-white flex items-center justify-center font-bold text-xl shadow-inner shrink-0">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-foreground truncate">
                {formData.displayName || rawDisplayName}
              </h2>
              <span className="inline-flex items-center rounded-md bg-blue-500/10 px-2 py-0.5 text-xs font-semibold text-blue-600 dark:text-blue-400 ring-1 ring-inset ring-blue-500/20">
                {roleDisplay}
              </span>
            </div>
            <p className="text-sm text-muted-foreground truncate mt-0.5">
              {rawEmail}
            </p>
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium text-foreground/90">
                  {orgName}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{signInProvider}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Personal Information */}
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-border pb-2">
          <h3 className="text-base font-semibold text-foreground">
            Personal Details
          </h3>
          <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
            <Info className="h-3.5 w-3.5 text-blue-500" />
            <span>Preference saving coming soon</span>
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="firstName"
              className="block text-xs font-medium text-foreground mb-1.5"
            >
              First Name
            </label>
            <Input
              id="firstName"
              type="text"
              autoComplete="given-name"
              value={formData.firstName}
              onChange={(e) => handleFieldChange('firstName', e.target.value)}
              placeholder="First name"
              className="w-full"
            />
          </div>

          <div>
            <label
              htmlFor="lastName"
              className="block text-xs font-medium text-foreground mb-1.5"
            >
              Last Name
            </label>
            <Input
              id="lastName"
              type="text"
              autoComplete="family-name"
              value={formData.lastName}
              onChange={(e) => handleFieldChange('lastName', e.target.value)}
              placeholder="Last name"
              className="w-full"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="displayName"
            className="block text-xs font-medium text-foreground mb-1.5"
          >
            Display Name <span className="text-rose-500">*</span>
          </label>
          <Input
            id="displayName"
            type="text"
            autoComplete="name"
            value={formData.displayName}
            onChange={(e) => handleFieldChange('displayName', e.target.value)}
            placeholder="Display name"
            className={cn(
              'w-full',
              errors.displayName &&
                'border-rose-500 focus-visible:ring-rose-500'
            )}
          />
          {errors.displayName && (
            <p className="text-xs text-rose-500 mt-1 font-medium">
              {errors.displayName}
            </p>
          )}
        </div>
      </div>

      {/* Read-Only Account Information */}
      <div className="space-y-4">
        <div className="border-b border-border pb-2">
          <h3 className="text-base font-semibold text-foreground">
            Account & Organization
          </h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="email"
              className="block text-xs font-medium text-foreground mb-1.5"
            >
              Email Address
            </label>
            <div className="relative">
              <Input
                id="email"
                type="email"
                value={rawEmail}
                readOnly
                disabled
                className="w-full bg-muted/50 text-muted-foreground pr-8 cursor-not-allowed"
              />
              <Lock
                className="h-4 w-4 text-muted-foreground absolute right-2.5 top-2.5"
                aria-hidden="true"
              />
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1">
              <span>
                Your sign-in email is managed through your authentication
                provider.
              </span>
            </p>
          </div>

          <div>
            <label
              htmlFor="organization"
              className="block text-xs font-medium text-foreground mb-1.5"
            >
              Organization
            </label>
            <Input
              id="organization"
              type="text"
              value={orgName}
              readOnly
              disabled
              className="w-full bg-muted/50 text-muted-foreground cursor-not-allowed"
            />
          </div>

          <div>
            <label
              htmlFor="role"
              className="block text-xs font-medium text-foreground mb-1.5"
            >
              Organization Role
            </label>
            <Input
              id="role"
              type="text"
              value={roleDisplay}
              readOnly
              disabled
              className="w-full bg-muted/50 text-muted-foreground cursor-not-allowed"
            />
          </div>

          <div>
            <label
              htmlFor="authProvider"
              className="block text-xs font-medium text-foreground mb-1.5"
            >
              Authentication Provider
            </label>
            <Input
              id="authProvider"
              type="text"
              value={signInProvider}
              readOnly
              disabled
              className="w-full bg-muted/50 text-muted-foreground cursor-not-allowed"
            />
          </div>
        </div>
      </div>

      {/* Locale & Preferences */}
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-border pb-2">
          <h3 className="text-base font-semibold text-foreground">
            Regional Preferences
          </h3>
          <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
            <Info className="h-3.5 w-3.5 text-blue-500" />
            <span>Preference saving coming soon</span>
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* Time zone selector */}
          <div className="relative">
            <label
              htmlFor="timeZone"
              className="block text-xs font-medium text-foreground mb-1.5"
            >
              Time Zone
            </label>
            <div className="relative">
              <Input
                id="timeZone"
                type="text"
                value={formData.timeZone}
                onClick={() => setIsTzDropdownOpen(true)}
                onChange={(e) => {
                  handleFieldChange('timeZone', e.target.value)
                  setTimeZoneQuery(e.target.value)
                  setIsTzDropdownOpen(true)
                }}
                placeholder="Search time zone..."
                className="w-full pr-8"
              />
              <Globe
                className="h-4 w-4 text-muted-foreground absolute right-2.5 top-2.5 pointer-events-none"
                aria-hidden="true"
              />
            </div>

            {isTzDropdownOpen && (
              <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-48 overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-lg text-xs">
                {filteredTimeZones.map((tz) => (
                  <button
                    key={tz}
                    type="button"
                    onClick={() => {
                      handleFieldChange('timeZone', tz)
                      setIsTzDropdownOpen(false)
                    }}
                    className={cn(
                      'w-full text-left px-3 py-1.5 hover:bg-accent hover:text-accent-foreground transition-colors',
                      formData.timeZone === tz &&
                        'font-bold bg-blue-500/10 text-blue-600 dark:text-blue-400'
                    )}
                  >
                    {tz}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Date format */}
          <div>
            <label
              htmlFor="dateFormat"
              className="block text-xs font-medium text-foreground mb-1.5"
            >
              Date Format
            </label>
            <div className="relative">
              <select
                id="dateFormat"
                value={formData.dateFormat}
                onChange={(e) =>
                  handleFieldChange('dateFormat', e.target.value)
                }
                className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-xs text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="MM/DD/YYYY">MM/DD/YYYY (e.g. 08/03/2026)</option>
                <option value="DD/MM/YYYY">DD/MM/YYYY (e.g. 03/08/2026)</option>
                <option value="YYYY-MM-DD">YYYY-MM-DD (e.g. 2026-08-03)</option>
              </select>
            </div>
          </div>

          {/* Time format */}
          <div>
            <label
              htmlFor="timeFormat"
              className="block text-xs font-medium text-foreground mb-1.5"
            >
              Time Format
            </label>
            <div className="relative">
              <select
                id="timeFormat"
                value={formData.timeFormat}
                onChange={(e) =>
                  handleFieldChange(
                    'timeFormat',
                    e.target.value as '12h' | '24h'
                  )
                }
                className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-xs text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="12h">12-hour (1:30 PM)</option>
                <option value="24h">24-hour (13:30)</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Appearance / Theme Preference */}
      <div className="space-y-4">
        <div className="border-b border-border pb-2">
          <h3 className="text-base font-semibold text-foreground">
            Theme Preference
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Choose how HawkView looks to you. This preference is saved
            immediately to your browser.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3 max-w-md">
          <button
            type="button"
            onClick={() => handleFieldChange('theme', 'system')}
            className={cn(
              'flex flex-col items-center justify-center p-3 rounded-lg border text-xs font-medium transition-all gap-2',
              formData.theme === 'system'
                ? 'border-blue-600 bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-1 ring-blue-500/30'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <Laptop className="h-5 w-5" />
            <span>System</span>
          </button>

          <button
            type="button"
            onClick={() => handleFieldChange('theme', 'light')}
            className={cn(
              'flex flex-col items-center justify-center p-3 rounded-lg border text-xs font-medium transition-all gap-2',
              formData.theme === 'light'
                ? 'border-blue-600 bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-1 ring-blue-500/30'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <Sun className="h-5 w-5 text-amber-500" />
            <span>Light</span>
          </button>

          <button
            type="button"
            onClick={() => handleFieldChange('theme', 'dark')}
            className={cn(
              'flex flex-col items-center justify-center p-3 rounded-lg border text-xs font-medium transition-all gap-2',
              formData.theme === 'dark'
                ? 'border-blue-600 bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-1 ring-blue-500/30'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <Moon className="h-5 w-5 text-purple-400" />
            <span>Dark</span>
          </button>
        </div>
      </div>

      {/* Actions Footer Bar */}
      <div className="pt-4 border-t border-border flex items-center justify-end gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={handleReset}
          disabled={!isDirty || isSaving}
          className="text-xs"
        >
          Cancel
        </Button>

        <Button
          type="submit"
          disabled={!isDirty || !isValid || isSaving}
          className="text-xs gap-2 min-w-[120px]"
        >
          {isSaving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Saving...</span>
            </>
          ) : (
            <>
              <Check className="h-3.5 w-3.5" />
              <span>Save changes</span>
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
