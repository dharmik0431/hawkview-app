'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Building2,
  Check,
  Clock3,
  Globe2,
  Loader2,
  LogOut,
  ShieldCheck,
} from 'lucide-react'
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
  workspaceOnboardingState,
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

function safeError(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message.slice(0, 300)
    : fallback
}

export function WorkspaceOnboardingGate({
  onboarding,
}: {
  onboarding: WorkspaceOnboarding
}) {
  const { identityUser, refreshSession, signOut } = useAuth()
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [organizationName, setOrganizationName] = useState(
    onboarding.organizationName ?? ''
  )
  const [businessDomain, setBusinessDomain] = useState(
    onboarding.businessDomain ?? ''
  )
  const [timeZone, setTimeZone] = useState(
    onboarding.timeZone ?? browserTimeZone()
  )
  const [phase, setPhase] = useState<'idle' | 'saving' | 'success'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    nameInputRef.current?.focus()
    nameInputRef.current?.select()
  }, [])

  const timeZoneOptions = useMemo(
    () => Array.from(new Set([browserTimeZone(), timeZone, ...COMMON_TIME_ZONES])),
    [timeZone]
  )

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!onboarding.organizationId || phase === 'saving') return

    const normalized = organizationSettingsPayload({
      organizationId: onboarding.organizationId,
      organizationName,
      businessDomain,
      timeZone,
    })
    if ('error' in normalized) {
      setError(normalized.error ?? 'Review the workspace details and try again.')
      return
    }

    setError(null)
    setPhase('saving')
    try {
      await apiClient.post('/api/workspace/onboarding', normalized.payload)
      setPhase('success')
      if (identityUser?.id) {
        publishWorkspaceChange(identityUser.id, normalized.payload.organizationId)
      }

      // No product cache may survive the setup boundary. Bootstrap again so
      // the gate is lifted only by durable backend completion state.
      clearIdentityBoundCaches()
      const refreshed = await refreshSession()
      const refreshedState = workspaceOnboardingState(refreshed)
      if (
        refreshedState.state !== 'ready' ||
        refreshedState.onboarding.required
      ) {
        throw new Error(
          'Workspace setup was saved, but HawkView could not verify it yet. Refresh and try again.'
        )
      }
    } catch (requestError) {
      setPhase('idle')
      setError(
        safeError(
          requestError,
          'HawkView could not finish workspace setup. Review the details and try again.'
        )
      )
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 px-4 py-8 sm:px-6">
      <div
        className="pointer-events-none absolute inset-0 opacity-80"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(circle at 15% 15%, rgba(37,99,235,.28), transparent 34%), radial-gradient(circle at 85% 80%, rgba(14,165,233,.18), transparent 30%)',
        }}
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-onboarding-title"
        aria-describedby="workspace-onboarding-description"
        className="relative w-full max-w-3xl overflow-hidden rounded-2xl border border-white/10 bg-white shadow-2xl dark:bg-slate-950"
      >
        <div className="grid md:grid-cols-[0.82fr_1.18fr]">
          <div className="hidden bg-gradient-to-br from-blue-700 via-blue-600 to-cyan-600 p-8 text-white md:flex md:flex-col md:justify-between">
            <div>
              <div className="mb-8 flex h-11 w-11 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/25">
                <ShieldCheck className="h-6 w-6" aria-hidden="true" />
              </div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-100">
                HawkView workspace
              </p>
              <h2 className="mt-3 text-2xl font-semibold leading-tight">
                One secure home for every tenant you manage.
              </h2>
              <p className="mt-4 text-sm leading-6 text-blue-100">
                Your workspace keeps customers, collection health, and Microsoft
                evidence separated from every other MSP.
              </p>
            </div>
            <div className="mt-10 space-y-3 text-sm text-blue-50">
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4" aria-hidden="true" />
                Organization-scoped access
              </div>
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4" aria-hidden="true" />
                Read-only Microsoft visibility
              </div>
            </div>
          </div>

          <div className="p-6 sm:p-8">
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <div className="mb-3 flex items-center gap-2 md:hidden">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white">
                    <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <span className="font-semibold text-slate-900 dark:text-white">
                    HawkView
                  </span>
                </div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-600 dark:text-blue-400">
                  Step 1 of 1
                </p>
                <h1
                  id="workspace-onboarding-title"
                  className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 dark:text-white"
                >
                  Set up your MSP workspace
                </h1>
                <p
                  id="workspace-onboarding-description"
                  className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300"
                >
                  Tell us how your organization should appear in HawkView.
                </p>
              </div>
              <div className="mt-1 h-2 w-20 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" aria-label="Setup progress: complete this step">
                <div className="h-full w-full rounded-full bg-blue-600" />
              </div>
            </div>

            <form onSubmit={submit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="workspace-organization-name">
                  MSP or organization name <span className="text-rose-600">*</span>
                </Label>
                <div className="relative">
                  <Building2 className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" aria-hidden="true" />
                  <Input
                    ref={nameInputRef}
                    id="workspace-organization-name"
                    name="organizationName"
                    autoComplete="organization"
                    value={organizationName}
                    onChange={(event) => setOrganizationName(event.target.value)}
                    maxLength={200}
                    className="pl-10"
                    disabled={phase !== 'idle'}
                    required
                  />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Visible to your HawkView team. The internal workspace ID is created automatically.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="workspace-business-domain">
                  Business domain <span className="font-normal text-slate-500">(optional)</span>
                </Label>
                <div className="relative">
                  <Globe2 className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" aria-hidden="true" />
                  <Input
                    id="workspace-business-domain"
                    name="businessDomain"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="example.com"
                    value={businessDomain}
                    onChange={(event) => setBusinessDomain(event.target.value)}
                    maxLength={253}
                    className="pl-10"
                    disabled={phase !== 'idle'}
                  />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Informational only; HawkView does not verify domain ownership.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="workspace-time-zone">
                  Default time zone <span className="text-rose-600">*</span>
                </Label>
                <div className="relative">
                  <Clock3 className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" aria-hidden="true" />
                  <Input
                    id="workspace-time-zone"
                    name="timeZone"
                    list="workspace-time-zone-options"
                    value={timeZone}
                    onChange={(event) => setTimeZone(event.target.value)}
                    maxLength={100}
                    className="pl-10"
                    disabled={phase !== 'idle'}
                    required
                  />
                  <datalist id="workspace-time-zone-options">
                    {timeZoneOptions.map((zone) => (
                      <option value={zone} key={zone} />
                    ))}
                  </datalist>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Prefilled from this browser. Use an IANA zone such as America/Toronto.
                </p>
              </div>

              <div aria-live="polite" aria-atomic="true" className="min-h-5">
                {error && (
                  <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
                    {error}
                  </p>
                )}
                {phase === 'success' && !error && (
                  <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                    <Check className="h-4 w-4" aria-hidden="true" /> Workspace ready. Opening HawkView…
                  </p>
                )}
              </div>

              <div className="flex flex-col-reverse gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void signOut()}
                  disabled={phase === 'saving'}
                  className="gap-2 text-slate-600 dark:text-slate-300"
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
                </Button>
                <Button type="submit" disabled={phase !== 'idle'} className="gap-2 sm:min-w-44">
                  {phase === 'saving' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Saving workspace…
                    </>
                  ) : phase === 'success' ? (
                    <>
                      <Check className="h-4 w-4" aria-hidden="true" /> Workspace ready
                    </>
                  ) : (
                    <>
                      Continue to HawkView <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </>
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      </section>
    </main>
  )
}
export function WorkspaceOnboardingUnavailable() {
  const { refreshSession, signOut } = useAuth()
  const [checking, setChecking] = useState(false)

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-8">
      <section className="w-full max-w-md rounded-2xl border border-white/10 bg-white p-7 text-center shadow-2xl dark:bg-slate-950" role="alert">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          <ShieldCheck className="h-6 w-6" aria-hidden="true" />
        </div>
        <h1 className="mt-4 text-xl font-semibold text-slate-950 dark:text-white">
          Workspace setup could not be verified
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
          HawkView is keeping product data hidden until your workspace state can be confirmed.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button
            onClick={async () => {
              setChecking(true)
              await refreshSession()
              setChecking(false)
            }}
            disabled={checking}
            className="gap-2"
          >
            {checking && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Check again
          </Button>
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </section>
    </main>
  )
}
